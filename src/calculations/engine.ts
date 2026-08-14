import type {
  AppSettings,
  CalculationDetails,
  CalendarSummary,
  CostBreakdown,
  LaborBreakdown,
  LaborCostMode,
  LaborCostResult,
  MakeBuyResult,
  PeriodKey,
  ProcessCalculationDetail,
  ResourceCalculationDetail,
  SimulationResult,
  SourceRef,
  Unit,
  UtilityConfig,
} from '../models/types'
import { calculateCalendarRange, calculateCalendarSummary, parseLocalDate } from './calendar'
import { simulateInventoryPeriod, simulateInventorySourcePlan } from './inventoryEngine'
import type { InventoryPeriodOptions } from './inventoryEngine'
import { tryConvertQuantity } from './units'

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

const emptyLabor = (): LaborBreakdown => ({
  shiftLaborCost: 0,
  prepLaborAllocation: 0,
  additionalPrepLaborCost: 0,
  accountingLaborCost: 0,
  marginalPrepLaborCost: 0,
})

interface TraceState {
  resources: Map<string, ResourceCalculationDetail>
  processes: Map<string, ProcessCalculationDetail>
  labor: LaborBreakdown
  waterL: number
  gasM3: number
  electricityKWh: number
}

const createTrace = (): TraceState => ({
  resources: new Map(),
  processes: new Map(),
  labor: emptyLabor(),
  waterL: 0,
  gasM3: 0,
  electricityKWh: 0,
})

const costKeys = Object.keys(emptyCosts()) as (keyof CostBreakdown)[]

const addCosts = (target: CostBreakdown, source: CostBreakdown, multiplier = 1) => {
  for (const key of costKeys) target[key] += source[key] * multiplier
  return target
}

const scaleCosts = (costs: CostBreakdown, multiplier: number) => {
  const result = emptyCosts()
  return addCosts(result, costs, multiplier)
}

export const sumCosts = (costs: CostBreakdown) => costKeys.reduce((sum, key) => sum + costs[key], 0)

export const calculateBatchCount = (requiredQuantity: number, batchSize: number) => {
  if (requiredQuantity <= 0 || batchSize <= 0) return 0
  return Math.ceil(requiredQuantity / batchSize)
}

export const getResourceUnitCost = (settings: AppSettings, resourceId: string) => {
  const resource = settings.resources.find((item) => item.id === resourceId)
  if (!resource || resource.purchaseQuantity <= 0 || resource.yieldRate <= 0 || resource.yieldRate > 1) return 0
  return resource.purchasePrice / (resource.purchaseQuantity * resource.yieldRate)
}

export const getResourceCostForQuantity = (
  settings: AppSettings,
  resourceId: string,
  quantity: number,
  unit: Unit,
) => {
  const resource = settings.resources.find((item) => item.id === resourceId)
  if (!resource) return 0
  const converted = tryConvertQuantity(quantity, unit, resource.purchaseUnit)
  return converted === null ? 0 : getResourceUnitCost(settings, resourceId) * converted
}

export const calculateLaborCost = (hourlyWage: number, minutes: number, headcount = 1) =>
  hourlyWage * headcount * (minutes / 60)

export const calculateLaborCostBreakdown = (
  hourlyWage: number,
  minutes: number,
  headcount = 1,
  marginalCostRate = 0,
): LaborCostResult => {
  const accountingLaborCost = calculateLaborCost(hourlyWage, minutes, headcount)
  return {
    accountingLaborCost,
    marginalLaborCost: accountingLaborCost * Math.min(1, Math.max(0, marginalCostRate)),
  }
}

export const calculateUtilityQuantity = (
  config: UtilityConfig,
  meals: number,
  hours: number,
) => config.uses.reduce((total, use) => {
  switch (use.behavior) {
    case 'perMeal': return total + use.quantity * meals
    case 'perHour': return total + use.quantity * hours
    case 'alwaysOn': return total + use.quantity * 24
    case 'perUse': return total + use.quantity * (use.usesPerMeal ?? 0) * meals
    case 'perDay': return total + use.quantity
    default: return total
  }
}, 0)

export const calculateUtilityPeriodQuantity = (
  config: UtilityConfig,
  meals: number,
  operatingDays: number,
  operatingHours: number,
  calendarDays: number,
) => config.uses.reduce((total, use) => {
  switch (use.behavior) {
    case 'perMeal': return total + use.quantity * meals
    case 'perHour': return total + use.quantity * operatingHours
    case 'alwaysOn': return total + use.quantity * 24 * calendarDays
    case 'perUse': return total + use.quantity * (use.usesPerMeal ?? 0) * meals
    case 'perDay': return total + use.quantity * operatingDays
    default: return total
  }
}, 0)

export const calculateUtilityDailyCost = (config: UtilityConfig, meals: number, hours: number) =>
  calculateUtilityQuantity(config, meals, hours) * config.unitPrice

export const calculateAverageDailyOilLiters = (settings: AppSettings, meals = settings.business.mealsPerDay) => {
  const oil = settings.fryingOil
  const replacement = oil.replacementIntervalDays > 0 ? oil.initialFillL / oil.replacementIntervalDays : 0
  return replacement + oil.dailyTopUpL + oil.absorptionLPerMeal * meals
}

const findProcessOutput = (settings: AppSettings, outputId: string) => {
  for (const process of settings.processes) {
    const output = process.outputs.find((item) => item.id === outputId)
    if (output) return { process, output }
  }
  return undefined
}

const addResourceTrace = (
  settings: AppSettings,
  trace: TraceState | undefined,
  resourceId: string,
  quantity: number,
  unit: Unit,
  cost: number,
) => {
  if (!trace) return
  const resource = settings.resources.find((item) => item.id === resourceId)
  if (!resource) return
  const converted = tryConvertQuantity(quantity, unit, resource.purchaseUnit)
  if (converted === null) return
  const current = trace.resources.get(resourceId)
  trace.resources.set(resourceId, current
    ? { ...current, quantity: current.quantity + converted, usageCost: current.usageCost + cost }
    : { id: resource.id, name: resource.name, quantity: converted, unit: resource.purchaseUnit, usageCost: cost })
}

const costResource = (
  settings: AppSettings,
  resourceId: string,
  quantity: number,
  unit: Unit,
  context: 'direct' | 'prep',
  trace?: TraceState,
) => {
  const costs = emptyCosts()
  const resource = settings.resources.find((item) => item.id === resourceId)
  if (!resource) return costs
  const amount = getResourceCostForQuantity(settings, resourceId, quantity, unit)
  if (resource.category === 'oil') costs.fryingOil = amount
  else if (context === 'direct') costs.directIngredients = amount
  else costs.prepMaterials = amount
  addResourceTrace(settings, trace, resourceId, quantity, unit, amount)
  return costs
}

const addProcessTrace = (
  trace: TraceState | undefined,
  process: AppSettings['processes'][number],
  batches: number,
  materialCost: number,
  allocation: number,
  additional: number,
  marginal: number,
) => {
  if (!trace) return
  const current = trace.processes.get(process.id)
  const detail: ProcessCalculationDetail = {
    id: process.id,
    name: process.name,
    batches,
    materialCost,
    activeLaborMinutes: process.activeLaborMinutes * batches,
    laborAllocation: allocation,
    additionalLaborCost: additional,
    marginalLaborCost: marginal,
  }
  trace.processes.set(process.id, current ? {
    ...current,
    batches: current.batches + detail.batches,
    materialCost: current.materialCost + detail.materialCost,
    activeLaborMinutes: current.activeLaborMinutes + detail.activeLaborMinutes,
    laborAllocation: current.laborAllocation + detail.laborAllocation,
    additionalLaborCost: current.additionalLaborCost + detail.additionalLaborCost,
    marginalLaborCost: current.marginalLaborCost + detail.marginalLaborCost,
  } : detail)
  trace.labor.prepLaborAllocation += allocation
  trace.labor.additionalPrepLaborCost += additional
  trace.labor.marginalPrepLaborCost += marginal
  trace.waterL += process.waterUsageL * batches
  trace.gasM3 += process.gasUsageM3 * batches
  trace.electricityKWh += process.electricUsageKWh * batches
}

const processOutputCost = (
  settings: AppSettings,
  outputId: string,
  requestedQuantity: number,
  roundBatches: boolean,
  laborMode: LaborCostMode,
  trail: Set<string>,
  trace?: TraceState,
): CostBreakdown => {
  const found = findProcessOutput(settings, outputId)
  const outputPerBatch = found && found.process.outputs[0]?.id === found.output.id
    ? found.process.batchSize
    : found?.output.quantity ?? 0
  if (!found || requestedQuantity <= 0 || outputPerBatch <= 0 || trail.has(outputId)) return emptyCosts()

  const nextTrail = new Set(trail).add(outputId)
  const batches = roundBatches
    ? calculateBatchCount(requestedQuantity, outputPerBatch)
    : requestedQuantity / outputPerBatch
  const costs = emptyCosts()

  for (const recipeInput of found.process.inputs) {
    const required = recipeInput.quantity * batches
    if (recipeInput.sourceType === 'resource') {
      addCosts(costs, costResource(settings, recipeInput.sourceId, required, recipeInput.unit, 'prep', trace))
      continue
    }
    const upstream = findProcessOutput(settings, recipeInput.sourceId)
    if (!upstream) continue
    const converted = tryConvertQuantity(required, recipeInput.unit, upstream.output.unit)
    if (converted === null) continue
    addCosts(costs, processOutputCost(settings, recipeInput.sourceId, converted, roundBatches, laborMode, nextTrail, trace))
  }

  const inputMaterialCost = costs.directIngredients + costs.prepMaterials + costs.fryingOil + costs.waste
  const role = settings.labor.find((item) => item.id === found.process.laborRole)
  const allocation = calculateLaborCost(role?.hourlyWage ?? 0, found.process.activeLaborMinutes * batches)
  const marginal = allocation * Math.min(1, Math.max(0, role?.marginalCostRate ?? 0))
  const additional = found.process.laborCostTreatment === 'additionalLabor' ? allocation : 0
  costs.prepLabor += laborMode === 'accounting' ? additional : marginal
  costs.water += found.process.waterUsageL * batches * settings.utilities.water.unitPrice
  costs.gas += found.process.gasUsageM3 * batches * settings.utilities.gas.unitPrice
  costs.electricity += found.process.electricUsageKWh * batches * settings.utilities.electricity.unitPrice

  const newlyWasted = costs.prepMaterials * Math.min(1, Math.max(0, found.process.wasteRate))
  costs.prepMaterials -= newlyWasted
  costs.waste += newlyWasted

  const allocationFactor = found.output.costAllocation
  addProcessTrace(
    trace,
    found.process,
    batches,
    inputMaterialCost * allocationFactor,
    allocation * allocationFactor,
    additional * allocationFactor,
    marginal * allocationFactor,
  )
  return scaleCosts(costs, allocationFactor)
}

const calculateOutputWithTrace = (
  settings: AppSettings,
  outputId: string,
  requestedQuantity: number,
  roundBatches: boolean,
  laborMode: LaborCostMode,
) => {
  const trace = createTrace()
  const costs = processOutputCost(settings, outputId, requestedQuantity, roundBatches, laborMode, new Set(), trace)
  return { costs, trace }
}

export const calculateProcessOutputCost = (
  settings: AppSettings,
  outputId: string,
  requestedQuantity = 1,
  roundBatches = true,
  laborMode: LaborCostMode = 'accounting',
) => processOutputCost(settings, outputId, requestedQuantity, roundBatches, laborMode, new Set())

export const calculateSourceCost = (
  settings: AppSettings,
  source: SourceRef,
  requiredQuantity: number,
  roundBatches = true,
  laborMode: LaborCostMode = 'accounting',
) => {
  if (source.sourceType === 'resource') {
    return costResource(settings, source.sourceId, requiredQuantity, source.unit, 'direct')
  }
  const target = findProcessOutput(settings, source.sourceId)
  if (!target) return emptyCosts()
  const converted = tryConvertQuantity(requiredQuantity, source.unit, target.output.unit)
  return converted === null ? emptyCosts() : calculateProcessOutputCost(settings, source.sourceId, converted, roundBatches, laborMode)
}

const getSourceUnit = (settings: AppSettings, source: SourceRef) => source.sourceType === 'resource'
  ? settings.resources.find((resource) => resource.id === source.sourceId)?.purchaseUnit
  : findProcessOutput(settings, source.sourceId)?.output.unit

const addDemand = (settings: AppSettings, demand: Map<string, SourceRef>, source: SourceRef, quantity: number) => {
  const targetUnit = getSourceUnit(settings, source)
  if (!targetUnit) return
  const converted = tryConvertQuantity(quantity, source.unit, targetUnit)
  if (converted === null) return
  const key = `${source.sourceType}:${source.sourceId}`
  const current = demand.get(key)
  demand.set(key, current
    ? { ...current, quantity: current.quantity + converted }
    : { ...source, quantity: converted, unit: targetUnit })
}

const calculateOperatingCore = (settings: AppSettings, meals: number, laborMode: LaborCostMode = 'accounting') => {
  const costs = emptyCosts()
  const demand = new Map<string, SourceRef>()
  const trace = createTrace()
  const menus: CalculationDetails['menus'] = []
  let menuRevenue = 0
  let toppingRevenue = 0
  let ratioTotal = 0

  for (const menu of settings.menuItems.filter((item) => item.enabled)) {
    const servings = meals * menu.expectedSalesRatio / 100
    const revenue = servings * menu.sellingPrice
    ratioTotal += menu.expectedSalesRatio
    menuRevenue += revenue
    menus.push({ id: menu.id, name: menu.name, servings, revenue })
    for (const source of menu.consumption) addDemand(settings, demand, source, source.quantity * servings)
  }

  for (const topping of settings.toppings.filter((item) => item.enabled)) {
    const orders = meals * topping.orderRate / 100
    toppingRevenue += orders * topping.sellingPrice
    for (const source of topping.consumption) addDemand(settings, demand, source, source.quantity * orders)
  }

  for (const source of demand.values()) {
    if (source.sourceType === 'resource') {
      addCosts(costs, costResource(settings, source.sourceId, source.quantity, source.unit, 'direct', trace))
    } else {
      const calculated = calculateOutputWithTrace(settings, source.sourceId, source.quantity, true, laborMode)
      addCosts(costs, calculated.costs)
      for (const detail of calculated.trace.resources.values()) {
        const current = trace.resources.get(detail.id)
        trace.resources.set(detail.id, current
          ? { ...current, quantity: current.quantity + detail.quantity, usageCost: current.usageCost + detail.usageCost }
          : detail)
      }
      for (const detail of calculated.trace.processes.values()) {
        const current = trace.processes.get(detail.id)
        trace.processes.set(detail.id, current ? {
          ...current,
          batches: current.batches + detail.batches,
          materialCost: current.materialCost + detail.materialCost,
          activeLaborMinutes: current.activeLaborMinutes + detail.activeLaborMinutes,
          laborAllocation: current.laborAllocation + detail.laborAllocation,
          additionalLaborCost: current.additionalLaborCost + detail.additionalLaborCost,
          marginalLaborCost: current.marginalLaborCost + detail.marginalLaborCost,
        } : detail)
      }
      trace.labor.prepLaborAllocation += calculated.trace.labor.prepLaborAllocation
      trace.labor.additionalPrepLaborCost += calculated.trace.labor.additionalPrepLaborCost
      trace.labor.marginalPrepLaborCost += calculated.trace.labor.marginalPrepLaborCost
      trace.waterL += calculated.trace.waterL
      trace.gasM3 += calculated.trace.gasM3
      trace.electricityKWh += calculated.trace.electricityKWh
    }
  }

  return { costs, revenue: menuRevenue + toppingRevenue, menuRevenue, toppingRevenue, ratioTotal, menus, trace, demand: [...demand.values()] }
}

/** Phase 8 planning forecast. It exposes quantities from the normal economic trace;
 * no independent recipe-cost formula is maintained by the planning engine. */
export const calculatePlanningRequirements = (settings: AppSettings, meals: number) => {
  const core = calculateOperatingCore(settings, Math.max(0, meals), 'accounting')
  const outputDemand = new Map<string, { outputId: string; quantity: number; unit: Unit }>()
  const addOutput = (outputId: string, quantity: number, unit: Unit, trail: Set<string>) => {
    const found = findProcessOutput(settings, outputId)
    if (!found || trail.has(outputId)) return
    const converted = tryConvertQuantity(quantity, unit, found.output.unit)
    if (converted === null) return
    const current = outputDemand.get(outputId)
    outputDemand.set(outputId, { outputId, quantity: (current?.quantity ?? 0) + converted, unit: found.output.unit })
    const outputPerBatch = found.process.outputs[0]?.id === outputId ? found.process.batchSize : found.output.quantity
    if (outputPerBatch <= 0) return
    const batches = converted / outputPerBatch
    const nextTrail = new Set(trail).add(outputId)
    for (const input of found.process.inputs.filter((source) => source.sourceType === 'output')) {
      addOutput(input.sourceId, input.quantity * batches, input.unit, nextTrail)
    }
  }
  core.demand.filter((source) => source.sourceType === 'output').forEach((source) => addOutput(source.sourceId, source.quantity, source.unit, new Set()))
  return {
    resources: [...core.trace.resources.values()],
    processes: [...core.trace.processes.values()],
    outputs: [...outputDemand.values()],
    menuRevenue: core.menuRevenue,
    totalRevenue: core.revenue,
  }
}

export const periodOperatingDays = (settings: AppSettings, period: PeriodKey) =>
  calculateCalendarSummary(settings, period).operatingDays

export const periodCalendarMonths = (settings: AppSettings, period: PeriodKey) =>
  calculateCalendarSummary(settings, period).calendarMonths

const calculateShiftLabor = (settings: AppSettings, operatingHours: number) => {
  if (operatingHours <= 0) return 0
  const baseHours = settings.business.hoursPerDay > 0 ? settings.business.hoursPerDay : 1
  return settings.labor.reduce((total, role) => (
    total + role.hourlyWage * role.headcount * role.hoursPerDay * operatingHours / baseHours
  ), 0)
}

export const simulateWithCalendar = (
  settings: AppSettings,
  calendar: CalendarSummary,
  period: SimulationResult['period'],
  mealsPerDay: number,
  inventoryOptions?: InventoryPeriodOptions,
): SimulationResult => {
  const core = calculateOperatingCore(settings, mealsPerDay, 'accounting')
  const inventoryEngine = simulateInventoryPeriod(settings, period === 'custom' ? 'month' : period, mealsPerDay, 'accounting', calendar, inventoryOptions)
  const costs = { ...inventoryEngine.costs }
  const meals = mealsPerDay * calendar.operatingDays
  const revenue = core.revenue * calendar.operatingDays

  const shiftLaborCost = calculateShiftLabor(settings, calendar.totalOperatingHours)
  costs.operatingLabor = shiftLaborCost

  const waterQuantity = calculateUtilityPeriodQuantity(settings.utilities.water, meals, calendar.operatingDays, calendar.totalOperatingHours, calendar.calendarDays)
  const gasQuantity = calculateUtilityPeriodQuantity(settings.utilities.gas, meals, calendar.operatingDays, calendar.totalOperatingHours, calendar.calendarDays)
  const electricityQuantity = calculateUtilityPeriodQuantity(settings.utilities.electricity, meals, calendar.operatingDays, calendar.totalOperatingHours, calendar.calendarDays)
  costs.water += waterQuantity * settings.utilities.water.unitPrice
  costs.gas += gasQuantity * settings.utilities.gas.unitPrice
  costs.electricity += electricityQuantity * settings.utilities.electricity.unitPrice

  const oilLiters = calculateAverageDailyOilLiters(settings, mealsPerDay) * calendar.operatingDays
  const inventoryManagedOil = !!settings.fryingOil.inventoryResourceId
  if (!inventoryManagedOil) costs.fryingOil += oilLiters * settings.fryingOil.unitPricePerL

  for (const item of settings.otherCosts) {
    if (item.behavior === 'perMeal') costs.other += item.amount * meals
    else if (item.behavior === 'perHour') costs.other += item.amount * calendar.totalOperatingHours
    else if (item.behavior === 'perDay') costs.other += item.amount * calendar.operatingDays
    else costs.fixedMonthly += item.amount * calendar.calendarMonths
  }

  costs.fixedMonthly += (
    settings.utilities.water.fixedChargePerMonth
    + settings.utilities.gas.fixedChargePerMonth
    + settings.utilities.electricity.fixedChargePerMonth
  ) * calendar.calendarMonths

  const prepLaborAllocation = inventoryEngine.labor.prepLaborAllocation
  const additionalPrepLaborCost = inventoryEngine.labor.additionalPrepLaborCost
  const marginalPrepLaborCost = inventoryEngine.labor.marginalPrepLaborCost
  const labor: LaborBreakdown = {
    shiftLaborCost,
    prepLaborAllocation,
    additionalPrepLaborCost,
    accountingLaborCost: shiftLaborCost + additionalPrepLaborCost,
    marginalPrepLaborCost,
  }

  const resourceDetails = inventoryEngine.resources
  const processOilLiters = resourceDetails.reduce((total, detail) => {
    const resource = settings.resources.find((item) => item.id === detail.id)
    if (resource?.category !== 'oil') return total
    return total + (tryConvertQuantity(detail.quantity, detail.unit, 'L') ?? 0)
  }, 0)

  const totalCost = sumCosts(costs)
  const foodCost = costs.directIngredients + costs.prepMaterials + costs.fryingOil + costs.waste
  const grossProfit = revenue - foodCost
  const operatingProfit = revenue - totalCost
  const operationalOilCost = inventoryManagedOil ? 0 : oilLiters * settings.fryingOil.unitPricePerL
  const globalUtilityCash = waterQuantity * settings.utilities.water.unitPrice
    + gasQuantity * settings.utilities.gas.unitPrice
    + electricityQuantity * settings.utilities.electricity.unitPrice
  const processUtilityCash = inventoryEngine.processCashUtilities.water
    + inventoryEngine.processCashUtilities.gas
    + inventoryEngine.processCashUtilities.electricity
  const simpleCashFlow = revenue
    - inventoryEngine.inventory.purchaseExpenditure
    - shiftLaborCost
    - inventoryEngine.processCashAdditionalLabor
    - globalUtilityCash
    - processUtilityCash
    - operationalOilCost
    - costs.other
    - costs.fixedMonthly
  const inventory = { ...inventoryEngine.inventory, simpleCashFlow }

  let marginalCostPerMeal = 0
  if (calendar.operatingDays > 0) {
    const nextCore = calculateOperatingCore(settings, mealsPerDay + 1, 'accounting')
    const coreDifference = sumCosts(nextCore.costs) - sumCosts(core.costs)
    const utilityDifference = settings.utilities.water.uses.reduce((sum, use) => sum + (use.behavior === 'perMeal' ? use.quantity : use.behavior === 'perUse' ? use.quantity * (use.usesPerMeal ?? 0) : 0), 0) * settings.utilities.water.unitPrice
      + settings.utilities.gas.uses.reduce((sum, use) => sum + (use.behavior === 'perMeal' ? use.quantity : use.behavior === 'perUse' ? use.quantity * (use.usesPerMeal ?? 0) : 0), 0) * settings.utilities.gas.unitPrice
      + settings.utilities.electricity.uses.reduce((sum, use) => sum + (use.behavior === 'perMeal' ? use.quantity : use.behavior === 'perUse' ? use.quantity * (use.usesPerMeal ?? 0) : 0), 0) * settings.utilities.electricity.unitPrice
    const otherDifference = settings.otherCosts.filter((item) => item.behavior === 'perMeal').reduce((sum, item) => sum + item.amount, 0)
    const oilUnitPrice = inventoryManagedOil && settings.fryingOil.inventoryResourceId
      ? getResourceCostForQuantity(settings, settings.fryingOil.inventoryResourceId, 1, 'L')
      : settings.fryingOil.unitPricePerL
    marginalCostPerMeal = Math.max(0, coreDifference + utilityDifference + settings.fryingOil.absorptionLPerMeal * oilUnitPrice + otherDifference)
  }

  const details: CalculationDetails = {
    meals,
    menus: core.menus.map((menu) => ({ ...menu, servings: menu.servings * calendar.operatingDays, revenue: menu.revenue * calendar.operatingDays })),
    resources: resourceDetails,
    processes: inventoryEngine.processes,
    utilities: {
      water: { quantity: waterQuantity + inventoryEngine.processes.reduce((sum, detail) => sum + (settings.processes.find((process) => process.id === detail.id)?.waterUsageL ?? 0) * detail.batches, 0), unit: 'L', usageCost: costs.water },
      gas: { quantity: gasQuantity + inventoryEngine.processes.reduce((sum, detail) => sum + (settings.processes.find((process) => process.id === detail.id)?.gasUsageM3 ?? 0) * detail.batches, 0), unit: 'm³', usageCost: costs.gas },
      electricity: { quantity: electricityQuantity + inventoryEngine.processes.reduce((sum, detail) => sum + (settings.processes.find((process) => process.id === detail.id)?.electricUsageKWh ?? 0) * detail.batches, 0), unit: 'kWh', usageCost: costs.electricity },
    },
    fryingOilLiters: inventoryManagedOil ? processOilLiters : oilLiters + processOilLiters,
    fryingOilCost: costs.fryingOil,
  }

  return {
    period,
    startDate: calendar.startDate,
    endDateExclusive: calendar.endDateExclusive,
    calendarDays: calendar.calendarDays,
    calendarMonths: calendar.calendarMonths,
    operatingDays: calendar.operatingDays,
    totalOperatingHours: calendar.totalOperatingHours,
    meals,
    revenue,
    menuRevenue: core.menuRevenue * calendar.operatingDays,
    toppingRevenue: core.toppingRevenue * calendar.operatingDays,
    costs,
    totalCost,
    grossProfit,
    operatingProfit,
    foodCostRate: revenue > 0 ? foodCost / revenue : 0,
    operatingMargin: revenue > 0 ? operatingProfit / revenue : 0,
    averageCostPerMeal: meals > 0 ? totalCost / meals : 0,
    profitPerOperatingDay: calendar.operatingDays > 0 ? operatingProfit / calendar.operatingDays : 0,
    profitPerOperatingHour: calendar.totalOperatingHours > 0 ? operatingProfit / calendar.totalOperatingHours : 0,
    marginalCostPerMeal,
    menuRatioTotal: core.ratioTotal,
    labor,
    details,
    inventory,
    inventoryShortages: inventoryEngine.shortages,
  }
}

export const simulate = (settings: AppSettings, period: PeriodKey, mealsPerDay = settings.business.mealsPerDay): SimulationResult => (
  simulateWithCalendar(settings, calculateCalendarSummary(settings, period), period, mealsPerDay)
)

export const simulateDateRange = (
  settings: AppSettings,
  startDate: string,
  endDateInclusive: string,
  mealsPerDay = settings.business.mealsPerDay,
  inventoryOptions?: InventoryPeriodOptions,
): SimulationResult | null => {
  const start = parseLocalDate(startDate)
  const end = parseLocalDate(endDateInclusive)
  if (!start || !end || end < start) return null
  const endExclusive = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1)
  return simulateWithCalendar(settings, calculateCalendarRange(settings, start, endExclusive), 'custom', mealsPerDay, inventoryOptions)
}

const outputQuantityInUnit = (settings: AppSettings, outputId: string, quantity: number, unit: Unit) => {
  const found = findProcessOutput(settings, outputId)
  return found ? tryConvertQuantity(quantity, unit, found.output.unit) : null
}

export const compareMakeBuy = (settings: AppSettings, laborCostMode: LaborCostMode = 'accounting'): MakeBuyResult => {
  const comparison = settings.makeBuyComparison
  const oneUnit = outputQuantityInUnit(settings, comparison.homemadeOutputId, 1, comparison.unit) ?? 0
  const homemade = calculateOutputWithTrace(settings, comparison.homemadeOutputId, oneUnit, false, laborCostMode)
  const homemadeUnitCost = sumCosts(homemade.costs)
  const purchasedUnitCost = getResourceCostForQuantity(settings, comparison.purchasedResourceId, 1, comparison.unit)
  const blendProcess = settings.processes.find((item) => item.id === comparison.blendProcessId)
  const blendOutput = blendProcess?.outputs[0]
  const blendOneUnit = blendOutput ? tryConvertQuantity(1, comparison.unit, blendOutput.unit) ?? 0 : 0
  const blended = blendOutput
    ? calculateOutputWithTrace(settings, blendOutput.id, blendOneUnit, false, laborCostMode)
    : { costs: emptyCosts(), trace: createTrace() }
  const blendedUnitCost = sumCosts(blended.costs)
  const operatingDays = periodOperatingDays(settings, 'month')
  const monthlyUsage = comparison.dailyUsage * operatingDays
  const homemadePlan = simulateInventorySourcePlan(settings, { sourceType: 'output', sourceId: comparison.homemadeOutputId, quantity: comparison.dailyUsage, unit: comparison.unit }, comparison.dailyUsage, laborCostMode)
  const purchasedPlan = simulateInventorySourcePlan(settings, { sourceType: 'resource', sourceId: comparison.purchasedResourceId, quantity: comparison.dailyUsage, unit: comparison.unit }, comparison.dailyUsage, laborCostMode)
  const blendedPlan = blendOutput
    ? simulateInventorySourcePlan(settings, { sourceType: 'output', sourceId: blendOutput.id, quantity: comparison.dailyUsage, unit: comparison.unit }, comparison.dailyUsage, laborCostMode)
    : { totalPeriodCost: 0, usageCost: 0, wasteCost: 0, endingInventoryValue: 0, purchaseExpenditure: 0, workHours: 0 }
  const homemadeMonthlyCost = homemadePlan.totalPeriodCost
  const purchasedMonthlyCost = purchasedPlan.totalPeriodCost
  const blendedMonthlyCost = blendedPlan.totalPeriodCost
  const monthlySavings = purchasedMonthlyCost - homemadeMonthlyCost
  const monthlyAdditionalHours = homemadePlan.workHours
  const usagePerMeal = comparison.dailyUsage / Math.max(1, settings.business.mealsPerDay)
  let breakEvenMealsPerDay: number | null = null

  for (let meals = 1; meals <= 500; meals += 1) {
    const dailyUsage = usagePerMeal * meals
    const outputQuantity = outputQuantityInUnit(settings, comparison.homemadeOutputId, dailyUsage, comparison.unit) ?? 0
    const makeCost = sumCosts(calculateProcessOutputCost(settings, comparison.homemadeOutputId, outputQuantity, true, laborCostMode))
    const buyCost = getResourceCostForQuantity(settings, comparison.purchasedResourceId, dailyUsage, comparison.unit)
    if (makeCost <= buyCost) {
      breakEvenMealsPerDay = meals
      break
    }
  }

  return {
    laborCostMode,
    homemadeUnitCost,
    purchasedUnitCost,
    blendedUnitCost,
    homemadeBreakdown: {
      prepMaterials: homemade.costs.prepMaterials,
      prepLabor: homemade.costs.prepLabor,
      water: homemade.costs.water,
      gas: homemade.costs.gas,
      electricity: homemade.costs.electricity,
      waste: homemade.costs.waste,
    },
    monthlyUsage,
    homemadeMonthlyCost,
    purchasedMonthlyCost,
    blendedMonthlyCost,
    monthlySavings,
    monthlyAdditionalHours,
    savingsPerWorkHour: monthlyAdditionalHours > 0 ? monthlySavings / monthlyAdditionalHours : 0,
    breakEvenMealsPerDay,
    homemadeLaborAllocation: homemade.trace.labor.prepLaborAllocation,
    homemadeMarginalLabor: homemade.trace.labor.marginalPrepLaborCost,
    homemadeWasteCost: homemadePlan.wasteCost,
    purchasedWasteCost: purchasedPlan.wasteCost,
    blendedWasteCost: blendedPlan.wasteCost,
    homemadeEndingInventoryValue: homemadePlan.endingInventoryValue,
    purchasedEndingInventoryValue: purchasedPlan.endingInventoryValue,
  }
}

export const createVolumeSeries = (settings: AppSettings) => {
  const values = []
  for (let meals = 10; meals <= 200; meals += 10) {
    const result = simulate(settings, 'day', meals)
    values.push({ meals, profit: result.operatingProfit, averageCost: result.averageCostPerMeal })
  }
  return values
}
