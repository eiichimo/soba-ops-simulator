import type {
  AppSettings,
  CostBreakdown,
  MakeBuyResult,
  LaborCostResult,
  PeriodKey,
  SimulationResult,
  SourceRef,
  UtilityConfig,
} from '../models/types'

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
  if (!resource) return 0
  const usable = resource.purchaseQuantity * Math.max(0.0001, resource.yieldRate)
  return resource.purchasePrice / usable
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

const costResource = (settings: AppSettings, resourceId: string, quantity: number, context: 'direct' | 'prep') => {
  const costs = emptyCosts()
  const resource = settings.resources.find((item) => item.id === resourceId)
  if (!resource) return costs
  const amount = getResourceUnitCost(settings, resourceId) * quantity
  if (resource.category === 'oil') costs.fryingOil = amount
  else if (context === 'direct') costs.directIngredients = amount
  else costs.prepMaterials = amount
  return costs
}

const processOutputCost = (
  settings: AppSettings,
  outputId: string,
  requestedQuantity: number,
  roundBatches: boolean,
  trail: Set<string>,
): CostBreakdown => {
  const found = findProcessOutput(settings, outputId)
  const outputPerBatch = found && found.process.outputs[0]?.id === found.output.id
    ? found.process.batchSize
    : found?.output.quantity ?? 0
  if (!found || requestedQuantity <= 0 || outputPerBatch <= 0) return emptyCosts()
  // 編集途中の循環参照は画面を停止させず、この枝を未計上として扱う。
  if (trail.has(outputId)) return emptyCosts()

  const nextTrail = new Set(trail).add(outputId)
  const batches = roundBatches
    ? calculateBatchCount(requestedQuantity, outputPerBatch)
    : requestedQuantity / outputPerBatch
  const costs = emptyCosts()

  for (const recipeInput of found.process.inputs) {
    const required = recipeInput.quantity * batches
    const inputCosts = recipeInput.sourceType === 'resource'
      ? costResource(settings, recipeInput.sourceId, required, 'prep')
      : processOutputCost(settings, recipeInput.sourceId, required, roundBatches, nextTrail)
    addCosts(costs, inputCosts)
  }

  const role = settings.labor.find((item) => item.id === found.process.laborRole)
  costs.prepLabor += calculateLaborCost(role?.hourlyWage ?? 0, found.process.activeLaborMinutes * batches)
  costs.water += found.process.waterUsageL * batches * settings.utilities.water.unitPrice
  costs.gas += found.process.gasUsageM3 * batches * settings.utilities.gas.unitPrice
  costs.electricity += found.process.electricUsageKWh * batches * settings.utilities.electricity.unitPrice

  const newlyWasted = costs.prepMaterials * Math.min(1, Math.max(0, found.process.wasteRate))
  costs.prepMaterials -= newlyWasted
  costs.waste += newlyWasted

  return scaleCosts(costs, found.output.costAllocation)
}

export const calculateProcessOutputCost = (
  settings: AppSettings,
  outputId: string,
  requestedQuantity = 1,
  roundBatches = true,
) => processOutputCost(settings, outputId, requestedQuantity, roundBatches, new Set())

export const calculateSourceCost = (
  settings: AppSettings,
  source: SourceRef,
  requiredQuantity: number,
  roundBatches = true,
) => source.sourceType === 'resource'
  ? costResource(settings, source.sourceId, requiredQuantity, 'direct')
  : calculateProcessOutputCost(settings, source.sourceId, requiredQuantity, roundBatches)

const addDemand = (demand: Map<string, SourceRef>, source: SourceRef, quantity: number) => {
  const key = `${source.sourceType}:${source.sourceId}`
  const current = demand.get(key)
  demand.set(key, current ? { ...current, quantity: current.quantity + quantity } : { ...source, quantity })
}

const calculateOperatingDay = (settings: AppSettings, meals: number) => {
  const costs = emptyCosts()
  const demand = new Map<string, SourceRef>()
  let menuRevenue = 0
  let toppingRevenue = 0
  let ratioTotal = 0

  for (const menu of settings.menuItems.filter((item) => item.enabled)) {
    const servings = meals * menu.expectedSalesRatio / 100
    ratioTotal += menu.expectedSalesRatio
    menuRevenue += servings * menu.sellingPrice
    for (const source of menu.consumption) addDemand(demand, source, source.quantity * servings)
  }

  for (const topping of settings.toppings.filter((item) => item.enabled)) {
    const orders = meals * topping.orderRate / 100
    toppingRevenue += orders * topping.sellingPrice
    for (const source of topping.consumption) addDemand(demand, source, source.quantity * orders)
  }

  for (const source of demand.values()) addCosts(costs, calculateSourceCost(settings, source, source.quantity, true))

  costs.operatingLabor = settings.labor.reduce(
    (total, role) => total + role.hourlyWage * role.headcount * role.hoursPerDay,
    0,
  )
  costs.water += calculateUtilityDailyCost(settings.utilities.water, meals, settings.business.hoursPerDay)
  costs.gas += calculateUtilityDailyCost(settings.utilities.gas, meals, settings.business.hoursPerDay)
  costs.electricity += calculateUtilityDailyCost(settings.utilities.electricity, meals, settings.business.hoursPerDay)
  costs.fryingOil += calculateAverageDailyOilLiters(settings, meals) * settings.fryingOil.unitPricePerL

  for (const item of settings.otherCosts) {
    if (item.behavior === 'perMeal') costs.other += item.amount * meals
    else if (item.behavior === 'perHour') costs.other += item.amount * settings.business.hoursPerDay
    else if (item.behavior === 'perDay') costs.other += item.amount
    else costs.fixedMonthly += item.amount / Math.max(1, settings.business.operatingDaysPerMonth)
  }

  const monthlyUtilityCharges = settings.utilities.water.fixedChargePerMonth
    + settings.utilities.gas.fixedChargePerMonth
    + settings.utilities.electricity.fixedChargePerMonth
  costs.fixedMonthly += monthlyUtilityCharges / Math.max(1, settings.business.operatingDaysPerMonth)

  return { costs, revenue: menuRevenue + toppingRevenue, menuRevenue, toppingRevenue, ratioTotal }
}

export const periodOperatingDays = (settings: AppSettings, period: PeriodKey) => {
  if (period === 'day') return 1
  const months = period === 'month' ? 1 : period === 'quarter' ? 3 : period === 'halfYear' ? 6 : 12
  return settings.business.operatingDaysPerMonth * months
}

export const periodCalendarMonths = (settings: AppSettings, period: PeriodKey) => {
  if (period === 'day') return 1 / Math.max(1, settings.business.operatingDaysPerMonth)
  return period === 'month' ? 1 : period === 'quarter' ? 3 : period === 'halfYear' ? 6 : 12
}

export const simulate = (settings: AppSettings, period: PeriodKey, mealsPerDay = settings.business.mealsPerDay): SimulationResult => {
  const day = calculateOperatingDay(settings, mealsPerDay)
  const operatingDays = periodOperatingDays(settings, period)
  const costs = scaleCosts(day.costs, operatingDays)
  const revenue = day.revenue * operatingDays
  const meals = mealsPerDay * operatingDays
  const totalCost = sumCosts(costs)
  const foodCost = costs.directIngredients + costs.prepMaterials + costs.fryingOil + costs.waste
  const grossProfit = revenue - foodCost
  const operatingProfit = revenue - totalCost

  const nextDay = calculateOperatingDay(settings, mealsPerDay + 1)
  const marginalCostPerMeal = Math.max(0, sumCosts(nextDay.costs) - sumCosts(day.costs))

  return {
    period,
    calendarMonths: periodCalendarMonths(settings, period),
    operatingDays,
    meals,
    revenue,
    menuRevenue: day.menuRevenue * operatingDays,
    toppingRevenue: day.toppingRevenue * operatingDays,
    costs,
    totalCost,
    grossProfit,
    operatingProfit,
    foodCostRate: revenue > 0 ? foodCost / revenue : 0,
    operatingMargin: revenue > 0 ? operatingProfit / revenue : 0,
    averageCostPerMeal: meals > 0 ? totalCost / meals : 0,
    profitPerOperatingDay: operatingDays > 0 ? operatingProfit / operatingDays : 0,
    profitPerOperatingHour: operatingDays > 0 && settings.business.hoursPerDay > 0
      ? operatingProfit / (operatingDays * settings.business.hoursPerDay)
      : 0,
    marginalCostPerMeal,
    menuRatioTotal: day.ratioTotal,
  }
}

const activeMinutesForOutput = (
  settings: AppSettings,
  outputId: string,
  quantity: number,
  roundBatches: boolean,
  trail = new Set<string>(),
): number => {
  const found = findProcessOutput(settings, outputId)
  const outputPerBatch = found && found.process.outputs[0]?.id === found.output.id
    ? found.process.batchSize
    : found?.output.quantity ?? 0
  if (!found || trail.has(outputId) || outputPerBatch <= 0) return 0
  const batches = roundBatches ? calculateBatchCount(quantity, outputPerBatch) : quantity / outputPerBatch
  const nextTrail = new Set(trail).add(outputId)
  return found.process.activeLaborMinutes * batches + found.process.inputs.reduce((total, recipeInput) => (
    recipeInput.sourceType === 'output'
      ? total + activeMinutesForOutput(settings, recipeInput.sourceId, recipeInput.quantity * batches, roundBatches, nextTrail)
      : total
  ), 0)
}

export const compareMakeBuy = (settings: AppSettings): MakeBuyResult => {
  const comparison = settings.makeBuyComparison
  const homemade = calculateProcessOutputCost(settings, comparison.homemadeOutputId, 1, false)
  const homemadeUnitCost = sumCosts(homemade)
  const purchasedUnitCost = getResourceUnitCost(settings, comparison.purchasedResourceId)
  const blendProcess = settings.processes.find((item) => item.id === comparison.blendProcessId)
  const blendOutput = blendProcess?.outputs[0]
  const blendedUnitCost = blendOutput
    ? sumCosts(calculateProcessOutputCost(settings, blendOutput.id, 1, false))
    : 0
  const monthlyUsage = comparison.dailyUsage * settings.business.operatingDaysPerMonth
  const homemadeMonthlyCost = sumCosts(calculateProcessOutputCost(settings, comparison.homemadeOutputId, monthlyUsage, true))
  const purchasedMonthlyCost = purchasedUnitCost * monthlyUsage
  const blendedMonthlyCost = blendOutput
    ? sumCosts(calculateProcessOutputCost(settings, blendOutput.id, monthlyUsage, true))
    : 0
  const monthlySavings = purchasedMonthlyCost - homemadeMonthlyCost
  const monthlyAdditionalHours = activeMinutesForOutput(settings, comparison.homemadeOutputId, monthlyUsage, true) / 60
  const usagePerMeal = comparison.dailyUsage / Math.max(1, settings.business.mealsPerDay)
  let breakEvenMealsPerDay: number | null = null

  for (let meals = 1; meals <= 500; meals += 1) {
    const dailyUsage = usagePerMeal * meals
    const makeCost = sumCosts(calculateProcessOutputCost(settings, comparison.homemadeOutputId, dailyUsage, true))
    if (makeCost <= purchasedUnitCost * dailyUsage) {
      breakEvenMealsPerDay = meals
      break
    }
  }

  return {
    homemadeUnitCost,
    purchasedUnitCost,
    blendedUnitCost,
    homemadeBreakdown: {
      prepMaterials: homemade.prepMaterials,
      prepLabor: homemade.prepLabor,
      water: homemade.water,
      gas: homemade.gas,
      electricity: homemade.electricity,
      waste: homemade.waste,
    },
    monthlyUsage,
    homemadeMonthlyCost,
    purchasedMonthlyCost,
    blendedMonthlyCost,
    monthlySavings,
    monthlyAdditionalHours,
    savingsPerWorkHour: monthlyAdditionalHours > 0 ? monthlySavings / monthlyAdditionalHours : 0,
    breakEvenMealsPerDay,
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
