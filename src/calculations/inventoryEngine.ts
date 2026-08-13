import type {
  AppSettings,
  CostBreakdown,
  InventoryCostComponents,
  InventoryDailyMovement,
  InventoryItemSummary,
  InventoryLot,
  InventorySimulationResult,
  InventoryWasteRecord,
  LaborCostMode,
  LaborBreakdown,
  PeriodKey,
  ProcessCalculationDetail,
  PurchaseRecord,
  Resource,
  ResourceCalculationDetail,
  SourceRef,
  Unit,
} from '../models/types'
import { calculateCalendarSummary, formatLocalDate, getScheduleForDate, parseLocalDate, scheduleHours } from './calendar'
import { tryConvertQuantity } from './units'

const EPSILON = 1e-9

const emptyCosts = (): CostBreakdown => ({
  directIngredients: 0,
  prepMaterials: 0,
  prepLabor: 0,
  operatingLabor: 0,
  water: 0,
  gas: 0,
  electricity: 0,
  fryingOil: 0,
  waste: 0,
  other: 0,
  fixedMonthly: 0,
})

const emptyComponents = (): InventoryCostComponents => ({
  directIngredients: 0,
  prepMaterials: 0,
  prepLabor: 0,
  water: 0,
  gas: 0,
  electricity: 0,
  fryingOil: 0,
})

const componentKeys = Object.keys(emptyComponents()) as (keyof InventoryCostComponents)[]

const addComponents = (target: InventoryCostComponents, source: InventoryCostComponents, multiplier = 1) => {
  for (const key of componentKeys) target[key] += source[key] * multiplier
  return target
}

const componentTotal = (components: InventoryCostComponents) => componentKeys.reduce((total, key) => total + components[key], 0)

const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)

const calculateExpiryDate = (acquiredDate: string, shelfLifeDays: number) => {
  const acquired = parseLocalDate(acquiredDate)
  return acquired && shelfLifeDays > 0 ? formatLocalDate(addDays(acquired, shelfLifeDays)) : undefined
}

const keyFor = (sourceType: 'resource' | 'output', sourceId: string) => `${sourceType}:${sourceId}`

const lotValue = (lot: InventoryLot) => lot.quantity * lot.unitCost

const sortLots = (lots: InventoryLot[]) => [...lots].sort((a, b) => (
  a.acquiredDate.localeCompare(b.acquiredDate) || a.id.localeCompare(b.id)
))

export interface FifoConsumptionResult {
  lots: InventoryLot[]
  consumedQuantity: number
  consumedCost: number
  consumedComponents: InventoryCostComponents
}

export const consumeInventoryFIFO = (
  lots: InventoryLot[],
  sourceType: 'resource' | 'output',
  sourceId: string,
  quantity: number,
  unit: Unit,
): FifoConsumptionResult => {
  let remaining = Math.max(0, quantity)
  let consumedQuantity = 0
  let consumedCost = 0
  const consumedComponents = emptyComponents()
  const updated: InventoryLot[] = []

  for (const lot of sortLots(lots)) {
    if (lot.sourceType !== sourceType || lot.sourceId !== sourceId || remaining <= EPSILON) {
      updated.push({ ...lot })
      continue
    }
    const availableInRequestedUnit = tryConvertQuantity(lot.quantity, lot.unit, unit)
    if (availableInRequestedUnit === null) {
      updated.push({ ...lot })
      continue
    }
    const takeInRequestedUnit = Math.min(remaining, availableInRequestedUnit)
    const takeInLotUnit = tryConvertQuantity(takeInRequestedUnit, unit, lot.unit) ?? 0
    consumedQuantity += takeInRequestedUnit
    consumedCost += takeInLotUnit * lot.unitCost
    if (lot.costComponents) addComponents(consumedComponents, lot.costComponents, takeInLotUnit)
    remaining -= takeInRequestedUnit
    const quantityLeft = lot.quantity - takeInLotUnit
    if (quantityLeft > EPSILON) updated.push({ ...lot, quantity: quantityLeft })
  }

  return { lots: updated, consumedQuantity, consumedCost, consumedComponents }
}

export interface PurchaseOrderCalculation {
  packages: number
  purchasedQuantity: number
  stockedQuantity: number
  expenditure: number
}

export const calculatePurchaseOrder = (
  resource: Resource,
  currentQuantity: number,
  requiredQuantity: number,
): PurchaseOrderCalculation => {
  const shortage = requiredQuantity - currentQuantity
  const usablePerPackage = resource.purchaseQuantity * resource.yieldRate
  if (shortage <= EPSILON || usablePerPackage <= 0 || resource.minimumPurchaseLot <= 0) {
    return { packages: 0, purchasedQuantity: 0, stockedQuantity: 0, expenditure: 0 }
  }
  const packages = Math.max(Math.ceil(resource.minimumPurchaseLot), Math.ceil(shortage / usablePerPackage))
  return {
    packages,
    purchasedQuantity: packages * resource.purchaseQuantity,
    stockedQuantity: packages * usablePerPackage,
    expenditure: packages * resource.purchasePrice,
  }
}

interface MutableSummary extends InventoryItemSummary {
  dailyMovements: InventoryDailyMovement[]
}

export interface InventoryEngineResult {
  costs: CostBreakdown
  labor: Omit<LaborBreakdown, 'shiftLaborCost' | 'accountingLaborCost'>
  resources: ResourceCalculationDetail[]
  processes: ProcessCalculationDetail[]
  processCashUtilities: { water: number; gas: number; electricity: number }
  processCashAdditionalLabor: number
  inventory: Omit<InventorySimulationResult, 'simpleCashFlow'>
}

export const simulateInventoryPeriod = (
  settings: AppSettings,
  period: PeriodKey,
  mealsPerDay = settings.business.mealsPerDay,
  laborCostMode: LaborCostMode = 'accounting',
): InventoryEngineResult => {
  const calendar = calculateCalendarSummary(settings, period)
  const startDate = parseLocalDate(calendar.startDate) ?? new Date()
  const endDate = parseLocalDate(calendar.endDateExclusive) ?? addDays(startDate, calendar.calendarDays)
  const costs = emptyCosts()
  const lots: InventoryLot[] = []
  const purchases: PurchaseRecord[] = []
  const wastes: InventoryWasteRecord[] = []
  const summaries = new Map<string, MutableSummary>()
  const resourceUsage = new Map<string, ResourceCalculationDetail>()
  const processDetails = new Map<string, ProcessCalculationDetail>()
  let lotSequence = 0
  let saleUsageCost = 0
  let processCashAdditionalLabor = 0
  const processCashUtilities = { water: 0, gas: 0, electricity: 0 }
  const labor = {
    prepLaborAllocation: 0,
    additionalPrepLaborCost: 0,
    marginalPrepLaborCost: 0,
  }

  const findOutput = (outputId: string) => {
    for (const process of settings.processes) {
      const outputIndex = process.outputs.findIndex((output) => output.id === outputId)
      if (outputIndex >= 0) return { process, output: process.outputs[outputIndex], outputIndex }
    }
    return undefined
  }

  const sourceMeta = (sourceType: 'resource' | 'output', sourceId: string) => {
    if (sourceType === 'resource') {
      const resource = settings.resources.find((item) => item.id === sourceId)
      return resource && { name: resource.name, unit: resource.purchaseUnit, shelfLifeDays: resource.shelfLifeDays }
    }
    const found = findOutput(sourceId)
    return found && { name: found.output.name, unit: found.output.unit, shelfLifeDays: found.output.shelfLifeDays }
  }

  const createSummary = (sourceType: 'resource' | 'output', sourceId: string) => {
    const key = keyFor(sourceType, sourceId)
    const existing = summaries.get(key)
    if (existing) return existing
    const meta = sourceMeta(sourceType, sourceId)
    const summary: MutableSummary = {
      sourceType,
      sourceId,
      name: meta?.name ?? sourceId,
      unit: meta?.unit ?? 'g',
      openingQuantity: 0,
      purchasedQuantity: 0,
      producedQuantity: 0,
      byProductQuantity: 0,
      consumedQuantity: 0,
      wastedQuantity: 0,
      endingQuantity: 0,
      openingValue: 0,
      endingValue: 0,
      usageCost: 0,
      wasteCost: 0,
      purchaseExpenditure: 0,
      productionValue: 0,
      endingLots: [],
      dailyMovements: [],
    }
    summaries.set(key, summary)
    return summary
  }

  for (const resource of settings.resources) createSummary('resource', resource.id)
  for (const process of settings.processes) for (const output of process.outputs) createSummary('output', output.id)

  const resourceUnitCost = (resource: Resource) => resource.purchaseQuantity > 0 && resource.yieldRate > 0
    ? resource.purchasePrice / (resource.purchaseQuantity * resource.yieldRate)
    : 0

  for (const opening of settings.inventory.openingLots) {
    const meta = sourceMeta(opening.sourceType, opening.sourceId)
    if (!meta || opening.quantity <= 0) continue
    const quantity = tryConvertQuantity(opening.quantity, opening.unit, meta.unit)
    if (quantity === null) continue
    const resource = opening.sourceType === 'resource' ? settings.resources.find((item) => item.id === opening.sourceId) : undefined
    const unitCost = opening.unitCost ?? (resource ? resourceUnitCost(resource) : 0)
    const acquiredDate = opening.acquiredDate || calendar.startDate
    const lot: InventoryLot = {
      id: opening.id,
      sourceType: opening.sourceType,
      sourceId: opening.sourceId,
      quantity,
      unit: meta.unit,
      acquiredDate,
      expiryDate: opening.expiryDate || calculateExpiryDate(acquiredDate, meta.shelfLifeDays),
      unitCost,
      purchaseCost: quantity * unitCost,
      source: 'openingInventory',
    }
    lots.push(lot)
    const summary = createSummary(opening.sourceType, opening.sourceId)
    summary.openingQuantity += quantity
    summary.openingValue += lotValue(lot)
  }

  const availableQuantity = (sourceType: 'resource' | 'output', sourceId: string, unit: Unit) => lots.reduce((total, lot) => {
    if (lot.sourceType !== sourceType || lot.sourceId !== sourceId) return total
    return total + (tryConvertQuantity(lot.quantity, lot.unit, unit) ?? 0)
  }, 0)

  const movementFor = (summary: MutableSummary, date: string) => {
    const movement = summary.dailyMovements.at(-1)
    if (!movement || movement.date !== date) throw new Error(`在庫日次推移が初期化されていません: ${summary.sourceId}`)
    return movement
  }

  const addLot = (lot: InventoryLot) => {
    lots.push(lot)
  }

  const purchaseResource = (resource: Resource, requiredQuantity: number, date: string) => {
    const currentQuantity = availableQuantity('resource', resource.id, resource.purchaseUnit)
    const order = calculatePurchaseOrder(resource, currentQuantity, requiredQuantity)
    if (order.packages <= 0) return
    const unitCost = order.expenditure / order.stockedQuantity
    const lot: InventoryLot = {
      id: `purchase-${date}-${resource.id}-${lotSequence += 1}`,
      sourceType: 'resource',
      sourceId: resource.id,
      quantity: order.stockedQuantity,
      unit: resource.purchaseUnit,
      acquiredDate: date,
      expiryDate: calculateExpiryDate(date, resource.shelfLifeDays),
      unitCost,
      purchaseCost: order.expenditure,
      source: 'purchase',
    }
    addLot(lot)
    const summary = createSummary('resource', resource.id)
    summary.purchasedQuantity += order.stockedQuantity
    summary.purchaseExpenditure += order.expenditure
    movementFor(summary, date).purchasedQuantity += order.stockedQuantity
    purchases.push({
      id: lot.id,
      date,
      resourceId: resource.id,
      resourceName: resource.name,
      packages: order.packages,
      purchasedQuantity: order.purchasedQuantity,
      stockedQuantity: order.stockedQuantity,
      unit: resource.purchaseUnit,
      expenditure: order.expenditure,
    })
  }

  const addRecognizedComponents = (components: InventoryCostComponents, fallbackCost: number) => {
    const recognized = componentTotal(components)
    if (recognized <= EPSILON) costs.prepMaterials += fallbackCost
    else {
      costs.directIngredients += components.directIngredients
      costs.prepMaterials += components.prepMaterials
      costs.prepLabor += components.prepLabor
      costs.water += components.water
      costs.gas += components.gas
      costs.electricity += components.electricity
      costs.fryingOil += components.fryingOil
    }
  }

  const consume = (
    sourceType: 'resource' | 'output',
    sourceId: string,
    quantity: number,
    unit: Unit,
    date: string,
    purpose: 'sale' | 'production',
  ) => {
    const result = consumeInventoryFIFO(lots, sourceType, sourceId, quantity, unit)
    lots.splice(0, lots.length, ...result.lots)
    const summary = createSummary(sourceType, sourceId)
    const canonicalQuantity = tryConvertQuantity(result.consumedQuantity, unit, summary.unit) ?? 0
    summary.consumedQuantity += canonicalQuantity
    summary.usageCost += result.consumedCost
    movementFor(summary, date).consumedQuantity += canonicalQuantity

    if (sourceType === 'resource') {
      const resource = settings.resources.find((item) => item.id === sourceId)
      const current = resourceUsage.get(sourceId)
      resourceUsage.set(sourceId, current
        ? { ...current, quantity: current.quantity + canonicalQuantity, usageCost: current.usageCost + result.consumedCost }
        : { id: sourceId, name: resource?.name ?? sourceId, quantity: canonicalQuantity, unit: summary.unit, usageCost: result.consumedCost })
    }
    if (purpose === 'sale') {
      saleUsageCost += result.consumedCost
      if (sourceType === 'resource') {
        const resource = settings.resources.find((item) => item.id === sourceId)
        if (resource?.category === 'oil') costs.fryingOil += result.consumedCost
        else costs.directIngredients += result.consumedCost
      } else addRecognizedComponents(result.consumedComponents, result.consumedCost)
    }
    return result
  }

  const ensureSource = (
    sourceType: 'resource' | 'output',
    sourceId: string,
    quantity: number,
    unit: Unit,
    date: string,
    trail: Set<string>,
  ): void => {
    const meta = sourceMeta(sourceType, sourceId)
    if (!meta) return
    const canonicalRequired = tryConvertQuantity(quantity, unit, meta.unit)
    if (canonicalRequired === null) return
    const current = availableQuantity(sourceType, sourceId, meta.unit)
    if (current + EPSILON >= canonicalRequired) return

    if (sourceType === 'resource') {
      const resource = settings.resources.find((item) => item.id === sourceId)
      if (resource) purchaseResource(resource, canonicalRequired, date)
      return
    }

    const found = findOutput(sourceId)
    const demandedOutputPerBatch = found && found.outputIndex === 0 ? found.process.batchSize : found?.output.quantity ?? 0
    if (!found || trail.has(found.process.id) || demandedOutputPerBatch <= 0) return
    const shortage = canonicalRequired - current
    const batches = Math.ceil(shortage / demandedOutputPerBatch)
    const nextTrail = new Set(trail).add(found.process.id)
    let materialCost = 0

    for (const recipeInput of found.process.inputs) {
      const inputMeta = sourceMeta(recipeInput.sourceType, recipeInput.sourceId)
      if (!inputMeta) continue
      const required = recipeInput.quantity * batches
      ensureSource(recipeInput.sourceType, recipeInput.sourceId, required, recipeInput.unit, date, nextTrail)
      const inputConsumption = consume(recipeInput.sourceType, recipeInput.sourceId, required, recipeInput.unit, date, 'production')
      materialCost += inputConsumption.consumedCost
    }

    const role = settings.labor.find((item) => item.id === found.process.laborRole)
    const allocation = (role?.hourlyWage ?? 0) * found.process.activeLaborMinutes * batches / 60
    const additionalLabor = found.process.laborCostTreatment === 'additionalLabor' ? allocation : 0
    const marginalLabor = allocation * Math.min(1, Math.max(0, role?.marginalCostRate ?? 0))
    const inventoryLaborCost = laborCostMode === 'accounting' ? additionalLabor : marginalLabor
    const water = found.process.waterUsageL * batches * settings.utilities.water.unitPrice
    const gas = found.process.gasUsageM3 * batches * settings.utilities.gas.unitPrice
    const electricity = found.process.electricUsageKWh * batches * settings.utilities.electricity.unitPrice
    const wasteCost = materialCost * Math.min(1, Math.max(0, found.process.wasteRate))
    const productiveMaterialCost = materialCost - wasteCost

    labor.prepLaborAllocation += allocation
    labor.additionalPrepLaborCost += additionalLabor
    labor.marginalPrepLaborCost += marginalLabor
    processCashAdditionalLabor += additionalLabor
    processCashUtilities.water += water
    processCashUtilities.gas += gas
    processCashUtilities.electricity += electricity
    costs.waste += wasteCost
    if (wasteCost > EPSILON) wastes.push({
      id: `process-waste-${date}-${found.process.id}-${lotSequence += 1}`,
      date,
      sourceType: 'process',
      sourceId: found.process.id,
      name: found.process.name,
      quantity: 0,
      cost: wasteCost,
      reason: found.process.wasteReason,
    })

    const processDetail: ProcessCalculationDetail = {
      id: found.process.id,
      name: found.process.name,
      batches,
      materialCost,
      activeLaborMinutes: found.process.activeLaborMinutes * batches,
      laborAllocation: allocation,
      additionalLaborCost: additionalLabor,
      marginalLaborCost: marginalLabor,
    }
    const existingProcess = processDetails.get(found.process.id)
    processDetails.set(found.process.id, existingProcess ? {
      ...existingProcess,
      batches: existingProcess.batches + processDetail.batches,
      materialCost: existingProcess.materialCost + processDetail.materialCost,
      activeLaborMinutes: existingProcess.activeLaborMinutes + processDetail.activeLaborMinutes,
      laborAllocation: existingProcess.laborAllocation + processDetail.laborAllocation,
      additionalLaborCost: existingProcess.additionalLaborCost + processDetail.additionalLaborCost,
      marginalLaborCost: existingProcess.marginalLaborCost + processDetail.marginalLaborCost,
    } : processDetail)

    const batchComponents: InventoryCostComponents = {
      ...emptyComponents(),
      prepMaterials: productiveMaterialCost,
      prepLabor: inventoryLaborCost,
      water,
      gas,
      electricity,
    }

    found.process.outputs.forEach((output, outputIndex) => {
      const outputPerBatch = outputIndex === 0 ? found.process.batchSize : output.quantity
      const producedQuantity = outputPerBatch * batches
      if (producedQuantity <= 0) return
      const allocatedComponents = emptyComponents()
      addComponents(allocatedComponents, batchComponents, output.costAllocation / producedQuantity)
      const unitCost = componentTotal(allocatedComponents)
      const source = outputIndex === 0 ? 'processOutput' as const : 'byProduct' as const
      const lot: InventoryLot = {
        id: `production-${date}-${output.id}-${lotSequence += 1}`,
        sourceType: 'output',
        sourceId: output.id,
        quantity: producedQuantity,
        unit: output.unit,
        acquiredDate: date,
        expiryDate: calculateExpiryDate(date, output.shelfLifeDays),
        unitCost,
        purchaseCost: producedQuantity * unitCost,
        source,
        costComponents: allocatedComponents,
      }
      addLot(lot)
      const summary = createSummary('output', output.id)
      summary.productionValue += lotValue(lot)
      if (source === 'byProduct') {
        summary.byProductQuantity += producedQuantity
        movementFor(summary, date).byProductQuantity += producedQuantity
      } else {
        summary.producedQuantity += producedQuantity
        movementFor(summary, date).producedQuantity += producedQuantity
      }
    })
  }

  const addDemand = (demand: Map<string, SourceRef>, source: SourceRef, quantity: number) => {
    const meta = sourceMeta(source.sourceType, source.sourceId)
    if (!meta) return
    const converted = tryConvertQuantity(quantity, source.unit, meta.unit)
    if (converted === null) return
    const key = keyFor(source.sourceType, source.sourceId)
    const current = demand.get(key)
    demand.set(key, current
      ? { ...current, quantity: current.quantity + converted }
      : { ...source, quantity: converted, unit: meta.unit })
  }

  for (let date = startDate; date < endDate; date = addDays(date, 1)) {
    const dateString = formatLocalDate(date)
    for (const summary of summaries.values()) {
      summary.dailyMovements.push({
        date: dateString,
        openingQuantity: availableQuantity(summary.sourceType, summary.sourceId, summary.unit),
        purchasedQuantity: 0,
        producedQuantity: 0,
        byProductQuantity: 0,
        consumedQuantity: 0,
        wastedQuantity: 0,
        endingQuantity: 0,
      })
    }

    const retainedLots: InventoryLot[] = []
    for (const lot of lots) {
      if (lot.expiryDate && dateString >= lot.expiryDate) {
        const summary = createSummary(lot.sourceType, lot.sourceId)
        const quantity = tryConvertQuantity(lot.quantity, lot.unit, summary.unit) ?? 0
        const value = lotValue(lot)
        summary.wastedQuantity += quantity
        summary.wasteCost += value
        movementFor(summary, dateString).wastedQuantity += quantity
        costs.waste += value
        wastes.push({
          id: `spoilage-${dateString}-${lot.id}`,
          date: dateString,
          sourceType: lot.sourceType,
          sourceId: lot.sourceId,
          name: summary.name,
          quantity,
          unit: summary.unit,
          cost: value,
          reason: 'spoilage',
        })
      } else retainedLots.push(lot)
    }
    lots.splice(0, lots.length, ...retainedLots)

    const schedule = getScheduleForDate(settings, date)
    if (schedule?.enabled && scheduleHours(schedule) > 0) {
      const demand = new Map<string, SourceRef>()
      for (const menu of settings.menuItems.filter((item) => item.enabled)) {
        const servings = mealsPerDay * menu.expectedSalesRatio / 100
        for (const source of menu.consumption) addDemand(demand, source, source.quantity * servings)
      }
      for (const topping of settings.toppings.filter((item) => item.enabled)) {
        const orders = mealsPerDay * topping.orderRate / 100
        for (const source of topping.consumption) addDemand(demand, source, source.quantity * orders)
      }
      if (settings.fryingOil.inventoryResourceId) {
        const replacement = settings.fryingOil.replacementIntervalDays > 0
          ? settings.fryingOil.initialFillL / settings.fryingOil.replacementIntervalDays
          : 0
        const oilDemand = replacement + settings.fryingOil.dailyTopUpL + settings.fryingOil.absorptionLPerMeal * mealsPerDay
        addDemand(demand, {
          sourceType: 'resource',
          sourceId: settings.fryingOil.inventoryResourceId,
          quantity: oilDemand,
          unit: 'L',
        }, oilDemand)
      }
      for (const source of demand.values()) {
        ensureSource(source.sourceType, source.sourceId, source.quantity, source.unit, dateString, new Set())
        consume(source.sourceType, source.sourceId, source.quantity, source.unit, dateString, 'sale')
      }
    }

    for (const summary of summaries.values()) {
      movementFor(summary, dateString).endingQuantity = availableQuantity(summary.sourceType, summary.sourceId, summary.unit)
    }
  }

  for (const summary of summaries.values()) {
    const endingLots = sortLots(lots.filter((lot) => lot.sourceType === summary.sourceType && lot.sourceId === summary.sourceId))
    summary.endingLots = endingLots
    summary.endingQuantity = endingLots.reduce((total, lot) => total + (tryConvertQuantity(lot.quantity, lot.unit, summary.unit) ?? 0), 0)
    summary.endingValue = endingLots.reduce((total, lot) => total + lotValue(lot), 0)
    summary.oldestAcquiredDate = endingLots[0]?.acquiredDate
    summary.nearestExpiryDate = endingLots.map((lot) => lot.expiryDate).filter((date): date is string => !!date).sort()[0]
  }

  const items = [...summaries.values()]
  const openingInventoryValue = items.reduce((total, item) => total + item.openingValue, 0)
  const endingInventoryValue = items.reduce((total, item) => total + item.endingValue, 0)
  const purchaseExpenditure = purchases.reduce((total, purchase) => total + purchase.expenditure, 0)
  const wasteCost = costs.waste

  return {
    costs,
    labor,
    resources: [...resourceUsage.values()],
    processes: [...processDetails.values()],
    processCashUtilities,
    processCashAdditionalLabor,
    inventory: {
      usageCost: saleUsageCost,
      purchaseExpenditure,
      openingInventoryValue,
      endingInventoryValue,
      wasteCost,
      purchaseCount: purchases.length,
      items,
      purchases,
      wastes,
      endingLots: sortLots(lots),
    },
  }
}

export const simulateInventorySourcePlan = (
  settings: AppSettings,
  source: SourceRef,
  dailyQuantity: number,
  laborCostMode: LaborCostMode = 'accounting',
) => {
  const planSettings: AppSettings = {
    ...settings,
    business: { ...settings.business, mealsPerDay: 1 },
    inventory: { ...settings.inventory, openingLots: [] },
    fryingOil: { ...settings.fryingOil, inventoryResourceId: undefined, unitPricePerL: 0, initialFillL: 0, dailyTopUpL: 0, absorptionLPerMeal: 0 },
    menuItems: [{
      id: 'inventory-source-plan',
      name: '比較用需要',
      sellingPrice: 0,
      expectedSalesRatio: 100,
      enabled: true,
      consumption: [{ ...source, quantity: dailyQuantity }],
    }],
    toppings: [],
  }
  const result = simulateInventoryPeriod(planSettings, 'month', 1, laborCostMode)
  return {
    totalPeriodCost: result.inventory.usageCost + result.inventory.wasteCost,
    usageCost: result.inventory.usageCost,
    wasteCost: result.inventory.wasteCost,
    endingInventoryValue: result.inventory.endingInventoryValue,
    purchaseExpenditure: result.inventory.purchaseExpenditure,
    workHours: result.processes.reduce((total, process) => total + process.activeLaborMinutes, 0) / 60,
  }
}
