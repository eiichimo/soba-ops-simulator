import { describe, expect, it } from 'vitest'
import { createSampleSettings } from '../data/sampleData'
import type { LaborCostTreatment, Unit } from '../models/types'
import { createBenchmarkStore } from './fixtures/benchmarkStore'
import {
  calculateAverageDailyOilLiters,
  calculateBatchCount,
  calculateLaborCost,
  calculateLaborCostBreakdown,
  calculateProcessOutputCost,
  calculateSourceCost,
  calculateUtilityDailyCost,
  compareMakeBuy,
  getResourceUnitCost,
  periodOperatingDays,
  simulate,
  sumCosts,
} from './engine'
import { convertQuantity } from './units'

const createLaborTreatmentStore = (laborCostTreatment: LaborCostTreatment) => {
  const settings = createBenchmarkStore()
  settings.processes = [{
    id: 'prep-process',
    name: '30分の仕込み',
    inputs: [],
    outputs: [{
      id: 'prepared-output',
      name: '仕込品',
      quantity: 100,
      unit: '食',
      costAllocation: 1,
      storageType: 'refrigerated',
      shelfLifeDays: 1,
    }],
    batchSize: 100,
    processDurationMinutes: 30,
    activeLaborMinutes: 30,
    laborRole: 'benchmark-staff',
    laborCostTreatment,
    gasUsageM3: 0,
    electricUsageKWh: 0,
    waterUsageL: 0,
    wasteRate: 0,
    wasteReason: 'cookingLoss',
  }]
  settings.menuItems[0].consumption = [{ sourceType: 'output', sourceId: 'prepared-output', quantity: 1, unit: '食' }]
  return settings
}

const resourceCost = (purchaseQuantity: number, purchaseUnit: Unit, quantity: number, unit: Unit) => {
  const settings = createBenchmarkStore()
  settings.resources[0] = {
    ...settings.resources[0],
    purchaseQuantity,
    purchaseUnit,
    purchasePrice: 1_000,
    usableQuantity: purchaseQuantity,
  }
  return sumCosts(calculateSourceCost(settings, {
    sourceType: 'resource',
    sourceId: settings.resources[0].id,
    quantity,
    unit,
  }, quantity))
}

describe('SobaOps calculation engine', () => {
  it('歩留まりを利用可能量へ反映する', () => {
    const settings = createSampleSettings()
    const onion = settings.resources.find((resource) => resource.id === 'long-onion')!
    expect(onion.purchaseQuantity * onion.yieldRate).toBe(900)
    expect(getResourceUnitCost(settings, onion.id)).toBeCloseTo(600 / 900)
  })

  it('1食分の直接原材料費を計算する', () => {
    const settings = createSampleSettings()
    const costs = calculateSourceCost(settings, {
      sourceType: 'resource', sourceId: 'raw-soba', quantity: 180, unit: 'g',
    }, 180)
    expect(costs.directIngredients).toBeCloseTo((750 / 980) * 180)
  })

  it('必要量をバッチサイズで切り上げる', () => {
    expect(calculateBatchCount(0, 10)).toBe(0)
    expect(calculateBatchCount(10, 10)).toBe(1)
    expect(calculateBatchCount(10.01, 10)).toBe(2)
  })

  it('水道光熱費を費用性質ごとに計算する', () => {
    const settings = createSampleSettings()
    const config = {
      ...settings.utilities.water,
      unitPrice: 0.5,
      uses: [
        { id: 'fixed', name: '固定', behavior: 'perDay' as const, quantity: 10 },
        { id: 'meal', name: '食数', behavior: 'perMeal' as const, quantity: 2 },
        { id: 'hour', name: '時間', behavior: 'perHour' as const, quantity: 3 },
      ],
    }
    expect(calculateUtilityDailyCost(config, 100, 8)).toBe((10 + 200 + 24) * 0.5)
  })

  it('実作業時間と時給から仕込み人件費を算出する', () => {
    expect(calculateLaborCost(1_200, 30)).toBe(600)
    expect(calculateLaborCost(1_200, 30, 2)).toBe(1_200)
  })

  it('内製品と既製品の混合レシピを通常工程として原価計算する', () => {
    const settings = createSampleSettings()
    const blend = settings.processes.find((process) => process.id === 'store-kaeshi-process')!
    blend.activeLaborMinutes = 0
    blend.waterUsageL = 0
    blend.wasteRate = 0
    const output = blend.outputs[0]
    const homemadeUnit = sumCosts(calculateProcessOutputCost(settings, 'homemade-kaeshi', 1, false))
    const purchasedUnit = getResourceUnitCost(settings, 'prepared-kaeshi')
    const blendedUnit = sumCosts(calculateProcessOutputCost(settings, output.id, 1, false))
    expect(blendedUnit).toBeCloseTo((homemadeUnit * 2 + purchasedUnit) / 3)
  })

  it('期間集計で曜日別営業カレンダーを使用する', () => {
    const settings = createSampleSettings()
    settings.business.simulationStartDate = '2026-01-05'
    const day = simulate(settings, 'day')
    const month = simulate(settings, 'month')
    const quarter = simulate(settings, 'quarter')
    expect(month.operatingDays).toBe(periodOperatingDays(settings, 'month'))
    expect(month.revenue).toBeCloseTo(day.revenue * month.operatingDays)
    expect(quarter.revenue).toBeCloseTo(day.revenue * quarter.operatingDays)
  })

  it('旧month営業日数フィールドを変えてもカレンダー集計結果は変わらない', () => {
    const full = createSampleSettings()
    full.business.simulationStartDate = '2026-01-05'
    full.business.operatingDaysPerMonth = 22
    const short = createSampleSettings()
    short.business.simulationStartDate = '2026-01-05'
    short.business.operatingDaysPerMonth = 11
    const fullResult = simulate(full, 'month')
    const shortResult = simulate(short, 'month')
    expect(shortResult.revenue).toBeCloseTo(fullResult.revenue)
    expect(shortResult.costs.fixedMonthly).toBeCloseTo(fullResult.costs.fixedMonthly)
    expect(shortResult.costs.operatingLabor).toBeCloseTo(fullResult.costs.operatingLabor)
  })

  it('揚げ油の交換周期を日次消費へ按分する', () => {
    const settings = createSampleSettings()
    settings.fryingOil.initialFillL = 15
    settings.fryingOil.replacementIntervalDays = 3
    settings.fryingOil.dailyTopUpL = 1
    settings.fryingOil.absorptionLPerMeal = 0
    expect(calculateAverageDailyOilLiters(settings)).toBe(6)
  })

  it('内製と既製品の月間費用・ROIを比較する', () => {
    const settings = createSampleSettings()
    settings.business.simulationStartDate = '2026-01-05'
    const result = compareMakeBuy(settings)
    expect(result.monthlyUsage).toBe(settings.makeBuyComparison.dailyUsage * periodOperatingDays(settings, 'month'))
    expect(result.purchasedMonthlyCost).toBeCloseTo(result.purchasedUnitCost * result.monthlyUsage)
    expect(result.monthlySavings).toBeCloseTo(result.purchasedMonthlyCost - result.homemadeMonthlyCost)
    expect(result.homemadeMonthlyCost).toBeGreaterThan(0)
    expect(result.homemadeWasteCost).toBeGreaterThanOrEqual(0)
    expect(result.homemadeEndingInventoryValue).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(result.savingsPerWorkHour)).toBe(true)
  })

  it('内製比較へ日次バッチと保存期限による廃棄を反映する', () => {
    const settings = createBenchmarkStore('2026-01-05')
    settings.resources = [
      { ...settings.resources[0], id: 'make-input', name: '内製材料', category: 'other', purchaseQuantity: 1, purchaseUnit: '食', purchasePrice: 20, usableQuantity: 1, shelfLifeDays: 365 },
      { ...settings.resources[0], id: 'buy-item', name: '既製品', category: 'prepared', purchaseQuantity: 100, purchaseUnit: '食', purchasePrice: 3_000, usableQuantity: 100, shelfLifeDays: 30 },
    ]
    settings.processes = [{
      id: 'make-process', name: '50個内製',
      inputs: [{ sourceType: 'resource', sourceId: 'make-input', quantity: 50, unit: '食' }],
      outputs: [{ id: 'make-output', name: '内製品', quantity: 50, unit: '食', costAllocation: 1, storageType: 'refrigerated', shelfLifeDays: 1 }],
      batchSize: 50, processDurationMinutes: 10, activeLaborMinutes: 0, laborRole: 'benchmark-staff', laborCostTreatment: 'withinScheduledShift',
      gasUsageM3: 0, electricUsageKWh: 0, waterUsageL: 0, wasteRate: 0, wasteReason: 'cookingLoss',
    }]
    settings.makeBuyComparison = { name: '比較品', homemadeOutputId: 'make-output', purchasedResourceId: 'buy-item', blendProcessId: '', dailyUsage: 10, unit: '食' }
    const result = compareMakeBuy(settings)
    expect(result.homemadeWasteCost).toBeGreaterThan(0)
    expect(result.purchasedWasteCost).toBe(0)
    expect(result.homemadeMonthlyCost).toBeGreaterThan(result.homemadeUnitCost * result.monthlyUsage)
  })

  it('工程需要をバッチ単位へ切り上げて原価へ反映する', () => {
    const settings = createSampleSettings()
    const oneBatch = calculateProcessOutputCost(settings, 'chopped-onion', 1, true)
    const sameBatch = calculateProcessOutputCost(settings, 'chopped-onion', 899, true)
    const twoBatches = calculateProcessOutputCost(settings, 'chopped-onion', 901, true)
    expect(sumCosts(sameBatch)).toBeCloseTo(sumCosts(oneBatch))
    expect(sumCosts(twoBatches)).toBeCloseTo(sumCosts(oneBatch) * 2)
  })

  it('基準店舗の1営業日結果を手計算値と一致させる', () => {
    const result = simulate(createBenchmarkStore('2026-01-05'), 'day')
    expect(result.operatingDays).toBe(1)
    expect(result.revenue).toBeCloseTo(100_000)
    expect(result.costs.directIngredients).toBeCloseTo(15_000)
    expect(result.labor.shiftLaborCost).toBeCloseTo(12_000)
    expect(result.costs.water).toBeCloseTo(100)
    expect(result.costs.gas).toBeCloseTo(360)
    expect(result.costs.electricity).toBeCloseTo(120)
    expect(result.totalCost).toBeCloseTo(27_580)
    expect(result.operatingProfit).toBeCloseTo(72_420)
    expect(result.averageCostPerMeal).toBeCloseTo(275.8)
    expect(result.profitPerOperatingHour).toBeCloseTo(9_052.5)
    expect(result.details.menus[0]).toMatchObject({ servings: 100, revenue: 100_000 })
    expect(result.details.resources[0]).toMatchObject({ quantity: 15, unit: 'kg', usageCost: 15_000 })
    expect(result.details.utilities.water.quantity).toBeCloseTo(200)
    expect(result.details.utilities.gas.quantity).toBeCloseTo(2)
    expect(result.details.utilities.electricity.quantity).toBeCloseTo(4)
  })

  it('開始日が休業日なら1日集計の営業由来値を0にする', () => {
    const result = simulate(createBenchmarkStore('2026-01-03'), 'day')
    expect(result.calendarDays).toBe(1)
    expect(result.operatingDays).toBe(0)
    expect(result.totalOperatingHours).toBe(0)
    expect(result.meals).toBe(0)
    expect(result.revenue).toBe(0)
    expect(result.totalCost).toBe(0)
  })

  it('休業日にも常時使用と月固定費の日割り分だけを計上する', () => {
    const settings = createBenchmarkStore('2026-01-03')
    settings.utilities.electricity.uses = [{ id: 'always-on', name: '冷蔵庫', behavior: 'alwaysOn', quantity: 0.5 }]
    settings.utilities.electricity.fixedChargePerMonth = 3_100
    const result = simulate(settings, 'day')
    expect(result.operatingDays).toBe(0)
    expect(result.costs.electricity).toBeCloseTo(0.5 * 24 * 30)
    expect(result.costs.fixedMonthly).toBeCloseTo(100)
    expect(result.totalCost).toBeCloseTo(460)
  })

  it('曜日別の総営業時間を時間比例費用とシフト人件費へ反映する', () => {
    const settings = createBenchmarkStore('2026-01-05')
    settings.business.weekdays[4].closingTime = '19:00'
    const result = simulate(settings, 'month')
    expect(result.operatingDays).toBe(22)
    expect(result.totalOperatingHours).toBeCloseTo(184)
    expect(result.costs.electricity).toBeCloseTo(0.5 * 184 * 30)
    expect(result.labor.shiftLaborCost).toBeCloseTo(1_500 * 184)
  })

  it('基準店舗の30日・20営業日結果を手計算値と一致させる', () => {
    const result = simulate(createBenchmarkStore('2026-01-03'), 'month')
    expect(result.calendarDays).toBe(30)
    expect(result.operatingDays).toBe(20)
    expect(result.revenue).toBeCloseTo(2_000_000)
    expect(result.totalCost).toBeCloseTo(551_600)
    expect(result.operatingProfit).toBeCloseTo(1_448_400)
  })

  it('勤務時間内仕込みは配賦するが会計人件費へ追加しない', () => {
    const result = simulate(createLaborTreatmentStore('withinScheduledShift'), 'day')
    expect(result.labor.shiftLaborCost).toBeCloseTo(12_000)
    expect(result.labor.prepLaborAllocation).toBeCloseTo(750)
    expect(result.labor.additionalPrepLaborCost).toBeCloseTo(0)
    expect(result.labor.accountingLaborCost).toBeCloseTo(12_000)
    expect(result.costs.prepLabor).toBeCloseTo(0)
  })

  it('追加勤務仕込みは会計人件費へ追加する', () => {
    const result = simulate(createLaborTreatmentStore('additionalLabor'), 'day')
    expect(result.labor.shiftLaborCost).toBeCloseTo(12_000)
    expect(result.labor.prepLaborAllocation).toBeCloseTo(750)
    expect(result.labor.additionalPrepLaborCost).toBeCloseTo(750)
    expect(result.labor.accountingLaborCost).toBeCloseTo(12_750)
    expect(result.costs.prepLabor).toBeCloseTo(750)
  })

  it('仕込み配賦額へ限界人件費率を適用する', () => {
    const result = simulate(createLaborTreatmentStore('withinScheduledShift'), 'day')
    expect(result.labor.prepLaborAllocation).toBeCloseTo(750)
    expect(result.labor.marginalPrepLaborCost).toBeCloseTo(150)
    expect(calculateLaborCostBreakdown(1_500, 30, 1, 0.2).marginalLaborCost).toBeCloseTo(150)
  })

  it('gのConsumptionをkg仕入へ換算する', () => {
    expect(resourceCost(1, 'kg', 150, 'g')).toBeCloseTo(150)
  })

  it('kgのConsumptionをg仕入へ換算する', () => {
    expect(resourceCost(1_000, 'g', 0.15, 'kg')).toBeCloseTo(150)
  })

  it('mlのConsumptionをL仕入へ換算する', () => {
    expect(resourceCost(1, 'L', 20, 'ml')).toBeCloseTo(20)
  })

  it('LのConsumptionをml仕入へ換算する', () => {
    expect(resourceCost(1_000, 'ml', 0.02, 'L')).toBeCloseTo(20)
  })

  it('互換性のない単位は変換エラーにする', () => {
    expect(() => convertQuantity(1, 'kg', 'L')).toThrow('単位を変換できません')
    expect(() => convertQuantity(1, '本', 'g')).toThrow('単位を変換できません')
  })
})
