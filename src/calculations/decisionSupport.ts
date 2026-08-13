import type {
  ActualPeriod,
  ActualValues,
  AppSettings,
  PeriodKey,
  ResourceVariance,
  Scenario,
  ScenarioComparison,
  SensitivityPoint,
  SensitivityTarget,
  SimulationResult,
  VarianceDirection,
  VarianceResult,
  VarianceRow,
} from '../models/types'
import { simulate, simulateDateRange } from './engine'
import { timeToMinutes } from './calendar'
import { tryConvertQuantity } from './units'

const EPSILON = 1e-9

export const calculateVariance = (
  plan: number,
  actual: number | null | undefined,
  direction: VarianceDirection,
): VarianceResult => {
  if (actual === undefined || actual === null) {
    return { plan, actual: null, amount: null, rate: null, direction, interpretation: 'notAvailable' }
  }
  const amount = actual - plan
  const rate = Math.abs(plan) <= EPSILON ? null : amount / plan
  const interpretation = Math.abs(amount) <= EPSILON || direction === 'neutral'
    ? 'neutral'
    : direction === 'benefit'
      ? amount > 0 ? 'favorable' : 'unfavorable'
      : amount < 0 ? 'favorable' : 'unfavorable'
  return { plan, actual, amount, rate, direction, interpretation }
}

export interface DerivedActualMetrics {
  usageCost: number | undefined
  operatingProfit: number | undefined
  simpleCashFlow: number | undefined
}

const allDefined = (values: (number | undefined)[]): values is number[] => values.every((value) => value !== undefined)

export const deriveActualMetrics = (actuals: ActualValues): DerivedActualMetrics => {
  const inventoryEquation = [actuals.openingInventoryValue, actuals.purchaseExpenditure, actuals.endingInventoryValue, actuals.wasteCost]
  const usageCost = actuals.usageCost ?? (allDefined(inventoryEquation)
    ? inventoryEquation[0] + inventoryEquation[1] - inventoryEquation[2] - inventoryEquation[3]
    : undefined)
  const expenseValues = [
    actuals.revenue,
    usageCost,
    actuals.laborCost,
    actuals.utilities.water.cost,
    actuals.utilities.gas.cost,
    actuals.utilities.electricity.cost,
    actuals.wasteCost,
    actuals.otherCost,
  ]
  const operatingProfit = actuals.operatingProfit ?? (allDefined(expenseValues)
    ? expenseValues[0] - expenseValues.slice(1).reduce((total, value) => total + value, 0)
    : undefined)
  const cashValues = [
    actuals.revenue,
    actuals.purchaseExpenditure,
    actuals.laborCost,
    actuals.utilities.water.cost,
    actuals.utilities.gas.cost,
    actuals.utilities.electricity.cost,
    actuals.otherCost,
  ]
  const simpleCashFlow = actuals.simpleCashFlow ?? (allDefined(cashValues)
    ? cashValues[0] - cashValues.slice(1).reduce((total, value) => total + value, 0)
    : undefined)
  return { usageCost, operatingProfit, simpleCashFlow }
}

export const simulateActualPeriod = (settings: AppSettings, actualPeriod: ActualPeriod) => (
  simulateDateRange(settings, actualPeriod.startDate, actualPeriod.endDate)
)

export const buildVarianceRows = (plan: SimulationResult, actualPeriod: ActualPeriod): VarianceRow[] => {
  const actuals = actualPeriod.actuals
  const derived = deriveActualMetrics(actuals)
  const definitions: Array<[string, string, number, number | undefined, VarianceDirection, VarianceRow['unit']]> = [
    ['revenue', '売上', plan.revenue, actuals.revenue, 'benefit', 'yen'],
    ['meals', '販売食数', plan.meals, actuals.meals, 'benefit', 'count'],
    ['usageCost', '使用原価', plan.inventory.usageCost, derived.usageCost, 'cost', 'yen'],
    ['purchaseExpenditure', '購入支出', plan.inventory.purchaseExpenditure, actuals.purchaseExpenditure, 'cost', 'yen'],
    ['laborCost', '人件費', plan.labor.accountingLaborCost, actuals.laborCost, 'cost', 'yen'],
    ['water', '水道', plan.costs.water, actuals.utilities.water.cost, 'cost', 'yen'],
    ['gas', 'ガス', plan.costs.gas, actuals.utilities.gas.cost, 'cost', 'yen'],
    ['electricity', '電気', plan.costs.electricity, actuals.utilities.electricity.cost, 'cost', 'yen'],
    ['waste', '廃棄', plan.inventory.wasteCost, actuals.wasteCost, 'cost', 'yen'],
    ['operatingProfit', '営業利益', plan.operatingProfit, derived.operatingProfit, 'benefit', 'yen'],
    ['simpleCashFlow', '簡易現金収支', plan.inventory.simpleCashFlow, derived.simpleCashFlow, 'benefit', 'yen'],
  ]
  return definitions.map(([key, label, planValue, actualValue, direction, unit]) => ({
    key,
    label,
    unit,
    ...calculateVariance(planValue, actualValue, direction),
  }))
}

export const calculateActualUtilityUnitPrice = (cost?: number, quantity?: number) => (
  cost === undefined || quantity === undefined || quantity <= 0 ? null : cost / quantity
)

export const buildResourceVariances = (
  settings: AppSettings,
  plan: SimulationResult,
  actualPeriod: ActualPeriod,
): ResourceVariance[] => settings.resources.map((resource) => {
  const item = plan.inventory.items.find((summary) => summary.sourceType === 'resource' && summary.sourceId === resource.id)
  const actual = actualPeriod.actuals.resourceRecords.find((record) => record.resourceId === resource.id)
  const plannedPurchases = plan.inventory.purchases.filter((purchase) => purchase.resourceId === resource.id)
  const plannedPurchaseQuantity = plannedPurchases.reduce((total, purchase) => total + purchase.purchasedQuantity, 0)
  const plannedPurchaseExpenditure = plannedPurchases.reduce((total, purchase) => total + purchase.expenditure, 0)
  const actualPurchaseQuantity = actual?.purchasedQuantity === undefined
    ? null
    : tryConvertQuantity(actual.purchasedQuantity, actual.purchaseUnit, resource.purchaseUnit)
  const actualUsageQuantity = actual?.usedQuantity === undefined || !actual.usageUnit
    ? null
    : tryConvertQuantity(actual.usedQuantity, actual.usageUnit, resource.purchaseUnit)
  const actualWasteQuantity = actual?.wasteQuantity === undefined || !actual.wasteUnit
    ? null
    : tryConvertQuantity(actual.wasteQuantity, actual.wasteUnit, resource.purchaseUnit)
  const plannedUnitPrice = plannedPurchaseQuantity > 0 ? plannedPurchaseExpenditure / plannedPurchaseQuantity : null
  const actualUnitPrice = actualPurchaseQuantity !== null && actualPurchaseQuantity > 0 && actual?.purchaseExpenditure !== undefined
    ? actual.purchaseExpenditure / actualPurchaseQuantity
    : null
  return {
    resourceId: resource.id,
    resourceName: resource.name,
    unit: resource.purchaseUnit,
    plannedUsageQuantity: item?.consumedQuantity ?? 0,
    actualUsageQuantity,
    plannedPurchaseQuantity,
    actualPurchaseQuantity,
    plannedPurchaseExpenditure,
    actualPurchaseExpenditure: actual?.purchaseExpenditure ?? null,
    plannedUnitPrice,
    actualUnitPrice,
    unitPriceDifference: actualUnitPrice === null || plannedUnitPrice === null ? null : actualUnitPrice - plannedUnitPrice,
    purchaseQuantityDifference: actualPurchaseQuantity === null ? null : actualPurchaseQuantity - plannedPurchaseQuantity,
    plannedWasteQuantity: item?.wastedQuantity ?? 0,
    actualWasteQuantity,
    wasteQuantityDifference: actualWasteQuantity === null ? null : actualWasteQuantity - (item?.wastedQuantity ?? 0),
  }
})

export interface RevenueVarianceAnalysis {
  quantityVariance: number
  priceAndMixVariance: number
  menuMixVariance: number | null
  residualPriceVariance: number | null
}

export const analyzeRevenueVariance = (settings: AppSettings, plan: SimulationResult, actualPeriod: ActualPeriod): RevenueVarianceAnalysis | null => {
  const { revenue, meals, menuSales } = actualPeriod.actuals
  if (revenue === undefined || meals === undefined || plan.meals <= 0) return null
  const plannedAveragePrice = plan.revenue / plan.meals
  const quantityVariance = (meals - plan.meals) * plannedAveragePrice
  const priceAndMixVariance = revenue - meals * plannedAveragePrice
  if (menuSales.length === 0) return { quantityVariance, priceAndMixVariance, menuMixVariance: null, residualPriceVariance: null }
  const menuMixVariance = menuSales.reduce((total, sale) => {
    const menu = settings.menuItems.find((item) => item.id === sale.menuItemId)
    return total + sale.quantity * ((menu?.sellingPrice ?? plannedAveragePrice) - plannedAveragePrice)
  }, 0)
  return { quantityVariance, priceAndMixVariance, menuMixVariance, residualPriceVariance: priceAndMixVariance - menuMixVariance }
}

const timeForHours = (openingTime: string, hours: number) => {
  const [hour = 0, minute = 0] = openingTime.split(':').map(Number)
  const closingMinutes = Math.min(23 * 60 + 59, hour * 60 + minute + Math.round(Math.max(0, hours) * 60))
  return `${String(Math.floor(closingMinutes / 60)).padStart(2, '0')}:${String(closingMinutes % 60).padStart(2, '0')}`
}

const scheduleDuration = (openingTime: string, closingTime: string) => {
  const [openingHour = 0, openingMinute = 0] = openingTime.split(':').map(Number)
  const [closingHour = 0, closingMinute = 0] = closingTime.split(':').map(Number)
  return Math.max(0, (closingHour * 60 + closingMinute - openingHour * 60 - openingMinute) / 60)
}

const minutesToTime = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(Math.round(minutes % 60)).padStart(2, '0')}`

const settingsWithKitchenTimes = (settings: AppSettings, openingTime?: string, closingTime?: string): AppSettings => {
  const nextOpening = openingTime ?? settings.business.openingTime
  const nextClosing = closingTime ?? settings.business.closingTime
  const openingMinute = timeToMinutes(nextOpening)
  const closingMinute = timeToMinutes(nextClosing)
  if (openingMinute === null || closingMinute === null || closingMinute <= openingMinute) return settings
  return {
    ...settings,
    business: {
      ...settings.business,
      openingTime: nextOpening,
      closingTime: nextClosing,
      hoursPerDay: (closingMinute - openingMinute) / 60,
      weekdays: settings.business.weekdays.map((schedule) => ({
        ...schedule,
        openingTime: nextOpening,
        closingTime: nextClosing,
      })),
    },
    capacity: {
      ...settings.capacity,
      staffShifts: settings.capacity.staffShifts.map((shift) => {
        const start = timeToMinutes(shift.startTime) ?? openingMinute
        const end = timeToMinutes(shift.endTime) ?? closingMinute
        const clampedStart = Math.max(openingMinute, start)
        const clampedEnd = Math.min(closingMinute, end)
        if (clampedEnd <= clampedStart) return { ...shift, startTime: nextOpening, endTime: nextClosing, headcount: 0 }
        return {
          ...shift,
          startTime: minutesToTime(clampedStart),
          endTime: minutesToTime(clampedEnd),
        }
      }),
    },
  }
}

const settingsWithHours = (settings: AppSettings, hours: number): AppSettings => ({
  ...settings,
  business: {
    ...settings.business,
    hoursPerDay: hours,
    closingTime: timeForHours(settings.business.openingTime, hours),
    weekdays: settings.business.weekdays.map((schedule) => ({
      ...schedule,
      closingTime: timeForHours(schedule.openingTime, hours),
    })),
  },
})

const settingsWithOperatingDays = (settings: AppSettings, operatingDaysPerWeek: number): AppSettings => {
  const days = Math.min(7, Math.max(0, Math.round(operatingDaysPerWeek)))
  const ordered = [...settings.business.weekdays].sort((a, b) => a.day - b.day)
  const currentlyEnabled = ordered.filter((schedule) => schedule.enabled).map((schedule) => schedule.day)
  const currentlyDisabled = ordered.filter((schedule) => !schedule.enabled).map((schedule) => schedule.day)
  const enabledDays = days <= currentlyEnabled.length
    ? new Set(currentlyEnabled.slice(0, days))
    : new Set([...currentlyEnabled, ...currentlyDisabled.slice(0, days - currentlyEnabled.length)])
  return {
    ...settings,
    business: {
      ...settings.business,
      weekdays: settings.business.weekdays.map((schedule) => ({ ...schedule, enabled: enabledDays.has(schedule.day) })),
    },
  }
}

const demandSlotsForMeals = (settings: AppSettings, mealsPerDay: number) => {
  const slots = settings.capacity.demandProfile.timeSlots
  const total = slots.reduce((sum, slot) => sum + Math.max(0, slot.meals), 0)
  const target = Math.max(0, Math.round(mealsPerDay))
  if (slots.length === 0) return []
  if (total <= 0) return slots.map((slot, index) => ({ ...slot, meals: index === 0 ? target : 0 }))
  const rows = slots.map((slot, index) => {
    const exact = target * Math.max(0, slot.meals) / total
    return { slot, index, meals: Math.floor(exact), remainder: exact - Math.floor(exact) }
  })
  let remaining = target - rows.reduce((sum, row) => sum + row.meals, 0)
  for (const row of [...rows].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (remaining <= 0) break
    row.meals += 1
    remaining -= 1
  }
  return rows.map((row) => ({ ...row.slot, meals: row.meals }))
}

export const applyScenarioOverrides = (settings: AppSettings, scenario: Scenario): AppSettings => {
  const overrides = scenario.overrides
  const mealsPerDay = overrides.business?.mealsPerDay ?? settings.business.mealsPerDay
  let result: AppSettings = {
    ...settings,
    business: {
      ...settings.business,
      mealsPerDay,
    },
    menuItems: settings.menuItems.map((menu) => ({
      ...menu,
      sellingPrice: menu.sellingPrice * (overrides.averageSellingPriceMultiplier ?? 1),
    })),
    toppings: settings.toppings.map((topping) => ({
      ...topping,
      sellingPrice: topping.sellingPrice * (overrides.averageSellingPriceMultiplier ?? 1),
    })),
    labor: settings.labor.map((role) => ({
      ...role,
      hourlyWage: role.hourlyWage * (overrides.laborWageMultiplier ?? 1),
    })),
    resources: settings.resources.map((resource) => ({
      ...resource,
      purchasePrice: resource.purchasePrice * (overrides.resourcePurchasePriceMultipliers?.[resource.id] ?? 1),
    })),
    utilities: {
      water: { ...settings.utilities.water, unitPrice: settings.utilities.water.unitPrice * (overrides.utilityUnitPriceMultipliers?.water ?? 1) },
      gas: { ...settings.utilities.gas, unitPrice: settings.utilities.gas.unitPrice * (overrides.utilityUnitPriceMultipliers?.gas ?? 1) },
      electricity: { ...settings.utilities.electricity, unitPrice: settings.utilities.electricity.unitPrice * (overrides.utilityUnitPriceMultipliers?.electricity ?? 1) },
    },
    capacity: {
      ...settings.capacity,
      staffShifts: settings.capacity.staffShifts.map((shift) => ({
        ...shift,
        headcount: overrides.staffShiftHeadcountOverrides?.[shift.id] ?? shift.headcount,
      })),
      equipment: settings.capacity.equipment.map((equipment) => ({
        ...equipment,
        capacity: overrides.equipmentCapacityOverrides?.[equipment.id] ?? equipment.capacity,
      })),
      operations: settings.capacity.operations.map((operation) => {
        const duration = overrides.kitchenOperationDurationOverrides?.[operation.id]
        if (duration === undefined) return operation
        const ratio = operation.durationMinutes > 0 ? duration / operation.durationMinutes : 1
        return {
          ...operation,
          durationMinutes: duration,
          activeLaborMinutes: Math.min(duration, operation.activeLaborMinutes * ratio),
          equipmentRequirements: operation.equipmentRequirements.map((requirement) => ({
            ...requirement,
            occupationMinutes: requirement.occupationMinutes * ratio,
          })),
        }
      }),
      demandProfile: overrides.business?.mealsPerDay === undefined ? settings.capacity.demandProfile : {
        ...settings.capacity.demandProfile,
        timeSlots: demandSlotsForMeals(settings, mealsPerDay),
      },
      stochasticDemand: {
        ...settings.capacity.stochasticDemand,
        seatingUnits: settings.capacity.stochasticDemand.seatingUnits.map((unit) => ({
          ...unit,
          count: overrides.seatingUnitCountOverrides?.[unit.id] ?? unit.count,
        })),
      },
    },
  }
  if (overrides.business?.hoursPerDay !== undefined) result = settingsWithHours(result, overrides.business.hoursPerDay)
  if (overrides.kitchenOpeningTime !== undefined || overrides.kitchenClosingTime !== undefined) {
    result = settingsWithKitchenTimes(result, overrides.kitchenOpeningTime, overrides.kitchenClosingTime)
  }
  if (overrides.business?.operatingDaysPerWeek !== undefined) result = settingsWithOperatingDays(result, overrides.business.operatingDaysPerWeek)
  return result
}

export const removeScenario = (settings: AppSettings, scenarioId: string): AppSettings => ({
  ...settings,
  scenarios: settings.scenarios.filter((scenario) => scenario.id !== scenarioId),
})

export const compareScenarios = (settings: AppSettings, period: PeriodKey): ScenarioComparison[] => (
  settings.scenarios.slice(0, 5).map((scenario) => {
    const scenarioSettings = applyScenarioOverrides(settings, scenario)
    return { scenario, settings: scenarioSettings, result: simulate(scenarioSettings, period) }
  })
)

export const applySensitivityChange = (
  settings: AppSettings,
  target: SensitivityTarget,
  rate: number,
  resourceId?: string,
): AppSettings => {
  const multiplier = Math.max(0, 1 + rate)
  if (target === 'mealsPerDay') return { ...settings, business: { ...settings.business, mealsPerDay: settings.business.mealsPerDay * multiplier } }
  if (target === 'averageSellingPrice') return applyScenarioOverrides(settings, { id: 'sensitivity', name: '感度分析', overrides: { averageSellingPriceMultiplier: multiplier } })
  if (target === 'laborWage') return applyScenarioOverrides(settings, { id: 'sensitivity', name: '感度分析', overrides: { laborWageMultiplier: multiplier } })
  if (target === 'resourcePrice') return applyScenarioOverrides(settings, { id: 'sensitivity', name: '感度分析', overrides: { resourcePurchasePriceMultipliers: resourceId ? { [resourceId]: multiplier } : {} } })
  if (target === 'waterPrice' || target === 'gasPrice' || target === 'electricityPrice') {
    const utility = target === 'waterPrice' ? 'water' : target === 'gasPrice' ? 'gas' : 'electricity'
    return applyScenarioOverrides(settings, { id: 'sensitivity', name: '感度分析', overrides: { utilityUnitPriceMultipliers: { [utility]: multiplier } } })
  }
  if (target === 'operatingHours') return {
    ...settings,
    business: {
      ...settings.business,
      hoursPerDay: settings.business.hoursPerDay * multiplier,
      weekdays: settings.business.weekdays.map((schedule) => ({
        ...schedule,
        closingTime: timeForHours(schedule.openingTime, scheduleDuration(schedule.openingTime, schedule.closingTime) * multiplier),
      })),
    },
  }
  const enabledDays = settings.business.weekdays.filter((schedule) => schedule.enabled).length
  return settingsWithOperatingDays(settings, enabledDays * multiplier)
}

const sensitivityParameterValue = (settings: AppSettings, target: SensitivityTarget, resourceId?: string) => {
  if (target === 'mealsPerDay') return settings.business.mealsPerDay
  if (target === 'averageSellingPrice') {
    const enabled = settings.menuItems.filter((menu) => menu.enabled)
    const ratio = enabled.reduce((total, menu) => total + menu.expectedSalesRatio, 0)
    return ratio > 0 ? enabled.reduce((total, menu) => total + menu.sellingPrice * menu.expectedSalesRatio, 0) / ratio : 0
  }
  if (target === 'laborWage') return settings.labor.length ? settings.labor.reduce((total, role) => total + role.hourlyWage, 0) / settings.labor.length : 0
  if (target === 'resourcePrice') return settings.resources.find((resource) => resource.id === resourceId)?.purchasePrice ?? 0
  if (target === 'waterPrice') return settings.utilities.water.unitPrice
  if (target === 'gasPrice') return settings.utilities.gas.unitPrice
  if (target === 'electricityPrice') return settings.utilities.electricity.unitPrice
  if (target === 'operatingHours') return settings.business.hoursPerDay
  return settings.business.weekdays.filter((schedule) => schedule.enabled).length
}

export const runSensitivityAnalysis = (
  settings: AppSettings,
  period: PeriodKey,
  target: SensitivityTarget,
  rates = [-0.2, -0.1, 0, 0.1, 0.2],
  resourceId?: string,
): SensitivityPoint[] => rates.map((rate) => {
  const changed = applySensitivityChange(settings, target, rate, resourceId)
  return {
    rate,
    label: rate === 0 ? '基準' : `${rate > 0 ? '+' : ''}${Math.round(rate * 100)}%`,
    parameterValue: sensitivityParameterValue(changed, target, resourceId),
    result: simulate(changed, period),
  }
})

export const findBreakEvenMealsPerDay = (
  settings: AppSettings,
  period: PeriodKey = 'month',
  maximumMeals = 500,
): number | null => {
  for (let meals = 0; meals <= maximumMeals; meals += 1) {
    if (simulate(settings, period, meals).operatingProfit >= 0) return meals
  }
  return null
}

export interface CalibrationHint {
  key: string
  message: string
  candidates: string[]
}

export const buildCalibrationHints = (rows: VarianceRow[], threshold = 0.2): CalibrationHint[] => {
  const candidates: Record<string, string[]> = {
    revenue: ['販売食数', '平均販売価格', 'メニュー構成'],
    usageCost: ['Resource単価', '1食使用量', '歩留まり・仕込みロス'],
    purchaseExpenditure: ['購入package', '期首・期末在庫', '購入単価'],
    laborCost: ['実労働時間', '人数', '時給・追加勤務'],
    water: ['水道単価', '麺洗浄水', '食器・器具洗浄水'],
    gas: ['ガス単価', '営業時間', 'そば釜・給湯使用量'],
    electricity: ['電気単価', '空調・照明時間', '常時稼働設備'],
    waste: ['保存期限', '購入package', '仕込みバッチ'],
  }
  return rows.filter((row) => row.rate !== null && Math.abs(row.rate) >= threshold && candidates[row.key]).map((row) => ({
    key: row.key,
    message: `${row.label}が予測より${Math.round(Math.abs(row.rate ?? 0) * 100)}%${(row.amount ?? 0) >= 0 ? '高い' : '低い'}実績です。`,
    candidates: candidates[row.key],
  }))
}
