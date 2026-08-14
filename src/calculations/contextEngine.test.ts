import { describe, expect, it } from 'vitest'
import { createSampleSettings } from '../data/sampleData'
import { createEmptyOptimizationStudy } from '../data/optimizationDefaults'
import type { ContextForecastSettings, DayContext, DemandForecast, DemandObservation } from '../models/types'
import {
  applyContextEffects,
  buildContextWarnings,
  calculateContextEffects,
  contextKeysForDate,
  precipitationBucket,
  temperatureBucket,
  type ContextResidualRecord,
} from './contextEngine'
import {
  applyForecastDemandToSettings,
  createDemandForecast,
  forecastToPlanningSettings,
  rollingContextForecastBacktest,
  sampleForecastDemand,
} from './forecastEngine'
import { runMonteCarlo } from './monteCarloEngine'
import { runOptimization } from './optimizationEngine'

const observation = (date: string, value: number, patch: Partial<DemandObservation> = {}): DemandObservation => ({
  id: `obs-${date}`,
  date,
  value,
  source: 'guestCount',
  quality: 'good',
  censoredReasons: [],
  excluded: false,
  ...patch,
})

const context = (date: string, patch: Partial<DayContext> = {}): DayContext => ({
  date,
  source: 'manual',
  holidayType: 'none',
  events: [],
  specialBusinessDay: 'normal',
  ...patch,
})

const residual = (date: string, value: number): ContextResidualRecord => ({ date, actual: 100 + value, baseForecast: 100, residual: value })

const contextSettings = (): ContextForecastSettings => ({
  ...createSampleSettings().contextForecastSettings,
  enabledContexts: ['weather'],
  minimumContextObservations: 3,
})

const alternatingFixture = () => {
  const settings = createSampleSettings()
  settings.business.weekdays.forEach((day) => { day.enabled = true })
  settings.forecastSettings = { ...settings.forecastSettings, method: 'naive', minimumObservations: 1, windowSize: 1, trainingWindow: 'all', minimumIntervalResiduals: 2 }
  settings.contextForecastSettings = { ...settings.contextForecastSettings, enabledContexts: ['weather'], minimumContextObservations: 1 }
  settings.dayContexts = ['2026-08-02', '2026-08-04', '2026-08-06', '2026-08-07'].map((date) => context(date, { weatherCategory: 'rain' }))
  const observations = [100, 90, 100, 90, 100, 90].map((value, index) => observation(`2026-08-0${index + 1}`, value))
  return { settings, observations }
}

const snapshot = (): DemandForecast => ({
  id: 'context-forecast', name: 'Context Forecast', createdAt: '2026-08-14T00:00:00.000Z', trainingStart: '2026-08-01', trainingEnd: '2026-08-06', targetStart: '2026-08-07', targetEnd: '2026-08-07', method: 'naive',
  settings: { ...createSampleSettings().forecastSettings, method: 'naive', horizonDays: 1 },
  forecastPoints: [{ date: '2026-08-07', baseForecast: 100, pointForecast: 90, adjustedForecast: 90, contextAdjustments: [{ contextKey: 'weather:rain', label: '天気 rain', adjustment: -10, observationCount: 3, standardDeviation: 0, sufficientData: true }], lower: 80, upper: 105, method: 'naive', observationCount: 1, closed: false, menuMix: [], menuMixFallback: true }],
  backtestSummary: { method: 'naive', count: 3, mae: 2, rmse: 2, bias: 0, wape: 0.02, mape: 0.02, intervalCoverage: 1, residuals: [-2, 0, 2], details: [] },
  sourceActualPeriodIds: [], contextEnabled: true, contextSettings: contextSettings(), contextEffects: [],
})

describe('DayContext feature extraction', () => {
  it('manual contextを保持する', () => expect(context('2026-08-01').source).toBe('manual'))
  it('imported contextを保持する', () => expect(context('2026-08-01', { source: 'imported' }).source).toBe('imported'))
  it('holidayをContext keyにする', () => expect(contextKeysForDate(context('2026-08-01', { holidayType: 'holiday' }), [], '2026-08-01', { ...contextSettings(), enabledContexts: ['holiday'] })[0].key).toBe('holiday:holiday'))
  it('weatherをContext keyにする', () => expect(contextKeysForDate(context('2026-08-01', { weatherCategory: 'rain' }), [], '2026-08-01', contextSettings())[0].key).toBe('weather:rain'))
  it('Event Tagを個別keyにする', () => {
    const tags = [{ id: 'festival', name: '地域祭り', category: 'event' as const }]
    expect(contextKeysForDate(context('2026-08-01', { events: [{ tagId: 'festival', importance: 'high' }] }), tags, '2026-08-01', { ...contextSettings(), enabledContexts: ['event'] })).toEqual([{ key: 'event:festival', label: 'Event 地域祭り' }])
  })
  it('unknown Weatherは補正keyを作らない', () => expect(contextKeysForDate(context('2026-08-01', { weatherCategory: 'unknown' }), [], '2026-08-01', contextSettings())).toEqual([]))
  it('Context occurrence除外時はkeyを作らない', () => expect(contextKeysForDate(context('2026-08-01', { weatherCategory: 'rain', excludedFromEffect: true }), [], '2026-08-01', contextSettings())).toEqual([]))
  it('月初・月末を日付から判定する', () => {
    const settings: ContextForecastSettings = { ...contextSettings(), enabledContexts: ['monthStart', 'monthEnd'] }
    expect(contextKeysForDate(undefined, [], '2026-08-01', settings).map((item) => item.key)).toContain('monthStart:true')
    expect(contextKeysForDate(undefined, [], '2026-08-31', settings).map((item) => item.key)).toContain('monthEnd:true')
  })
  it('特殊営業をStore keyにする', () => expect(contextKeysForDate(context('2026-08-01', { specialBusinessDay: 'shortened' }), [], '2026-08-01', { ...contextSettings(), enabledContexts: ['store'] })[0].key).toBe('store:shortened'))
  it('気温Bucket境界を固定する', () => expect([temperatureBucket(9.9), temperatureBucket(10), temperatureBucket(20), temperatureBucket(30)]).toEqual(['under10', '10to20', '20to30', '30plus']))
  it('降水量Bucket境界を固定する', () => expect([precipitationBucket(0), precipitationBucket(1), precipitationBucket(5), precipitationBucket(20)]).toEqual(['zero', 'under5', '5to20', '20plus']))
})

describe('Context Effect', () => {
  const rainy = ['2026-08-03', '2026-08-10', '2026-08-17'].map((date) => context(date, { weatherCategory: 'rain' }))
  it('Rain fixtureの平均Residualを-10とする', () => expect(calculateContextEffects([residual('2026-08-03', -10), residual('2026-08-10', -15), residual('2026-08-17', -5)], rainy, [], contextSettings())[0].meanResidual).toBe(-10))
  it('正のHoliday Effectを算出する', () => {
    const rows = ['2026-08-03', '2026-08-10', '2026-08-17'].map((date) => context(date, { holidayType: 'holiday' }))
    const result = calculateContextEffects([residual(rows[0].date, 20), residual(rows[1].date, 10), residual(rows[2].date, 30)], rows, [], { ...contextSettings(), enabledContexts: ['holiday'] })
    expect(result[0].meanResidual).toBe(20)
  })
  it('負のEffectを算出する', () => expect(calculateContextEffects([residual('2026-08-03', -20), residual('2026-08-10', -10), residual('2026-08-17', -30)], rainy, [], contextSettings())[0].meanResidual).toBe(-20))
  it('最低件数未満は補正へ使わない', () => expect(calculateContextEffects([residual('2026-08-03', -10)], rainy, [], contextSettings())[0].sufficientData).toBe(false))
  it('標準偏差とmin/maxを保持する', () => expect(calculateContextEffects([residual('2026-08-03', -10), residual('2026-08-10', -15), residual('2026-08-17', -5)], rainy, [], contextSettings())[0]).toMatchObject({ minimumResidual: -15, maximumResidual: -5 }))
  it('曜日分布を保持する', () => expect(calculateContextEffects([residual('2026-08-03', -10), residual('2026-08-11', -10), residual('2026-08-19', -10)], rainy.map((item, index) => ({ ...item, date: ['2026-08-03', '2026-08-11', '2026-08-19'][index] })), [], contextSettings())[0].weekdays).toHaveLength(3))
  it('Holiday + Rainを加算する', () => {
    const effects = [
      { ...calculateContextEffects([residual('2026-08-03', 20), residual('2026-08-10', 20), residual('2026-08-17', 20)], rainy.map((item) => ({ ...item, holidayType: 'holiday' })), [], { ...contextSettings(), enabledContexts: ['holiday'] })[0], contextKey: 'holiday:holiday', label: '祝日' },
      calculateContextEffects([residual('2026-08-03', -10), residual('2026-08-10', -10), residual('2026-08-17', -10)], rainy, [], contextSettings())[0],
    ]
    const adjusted = applyContextEffects(100, '2026-08-24', context('2026-08-24', { holidayType: 'holiday', weatherCategory: 'rain' }), [], effects, { ...contextSettings(), enabledContexts: ['holiday', 'weather'] })
    expect(adjusted.adjustedForecast).toBe(110)
  })
  it('補正後の負需要を0へclipする', () => {
    const effect = calculateContextEffects([residual('2026-08-03', -100), residual('2026-08-10', -100), residual('2026-08-17', -100)], rainy, [], contextSettings())
    expect(applyContextEffects(20, '2026-08-24', context('2026-08-24', { weatherCategory: 'rain' }), [], effect, contextSettings()).adjustedForecast).toBe(0)
  })
  it('任意Capを明示設定時だけ適用する', () => {
    const effect = calculateContextEffects([residual('2026-08-03', -100), residual('2026-08-10', -100), residual('2026-08-17', -100)], rainy, [], contextSettings())
    expect(applyContextEffects(100, '2026-08-24', context('2026-08-24', { weatherCategory: 'rain' }), [], effect, { ...contextSettings(), adjustmentCapEnabled: true, maximumAbsoluteAdjustment: 30 }).adjustedForecast).toBe(70)
  })
  it('無効Featureを補正へ使わない', () => expect(applyContextEffects(100, '2026-08-24', context('2026-08-24', { weatherCategory: 'rain' }), [], [], { ...contextSettings(), enabledContexts: [] }).adjustments).toEqual([]))
})

describe('Context-aware rolling backtest', () => {
  it('Base residualで曜日水準を先に扱う', () => {
    const { settings, observations } = alternatingFixture()
    const firstRain = rollingContextForecastBacktest(settings, observations).base.details.find((item) => item.date === '2026-08-02')
    expect(firstRain).toMatchObject({ baseForecast: 100, residual: -10 })
  })
  it('Context補正をRolling forecastへ適用する', () => {
    const { settings, observations } = alternatingFixture()
    expect(rollingContextForecastBacktest(settings, observations).context.details.find((item) => item.date === '2026-08-04')?.forecast).toBe(90)
  })
  it('未来Actualを過去Forecastへ使用しない', () => {
    const { settings, observations } = alternatingFixture()
    const before = rollingContextForecastBacktest(settings, observations.slice(0, 4)).context.details.find((item) => item.date === '2026-08-04')
    const after = rollingContextForecastBacktest(settings, [...observations, observation('2026-08-08', 999)]).context.details.find((item) => item.date === '2026-08-04')
    expect(after).toEqual(before)
  })
  it('未来Context Effectを過去Forecastへ使用しない', () => {
    const { settings, observations } = alternatingFixture()
    const before = rollingContextForecastBacktest(settings, observations).context.details.find((item) => item.date === '2026-08-04')
    settings.dayContexts.push(context('2026-08-20', { weatherCategory: 'rain' }))
    const after = rollingContextForecastBacktest(settings, observations).context.details.find((item) => item.date === '2026-08-04')
    expect(after).toEqual(before)
  })
  it('ContextでMAEが改善するfixture', () => {
    const { settings, observations } = alternatingFixture()
    expect(rollingContextForecastBacktest(settings, observations).improvement.mae).toBeGreaterThan(0)
  })
  it('ContextでMAEが悪化する場合も負値で返す', () => {
    const { settings } = alternatingFixture()
    const observations = [100, 120, 100, 80, 100, 80].map((value, index) => observation(`2026-08-0${index + 1}`, value))
    expect(rollingContextForecastBacktest(settings, observations).improvement.mae).toBeLessThan(0)
  })
  it('censored設定をContext推定で尊重する', () => {
    const { settings, observations } = alternatingFixture()
    observations[1] = observation('2026-08-02', 90, { quality: 'censored', censoredReasons: ['stockout'] })
    settings.contextForecastSettings.includeCensored = false
    const excluded = rollingContextForecastBacktest(settings, observations).base.details.some((item) => item.date === '2026-08-02')
    settings.contextForecastSettings.includeCensored = true
    const included = rollingContextForecastBacktest(settings, observations).base.details.some((item) => item.date === '2026-08-02')
    expect([excluded, included]).toEqual([false, true])
  })
})

describe('Context Forecast snapshot and downstream integration', () => {
  const historicalSettings = () => {
    const { settings, observations } = alternatingFixture()
    settings.actualPeriods = observations.map((item) => ({ id: item.id, name: item.date, startDate: item.date, endDate: item.date, actuals: { guestCount: item.value, menuSales: [], resourceRecords: [], utilities: { water: {}, gas: {}, electricity: {} } } }))
    return settings
  }

  it('Future holiday / weather Context Contributionを保存する', () => {
    const settings = historicalSettings()
    const created = createDemandForecast(settings, 'Context', '2026-08-07', 1, 'naive')
    expect(created.forecastPoints[0].contextAdjustments?.[0]).toMatchObject({ contextKey: 'weather:rain', adjustment: -10 })
    expect(created.contextEnabled).toBe(true)
  })
  it('Snapshot作成後にContext履歴を変えてもimmutable', () => {
    const settings = historicalSettings()
    const created = createDemandForecast(settings, 'Context', '2026-08-07', 1, 'naive')
    const before = structuredClone(created)
    settings.dayContexts.push(context('2026-08-08', { weatherCategory: 'snow' }))
    expect(created).toEqual(before)
  })
  it('Context-adjusted ForecastをPlanningへ渡してBaseを破壊しない', () => {
    const settings = createSampleSettings()
    settings.demandForecasts = [snapshot()]
    const base = settings.business.mealsPerDay
    const planned = forecastToPlanningSettings(settings, settings.demandForecasts[0])
    expect(planned.planning.dailyOperatingPlans[0].mealsPerDay).toBe(90)
    expect(settings.business.mealsPerDay).toBe(base)
  })
  it('Context-adjusted PointをDemand Engineへ適用する', () => {
    const settings = createSampleSettings()
    settings.demandForecasts = [snapshot()]
    settings.planning.demandSource = { type: 'forecastSnapshot', forecastId: 'context-forecast', demandCase: 'point' }
    expect(applyForecastDemandToSettings(settings, '2026-08-07', 1, false).business.mealsPerDay).toBe(90)
  })
  it('Context-aware residual bootstrapを同じseedで再現する', () => expect(sampleForecastDemand(snapshot(), '2026-08-07', 77, 'bootstrap')).toBe(sampleForecastDemand(snapshot(), '2026-08-07', 77, 'bootstrap')))
  it('Monte CarloでContext Forecastを再現する', () => {
    const settings = createSampleSettings()
    settings.business.simulationStartDate = '2026-08-07'
    settings.capacity.demandMode = 'stochastic'
    settings.demandForecasts = [snapshot()]
    settings.planning.demandSource = { type: 'forecastSnapshot', forecastId: 'context-forecast', demandCase: 'bootstrap', sampleUncertainty: true }
    expect(runMonteCarlo(settings, 2, 55).summaries).toEqual(runMonteCarlo(settings, 2, 55).summaries)
  })
  it('OptimizationでCommon Random Numbersを維持する', () => {
    const settings = createSampleSettings()
    settings.business.simulationStartDate = '2026-08-07'
    settings.capacity.demandMode = 'stochastic'
    settings.demandForecasts = [snapshot()]
    const study = createEmptyOptimizationStudy('context')
    study.evaluationMode = 'monteCarlo'; study.monteCarloRuns = 2; study.demandForecastId = 'context-forecast'; study.forecastDemandCase = 'bootstrap'; study.sampleForecastUncertainty = true
    study.variables = [{ id: 'staff', name: 'staff', type: 'staffShiftHeadcount', targetId: settings.capacity.staffShifts[0].id, values: [settings.capacity.staffShifts[0].headcount] }]
    expect(runOptimization(settings, study).evaluationSeeds).toEqual(runOptimization(settings, study).evaluationSeeds)
  })
})

describe('Context warnings', () => {
  it('HolidayとLong Weekendの重複を警告する', () => {
    const settings = createSampleSettings(); settings.contextForecastSettings.enabledContexts = ['holiday', 'longWeekend']
    expect(buildContextWarnings(settings, [], []).map((item) => item.code)).toContain('overlapping-calendar-contexts')
  })
  it('WeatherとPrecipitationの重複を警告する', () => {
    const settings = createSampleSettings(); settings.contextForecastSettings.enabledContexts = ['weather', 'precipitation']
    expect(buildContextWarnings(settings, [], []).map((item) => item.code)).toContain('overlapping-weather-contexts')
  })
  it('Backtest悪化を警告する', () => expect(buildContextWarnings(createSampleSettings(), [], [], 5, 6).map((item) => item.code)).toContain('context-backtest-worsened'))
  it('販売数近似依存を警告する', () => expect(buildContextWarnings(createSampleSettings(), [observation('2026-08-01', 100, { source: 'salesCount' })], []).map((item) => item.code)).toContain('context-sales-proxy'))
})
