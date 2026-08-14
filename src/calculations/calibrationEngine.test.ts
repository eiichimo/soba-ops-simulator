import { describe, expect, it } from 'vitest'
import { createBenchmarkStore } from './fixtures/benchmarkStore'
import { createSampleSettings } from '../data/sampleData'
import type { ActualPeriod, AppSettings, BacktestResult } from '../models/types'
import {
  applyCalibrationCandidate,
  buildCalibrationCandidates,
  buildCalibrationWarnings,
  calculateBacktestAccuracy,
  calibrationCandidateToScenario,
  compareCalibrationScenarioBacktests,
  revertCalibration,
  runBacktest,
  runBacktests,
} from './calibrationEngine'
import { applyScenarioOverrides } from './decisionSupport'

const actual = (id: string, patch: Partial<ActualPeriod['actuals']> = {}): ActualPeriod => ({
  id,
  name: id,
  startDate: '2026-08-01',
  endDate: '2026-08-31',
  actuals: {
    menuSales: [], resourceRecords: [], laborRecords: [], wasteRecords: [], inventoryRecords: [],
    utilities: { water: {}, gas: {}, electricity: {} },
    ...patch,
  },
})

const calibrationStore = (): AppSettings => {
  const settings = createSampleSettings()
  settings.utilities.electricity.unitPrice = 30
  settings.actualPeriods = [
    actual('A', { utilities: { water: {}, gas: {}, electricity: { quantity: 1_000, cost: 32_000 } } }),
    actual('B', { utilities: { water: {}, gas: {}, electricity: { quantity: 2_000, cost: 62_000 } } }),
  ]
  return settings
}

describe('Calibration Candidate', () => {
  it('光熱費を複数期間の使用量加重平均で校正する', () => {
    const candidate = buildCalibrationCandidates(calibrationStore()).find((item) => item.targetId === 'electricity')!
    expect(candidate.suggestedValue).toBeCloseTo(94_000 / 3_000)
    expect(candidate.evidence).toMatchObject({ totalAmount: 94_000, totalQuantity: 3_000, periodCount: 2 })
  })

  it('Resource購入単価を単位換算後数量で加重平均する', () => {
    const settings = createSampleSettings(); const resource = settings.resources[0]
    resource.purchaseQuantity = 10; resource.purchaseUnit = 'kg'; resource.purchasePrice = 10_000
    settings.actualPeriods = [
      actual('A', { resourceRecords: [{ resourceId: resource.id, purchasedQuantity: 10, purchaseUnit: 'kg', purchaseExpenditure: 6_000 }] }),
      actual('B', { resourceRecords: [{ resourceId: resource.id, purchasedQuantity: 20, purchaseUnit: 'kg', purchaseExpenditure: 13_000 }] }),
    ]
    const candidate = buildCalibrationCandidates(settings).find((item) => item.targetId === resource.id)!
    expect(candidate.suggestedValue).toBeCloseTo(19_000 / 30)
    expect(candidate.currentValue).toBe(1_000)
  })

  it('Resource異単位Actualを購入単位へ換算する', () => {
    const settings = createSampleSettings(); const resource = settings.resources[0]
    resource.purchaseQuantity = 10; resource.purchaseUnit = 'kg'; resource.purchasePrice = 10_000
    settings.actualPeriods = [actual('A', { resourceRecords: [{ resourceId: resource.id, purchasedQuantity: 1_000, purchaseUnit: 'g', purchaseExpenditure: 700 }] })]
    expect(buildCalibrationCandidates(settings).find((item) => item.targetId === resource.id)?.suggestedValue).toBeCloseTo(700)
  })

  it('Role別実績から平均時給候補を作る', () => {
    const settings = createSampleSettings(); const role = settings.labor[0]
    settings.actualPeriods = [actual('A', { laborRecords: [{ laborRoleId: role.id, hours: 10, cost: 16_000 }] })]
    const candidate = buildCalibrationCandidates(settings).find((item) => item.targetType === 'laborHourlyWage')!
    expect(candidate.suggestedValue).toBe(1_600)
  })

  it('Role別情報がなく複数RoleならStaff時給を推定しない', () => {
    const settings = createSampleSettings()
    settings.actualPeriods = [actual('A', { laborHours: 10, laborCost: 16_000 })]
    expect(buildCalibrationCandidates(settings).filter((item) => item.targetType === 'laborHourlyWage')).toHaveLength(0)
  })

  it('1期間low・3期間medium・6期間highのconfidenceを返す', () => {
    const settings = calibrationStore()
    settings.actualPeriods = settings.actualPeriods.slice(0, 1)
    expect(buildCalibrationCandidates(settings)[0].confidence).toBe('low')
    settings.actualPeriods = Array.from({ length: 3 }, (_, index) => actual(String(index), { utilities: { water: {}, gas: {}, electricity: { quantity: 1, cost: 30 } } }))
    expect(buildCalibrationCandidates(settings)[0].confidence).toBe('medium')
    settings.actualPeriods = Array.from({ length: 6 }, (_, index) => actual(String(index), { utilities: { water: {}, gas: {}, electricity: { quantity: 1, cost: 30 } } }))
    expect(buildCalibrationCandidates(settings)[0].confidence).toBe('high')
  })

  it('選択ActualPeriodだけを候補へ使用する', () => {
    const settings = calibrationStore()
    const candidate = buildCalibrationCandidates(settings, ['A']).find((item) => item.targetId === 'electricity')!
    expect(candidate.suggestedValue).toBe(32)
    expect(candidate.sourceActualPeriodIds).toEqual(['A'])
  })

  it('販売食数を潜在需要と断定せず確認候補にする', () => {
    const settings = createSampleSettings()
    settings.actualPeriods = [actual('A', { meals: 830, operatingDays: 10 })]
    const candidate = buildCalibrationCandidates(settings).find((item) => item.targetType === 'demandMeals')!
    expect(candidate.suggestedValue).toBe(83)
    expect(candidate.evidence.description).toMatch(/潜在需要ではありません/)
  })

  it('Menu平均価格は情報表示のみとする', () => {
    const settings = createSampleSettings(); const menu = settings.menuItems[0]
    settings.actualPeriods = [actual('A', { menuSales: [{ menuItemId: menu.id, quantity: 10, revenue: 8_500 }] })]
    const candidate = buildCalibrationCandidates(settings).find((item) => item.targetType === 'menuAveragePrice')!
    expect(candidate.suggestedValue).toBe(850)
    expect(candidate.informationalOnly).toBe(true)
  })

  it('対象期間不足・大差・外れ値をWarningにするが除外しない', () => {
    const settings = calibrationStore()
    settings.calibrationSettings.minimumPeriods = 3
    settings.actualPeriods.push(actual('C', { utilities: { water: {}, gas: {}, electricity: { quantity: 1_000, cost: 100_000 } } }))
    const candidates = buildCalibrationCandidates(settings)
    const warnings = buildCalibrationWarnings(settings, candidates)
    expect(warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining(['large-variance', 'outlier']))
    expect(candidates.find((item) => item.targetId === 'electricity')?.sourceActualPeriodIds).toHaveLength(3)
  })
})

describe('Calibration Scenario / apply / history', () => {
  it('Candidate生成だけではBaseを変更しない', () => {
    const settings = calibrationStore(); const before = settings.utilities.electricity.unitPrice
    buildCalibrationCandidates(settings)
    expect(settings.utilities.electricity.unitPrice).toBe(before)
  })

  it('Calibration ScenarioはBaseを破壊せずOverrideする', () => {
    const settings = calibrationStore(); const candidate = buildCalibrationCandidates(settings).find((item) => item.targetId === 'electricity')!
    const scenario = calibrationCandidateToScenario(candidate, '2026-09-01T00:00:00.000Z')
    const changed = applyScenarioOverrides(settings, scenario)
    expect(changed.utilities.electricity.unitPrice).toBeCloseTo(candidate.suggestedValue)
    expect(settings.utilities.electricity.unitPrice).toBe(30)
  })

  it('Resource Candidate Scenarioをpackage価格倍率へ変換する', () => {
    const settings = createSampleSettings(); const resource = settings.resources[0]
    settings.actualPeriods = [actual('A', { resourceRecords: [{ resourceId: resource.id, purchasedQuantity: 1_000, purchaseUnit: resource.purchaseUnit, purchaseExpenditure: 900 }] })]
    const candidate = buildCalibrationCandidates(settings).find((item) => item.targetId === resource.id)!
    const changed = applyScenarioOverrides(settings, calibrationCandidateToScenario(candidate))
    expect(changed.resources[0].purchasePrice / changed.resources[0].purchaseQuantity).toBeCloseTo(candidate.suggestedValue)
  })

  it('Role別時給Scenarioは他Roleを変更しない', () => {
    const settings = createSampleSettings(); const role = settings.labor[0]; const other = settings.labor[1]
    settings.actualPeriods = [actual('A', { laborRecords: [{ laborRoleId: role.id, hours: 10, cost: 20_000 }] })]
    const candidate = buildCalibrationCandidates(settings).find((item) => item.targetType === 'laborHourlyWage')!
    const changed = applyScenarioOverrides(settings, calibrationCandidateToScenario(candidate))
    expect(changed.labor.find((item) => item.id === role.id)?.hourlyWage).toBe(2_000)
    expect(changed.labor.find((item) => item.id === other.id)?.hourlyWage).toBe(other.hourlyWage)
  })

  it('明示Base適用で値と履歴を保存する', () => {
    const settings = calibrationStore(); const candidate = buildCalibrationCandidates(settings).find((item) => item.targetId === 'electricity')!
    const changed = applyCalibrationCandidate(settings, candidate, '2026-09-01T00:00:00.000Z')
    expect(changed.utilities.electricity.unitPrice).toBeCloseTo(candidate.suggestedValue)
    expect(changed.calibrationHistory[0]).toMatchObject({ previousValue: 30, newValue: candidate.suggestedValue, sourceActualPeriodIds: ['A', 'B'] })
  })

  it('Resource Base適用は平均単価だけをpackage価格へ反映する', () => {
    const settings = createSampleSettings(); const resource = settings.resources[0]
    settings.actualPeriods = [actual('A', { resourceRecords: [{ resourceId: resource.id, purchasedQuantity: resource.purchaseQuantity, purchaseUnit: resource.purchaseUnit, purchaseExpenditure: 900 }] })]
    const candidate = buildCalibrationCandidates(settings).find((item) => item.targetId === resource.id)!
    const changed = applyCalibrationCandidate(settings, candidate)
    expect(changed.resources[0].purchasePrice).toBeCloseTo(candidate.suggestedValue * resource.purchaseQuantity)
    expect(changed.resources[0].minimumPurchaseLot).toBe(resource.minimumPurchaseLot)
  })

  it('Calibration Historyから直前値へRevertする', () => {
    const settings = calibrationStore(); const candidate = buildCalibrationCandidates(settings).find((item) => item.targetId === 'electricity')!
    const changed = applyCalibrationCandidate(settings, candidate)
    const reverted = revertCalibration(changed, changed.calibrationHistory[0].id, '2026-09-02T00:00:00.000Z')
    expect(reverted.utilities.electricity.unitPrice).toBe(30)
    expect(reverted.calibrationHistory[0].revertedAt).toBeTruthy()
  })

  it('適用後の手動変更がある場合はRevertを拒否する', () => {
    const settings = calibrationStore(); const candidate = buildCalibrationCandidates(settings).find((item) => item.targetId === 'electricity')!
    const changed = applyCalibrationCandidate(settings, candidate)
    changed.utilities.electricity.unitPrice = 99
    expect(() => revertCalibration(changed, changed.calibrationHistory[0].id)).toThrow(/安全にRevert/)
  })

  it('情報表示のみMenu Candidateの適用を拒否する', () => {
    const settings = createSampleSettings(); const menu = settings.menuItems[0]
    settings.actualPeriods = [actual('A', { menuSales: [{ menuItemId: menu.id, quantity: 1, revenue: 500 }] })]
    const candidate = buildCalibrationCandidates(settings).find((item) => item.targetType === 'menuAveragePrice')!
    expect(() => applyCalibrationCandidate(settings, candidate)).toThrow(/情報表示のみ/)
  })
})

describe('Backtest / accuracy', () => {
  const benchmarkPeriod = (endDate = '2026-01-05') => actual('benchmark', {
    revenue: endDate === '2026-01-05' ? 90_000 : 180_000,
    meals: endDate === '2026-01-05' ? 90 : 180,
    laborCost: endDate === '2026-01-05' ? 22_000 : 44_000,
  })

  it('単一ActualPeriodを現在モデルでBacktestする', () => {
    const settings = createBenchmarkStore('2026-01-05')
    const period = benchmarkPeriod(); period.startDate = '2026-01-05'; period.endDate = '2026-01-05'
    const result = runBacktest(settings, period)
    expect(result.metrics.find((metric) => metric.key === 'revenue')).toMatchObject({ predicted: 100_000, actual: 90_000, error: 10_000, absoluteError: 10_000 })
    expect(result.metrics.find((metric) => metric.key === 'laborCost')).toMatchObject({ predicted: 12_000, actual: 22_000, error: -10_000 })
  })

  it('複数日ActualPeriodはMulti-day Engineで連続評価する', () => {
    const settings = createBenchmarkStore('2026-01-05')
    const period = benchmarkPeriod('2026-01-06'); period.startDate = '2026-01-05'; period.endDate = '2026-01-06'
    expect(runBacktest(settings, period).metrics.find((metric) => metric.key === 'revenue')?.predicted).toBe(200_000)
  })

  it('複数期間Backtestを選択IDで絞る', () => {
    const settings = createBenchmarkStore('2026-01-05')
    const a = benchmarkPeriod(); a.id = 'A'; a.startDate = a.endDate = '2026-01-05'
    const b = benchmarkPeriod(); b.id = 'B'; b.startDate = b.endDate = '2026-01-06'
    settings.actualPeriods = [a, b]
    expect(runBacktests(settings, ['B'])).toHaveLength(1)
    expect(runBacktests(settings, ['B'])[0].actualPeriodId).toBe('B')
  })

  it('MAEとMAPEを手計算どおり集計する', () => {
    const rows = (id: string, predicted: number, actualValue: number): BacktestResult => ({ actualPeriodId: id, actualPeriodName: id, startDate: '', endDate: '', modelLabel: 'test', metrics: [{ key: 'revenue', label: '売上', predicted, actual: actualValue, error: predicted - actualValue, absoluteError: Math.abs(predicted - actualValue), absolutePercentageError: actualValue === 0 ? null : Math.abs(predicted - actualValue) / actualValue }] })
    const accuracy = calculateBacktestAccuracy([rows('A', 100, 80), rows('B', 100, 120)]).find((metric) => metric.key === 'revenue')!
    expect(accuracy.mae).toBe(20)
    expect(accuracy.mape).toBeCloseTo((0.25 + 1 / 6) / 2)
  })

  it('Actual 0をMAPEから除外するがMAEには含める', () => {
    const result: BacktestResult = { actualPeriodId: 'A', actualPeriodName: 'A', startDate: '', endDate: '', modelLabel: 'test', metrics: [{ key: 'revenue', label: '売上', predicted: 10, actual: 0, error: 10, absoluteError: 10, absolutePercentageError: null }] }
    const accuracy = calculateBacktestAccuracy([result]).find((metric) => metric.key === 'revenue')!
    expect(accuracy.mae).toBe(10)
    expect(accuracy.mape).toBeNull()
    expect(accuracy.mapeSampleCount).toBe(0)
  })

  it('未入力Actualは0扱いせずaccuracy対象外にする', () => {
    const settings = createBenchmarkStore('2026-01-05'); const period = actual('empty'); period.startDate = period.endDate = '2026-01-05'
    const result = runBacktest(settings, period)
    expect(result.metrics.find((metric) => metric.key === 'revenue')?.actual).toBeNull()
    expect(calculateBacktestAccuracy([result]).find((metric) => metric.key === 'revenue')?.sampleCount).toBe(0)
  })

  it('BaseとCalibration ScenarioのBacktest精度を並べる', () => {
    const settings = createBenchmarkStore('2026-01-05'); const period = benchmarkPeriod(); period.startDate = period.endDate = '2026-01-05'; settings.actualPeriods = [period]
    const scenario = { id: 'calibrated', name: 'Calibrated', overrides: { business: { mealsPerDay: 90 } } }
    const comparison = compareCalibrationScenarioBacktests(settings, scenario)
    const baseMae = comparison.baseAccuracy.find((metric) => metric.key === 'revenue')?.mae
    const calibratedMae = comparison.calibratedAccuracy.find((metric) => metric.key === 'revenue')?.mae
    expect(baseMae).toBe(10_000)
    expect(calibratedMae).toBe(0)
  })
})
