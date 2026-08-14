import type {
  AppSettings,
  InventoryLot,
  MultiDayDailyResult,
  MultiDayInventoryTimelineEntry,
  MultiDayMonteCarloResult,
  MultiDayMonteCarloRunSummary,
  MultiDayPrepTimelineEntry,
  MultiDaySimulationResult,
  OperatingPlanOverride,
  PurchaseOrder,
  Resource,
} from '../models/types'
import { planningSettingsFor } from '../data/planningDefaults'
import { calculateCalendarRange, formatLocalDate, parseLocalDate, scheduleHours } from './calendar'
import { calculateCapacityStaffCost, simulateCapacity } from './capacityEngine'
import { calculatePlanningRequirements, simulateDateRange } from './engine'
import { calculatePurchaseOrder } from './inventoryEngine'
import { calculateStatistics } from './monteCarloEngine'
import { simulateCustomerJourney } from './seatingEngine'
import { tryConvertQuantity } from './units'

const EPSILON = 1e-9

const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
const mondayFirstDay = (date: Date) => (date.getDay() + 6) % 7
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

const scaleDemandProfile = (settings: AppSettings, meals: number) => {
  const current = sum(settings.capacity.demandProfile.timeSlots.map((slot) => slot.meals))
  return {
    ...settings.capacity.demandProfile,
    timeSlots: settings.capacity.demandProfile.timeSlots.map((slot) => ({
      ...slot,
      meals: current > 0 ? slot.meals * meals / current : 0,
    })),
  }
}

const scaleArrivalProfile = (settings: AppSettings, guests: number) => {
  const current = sum(settings.capacity.stochasticDemand.arrivalProfile.slots.map((slot) => slot.expectedGuests))
  return {
    ...settings.capacity.stochasticDemand.arrivalProfile,
    slots: settings.capacity.stochasticDemand.arrivalProfile.slots.map((slot) => ({
      ...slot,
      expectedGuests: current > 0 ? slot.expectedGuests * guests / current : 0,
    })),
  }
}

const mergePlanOverride = (weekday: OperatingPlanOverride | undefined, dated: OperatingPlanOverride | undefined): OperatingPlanOverride => ({
  ...weekday,
  ...dated,
  staffHeadcountOverrides: { ...weekday?.staffHeadcountOverrides, ...dated?.staffHeadcountOverrides },
  manualPrepBatches: { ...weekday?.manualPrepBatches, ...dated?.manualPrepBatches },
})

export const resolveDailyOperatingSettings = (settings: AppSettings, date: Date): AppSettings => {
  const planning = planningSettingsFor(settings)
  const dateString = formatLocalDate(date)
  const day = mondayFirstDay(date)
  const weekday = planning.weekdayTemplates.find((template) => template.day === day)
  const dated = planning.dailyOperatingPlans.find((plan) => plan.date === dateString)
  const override = mergePlanOverride(weekday, dated)
  const baseSchedule = settings.business.weekdays.find((schedule) => schedule.day === day)
  const enabled = override.enabled ?? baseSchedule?.enabled ?? false
  const openingTime = override.openingTime ?? baseSchedule?.openingTime ?? settings.business.openingTime
  const closingTime = override.closingTime ?? baseSchedule?.closingTime ?? settings.business.closingTime
  const mealsPerDay = Math.max(0, override.mealsPerDay ?? settings.business.mealsPerDay)
  const demandProfile = override.demandProfile ?? scaleDemandProfile(settings, mealsPerDay)
  const arrivalProfile = override.arrivalProfile ?? scaleArrivalProfile(settings, mealsPerDay)
  const business = {
    ...settings.business,
    simulationStartDate: dateString,
    openingTime,
    closingTime,
    hoursPerDay: enabled ? scheduleHours({ openingTime, closingTime }) : 0,
    mealsPerDay: enabled ? mealsPerDay : 0,
    weekdays: settings.business.weekdays.map((schedule) => schedule.day === day
      ? { ...schedule, enabled, openingTime, closingTime }
      : schedule),
  }
  return {
    ...settings,
    business,
    capacity: {
      ...settings.capacity,
      demandProfile: enabled ? demandProfile : { ...demandProfile, timeSlots: demandProfile.timeSlots.map((slot) => ({ ...slot, meals: 0 })) },
      staffShifts: settings.capacity.staffShifts.map((shift) => ({
        ...shift,
        headcount: Math.max(0, override.staffHeadcountOverrides?.[shift.id] ?? shift.headcount),
      })),
      stochasticDemand: {
        ...settings.capacity.stochasticDemand,
        arrivalProfile: enabled ? arrivalProfile : { ...arrivalProfile, slots: arrivalProfile.slots.map((slot) => ({ ...slot, expectedGuests: 0 })) },
      },
    },
  }
}

export const deriveMultiDaySeed = (baseSeed: number, runIndex: number, dayIndex: number) => {
  let value = (Math.trunc(baseSeed) ^ Math.imul(runIndex + 1, 0x9e3779b1) ^ Math.imul(dayIndex + 1, 0x85ebca6b)) >>> 0
  value ^= value >>> 16
  value = Math.imul(value, 0x7feb352d)
  value ^= value >>> 15
  value = Math.imul(value, 0x846ca68b)
  value ^= value >>> 16
  return value >>> 0
}

const availableResourceQuantity = (lots: InventoryLot[], resource: Resource) => lots.reduce((total, lot) => {
  if (lot.sourceType !== 'resource' || lot.sourceId !== resource.id) return total
  return total + (tryConvertQuantity(lot.quantity, lot.unit, resource.purchaseUnit) ?? 0)
}, 0)

const openingLotsFrom = (lots: InventoryLot[]): AppSettings['inventory']['openingLots'] => lots.map((lot) => ({
  id: lot.id,
  sourceType: lot.sourceType,
  sourceId: lot.sourceId,
  quantity: lot.quantity,
  unit: lot.unit,
  acquiredDate: lot.acquiredDate,
  expiryDate: lot.expiryDate,
  unitCost: lot.unitCost,
  costComponents: lot.costComponents,
  source: lot.source,
}))

const purchaseLot = (order: PurchaseOrder, resource: Resource): InventoryLot => ({
  id: `delivery-${order.id}`,
  sourceType: 'resource',
  sourceId: resource.id,
  quantity: order.quantity,
  unit: resource.purchaseUnit,
  acquiredDate: order.deliveryDate,
  expiryDate: resource.shelfLifeDays > 0
    ? formatLocalDate(addDays(parseLocalDate(order.deliveryDate) ?? new Date(), resource.shelfLifeDays))
    : undefined,
  unitCost: order.quantity > 0 ? order.cost / order.quantity : 0,
  purchaseCost: order.cost,
  source: 'purchase',
})

const orderFromPackages = (resource: Resource, orderedDate: string, packageCount: number, automatic: boolean): PurchaseOrder => ({
  id: `${automatic ? 'auto' : 'manual'}-${orderedDate}-${resource.id}-${packageCount}`,
  resourceId: resource.id,
  orderedDate,
  deliveryDate: formatLocalDate(addDays(parseLocalDate(orderedDate) ?? new Date(), Math.max(0, resource.procurementLeadTimeDays ?? 0))),
  packageCount,
  quantity: packageCount * resource.purchaseQuantity * resource.yieldRate,
  cost: packageCount * resource.purchasePrice,
  status: 'pending',
  automatic,
})

const expectedResourceDemand = (settings: AppSettings, resourceId: string, date: Date, days: number) => {
  let required = 0
  for (let offset = 0; offset <= days; offset += 1) {
    const daily = resolveDailyOperatingSettings(settings, addDays(date, offset))
    if (daily.business.mealsPerDay <= 0) continue
    const detail = calculatePlanningRequirements(daily, daily.business.mealsPerDay).resources.find((item) => item.id === resourceId)
    required += detail?.quantity ?? 0
  }
  return required
}

const autoPurchaseOrders = (
  settings: AppSettings,
  date: Date,
  lots: InventoryLot[],
  pending: PurchaseOrder[],
) => settings.resources.flatMap((resource) => {
  const lead = Math.max(0, resource.procurementLeadTimeDays ?? 0)
  if (lead === 0) return []
  const lookahead = Math.max(lead, resource.procurementLookaheadDays ?? 0)
  const required = expectedResourceDemand(settings, resource.id, date, lookahead)
  const current = availableResourceQuantity(lots, resource)
  const incoming = pending.filter((order) => order.resourceId === resource.id && order.status === 'pending')
    .reduce((total, order) => total + order.quantity, 0)
  const calculation = calculatePurchaseOrder(resource, current + incoming, required)
  return calculation.packages > 0
    ? [orderFromPackages(resource, formatLocalDate(date), calculation.packages, true)]
    : []
})

const manualOrdersForDate = (settings: AppSettings, date: string) => planningSettingsFor(settings).purchaseOrders
  .filter((order) => order.orderedDate === date && order.status !== 'cancelled')
  .map((order) => ({ ...order, status: 'pending' as const }))

const prepTargetsForDate = (settings: AppSettings, date: Date, currentLots: InventoryLot[]) => {
  const planning = planningSettingsFor(settings)
  const override = mergePlanOverride(
    planning.weekdayTemplates.find((template) => template.day === mondayFirstDay(date)),
    planning.dailyOperatingPlans.find((plan) => plan.date === formatLocalDate(date)),
  )
  const operatingSettings = resolveDailyOperatingSettings(settings, date)
  if (operatingSettings.business.hoursPerDay <= 0) return []
  return settings.processes.flatMap((process) => {
    const output = process.outputs[0]
    if (!output) return []
    const safeLookahead = Math.min(Math.max(0, process.prepLookaheadDays ?? 0), Math.max(0, output.shelfLifeDays - 1))
    let totalMeals = 0
    for (let offset = 0; offset <= safeLookahead; offset += 1) totalMeals += resolveDailyOperatingSettings(settings, addDays(date, offset)).business.mealsPerDay
    const forecast = calculatePlanningRequirements(operatingSettings, totalMeals).outputs.find((item) => item.outputId === output.id)
    const automaticTarget = forecast?.quantity ?? 0
    const current = currentLots.reduce((total, lot) => lot.sourceType === 'output' && lot.sourceId === output.id
      ? total + (tryConvertQuantity(lot.quantity, lot.unit, output.unit) ?? 0)
      : total, 0)
    const manualTarget = current + Math.max(0, override.manualPrepBatches?.[process.id] ?? 0) * process.batchSize
    const targetQuantity = Math.max(automaticTarget, manualTarget)
    return targetQuantity > EPSILON ? [{ outputId: output.id, targetQuantity, unit: output.unit }] : []
  })
}

const settingsWithMenuIds = (settings: AppSettings, menuIds: string[]) => {
  const counts = new Map<string, number>()
  menuIds.forEach((id) => counts.set(id, (counts.get(id) ?? 0) + 1))
  const total = menuIds.length
  return {
    ...settings,
    menuItems: settings.menuItems.map((menu) => ({
      ...menu,
      enabled: total > 0 && (counts.get(menu.id) ?? 0) > 0,
      expectedSalesRatio: total > 0 ? (counts.get(menu.id) ?? 0) / total * 100 : 0,
    })),
  }
}

const simulateInventoryConstrainedDay = (
  settings: AppSettings,
  date: string,
  menuIds: string[],
  openingLots: InventoryLot[],
  prepTargets: ReturnType<typeof prepTargetsForDate>,
) => {
  const evaluate = (count: number) => simulateDateRange({
    ...settingsWithMenuIds(settings, menuIds.slice(0, count)),
    inventory: { ...settings.inventory, openingLots: openingLotsFrom(openingLots) },
  }, date, date, count, {
    canPurchaseResource: (resource) => Math.max(0, resource.procurementLeadTimeDays ?? 0) === 0,
    prepTargetsByDate: { [date]: prepTargets },
  })!

  const fullTrial = evaluate(menuIds.length)
  const fullSaleShortage = (fullTrial.inventoryShortages ?? []).some((shortage) => shortage.purpose === 'sale')
  if (!fullSaleShortage) return { realizedCount: menuIds.length, simulation: fullTrial, shortages: fullTrial.inventoryShortages ?? [] }
  let low = 0
  let high = menuIds.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const trial = evaluate(middle)
    const saleShortage = (trial.inventoryShortages ?? []).some((shortage) => shortage.purpose === 'sale')
    if (saleShortage) high = middle - 1
    else low = middle
  }
  return { realizedCount: low, simulation: evaluate(low), shortages: fullTrial.inventoryShortages ?? [] }
}

const adjustShiftLabor = (settings: AppSettings, result: ReturnType<typeof simulateDateRange>, operating: boolean) => {
  if (!result) throw new Error('日次Simulationを生成できませんでした。')
  const staffCost = operating ? calculateCapacityStaffCost(settings) : 0
  const adjustment = staffCost - result.labor.shiftLaborCost
  const costs = { ...result.costs, operatingLabor: staffCost }
  const totalCost = result.totalCost + adjustment
  const operatingProfit = result.operatingProfit - adjustment
  return {
    ...result,
    costs,
    totalCost,
    operatingProfit,
    operatingMargin: result.revenue > 0 ? operatingProfit / result.revenue : 0,
    averageCostPerMeal: result.meals > 0 ? totalCost / result.meals : 0,
    profitPerOperatingDay: result.operatingDays > 0 ? operatingProfit / result.operatingDays : 0,
    profitPerOperatingHour: result.totalOperatingHours > 0 ? operatingProfit / result.totalOperatingHours : 0,
    labor: {
      ...result.labor,
      shiftLaborCost: staffCost,
      accountingLaborCost: staffCost + result.labor.additionalPrepLaborCost,
    },
    inventory: { ...result.inventory, simpleCashFlow: result.inventory.simpleCashFlow - adjustment },
  }
}

export interface MultiDaySimulationOptions {
  horizonDays?: number
  baseSeed?: number
  runIndex?: number
  stochastic?: boolean
  onProgress?: (completedDays: number, totalDays: number) => void
}

export const simulateMultiDay = (settings: AppSettings, options: MultiDaySimulationOptions = {}): MultiDaySimulationResult => {
  const planning = planningSettingsFor(settings)
  const horizonDays = Math.max(1, Math.min(planning.hardMaximumDays, Math.trunc(options.horizonDays ?? planning.horizonDays)))
  const start = parseLocalDate(settings.business.simulationStartDate) ?? new Date()
  const initialLots = settings.inventory.openingLots.flatMap((opening): InventoryLot[] => {
    const source = opening.sourceType === 'resource'
      ? settings.resources.find((resource) => resource.id === opening.sourceId)
      : settings.processes.flatMap((process) => process.outputs).find((output) => output.id === opening.sourceId)
    if (!source || opening.quantity <= 0) return []
    const unit = 'purchaseUnit' in source ? source.purchaseUnit : source.unit
    const quantity = tryConvertQuantity(opening.quantity, opening.unit, unit)
    if (quantity === null) return []
    const fallbackUnitCost = 'purchasePrice' in source && source.purchaseQuantity > 0 && source.yieldRate > 0
      ? source.purchasePrice / (source.purchaseQuantity * source.yieldRate)
      : 0
    return [{
      id: opening.id,
      sourceType: opening.sourceType,
      sourceId: opening.sourceId,
      quantity,
      unit,
      acquiredDate: opening.acquiredDate || formatLocalDate(start),
      expiryDate: opening.expiryDate,
      unitCost: opening.unitCost ?? fallbackUnitCost,
      purchaseCost: quantity * (opening.unitCost ?? fallbackUnitCost),
      source: opening.source ?? 'openingInventory',
      costComponents: opening.costComponents,
    }]
  })
  let lots = initialLots
  let pending = planning.purchaseOrders.filter((order) => order.status === 'pending' && order.orderedDate < formatLocalDate(start)).map((order) => ({ ...order }))
  const allOrders: PurchaseOrder[] = []
  const dailyResults: MultiDayDailyResult[] = []
  const inventoryTimeline: MultiDayInventoryTimelineEntry[] = []
  const prepTimeline: MultiDayPrepTimelineEntry[] = []
  const warnings: string[] = []

  for (let dayIndex = 0; dayIndex < horizonDays; dayIndex += 1) {
    const date = addDays(start, dayIndex)
    const dateString = formatLocalDate(date)
    const dailySettings = resolveDailyOperatingSettings(settings, date)
    const schedule = dailySettings.business.weekdays.find((item) => item.day === mondayFirstDay(date))!
    const operating = schedule.enabled && scheduleHours(schedule) > 0
    const placedOrders = [...manualOrdersForDate(settings, dateString), ...autoPurchaseOrders(settings, date, lots, pending)]
    pending.push(...placedOrders)
    allOrders.push(...placedOrders)
    const deliveredOrders = pending.filter((order) => order.deliveryDate <= dateString && order.status === 'pending')
      .map((order) => ({ ...order, status: 'delivered' as const }))
    const deliveredIds = new Set(deliveredOrders.map((order) => order.id))
    pending = pending.filter((order) => !deliveredIds.has(order.id))
    for (const order of deliveredOrders) {
      const resource = settings.resources.find((item) => item.id === order.resourceId)
      if (resource && order.quantity > 0) lots.push(purchaseLot(order, resource))
    }

    const daySeed = deriveMultiDaySeed(options.baseSeed ?? planning.baseSeed, options.runIndex ?? 0, dayIndex)
    let completedMenuIds: string[] = []
    let demandMeals = 0
    let averageWaitMinutes = 0
    let serviceLevel = 1
    let abandonmentRate = 0
    if (operating) {
      if (options.stochastic ?? dailySettings.capacity.demandMode === 'stochastic') {
        const journey = simulateCustomerJourney(dailySettings, daySeed)
        completedMenuIds = journey.capacity.orders.filter((order) => order.status === 'completed').map((order) => order.menuItemId)
        demandMeals = journey.arrivedGuests
        averageWaitMinutes = journey.averageKitchenWaitMinutes
        serviceLevel = journey.capacity.withinTargetRate
        abandonmentRate = journey.abandonmentRate
      } else {
        const capacity = simulateCapacity(dailySettings)
        completedMenuIds = capacity.orders.filter((order) => order.status === 'completed').map((order) => order.menuItemId)
        demandMeals = capacity.totalOrders
        averageWaitMinutes = capacity.averageWaitMinutes
        serviceLevel = capacity.withinTargetRate
      }
    }

    const prepTargets = prepTargetsForDate(settings, date, lots)
    const constrained = simulateInventoryConstrainedDay(dailySettings, dateString, completedMenuIds, lots, prepTargets)
    const simulation = adjustShiftLabor(dailySettings, constrained.simulation, operating)
    const immediateOrders: PurchaseOrder[] = simulation.inventory.purchases.map((purchase) => ({
      id: `immediate-${purchase.id}`,
      resourceId: purchase.resourceId,
      orderedDate: purchase.date,
      deliveryDate: purchase.date,
      packageCount: purchase.packages,
      quantity: purchase.stockedQuantity,
      cost: purchase.expenditure,
      status: 'delivered',
      automatic: true,
    }))
    allOrders.push(...immediateOrders)
    const dayDeliveredOrders = [...deliveredOrders, ...immediateOrders]
    const lostMenuIds = completedMenuIds.slice(constrained.realizedCount)
    const lostRevenue = lostMenuIds.reduce((total, id) => total + (settings.menuItems.find((menu) => menu.id === id)?.sellingPrice ?? 0), 0)
    const deliveredExpenditure = sum(deliveredOrders.map((order) => order.cost))
    const simpleCashFlow = simulation.inventory.simpleCashFlow - deliveredExpenditure
    const inventoryAdjustedServiceLevel = demandMeals > 0 ? serviceLevel * constrained.realizedCount / demandMeals : 1
    lots = simulation.inventory.endingLots
    const stockout = completedMenuIds.length > constrained.realizedCount ? [{
      date: dateString,
      resourceIds: [...new Set(constrained.shortages.filter((item) => item.purpose === 'sale' || item.purpose === 'production').map((item) => item.sourceId))],
      menuItemIds: [...new Set(lostMenuIds)],
      lostMeals: completedMenuIds.length - constrained.realizedCount,
      lostRevenue,
      shortages: constrained.shortages,
    }] : []
    const daily: MultiDayDailyResult & { abandonmentRate?: number } = {
      date: dateString,
      day: mondayFirstDay(date),
      operating,
      openingTime: schedule.openingTime,
      closingTime: schedule.closingTime,
      demandMeals,
      capacityCompletedMeals: completedMenuIds.length,
      realizedMeals: constrained.realizedCount,
      lostMeals: completedMenuIds.length - constrained.realizedCount,
      lostRevenue,
      revenue: simulation.revenue,
      usageCost: simulation.inventory.usageCost,
      laborCost: simulation.labor.accountingLaborCost,
      operatingProfit: simulation.operatingProfit,
      purchaseExpenditure: simulation.inventory.purchaseExpenditure + deliveredExpenditure,
      wasteCost: simulation.inventory.wasteCost,
      endingInventoryValue: simulation.inventory.endingInventoryValue,
      averageWaitMinutes,
      serviceLevel: inventoryAdjustedServiceLevel,
      inventory: { ...simulation.inventory, purchaseExpenditure: simulation.inventory.purchaseExpenditure + deliveredExpenditure, simpleCashFlow },
      simulation: { ...simulation, inventory: { ...simulation.inventory, purchaseExpenditure: simulation.inventory.purchaseExpenditure + deliveredExpenditure, simpleCashFlow } },
      stockouts: stockout,
      deliveredOrders: dayDeliveredOrders,
      placedOrders,
      abandonmentRate,
    }
    dailyResults.push(daily)

    for (const item of simulation.inventory.items) {
      const movement = item.dailyMovements[0]
      const deliveredQuantity = deliveredOrders.filter((order) => order.resourceId === item.sourceId).reduce((total, order) => total + order.quantity, 0)
      const pendingQuantity = pending.filter((order) => order.resourceId === item.sourceId).reduce((total, order) => total + order.quantity, 0)
      inventoryTimeline.push({
        date: dateString,
        sourceType: item.sourceType,
        sourceId: item.sourceId,
        name: item.name,
        unit: item.unit,
        openingQuantity: Math.max(0, (movement?.openingQuantity ?? item.openingQuantity) - deliveredQuantity),
        deliveredQuantity: deliveredQuantity + (movement?.purchasedQuantity ?? 0),
        producedQuantity: movement?.producedQuantity ?? 0,
        byProductQuantity: movement?.byProductQuantity ?? 0,
        consumedQuantity: movement?.consumedQuantity ?? 0,
        wastedQuantity: movement?.wastedQuantity ?? 0,
        endingQuantity: movement?.endingQuantity ?? item.endingQuantity,
        pendingQuantity,
      })
    }
    for (const detail of simulation.details.processes) {
      const process = settings.processes.find((item) => item.id === detail.id)
      const output = process?.outputs[0]
      const inventoryItem = output ? simulation.inventory.items.find((item) => item.sourceType === 'output' && item.sourceId === output.id) : undefined
      prepTimeline.push({
        date: dateString,
        processId: detail.id,
        processName: detail.name,
        batches: detail.batches,
        producedQuantity: (process?.batchSize ?? 0) * detail.batches,
        consumedQuantity: inventoryItem?.dailyMovements[0]?.consumedQuantity ?? 0,
        endingQuantity: inventoryItem?.endingQuantity ?? 0,
        activeLaborMinutes: detail.activeLaborMinutes,
      })
    }
    if (stockout.length > 0) warnings.push(`${dateString}: 欠品により${stockout[0].lostMeals}食、${Math.round(lostRevenue).toLocaleString('ja-JP')}円の売上機会を失いました。`)
    if (simulation.inventory.wasteCost > 0) warnings.push(`${dateString}: 廃棄原価${Math.round(simulation.inventory.wasteCost).toLocaleString('ja-JP')}円が発生しました。`)
    options.onProgress?.(dayIndex + 1, horizonDays)
  }

  const openingInventoryValue = initialLots.reduce((total, lot) => total + lot.quantity * lot.unitCost, 0)
  const operatingProfit = sum(dailyResults.map((day) => day.operatingProfit))
  const operatingResults = dailyResults.filter((day) => day.operating)
  return {
    startDate: formatLocalDate(start),
    endDateExclusive: formatLocalDate(addDays(start, horizonDays)),
    horizonDays,
    operatingDays: dailyResults.filter((day) => day.operating).length,
    demandMeals: sum(dailyResults.map((day) => day.demandMeals)),
    capacityCompletedMeals: sum(dailyResults.map((day) => day.capacityCompletedMeals)),
    realizedMeals: sum(dailyResults.map((day) => day.realizedMeals)),
    stockoutLostMeals: sum(dailyResults.map((day) => day.lostMeals)),
    stockoutLostRevenue: sum(dailyResults.map((day) => day.lostRevenue)),
    revenue: sum(dailyResults.map((day) => day.revenue)),
    usageCost: sum(dailyResults.map((day) => day.usageCost)),
    laborCost: sum(dailyResults.map((day) => day.laborCost)),
    operatingProfit,
    simpleCashFlow: sum(dailyResults.map((day) => day.inventory.simpleCashFlow)),
    purchaseExpenditure: sum(dailyResults.map((day) => day.purchaseExpenditure)),
    wasteCost: sum(dailyResults.map((day) => day.wasteCost)),
    openingInventoryValue,
    endingInventoryValue: lots.reduce((total, lot) => total + lot.quantity * lot.unitCost, 0),
    averageWaitMinutes: operatingResults.length ? sum(operatingResults.map((day) => day.averageWaitMinutes)) / operatingResults.length : 0,
    serviceLevel: operatingResults.length ? sum(operatingResults.map((day) => day.serviceLevel)) / operatingResults.length : 1,
    purchaseCount: sum(dailyResults.map((day) => day.deliveredOrders.length)),
    stockoutDays: dailyResults.filter((day) => day.stockouts.length > 0).length,
    dailyResults,
    endingLots: lots,
    pendingOrders: pending,
    purchaseOrders: allOrders,
    inventoryTimeline,
    prepTimeline,
    warnings: [...new Set(warnings)],
  }
}

const monteCarloSummary = (runIndex: number, seed: number, result: MultiDaySimulationResult): MultiDayMonteCarloRunSummary => ({
  runIndex,
  seed,
  revenue: result.revenue,
  realizedMeals: result.realizedMeals,
  operatingProfit: result.operatingProfit,
  simpleCashFlow: result.simpleCashFlow,
  wasteCost: result.wasteCost,
  stockoutDays: result.stockoutDays,
  stockoutLostMeals: result.stockoutLostMeals,
  stockoutLostRevenue: result.stockoutLostRevenue,
  abandonmentRate: result.demandMeals > 0 ? Math.max(0, result.demandMeals - result.capacityCompletedMeals) / result.demandMeals : 0,
  averageWaitMinutes: result.averageWaitMinutes,
  endingInventoryValue: result.endingInventoryValue,
})

const aggregateMonteCarlo = (runs: number, baseSeed: number, horizonDays: number, summaries: MultiDayMonteCarloRunSummary[], targetProfit: number): MultiDayMonteCarloResult => {
  const values = <K extends keyof MultiDayMonteCarloRunSummary>(key: K) => summaries.map((summary) => Number(summary[key]))
  return {
    runs,
    baseSeed,
    horizonDays,
    summaries,
    statistics: {
      revenue: calculateStatistics(values('revenue')),
      realizedMeals: calculateStatistics(values('realizedMeals')),
      operatingProfit: calculateStatistics(values('operatingProfit')),
      simpleCashFlow: calculateStatistics(values('simpleCashFlow')),
      wasteCost: calculateStatistics(values('wasteCost')),
      stockoutDays: calculateStatistics(values('stockoutDays')),
      stockoutLostMeals: calculateStatistics(values('stockoutLostMeals')),
      stockoutLostRevenue: calculateStatistics(values('stockoutLostRevenue')),
      abandonmentRate: calculateStatistics(values('abandonmentRate')),
      averageWaitMinutes: calculateStatistics(values('averageWaitMinutes')),
      endingInventoryValue: calculateStatistics(values('endingInventoryValue')),
    },
    lossPeriodRate: summaries.filter((summary) => summary.operatingProfit < 0).length / Math.max(1, summaries.length),
    targetProfitProbability: summaries.filter((summary) => summary.operatingProfit >= targetProfit).length / Math.max(1, summaries.length),
  }
}

export const runMultiDayMonteCarlo = (settings: AppSettings, requestedRuns = planningSettingsFor(settings).monteCarloRuns, baseSeed = planningSettingsFor(settings).baseSeed, horizonDays = planningSettingsFor(settings).horizonDays) => {
  if (!Number.isInteger(requestedRuns) || requestedRuns <= 0 || requestedRuns > 1_000) throw new Error('複数日Monte Carlo run数は1〜1,000にしてください。')
  const summaries = Array.from({ length: requestedRuns }, (_, runIndex) => monteCarloSummary(
    runIndex,
    deriveMultiDaySeed(baseSeed, runIndex, 0),
    simulateMultiDay(settings, { horizonDays, baseSeed, runIndex, stochastic: true }),
  ))
  return aggregateMonteCarlo(requestedRuns, baseSeed, horizonDays, summaries, planningSettingsFor(settings).targetProfit)
}

export const runMultiDayMonteCarloAsync = async (
  settings: AppSettings,
  requestedRuns = planningSettingsFor(settings).monteCarloRuns,
  baseSeed = planningSettingsFor(settings).baseSeed,
  horizonDays = planningSettingsFor(settings).horizonDays,
  onProgress?: (completed: number, total: number) => void,
  shouldCancel?: () => boolean,
) => {
  if (!Number.isInteger(requestedRuns) || requestedRuns <= 0 || requestedRuns > 1_000) throw new Error('複数日Monte Carlo run数は1〜1,000にしてください。')
  const summaries: MultiDayMonteCarloRunSummary[] = []
  for (let runIndex = 0; runIndex < requestedRuns; runIndex += 1) {
    if (shouldCancel?.()) throw new Error('複数日Monte Carloをキャンセルしました。')
    summaries.push(monteCarloSummary(runIndex, deriveMultiDaySeed(baseSeed, runIndex, 0), simulateMultiDay(settings, { horizonDays, baseSeed, runIndex, stochastic: true })))
    onProgress?.(runIndex + 1, requestedRuns)
    if ((runIndex + 1) % 2 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  return aggregateMonteCarlo(requestedRuns, baseSeed, horizonDays, summaries, planningSettingsFor(settings).targetProfit)
}

export const multiDayCalendar = (settings: AppSettings, horizonDays = planningSettingsFor(settings).horizonDays) => {
  const start = parseLocalDate(settings.business.simulationStartDate) ?? new Date()
  return calculateCalendarRange(settings, start, addDays(start, horizonDays))
}
