import { describe, expect, it } from 'vitest'
import { createSampleSettings } from '../data/sampleData'
import {
  calculateAverageDailyOilLiters,
  calculateBatchCount,
  calculateLaborCost,
  calculateProcessOutputCost,
  calculateSourceCost,
  calculateUtilityDailyCost,
  compareMakeBuy,
  getResourceUnitCost,
  simulate,
  sumCosts,
} from './engine'

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

  it('期間集計で月営業日数を使用する', () => {
    const settings = createSampleSettings()
    settings.business.operatingDaysPerMonth = 22
    const day = simulate(settings, 'day')
    const month = simulate(settings, 'month')
    const quarter = simulate(settings, 'quarter')
    expect(month.operatingDays).toBe(22)
    expect(month.revenue).toBeCloseTo(day.revenue * 22)
    expect(quarter.operatingDays).toBe(66)
    expect(quarter.revenue).toBeCloseTo(month.revenue * 3)
  })

  it('月営業日数の変更で変動費と固定費を正しく集計する', () => {
    const full = createSampleSettings()
    full.business.operatingDaysPerMonth = 22
    const short = createSampleSettings()
    short.business.operatingDaysPerMonth = 11
    const fullResult = simulate(full, 'month')
    const shortResult = simulate(short, 'month')
    expect(shortResult.revenue).toBeCloseTo(fullResult.revenue / 2)
    expect(shortResult.costs.fixedMonthly).toBeCloseTo(fullResult.costs.fixedMonthly)
    expect(shortResult.costs.operatingLabor).toBeCloseTo(fullResult.costs.operatingLabor / 2)
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
    const result = compareMakeBuy(settings)
    expect(result.monthlyUsage).toBe(settings.makeBuyComparison.dailyUsage * settings.business.operatingDaysPerMonth)
    expect(result.homemadeMonthlyCost).toBeCloseTo(sumCosts(calculateProcessOutputCost(settings, settings.makeBuyComparison.homemadeOutputId, result.monthlyUsage, true)))
    expect(result.purchasedMonthlyCost).toBeCloseTo(result.purchasedUnitCost * result.monthlyUsage)
    expect(result.monthlySavings).toBeCloseTo(result.purchasedMonthlyCost - result.homemadeMonthlyCost)
    expect(Number.isFinite(result.savingsPerWorkHour)).toBe(true)
  })

  it('工程需要をバッチ単位へ切り上げて原価へ反映する', () => {
    const settings = createSampleSettings()
    const oneBatch = calculateProcessOutputCost(settings, 'chopped-onion', 1, true)
    const sameBatch = calculateProcessOutputCost(settings, 'chopped-onion', 899, true)
    const twoBatches = calculateProcessOutputCost(settings, 'chopped-onion', 901, true)
    expect(sumCosts(sameBatch)).toBeCloseTo(sumCosts(oneBatch))
    expect(sumCosts(twoBatches)).toBeCloseTo(sumCosts(oneBatch) * 2)
  })
})
