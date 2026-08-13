import { describe, expect, it } from 'vitest'
import type { ActualPeriod, AppSettings, Process, Scenario } from '../models/types'
import {
  applyScenarioOverrides,
  applySensitivityChange,
  analyzeRevenueVariance,
  buildResourceVariances,
  calculateActualUtilityUnitPrice,
  calculateVariance,
  compareScenarios,
  deriveActualMetrics,
  findBreakEvenMealsPerDay,
  removeScenario,
  runSensitivityAnalysis,
  simulateActualPeriod,
} from './decisionSupport'
import { simulate } from './engine'
import { createBenchmarkStore } from './fixtures/benchmarkStore'

const actualPeriod = (patch: Partial<ActualPeriod['actuals']> = {}): ActualPeriod => ({
  id: 'actual-1',
  name: '検算実績',
  startDate: '2026-01-05',
  endDate: '2026-01-11',
  actuals: {
    menuSales: [],
    resourceRecords: [],
    utilities: { water: {}, gas: {}, electricity: {} },
    ...patch,
  },
})

const scenario = (id: string, overrides: Scenario['overrides']): Scenario => ({ id, name: id, overrides })

const createStairStore = (source: 'resource' | 'output'): AppSettings => {
  const settings = createBenchmarkStore('2026-01-05')
  settings.business.hoursPerDay = 1
  settings.business.weekdays = settings.business.weekdays.map((day) => ({ ...day, enabled: true, openingTime: '09:00', closingTime: '10:00' }))
  settings.labor = [{ id: 'staff', name: 'スタッフ', hourlyWage: 100, headcount: 1, hoursPerDay: 1, marginalCostRate: 1 }]
  settings.resources = [{
    id: 'raw', name: '材料', category: 'other', purchaseQuantity: 10, purchaseUnit: '個', purchasePrice: 100,
    yieldRate: 1, usableQuantity: 10, storageType: 'ambient', shelfLifeDays: source === 'resource' ? 1 : 365, minimumPurchaseLot: 1,
  }]
  const process: Process = {
    id: 'batch-process', name: '10個バッチ', inputs: [{ sourceType: 'resource', sourceId: 'raw', quantity: 10, unit: '個' }],
    outputs: [{ id: 'batch-output', name: 'バッチ品', quantity: 10, unit: '個', costAllocation: 1, storageType: 'ambient', shelfLifeDays: 1 }],
    batchSize: 10, processDurationMinutes: 0, activeLaborMinutes: 0, laborRole: 'staff', laborCostTreatment: 'withinScheduledShift',
    gasUsageM3: 0, electricUsageKWh: 0, waterUsageL: 0, wasteRate: 0, wasteReason: 'cookingLoss',
  }
  settings.processes = source === 'output' ? [process] : []
  settings.menuItems = [{
    id: 'menu', name: '商品', sellingPrice: 30, expectedSalesRatio: 100, enabled: true,
    consumption: [{ sourceType: source, sourceId: source === 'resource' ? 'raw' : 'batch-output', quantity: 1, unit: '個' }],
  }]
  settings.toppings = []
  settings.utilities = {
    water: { unitPrice: 0, fixedChargePerMonth: 0, uses: [], isReferencePrice: false },
    gas: { unitPrice: 0, fixedChargePerMonth: 0, uses: [], isReferencePrice: false },
    electricity: { unitPrice: 0, fixedChargePerMonth: 0, uses: [], isReferencePrice: false },
  }
  settings.fryingOil = { unitPricePerL: 0, initialFillL: 0, dailyTopUpL: 0, absorptionLPerMeal: 0, replacementIntervalDays: 1, discardLAtReplacement: 0, isReferencePrice: false }
  settings.otherCosts = []
  return settings
}

describe('Actual and variance', () => {
  it('予測100,000円・実績110,000円を+10,000円・+10%とする', () => {
    const result = calculateVariance(100_000, 110_000, 'benefit')
    expect(result.amount).toBe(10_000)
    expect(result.rate).toBeCloseTo(0.1)
    expect(result.interpretation).toBe('favorable')
  })

  it('費用予測30,000円・実績36,000円を+20%の悪化とする', () => {
    const result = calculateVariance(30_000, 36_000, 'cost')
    expect(result.rate).toBeCloseTo(0.2)
    expect(result.interpretation).toBe('unfavorable')
  })

  it('Actual未入力を0として扱わない', () => {
    expect(calculateVariance(10_000, undefined, 'cost')).toMatchObject({ actual: null, amount: null, rate: null, interpretation: 'notAvailable' })
  })

  it('予測0の場合は差率を算出不可にする', () => {
    expect(calculateVariance(0, 10_000, 'benefit')).toMatchObject({ amount: 10_000, rate: null })
  })

  it('電気42,000円・1,400kWhから30円/kWhを算出する', () => {
    expect(calculateActualUtilityUnitPrice(42_000, 1_400)).toBeCloseTo(30)
    expect(calculateActualUtilityUnitPrice(42_000, 0)).toBeNull()
  })

  it('Actualの任意日付範囲を既存Engineで再計算する', () => {
    const result = simulateActualPeriod(createBenchmarkStore('2026-01-05'), actualPeriod())!
    expect(result.period).toBe('custom')
    expect(result.calendarDays).toBe(7)
    expect(result.operatingDays).toBe(5)
  })

  it('購入量だけを実績使用量へ転用しない', () => {
    const settings = createBenchmarkStore('2026-01-05')
    const actual = actualPeriod({ resourceRecords: [{ resourceId: 'benchmark-noodle', purchasedQuantity: 20, purchaseUnit: 'kg', purchaseExpenditure: 20_000 }] })
    const plan = simulateActualPeriod(settings, actual)!
    const variance = buildResourceVariances(settings, plan, actual)[0]
    expect(variance.actualPurchaseQuantity).toBe(20)
    expect(variance.actualUsageQuantity).toBeNull()
    expect(variance.actualUnitPrice).toBe(1_000)
  })

  it('在庫方程式が揃った場合だけActual使用原価を導出する', () => {
    const complete = actualPeriod({ openingInventoryValue: 100, purchaseExpenditure: 500, endingInventoryValue: 200, wasteCost: 50 })
    expect(deriveActualMetrics(complete.actuals).usageCost).toBe(350)
    expect(deriveActualMetrics(actualPeriod({ purchaseExpenditure: 500 }).actuals).usageCost).toBeUndefined()
  })

  it('売上差を販売数量差と単価・構成差へ分解する', () => {
    const settings = createBenchmarkStore('2026-01-05')
    const plan = simulate(settings, 'day')
    const actual = actualPeriod({ revenue: 112_000, meals: 110, menuSales: [{ menuItemId: 'benchmark-menu', quantity: 110 }] })
    const analysis = analyzeRevenueVariance(settings, plan, actual)!
    expect(analysis.quantityVariance).toBeCloseTo(10_000)
    expect(analysis.priceAndMixVariance).toBeCloseTo(2_000)
  })
})

describe('Scenario', () => {
  it('Baseを変更せずScenario Overrideを適用する', () => {
    const settings = createBenchmarkStore()
    const changed = applyScenarioOverrides(settings, scenario('A', { business: { mealsPerDay: 120 }, laborWageMultiplier: 1.1 }))
    expect(changed.business.mealsPerDay).toBe(120)
    expect(changed.labor[0].hourlyWage).toBeCloseTo(1_650)
    expect(settings.business.mealsPerDay).toBe(100)
    expect(settings.labor[0].hourlyWage).toBe(1_500)
  })

  it('Scenario削除後もBaseを変更しない', () => {
    const settings = createBenchmarkStore()
    settings.scenarios = [scenario('A', { business: { mealsPerDay: 120 } })]
    const removed = removeScenario(settings, 'A')
    expect(removed.scenarios).toEqual([])
    expect(removed.business).toEqual(settings.business)
    expect(settings.scenarios).toHaveLength(1)
  })

  it('複数Scenarioを同じEngineで比較する', () => {
    const settings = createBenchmarkStore()
    settings.scenarios = [scenario('A', { business: { mealsPerDay: 90 } }), scenario('B', { business: { mealsPerDay: 110 } })]
    const compared = compareScenarios(settings, 'day')
    expect(compared).toHaveLength(2)
    expect(compared[0].result.meals).toBe(90)
    expect(compared[1].result.meals).toBe(110)
    expect(settings.business.mealsPerDay).toBe(100)
  })
})

describe('Sensitivity', () => {
  it('人件費+10%で会計上人件費を10%増加させる', () => {
    const settings = createBenchmarkStore()
    const points = runSensitivityAnalysis(settings, 'day', 'laborWage')
    const base = points.find((point) => point.rate === 0)!.result
    const plus = points.find((point) => point.rate === 0.1)!.result
    expect(plus.labor.accountingLaborCost).toBeCloseTo(base.labor.accountingLaborCost * 1.1)
  })

  it('Resource価格+20%を対象Resourceだけへ適用する', () => {
    const settings = createBenchmarkStore()
    const changed = applySensitivityChange(settings, 'resourcePrice', 0.2, 'benchmark-noodle')
    expect(changed.resources[0].purchasePrice).toBe(12_000)
    expect(settings.resources[0].purchasePrice).toBe(10_000)
  })

  it('mealsPerDay -10%を適用する', () => {
    const changed = applySensitivityChange(createBenchmarkStore(), 'mealsPerDay', -0.1)
    expect(changed.business.mealsPerDay).toBeCloseTo(90)
  })

  it('営業時間+10%を曜日別閉店時刻へ反映する', () => {
    const settings = createBenchmarkStore()
    settings.business.weekdays[4].closingTime = '19:00'
    const changed = applySensitivityChange(settings, 'operatingHours', 0.1)
    expect(changed.business.hoursPerDay).toBeCloseTo(8.8)
    expect(changed.business.weekdays[0].closingTime).toBe('17:48')
    expect(changed.business.weekdays[4].closingTime).toBe('20:00')
    expect(simulate(changed, 'day').totalOperatingHours).toBeCloseTo(8.8)
  })

  it('週営業日数の基準点で既存の休業曜日を変更しない', () => {
    const settings = createBenchmarkStore()
    const changed = applySensitivityChange(settings, 'operatingDays', 0)
    expect(changed.business.weekdays).toEqual(settings.business.weekdays)
  })
})

describe('break-even search', () => {
  it('基準店舗の既知の損益分岐を15食/日とする', () => {
    expect(findBreakEvenMealsPerDay(createBenchmarkStore('2026-01-05'), 'day')).toBe(15)
  })

  it('バッチ生産と期限切れを含む階段状費用を逐次探索する', () => {
    expect(findBreakEvenMealsPerDay(createStairStore('output'), 'month', 20)).toBe(7)
  })

  it('購入packageと期限切れを含む階段状費用を逐次探索する', () => {
    expect(findBreakEvenMealsPerDay(createStairStore('resource'), 'month', 20)).toBe(7)
  })
})
