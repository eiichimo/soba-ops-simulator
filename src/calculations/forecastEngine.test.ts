import { describe, expect, it } from 'vitest'
import { createSampleSettings } from '../data/sampleData'
import { createEmptyOptimizationStudy } from '../data/optimizationDefaults'
import type { DemandForecast, DemandObservation, ForecastMethod } from '../models/types'
import {
  applyForecastDemandToSettings,
  buildDemandObservations,
  calculateForecastMetrics,
  compareForecastMethods,
  compareForecastSnapshotActuals,
  createDemandForecast,
  forecastDemandValue,
  forecastMenuMix,
  forecastPercentile,
  forecastPeriodDistribution,
  forecastToPlanningSettings,
  forecastToScenario,
  generateFutureForecast,
  residualForecastInterval,
  rollingForecastBacktest,
  sampleForecastDemand,
  selectBestForecastModel,
  selectTrainingObservations,
} from './forecastEngine'
import { runMonteCarlo } from './monteCarloEngine'
import { simulateMultiDay } from './multiDayEngine'
import { runOptimization } from './optimizationEngine'

const observation = (date: string, value: number, patch: Partial<DemandObservation> = {}): DemandObservation => ({
  id: `observation-${date}`,
  date,
  value,
  source: 'guestCount',
  quality: 'good',
  censoredReasons: [],
  excluded: false,
  ...patch,
})

const forecastSettings = () => ({
  ...createSampleSettings().forecastSettings,
  method: 'movingAverage' as ForecastMethod,
  windowSize: 3,
  minimumObservations: 3,
  trainingWindow: 'all' as const,
  minimumIntervalResiduals: 3,
})

const simpleForecast = (): DemandForecast => ({
  id: 'forecast-test',
  name: 'Test Forecast',
  createdAt: '2026-08-14T00:00:00.000Z',
  trainingStart: '2026-07-01',
  trainingEnd: '2026-08-13',
  targetStart: '2026-08-17',
  targetEnd: '2026-08-18',
  method: 'naive',
  settings: { ...forecastSettings(), method: 'naive', horizonDays: 2 },
  forecastPoints: [
    { date: '2026-08-17', pointForecast: 100, lower: 80, upper: 120, method: 'naive', observationCount: 1, closed: false, menuMix: [], menuMixFallback: true },
    { date: '2026-08-18', pointForecast: 90, lower: 70, upper: 110, method: 'naive', observationCount: 1, closed: false, menuMix: [], menuMixFallback: true },
  ],
  backtestSummary: {
    method: 'naive', count: 4, mae: 10, rmse: 10, bias: 0, wape: 0.1, mape: 0.1, intervalCoverage: 0.75,
    residuals: [-20, -5, 10, 25], details: [],
  },
  sourceActualPeriodIds: ['actual-history'],
})

describe('DemandObservation', () => {
  it('guestCountをsalesCountより優先する', () => {
    const settings = createSampleSettings()
    settings.actualPeriods = [{ id: 'a', name: '単日', startDate: '2026-08-01', endDate: '2026-08-01', actuals: { guestCount: 120, meals: 95, menuSales: [], resourceRecords: [], utilities: { water: {}, gas: {}, electricity: {} } } }]
    expect(buildDemandObservations(settings)[0]).toMatchObject({ value: 120, source: 'guestCount' })
  })

  it('guestCountがなければ明示需要を使う', () => {
    const settings = createSampleSettings()
    settings.actualPeriods = [{ id: 'a', name: '単日', startDate: '2026-08-01', endDate: '2026-08-01', actuals: { demandCount: 110, meals: 95, menuSales: [], resourceRecords: [], utilities: { water: {}, gas: {}, electricity: {} } } }]
    expect(buildDemandObservations(settings)[0]).toMatchObject({ value: 110, source: 'manual' })
  })

  it('来店・明示需要がなければ販売食数を需要近似にする', () => {
    const settings = createSampleSettings()
    settings.actualPeriods = [{ id: 'a', name: '単日', startDate: '2026-08-01', endDate: '2026-08-01', actuals: { meals: 95, menuSales: [], resourceRecords: [], utilities: { water: {}, gas: {}, electricity: {} } } }]
    expect(buildDemandObservations(settings)[0]).toMatchObject({ value: 95, source: 'salesCount' })
  })

  it('stockoutの販売数を補正せずcensoredにする', () => {
    const settings = createSampleSettings()
    settings.actualPeriods = [{ id: 'a', name: '単日', startDate: '2026-08-01', endDate: '2026-08-01', actuals: { meals: 80, stockoutLostMeals: 20, menuSales: [], resourceRecords: [], utilities: { water: {}, gas: {}, electricity: {} } } }]
    expect(buildDemandObservations(settings)[0]).toMatchObject({ value: 80, quality: 'censored', possibleDemandFloor: 100, censoredReasons: ['stockout'] })
  })

  it('早仕舞いをlimitedとして扱う', () => {
    const settings = createSampleSettings()
    settings.actualPeriods = [{ id: 'a', name: '単日', startDate: '2026-08-01', endDate: '2026-08-01', actuals: { meals: 40, earlyClosing: true, menuSales: [], resourceRecords: [], utilities: { water: {}, gas: {}, electricity: {} } } }]
    expect(buildDemandObservations(settings)[0].quality).toBe('limited')
  })

  it('除外設定はActualを消さずObservationだけを除外する', () => {
    const settings = createSampleSettings()
    settings.actualPeriods = [{ id: 'a', name: '単日', startDate: '2026-08-01', endDate: '2026-08-01', actuals: { meals: 40, menuSales: [], resourceRecords: [], utilities: { water: {}, gas: {}, electricity: {} } } }]
    settings.forecastExclusions = [{ date: '2026-08-01', reason: 'event' }]
    expect(buildDemandObservations(settings)[0]).toMatchObject({ excluded: true, exclusionReason: 'event', value: 40 })
    expect(settings.actualPeriods[0].actuals.meals).toBe(40)
  })
})

describe('Forecast methods', () => {
  const rows = [observation('2026-08-03', 10), observation('2026-08-04', 20), observation('2026-08-05', 30)]

  it('naiveは直近Observationを使う', () => {
    expect(forecastDemandValue(rows, '2026-08-06', { ...forecastSettings(), method: 'naive' })?.value).toBe(30)
  })

  it('3-point moving averageを計算する', () => {
    expect(forecastDemandValue(rows, '2026-08-06', forecastSettings())?.value).toBe(20)
  })

  it('window不足時にmoving averageからnaiveへfallbackする', () => {
    const result = forecastDemandValue(rows.slice(0, 2), '2026-08-06', forecastSettings())
    expect(result).toMatchObject({ value: 20, fallbackMethod: 'naive' })
  })

  it('weighted moving averageは新しい値を重くする', () => {
    const result = forecastDemandValue(rows, '2026-08-06', { ...forecastSettings(), method: 'weightedMovingAverage' })
    expect(result?.value).toBeCloseTo(140 / 6)
  })

  it('weekday averageは同じ曜日だけを使う', () => {
    const history = [observation('2026-07-20', 80), observation('2026-07-21', 50), observation('2026-07-27', 90), observation('2026-07-28', 60), observation('2026-08-03', 100), observation('2026-08-04', 70)]
    const settings = { ...forecastSettings(), method: 'weekdayAverage' as const }
    expect(forecastDemandValue(history, '2026-08-10', settings)?.value).toBe(90)
    expect(forecastDemandValue(history, '2026-08-11', settings)?.value).toBe(60)
  })

  it('weekday weighted averageは同曜日の直近値を重くする', () => {
    const history = [observation('2026-07-20', 60), observation('2026-07-27', 90), observation('2026-08-03', 120)]
    expect(forecastDemandValue(history, '2026-08-10', { ...forecastSettings(), method: 'weekdayWeightedAverage' })?.value).toBe(100)
  })

  it('weekday trendは上昇傾向を外挿する', () => {
    const history = [observation('2026-07-20', 80), observation('2026-07-27', 90), observation('2026-08-03', 100)]
    expect(forecastDemandValue(history, '2026-08-10', { ...forecastSettings(), method: 'weekdayTrend' })?.value).toBeCloseTo(110)
  })

  it('weekday trendは下降傾向を外挿する', () => {
    const history = [observation('2026-07-20', 100), observation('2026-07-27', 90), observation('2026-08-03', 80)]
    expect(forecastDemandValue(history, '2026-08-10', { ...forecastSettings(), method: 'weekdayTrend' })?.value).toBeCloseTo(70)
  })

  it('Training Windowは対象日より未来のObservationを除外する', () => {
    const selected = selectTrainingObservations([...rows, observation('2026-08-07', 999)], '2026-08-06', forecastSettings())
    expect(selected.map((item) => item.value)).toEqual([10, 20, 30])
  })

  it('censoredとlimitedを設定に応じて除外する', () => {
    const selected = selectTrainingObservations([observation('2026-08-03', 10), observation('2026-08-04', 20, { quality: 'censored' }), observation('2026-08-05', 30, { quality: 'limited' })], '2026-08-06', forecastSettings())
    expect(selected.map((item) => item.value)).toEqual([10])
  })
})

describe('Rolling-origin Backtest and metrics', () => {
  const rows = [10, 20, 30, 40].map((value, index) => observation(`2026-08-0${index + 1}`, value))
  const settings = { ...forecastSettings(), windowSize: 2, minimumObservations: 2 }

  it('2-day moving averageでDay3を15と予測する', () => {
    expect(rollingForecastBacktest(rows, settings).details.find((item) => item.date === '2026-08-03')).toMatchObject({ date: '2026-08-03', forecast: 15, actual: 30 })
  })

  it('Day4予測にDay4 Actualを使わない', () => {
    expect(rollingForecastBacktest(rows, settings).details.find((item) => item.date === '2026-08-04')).toMatchObject({ date: '2026-08-04', trainingEndDate: '2026-08-03', forecast: 25 })
  })

  it('Rolling backtestはFallbackを含む複数pointを返す', () => expect(rollingForecastBacktest(rows, settings).count).toBe(3))

  it('MAEを計算する', () => expect(calculateForecastMetrics([{ date: 'a', trainingEndDate: '', forecast: 100, actual: 90, error: 10, residual: -10, method: 'naive', observationCount: 1 }, { date: 'b', trainingEndDate: '', forecast: 80, actual: 100, error: -20, residual: 20, method: 'naive', observationCount: 1 }], 'naive').mae).toBe(15))

  it('RMSEを計算する', () => expect(calculateForecastMetrics([{ date: 'a', trainingEndDate: '', forecast: 100, actual: 90, error: 10, residual: -10, method: 'naive', observationCount: 1 }, { date: 'b', trainingEndDate: '', forecast: 80, actual: 100, error: -20, residual: 20, method: 'naive', observationCount: 1 }], 'naive').rmse).toBeCloseTo(Math.sqrt(250)))

  it('Biasはforecast minus actualで計算する', () => {
    const details = [90, 100, 110].map((actual) => ({ date: String(actual), trainingEndDate: '', forecast: 100, actual, error: 100 - actual, residual: actual - 100, method: 'naive' as const, observationCount: 1 }))
    expect(calculateForecastMetrics(details, 'naive').bias).toBe(0)
  })

  it('WAPEを計算する', () => {
    const details = [{ date: 'a', trainingEndDate: '', forecast: 100, actual: 80, error: 20, residual: -20, method: 'naive' as const, observationCount: 1 }, { date: 'b', trainingEndDate: '', forecast: 100, actual: 120, error: -20, residual: 20, method: 'naive' as const, observationCount: 1 }]
    expect(calculateForecastMetrics(details, 'naive').wape).toBeCloseTo(0.2)
  })

  it('MAPEはActual 0を除外する', () => {
    const details = [{ date: 'a', trainingEndDate: '', forecast: 10, actual: 0, error: 10, residual: -10, method: 'naive' as const, observationCount: 1 }, { date: 'b', trainingEndDate: '', forecast: 110, actual: 100, error: 10, residual: -10, method: 'naive' as const, observationCount: 1 }]
    expect(calculateForecastMetrics(details, 'naive').mape).toBeCloseTo(0.1)
  })

  it('全Modelを同じ履歴で比較する', () => expect(compareForecastMethods(rows, settings)).toHaveLength(6))

  it('選択指標が最小のModelを返す', () => {
    const summaries = compareForecastMethods(rows, settings)
    expect(selectBestForecastModel(summaries, 'mae')?.mae).toBe(Math.min(...summaries.filter((item) => item.mae !== null).map((item) => item.mae!)))
  })
})

describe('Residual interval', () => {
  it('percentileを線形補間する', () => expect(forecastPercentile([0, 10, 20], 0.25)).toBe(5))

  it('p10 residualからlowerを作る', () => expect(residualForecastInterval(100, [-20, 0, 20], forecastSettings())?.lower).toBeCloseTo(84))

  it('p90 residualからupperを作る', () => expect(residualForecastInterval(100, [-20, 0, 20], forecastSettings())?.upper).toBeCloseTo(116))

  it('lower boundを0へclipする', () => expect(residualForecastInterval(5, [-100, -50, 10], forecastSettings())?.lower).toBe(0))

  it('Residual不足ではIntervalを返さない', () => expect(residualForecastInterval(100, [-10, 10], forecastSettings())).toBeNull())

  it('CoverageをInterval付きpointだけで計算する', () => {
    const summary = calculateForecastMetrics([{ date: 'a', trainingEndDate: '', forecast: 100, actual: 100, error: 0, residual: 0, lower: 90, upper: 110, intervalCovered: true, method: 'naive', observationCount: 1 }, { date: 'b', trainingEndDate: '', forecast: 100, actual: 130, error: -30, residual: 30, lower: 90, upper: 110, intervalCovered: false, method: 'naive', observationCount: 1 }], 'naive')
    expect(summary.intervalCoverage).toBe(0.5)
  })

  it('Rolling intervalは将来Residualを使わない', () => {
    const result = rollingForecastBacktest([10, 20, 30, 40, 50].map((value, index) => observation(`2026-08-0${index + 1}`, value)), { ...forecastSettings(), windowSize: 1, minimumObservations: 1, minimumIntervalResiduals: 2 })
    expect(result.details[0].lower).toBeUndefined()
    expect(result.details[1].lower).toBeUndefined()
    expect(result.details[2].lower).toBeDefined()
  })
})

describe('Forecast snapshot and integrations', () => {
  const historicalSettings = () => {
    const settings = createSampleSettings()
    settings.business.weekdays.forEach((day) => { day.enabled = true })
    settings.forecastSettings = { ...settings.forecastSettings, method: 'movingAverage', windowSize: 3, minimumObservations: 3, trainingWindow: 'all', minimumIntervalResiduals: 2 }
    settings.actualPeriods = [10, 20, 30, 40, 50].map((meals, index) => ({ id: `a${index}`, name: `Day${index}`, startDate: `2026-08-0${index + 1}`, endDate: `2026-08-0${index + 1}`, actuals: { meals, menuSales: [{ menuItemId: settings.menuItems[index % 2].id, quantity: meals }], resourceRecords: [], utilities: { water: {}, gas: {}, electricity: {} } } }))
    return settings
  }

  it('7日Future Forecastを生成する', () => {
    const settings = historicalSettings()
    expect(generateFutureForecast(settings, buildDemandObservations(settings), '2026-08-06', 7).points).toHaveLength(7)
  })

  it('Forecast Snapshotへsource Actual IDsを保存する', () => {
    const settings = historicalSettings()
    expect(createDemandForecast(settings, 'snapshot', '2026-08-06', 2).sourceActualPeriodIds).toHaveLength(5)
  })

  it('新Actual追加後も既存Snapshotは変わらない', () => {
    const settings = historicalSettings()
    const snapshot = createDemandForecast(settings, 'snapshot', '2026-08-06', 2)
    const before = structuredClone(snapshot.forecastPoints)
    settings.actualPeriods.push({ id: 'new', name: 'new', startDate: '2026-08-06', endDate: '2026-08-06', actuals: { meals: 999, menuSales: [], resourceRecords: [], utilities: { water: {}, gas: {}, electricity: {} } } })
    expect(snapshot.forecastPoints).toEqual(before)
  })

  it('ForecastをPlanningへ渡してもBase Demandを変更しない', () => {
    const settings = createSampleSettings()
    settings.demandForecasts = [simpleForecast()]
    const baseMeals = settings.business.mealsPerDay
    const planned = forecastToPlanningSettings(settings, settings.demandForecasts[0])
    expect(planned.planning.dailyOperatingPlans.find((item) => item.date === '2026-08-17')?.mealsPerDay).toBe(100)
    expect(settings.business.mealsPerDay).toBe(baseMeals)
  })

  it('Forecast ScenarioはBaseを破壊しない', () => {
    const snapshot = simpleForecast()
    const scenario = forecastToScenario(snapshot, 'upper')
    expect(scenario.overrides.planningDailyDemandOverrides?.['2026-08-17']).toBe(120)
    expect(snapshot.forecastPoints[0].pointForecast).toBe(100)
  })

  it('Residual bootstrapは同じseedで同じ需要になる', () => {
    const snapshot = simpleForecast()
    expect(sampleForecastDemand(snapshot, '2026-08-17', 123, 'bootstrap')).toBe(sampleForecastDemand(snapshot, '2026-08-17', 123, 'bootstrap'))
  })

  it('Residual bootstrapは異なるseed集合で変動する', () => {
    const snapshot = simpleForecast()
    const values = new Set(Array.from({ length: 20 }, (_, seed) => sampleForecastDemand(snapshot, '2026-08-17', seed, 'bootstrap')))
    expect(values.size).toBeGreaterThan(1)
  })

  it('Planning Forecast sourceを既存Demand Profileへ適用する', () => {
    const settings = createSampleSettings()
    settings.business.simulationStartDate = '2026-08-17'
    settings.demandForecasts = [simpleForecast()]
    settings.planning.demandSource = { type: 'forecastSnapshot', forecastId: 'forecast-test', demandCase: 'point' }
    const applied = applyForecastDemandToSettings(settings, '2026-08-17', 1, false)
    expect(applied.business.mealsPerDay).toBe(100)
    expect(applied.capacity.demandProfile.timeSlots.reduce((total, slot) => total + slot.meals, 0)).toBeCloseTo(100)
  })

  it('Forecast Snapshotと後日Actualを比較する', () => {
    expect(compareForecastSnapshotActuals(simpleForecast(), [observation('2026-08-17', 92)])).toEqual([{ date: '2026-08-17', forecast: 100, actual: 92, error: 8 }])
  })

  it('期間Residual bootstrapを同じbaseSeedで再現する', () => {
    const first = forecastPeriodDistribution(simpleForecast(), 20, 500)
    const second = forecastPeriodDistribution(simpleForecast(), 20, 500)
    expect(first).toEqual(second)
  })

  it('Monte CarloへForecast uncertaintyを渡して同じseed集合を再現する', () => {
    const settings = createSampleSettings()
    settings.business.simulationStartDate = '2026-08-17'
    settings.capacity.demandMode = 'stochastic'
    settings.demandForecasts = [simpleForecast()]
    settings.planning.demandSource = { type: 'forecastSnapshot', forecastId: 'forecast-test', demandCase: 'bootstrap', sampleUncertainty: true }
    expect(runMonteCarlo(settings, 3, 700).summaries).toEqual(runMonteCarlo(settings, 3, 700).summaries)
  })

  it('複数日Planningが日別Forecast Pointを需要として使う', () => {
    const settings = createSampleSettings()
    settings.business.simulationStartDate = '2026-08-17'
    settings.capacity.demandMode = 'deterministic'
    settings.demandForecasts = [simpleForecast()]
    settings.planning.demandSource = { type: 'forecastSnapshot', forecastId: 'forecast-test', demandCase: 'point' }
    const result = simulateMultiDay(settings, { horizonDays: 2, stochastic: false })
    expect(result.dailyResults[0].demandMeals).toBe(100)
    expect(result.dailyResults[1].demandMeals).toBeGreaterThanOrEqual(90)
    expect(result.dailyResults[1].demandMeals).toBeLessThanOrEqual(91)
  })

  it('OptimizationでForecast Snapshotと共通seedを再利用する', () => {
    const settings = createSampleSettings()
    settings.business.simulationStartDate = '2026-08-17'
    settings.capacity.demandMode = 'stochastic'
    settings.demandForecasts = [simpleForecast()]
    const study = createEmptyOptimizationStudy('forecast-study')
    study.evaluationMode = 'monteCarlo'
    study.monteCarloRuns = 2
    study.demandForecastId = 'forecast-test'
    study.forecastDemandCase = 'bootstrap'
    study.sampleForecastUncertainty = true
    study.variables = [{ id: 'staff', name: 'Staff', type: 'staffShiftHeadcount', targetId: settings.capacity.staffShifts[0].id, values: [settings.capacity.staffShifts[0].headcount] }]
    expect(runOptimization(settings, study).candidates).toEqual(runOptimization(settings, study).candidates)
  })

  it('曜日別Menu Mixを100%へ正規化する', () => {
    const settings = createSampleSettings()
    const rows = [observation('2026-08-03', 10, { menuCounts: [{ menuItemId: 'a', quantity: 3 }, { menuItemId: 'b', quantity: 7 }] }), observation('2026-08-10', 20, { menuCounts: [{ menuItemId: 'a', quantity: 10 }, { menuItemId: 'b', quantity: 10 }] })]
    const result = forecastMenuMix(settings, rows, '2026-08-17', { ...forecastSettings(), menuMixMethod: 'weekday' })
    expect(result.menuMix.reduce((total, item) => total + item.ratio, 0)).toBeCloseTo(1)
    expect(result.fallback).toBe(false)
  })

  it('Menu履歴不足時はBase Mixへfallbackする', () => {
    const settings = createSampleSettings()
    const result = forecastMenuMix(settings, [observation('2026-08-03', 10)], '2026-08-17', forecastSettings())
    expect(result.fallback).toBe(true)
    expect(result.menuMix.reduce((total, item) => total + item.ratio, 0)).toBeCloseTo(1)
  })
})
