import { describe, expect, it } from 'vitest'
import { createSampleSettings } from '../data/sampleData'
import { createBenchmarkStore } from './fixtures/benchmarkStore'
import { calculateStatistics, compareMonteCarloScenarios, quantile, runMonteCarlo, runMonteCarloAsync } from './monteCarloEngine'

const monteStore = () => {
  const settings = createBenchmarkStore('2026-01-05')
  settings.capacity.demandMode = 'stochastic'
  settings.capacity.stochasticDemand.arrivalProfile.slots = [{
    id: 'slot', startTime: '09:00', endTime: '10:00', expectedGuests: 10, arrivalDistribution: 'uniform',
  }]
  settings.capacity.stochasticDemand.seatingUnits = [{ id: 'seat', name: '2名席', capacity: 2, count: 4, category: 'table', enabled: true }]
  settings.capacity.stochasticDemand.orderDelay = { distribution: 'uniform', meanMinutes: 2, minMinutes: 1, maxMinutes: 3 }
  settings.capacity.stochasticDemand.dwellTime = { distribution: 'uniform', meanMinutes: 20, minMinutes: 15, maxMinutes: 25 }
  settings.capacity.stochasticDemand.monteCarlo.runs = 5
  settings.capacity.stochasticDemand.monteCarlo.maximumRuns = 1_000
  return settings
}

describe('Monte Carlo statistics', () => {
  it('固定配列のmeanとmedianを算出する', () => {
    const result = calculateStatistics([1, 2, 3, 4, 5])
    expect(result.mean).toBe(3)
    expect(result.median).toBe(3)
  })

  it('固定配列のp10とp90を線形補間する', () => {
    expect(quantile([0, 10, 20, 30, 40], 0.1)).toBe(4)
    expect(quantile([0, 10, 20, 30, 40], 0.9)).toBe(36)
  })

  it('p5・p95・min・maxを算出する', () => {
    const result = calculateStatistics([0, 10, 20, 30, 40])
    expect(result).toMatchObject({ p5: 2, p95: 38, min: 0, max: 40 })
  })
})

describe('Monte Carlo reproducibility and risk', () => {
  it('指定run数だけ実行する', () => {
    expect(runMonteCarlo(monteStore(), 4, 100).summaries).toHaveLength(4)
  })

  it('baseSeed+runIndexのseed集合を使う', () => {
    expect(runMonteCarlo(monteStore(), 4, 100).summaries.map((run) => run.seed)).toEqual([100, 101, 102, 103])
  })

  it('同じseed集合から同じMonte Carlo結果を再現する', () => {
    const settings = monteStore()
    expect(runMonteCarlo(settings, 3, 200)).toEqual(runMonteCarlo(settings, 3, 200))
  })

  it('赤字run率を個別runから算出する', () => {
    const result = runMonteCarlo(monteStore(), 5, 300)
    const expected = result.summaries.filter((run) => run.operatingProfit < 0).length / 5
    expect(result.lossRunRate).toBe(expected)
  })

  it('run上限超過を拒否する', () => {
    expect(() => runMonteCarlo(monteStore(), 1_001, 1)).toThrow(/1〜1000/)
  })

  it('非同期実行も同じseed集合を維持する', async () => {
    const result = await runMonteCarloAsync(monteStore(), 6, 800)
    expect(result.summaries.map((run) => run.seed)).toEqual([800, 801, 802, 803, 804, 805])
  })

  it('サンプル店舗を100 run集計できる', () => {
    const result = runMonteCarlo(createSampleSettings(), 100, 12_345)
    expect(result.summaries).toHaveLength(100)
    expect(result.statistics.arrivedGuests.mean).toBeGreaterThan(0)
  }, 15_000)
})

describe('Monte Carlo Scenario common seeds', () => {
  it('BaseとScenarioへ共通seed集合を適用する', () => {
    const settings = monteStore()
    settings.scenarios = [{ id: 'more-seats', name: '増席', overrides: { seatingUnitCountOverrides: { seat: 6 } } }]
    const compared = compareMonteCarloScenarios(settings, 3, 500)
    expect(compared).toHaveLength(2)
    expect(compared[0].result.summaries.map((run) => run.seed)).toEqual(compared[1].result.summaries.map((run) => run.seed))
  })

  it('Scenario客席変更がBase設定を破壊しない', () => {
    const settings = monteStore()
    settings.scenarios = [{ id: 'more-seats', name: '増席', overrides: { seatingUnitCountOverrides: { seat: 6 } } }]
    compareMonteCarloScenarios(settings, 2, 600)
    expect(settings.capacity.stochasticDemand.seatingUnits[0].count).toBe(4)
  })
})
