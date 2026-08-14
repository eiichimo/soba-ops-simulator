import type {
  ActualDailyDemandRecord,
  AppSettings,
  DemandForecast,
  DemandObservation,
  ForecastBacktestPoint,
  ForecastBacktestSummary,
  ForecastDemandCase,
  ForecastMenuMix,
  ForecastMethod,
  ForecastPoint,
  ForecastSelectionMetric,
  ForecastSettings,
  ContextEffect,
  ContextForecastSettings,
  Scenario,
} from '../models/types'
import { createSeededRandom } from './demandEngine'
import { formatLocalDate, parseLocalDate } from './calendar'
import { applyContextEffects, calculateContextEffects, type ContextResidualRecord } from './contextEngine'

const DAY_MS = 86_400_000
const METHODS: ForecastMethod[] = ['naive', 'movingAverage', 'weightedMovingAverage', 'weekdayAverage', 'weekdayWeightedAverage', 'weekdayTrend']

const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
const dayDifference = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / DAY_MS)
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)
const average = (values: number[]) => values.length ? sum(values) / values.length : 0
const observationPriority = (source: DemandObservation['source']) => source === 'guestCount' ? 3 : source === 'manual' ? 2 : 1

export const forecastPercentile = (values: number[], probability: number) => {
  if (!values.length) return null
  const ordered = [...values].sort((a, b) => a - b)
  const position = Math.min(1, Math.max(0, probability)) * (ordered.length - 1)
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  return lower === upper ? ordered[lower] : ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)
}

const sourceValue = (record: Pick<ActualDailyDemandRecord, 'guestCount' | 'demandCount' | 'salesCount'>) => {
  if (record.guestCount !== undefined) return { source: 'guestCount' as const, value: record.guestCount }
  if (record.demandCount !== undefined) return { source: 'manual' as const, value: record.demandCount }
  if (record.salesCount !== undefined) return { source: 'salesCount' as const, value: record.salesCount }
  return null
}

const observationFromRecord = (
  periodId: string,
  record: ActualDailyDemandRecord,
  exclusion: AppSettings['forecastExclusions'][number] | undefined,
): DemandObservation | null => {
  const selected = sourceValue(record)
  if (!selected || record.closed || !parseLocalDate(record.date) || !Number.isFinite(selected.value) || selected.value < 0) return null
  const reasons: DemandObservation['censoredReasons'] = []
  if (selected.source === 'salesCount') {
    if ((record.stockoutLostMeals ?? 0) > 0) reasons.push('stockout')
    if ((record.abandonmentGuests ?? 0) > 0) reasons.push('abandonment')
    if ((record.capacityUnservedMeals ?? 0) > 0) reasons.push('capacity')
  }
  const limited = record.earlyClosing || (
    record.operatingHours !== undefined
    && record.expectedOperatingHours !== undefined
    && record.operatingHours + 1e-9 < record.expectedOperatingHours
  )
  if (limited) reasons.push('earlyClosing')
  const lostDemand = selected.source === 'salesCount'
    ? (record.stockoutLostMeals ?? 0) + (record.abandonmentGuests ?? 0) + (record.capacityUnservedMeals ?? 0)
    : 0
  return {
    id: `observation-${periodId}-${record.date}`,
    date: record.date,
    value: selected.value,
    source: selected.source,
    quality: reasons.some((reason) => reason !== 'earlyClosing') ? 'censored' : limited ? 'limited' : 'good',
    censoredReasons: reasons,
    possibleDemandFloor: lostDemand > 0 ? selected.value + lostDemand : undefined,
    menuCounts: record.menuCounts?.map((item) => ({ ...item })),
    actualPeriodId: periodId,
    excluded: !!exclusion,
    exclusionReason: exclusion?.reason,
    exclusionNote: exclusion?.note,
  }
}

export const buildDemandObservations = (settings: AppSettings): DemandObservation[] => {
  const byDate = new Map<string, DemandObservation>()
  const exclusions = new Map(settings.forecastExclusions.map((item) => [item.date, item]))
  for (const period of settings.actualPeriods) {
    const records = [...(period.actuals.dailyDemandRecords ?? [])]
    if (period.startDate === period.endDate && !records.some((record) => record.date === period.startDate)) {
      records.push({
        date: period.startDate,
        guestCount: period.actuals.guestCount,
        demandCount: period.actuals.demandCount,
        salesCount: period.actuals.meals,
        menuCounts: period.actuals.menuSales,
        stockoutLostMeals: period.actuals.stockoutLostMeals,
        abandonmentGuests: period.actuals.abandonmentGuests,
        capacityUnservedMeals: period.actuals.capacityUnservedMeals,
        operatingHours: period.actuals.operatingHours,
        earlyClosing: period.actuals.earlyClosing,
        closed: period.actuals.operatingDays === 0,
      })
    }
    for (const record of records) {
      const observation = observationFromRecord(period.id, record, exclusions.get(record.date))
      if (!observation) continue
      const current = byDate.get(observation.date)
      if (!current || observationPriority(observation.source) >= observationPriority(current.source)) byDate.set(observation.date, observation)
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

const relativeWindowDays = (window: ForecastSettings['trainingWindow']) => window === 'last4Weeks' ? 28 : window === 'last8Weeks' ? 56 : window === 'last12Weeks' ? 84 : null

export const selectTrainingObservations = (
  observations: DemandObservation[],
  targetDate: string,
  settings: ForecastSettings,
) => {
  const target = parseLocalDate(targetDate)
  if (!target) return []
  const windowDays = relativeWindowDays(settings.trainingWindow)
  return observations.filter((observation) => {
    const date = parseLocalDate(observation.date)
    if (!date || date >= target || observation.excluded) return false
    if (!settings.includeCensored && observation.quality === 'censored') return false
    if (!settings.includeLimitedDays && observation.quality === 'limited') return false
    if (windowDays !== null && dayDifference(date, target) > windowDays) return false
    if (settings.trainingWindow === 'custom' && settings.trainingStart && observation.date < settings.trainingStart) return false
    if (settings.trainingWindow === 'custom' && settings.trainingEnd && observation.date > settings.trainingEnd) return false
    return true
  }).sort((left, right) => left.date.localeCompare(right.date))
}

const latest = (observations: DemandObservation[], count: number) => observations.slice(-Math.max(1, count))
const weekday = (dateText: string) => parseLocalDate(dateText)?.getDay() ?? -1

const linearTrend = (observations: DemandObservation[], targetDate: string) => {
  const first = parseLocalDate(observations[0].date)!
  const target = parseLocalDate(targetDate)!
  const xs = observations.map((item) => dayDifference(first, parseLocalDate(item.date)!) / 7)
  const ys = observations.map((item) => item.value)
  const xMean = average(xs)
  const yMean = average(ys)
  const denominator = sum(xs.map((x) => (x - xMean) ** 2))
  const slope = denominator > 0 ? sum(xs.map((x, index) => (x - xMean) * (ys[index] - yMean))) / denominator : 0
  return yMean + slope * (dayDifference(first, target) / 7 - xMean)
}

const fallbackChain = (method: ForecastMethod): ForecastMethod[] => {
  if (method === 'weekdayTrend') return ['weekdayTrend', 'weekdayAverage', 'movingAverage', 'naive']
  if (method === 'weekdayWeightedAverage') return ['weekdayWeightedAverage', 'weekdayAverage', 'movingAverage', 'naive']
  if (method === 'weekdayAverage') return ['weekdayAverage', 'movingAverage', 'naive']
  if (method === 'weightedMovingAverage') return ['weightedMovingAverage', 'movingAverage', 'naive']
  if (method === 'movingAverage') return ['movingAverage', 'naive']
  return ['naive']
}

const valueForMethod = (method: ForecastMethod, training: DemandObservation[], targetDate: string, settings: ForecastSettings) => {
  if (method === 'naive') return training.length ? { value: training.at(-1)!.value, count: 1 } : null
  const required = Math.max(1, Math.min(settings.windowSize, settings.minimumObservations))
  if (method === 'movingAverage' || method === 'weightedMovingAverage') {
    if (training.length < required) return null
    const rows = latest(training, settings.windowSize)
    if (method === 'movingAverage') return { value: average(rows.map((item) => item.value)), count: rows.length }
    const weightTotal = rows.length * (rows.length + 1) / 2
    return { value: sum(rows.map((item, index) => item.value * (index + 1))) / weightTotal, count: rows.length }
  }
  const sameWeekday = training.filter((item) => weekday(item.date) === weekday(targetDate))
  if (sameWeekday.length < settings.minimumObservations) return null
  const rows = latest(sameWeekday, settings.windowSize)
  if (method === 'weekdayAverage') return { value: average(rows.map((item) => item.value)), count: rows.length }
  if (method === 'weekdayWeightedAverage') {
    const weightTotal = rows.length * (rows.length + 1) / 2
    return { value: sum(rows.map((item, index) => item.value * (index + 1))) / weightTotal, count: rows.length }
  }
  if (rows.length < Math.max(3, settings.minimumObservations)) return null
  return { value: linearTrend(rows, targetDate), count: rows.length }
}

export const forecastDemandValue = (
  observations: DemandObservation[],
  targetDate: string,
  settings: ForecastSettings,
  requestedMethod = settings.method,
) => {
  const training = selectTrainingObservations(observations, targetDate, settings)
  for (const method of fallbackChain(requestedMethod)) {
    const result = valueForMethod(method, training, targetDate, settings)
    if (result) return {
      value: Math.max(0, result.value),
      method: requestedMethod,
      fallbackMethod: method === requestedMethod ? undefined : method,
      observationCount: result.count,
      training,
    }
  }
  return null
}

export const residualForecastInterval = (
  pointForecast: number,
  residuals: number[],
  settings: Pick<ForecastSettings, 'minimumIntervalResiduals' | 'intervalLowerPercentile' | 'intervalUpperPercentile'>,
) => {
  if (residuals.length < settings.minimumIntervalResiduals) return null
  const lowerResidual = forecastPercentile(residuals, settings.intervalLowerPercentile)
  const upperResidual = forecastPercentile(residuals, settings.intervalUpperPercentile)
  if (lowerResidual === null || upperResidual === null) return null
  return { lower: Math.max(0, pointForecast + lowerResidual), upper: Math.max(0, pointForecast + upperResidual) }
}

export const calculateForecastMetrics = (details: ForecastBacktestPoint[], method: ForecastMethod): ForecastBacktestSummary => {
  const errors = details.map((item) => item.error)
  const absolute = errors.map(Math.abs)
  const actualTotal = sum(details.map((item) => item.actual))
  const nonZero = details.filter((item) => item.actual !== 0)
  const covered = details.filter((item) => item.intervalCovered !== undefined)
  return {
    method,
    count: details.length,
    mae: details.length ? average(absolute) : null,
    rmse: details.length ? Math.sqrt(average(errors.map((value) => value ** 2))) : null,
    bias: details.length ? average(errors) : null,
    wape: actualTotal > 0 ? sum(absolute) / actualTotal : null,
    mape: nonZero.length ? average(nonZero.map((item) => Math.abs(item.error) / Math.abs(item.actual))) : null,
    intervalCoverage: covered.length ? covered.filter((item) => item.intervalCovered).length / covered.length : null,
    residuals: details.map((item) => item.residual),
    details,
  }
}

export const rollingForecastBacktest = (
  observations: DemandObservation[],
  settings: ForecastSettings,
  method = settings.method,
) => {
  const details: ForecastBacktestPoint[] = []
  const priorResiduals: number[] = []
  for (const target of [...observations].sort((left, right) => left.date.localeCompare(right.date))) {
    if (target.excluded || (!settings.includeCensored && target.quality === 'censored') || (!settings.includeLimitedDays && target.quality === 'limited')) continue
    const prediction = forecastDemandValue(observations, target.date, settings, method)
    if (!prediction) continue
    const interval = residualForecastInterval(prediction.value, priorResiduals, settings)
    const error = prediction.value - target.value
    const residual = target.value - prediction.value
    details.push({
      date: target.date,
      trainingEndDate: prediction.training.at(-1)?.date ?? '',
      forecast: prediction.value,
      actual: target.value,
      error,
      residual,
      lower: interval?.lower,
      upper: interval?.upper,
      intervalCovered: interval ? target.value >= interval.lower && target.value <= interval.upper : undefined,
      method,
      fallbackMethod: prediction.fallbackMethod,
      observationCount: prediction.observationCount,
    })
    priorResiduals.push(residual)
  }
  return calculateForecastMetrics(details, method)
}

export interface ContextBacktestComparison {
  base: ForecastBacktestSummary
  context: ForecastBacktestSummary
  effects: ContextEffect[]
  improvement: {
    mae: number | null
    rmse: number | null
    bias: number | null
    wape: number | null
  }
}

const metricImprovement = (base: number | null, context: number | null, absolute = false) => (
  base === null || context === null ? null : (absolute ? Math.abs(base) - Math.abs(context) : base - context)
)

export const rollingContextForecastBacktest = (
  settings: AppSettings,
  observations: DemandObservation[],
  method = settings.forecastSettings.method,
  contextSettings: ContextForecastSettings = settings.contextForecastSettings,
): ContextBacktestComparison => {
  const forecastSettings: ForecastSettings = {
    ...settings.forecastSettings,
    includeCensored: contextSettings.includeCensored,
    includeLimitedDays: contextSettings.includeLimitedDays,
  }
  const baseDetails: ForecastBacktestPoint[] = []
  const contextDetails: ForecastBacktestPoint[] = []
  const historicalBaseResiduals: ContextResidualRecord[] = []
  const priorContextResiduals: number[] = []
  for (const target of [...observations].sort((left, right) => left.date.localeCompare(right.date))) {
    if (target.excluded || (!forecastSettings.includeCensored && target.quality === 'censored') || (!forecastSettings.includeLimitedDays && target.quality === 'limited')) continue
    const prediction = forecastDemandValue(observations, target.date, forecastSettings, method)
    if (!prediction) continue
    const effects = calculateContextEffects(historicalBaseResiduals, settings.dayContexts, settings.contextTags, contextSettings)
    const context = settings.dayContexts.find((item) => item.date === target.date)
    const adjusted = applyContextEffects(prediction.value, target.date, context, settings.contextTags, effects, contextSettings)
    const interval = residualForecastInterval(adjusted.adjustedForecast, priorContextResiduals, forecastSettings)
    const baseError = prediction.value - target.value
    const baseResidual = target.value - prediction.value
    const contextError = adjusted.adjustedForecast - target.value
    const contextResidual = target.value - adjusted.adjustedForecast
    const shared = {
      date: target.date,
      trainingEndDate: prediction.training.at(-1)?.date ?? '',
      actual: target.value,
      method,
      fallbackMethod: prediction.fallbackMethod,
      observationCount: prediction.observationCount,
    }
    baseDetails.push({ ...shared, forecast: prediction.value, error: baseError, residual: baseResidual, baseForecast: prediction.value, contextAdjustments: [] })
    contextDetails.push({
      ...shared,
      forecast: adjusted.adjustedForecast,
      error: contextError,
      residual: contextResidual,
      lower: interval?.lower,
      upper: interval?.upper,
      intervalCovered: interval ? target.value >= interval.lower && target.value <= interval.upper : undefined,
      baseForecast: prediction.value,
      contextAdjustments: adjusted.adjustments,
    })
    historicalBaseResiduals.push({ date: target.date, actual: target.value, baseForecast: prediction.value, residual: baseResidual })
    priorContextResiduals.push(contextResidual)
  }
  const base = calculateForecastMetrics(baseDetails, method)
  const context = calculateForecastMetrics(contextDetails, method)
  return {
    base,
    context,
    effects: calculateContextEffects(historicalBaseResiduals, settings.dayContexts, settings.contextTags, contextSettings),
    improvement: {
      mae: metricImprovement(base.mae, context.mae),
      rmse: metricImprovement(base.rmse, context.rmse),
      bias: metricImprovement(base.bias, context.bias, true),
      wape: metricImprovement(base.wape, context.wape),
    },
  }
}

export const compareForecastMethods = (observations: DemandObservation[], settings: ForecastSettings) => (
  METHODS.map((method) => rollingForecastBacktest(observations, settings, method))
)

const metricValue = (summary: ForecastBacktestSummary, metric: ForecastSelectionMetric) => summary[metric] ?? Number.POSITIVE_INFINITY
export const selectBestForecastModel = (summaries: ForecastBacktestSummary[], metric: ForecastSelectionMetric) => (
  [...summaries].filter((item) => item.count > 0).sort((a, b) => metricValue(a, metric) - metricValue(b, metric) || METHODS.indexOf(a.method) - METHODS.indexOf(b.method))[0]
)

const businessOpen = (settings: AppSettings, date: Date) => {
  const dateText = formatLocalDate(date)
  const mondayFirst = (date.getDay() + 6) % 7
  const dated = settings.planning.dailyOperatingPlans.find((item) => item.date === dateText)
  const template = settings.planning.weekdayTemplates.find((item) => item.day === mondayFirst)
  const schedule = settings.business.weekdays.find((item) => item.day === mondayFirst)
  return dated?.enabled ?? template?.enabled ?? schedule?.enabled ?? false
}

const baseMenuMix = (settings: AppSettings): ForecastMenuMix[] => {
  const menus = settings.menuItems.filter((item) => item.enabled && item.expectedSalesRatio > 0)
  const total = sum(menus.map((item) => item.expectedSalesRatio))
  return total > 0 ? menus.map((item) => ({ menuItemId: item.id, ratio: item.expectedSalesRatio / total })) : []
}

export const forecastMenuMix = (
  settings: AppSettings,
  training: DemandObservation[],
  targetDate: string,
  forecastSettings: ForecastSettings,
) => {
  const candidates = forecastSettings.menuMixMethod === 'weekday'
    ? training.filter((item) => weekday(item.date) === weekday(targetDate) && item.menuCounts?.length)
    : training.filter((item) => item.menuCounts?.length)
  const rows = latest(candidates, forecastSettings.windowSize)
  if (!rows.length) return { menuMix: baseMenuMix(settings), fallback: true }
  const totals = new Map<string, number>()
  rows.flatMap((item) => item.menuCounts ?? []).forEach((item) => totals.set(item.menuItemId, (totals.get(item.menuItemId) ?? 0) + Math.max(0, item.quantity)))
  const total = sum([...totals.values()])
  if (total <= 0) return { menuMix: baseMenuMix(settings), fallback: true }
  return { menuMix: [...totals].map(([menuItemId, quantity]) => ({ menuItemId, ratio: quantity / total })), fallback: false }
}

export const generateFutureForecast = (
  settings: AppSettings,
  observations: DemandObservation[],
  startDate: string,
  horizonDays = settings.forecastSettings.horizonDays,
  method = settings.forecastSettings.method,
) => {
  const start = parseLocalDate(startDate)
  if (!start || !Number.isInteger(horizonDays) || horizonDays <= 0) throw new Error('Forecast開始日またはHorizonが正しくありません。')
  const contextEnabled = settings.contextForecastSettings.enabledContexts.length > 0
  const contextComparison = rollingContextForecastBacktest(settings, observations, method)
  const backtest = contextEnabled ? contextComparison.context : rollingForecastBacktest(observations, settings.forecastSettings, method)
  const points: ForecastPoint[] = []
  for (let index = 0; index < horizonDays; index += 1) {
    const date = addDays(start, index)
    const dateText = formatLocalDate(date)
    if (!businessOpen(settings, date)) {
      points.push({ date: dateText, baseForecast: 0, pointForecast: 0, adjustedForecast: 0, contextAdjustments: [], method, observationCount: 0, closed: true, menuMix: baseMenuMix(settings), menuMixFallback: true })
      continue
    }
    const prediction = forecastDemandValue(observations, dateText, settings.forecastSettings, method)
    if (!prediction) throw new Error(`${dateText}のForecastに必要なObservationがありません。`)
    const context = settings.dayContexts.find((item) => item.date === dateText)
    const adjusted = contextEnabled
      ? applyContextEffects(prediction.value, dateText, context, settings.contextTags, contextComparison.effects, settings.contextForecastSettings)
      : { adjustedForecast: prediction.value, adjustments: [] }
    const interval = residualForecastInterval(adjusted.adjustedForecast, backtest.residuals, settings.forecastSettings)
    const menu = forecastMenuMix(settings, prediction.training, dateText, settings.forecastSettings)
    points.push({
      date: dateText,
      baseForecast: prediction.value,
      pointForecast: adjusted.adjustedForecast,
      adjustedForecast: adjusted.adjustedForecast,
      contextAdjustments: adjusted.adjustments,
      lower: interval?.lower,
      upper: interval?.upper,
      method,
      fallbackMethod: prediction.fallbackMethod,
      observationCount: prediction.observationCount,
      closed: false,
      menuMix: menu.menuMix,
      menuMixFallback: menu.fallback,
    })
  }
  return { points, backtest, contextComparison }
}

export const createDemandForecast = (
  settings: AppSettings,
  name: string,
  startDate: string,
  horizonDays = settings.forecastSettings.horizonDays,
  method = settings.forecastSettings.method,
  now = new Date().toISOString(),
): DemandForecast => {
  const observations = buildDemandObservations(settings)
  const generated = generateFutureForecast(settings, observations, startDate, horizonDays, method)
  const training = selectTrainingObservations(observations, startDate, settings.forecastSettings)
  if (!training.length) throw new Error('Forecastへ使用できる履歴がありません。')
  return {
    id: `forecast-${now}-${method}`,
    name,
    createdAt: now,
    trainingStart: training[0].date,
    trainingEnd: training.at(-1)!.date,
    targetStart: generated.points[0]?.date ?? startDate,
    targetEnd: generated.points.at(-1)?.date ?? startDate,
    method,
    settings: structuredClone({ ...settings.forecastSettings, method, horizonDays }),
    forecastPoints: structuredClone(generated.points),
    backtestSummary: structuredClone(generated.backtest),
    sourceActualPeriodIds: [...new Set(training.flatMap((item) => item.actualPeriodId ? [item.actualPeriodId] : []))],
    contextSettings: structuredClone(settings.contextForecastSettings),
    contextEffects: structuredClone(generated.contextComparison.effects),
    contextEnabled: settings.contextForecastSettings.enabledContexts.length > 0,
  }
}

export const sampleForecastDemand = (forecast: DemandForecast, date: string, seed: number, demandCase: ForecastDemandCase = 'point') => {
  const point = forecast.forecastPoints.find((item) => item.date === date)
  if (!point || point.closed) return point?.pointForecast ?? 0
  if (demandCase === 'lower') return point.lower ?? point.pointForecast
  if (demandCase === 'upper') return point.upper ?? point.pointForecast
  if (demandCase === 'bootstrap' && forecast.backtestSummary.residuals.length) {
    const random = createSeededRandom(seed)
    const residual = forecast.backtestSummary.residuals[Math.min(forecast.backtestSummary.residuals.length - 1, Math.floor(random() * forecast.backtestSummary.residuals.length))]
    return Math.max(0, point.pointForecast + residual)
  }
  return point.pointForecast
}

const scaleToTotal = <T extends { expectedGuests: number }>(rows: T[], total: number) => {
  const current = sum(rows.map((row) => Math.max(0, row.expectedGuests)))
  return rows.map((row) => ({ ...row, expectedGuests: current > 0 ? Math.max(0, row.expectedGuests) * total / current : 0 }))
}

const scaleMealsToTotal = <T extends { meals: number }>(rows: T[], total: number) => {
  const current = sum(rows.map((row) => Math.max(0, row.meals)))
  if (current <= 0) return rows.map((row) => ({ ...row, meals: 0 }))
  const target = Math.max(0, Math.round(total))
  const allocated = rows.map((row, index) => {
    const exact = Math.max(0, row.meals) * target / current
    return { row, index, meals: Math.floor(exact), remainder: exact - Math.floor(exact) }
  })
  let remaining = target - sum(allocated.map((item) => item.meals))
  for (const item of [...allocated].sort((left, right) => right.remainder - left.remainder || left.index - right.index)) {
    if (remaining <= 0) break
    item.meals += 1
    remaining -= 1
  }
  return allocated.sort((left, right) => left.index - right.index).map((item) => ({ ...item.row, meals: item.meals }))
}

export const applyForecastDemandToSettings = (
  settings: AppSettings,
  date = settings.business.simulationStartDate,
  seed = settings.capacity.stochasticDemand.seed,
  stochastic = settings.capacity.demandMode === 'stochastic',
): AppSettings => {
  const source = settings.planning.demandSource
  if (source.type !== 'forecastSnapshot' || !source.forecastId) return settings
  const forecast = settings.demandForecasts.find((item) => item.id === source.forecastId)
  const point = forecast?.forecastPoints.find((item) => item.date === date)
  if (!forecast || !point) return settings
  const demandCase = stochastic && source.sampleUncertainty ? 'bootstrap' : source.demandCase ?? 'point'
  const demand = sampleForecastDemand(forecast, date, seed, demandCase)
  const mix = new Map(point.menuMix.map((item) => [item.menuItemId, item.ratio]))
  return {
    ...settings,
    business: { ...settings.business, mealsPerDay: demand },
    menuItems: point.menuMix.length ? settings.menuItems.map((menu) => ({
      ...menu,
      expectedSalesRatio: menu.enabled ? (mix.get(menu.id) ?? 0) * 100 : menu.expectedSalesRatio,
    })) : settings.menuItems,
    capacity: {
      ...settings.capacity,
      demandProfile: {
        ...settings.capacity.demandProfile,
        timeSlots: scaleMealsToTotal(settings.capacity.demandProfile.timeSlots, demand),
      },
      stochasticDemand: {
        ...settings.capacity.stochasticDemand,
        arrivalProfile: {
          ...settings.capacity.stochasticDemand.arrivalProfile,
          slots: scaleToTotal(settings.capacity.stochasticDemand.arrivalProfile.slots, demand),
        },
      },
    },
  }
}

export const forecastToScenario = (forecast: DemandForecast, demandCase: ForecastDemandCase, name = `${forecast.name} ${demandCase}`): Scenario => ({
  id: `scenario-${forecast.id}-${demandCase}`,
  name,
  notes: `Forecast Snapshot ${forecast.id}。Base Demandは変更しません。`,
  overrides: {
    business: { simulationStartDate: forecast.targetStart },
    planningDailyDemandOverrides: Object.fromEntries(forecast.forecastPoints.map((point) => [point.date, demandCase === 'lower' ? point.lower ?? point.pointForecast : demandCase === 'upper' ? point.upper ?? point.pointForecast : point.pointForecast])),
    planningDemandSource: { type: 'forecastSnapshot', forecastId: forecast.id, demandCase, sampleUncertainty: demandCase === 'bootstrap' },
  },
})

export const forecastToPlanningSettings = (
  settings: AppSettings,
  forecast: DemandForecast,
  demandCase: ForecastDemandCase = 'point',
  sampleUncertainty = demandCase === 'bootstrap',
): AppSettings => {
  const values = Object.fromEntries(forecast.forecastPoints.map((point) => [
    point.date,
    demandCase === 'lower' ? point.lower ?? point.pointForecast
      : demandCase === 'upper' ? point.upper ?? point.pointForecast
        : point.pointForecast,
  ]))
  const dailyOperatingPlans = Object.entries(values).reduce((plans, [date, mealsPerDay]) => {
    const existing = plans.find((plan) => plan.date === date)
    return existing
      ? plans.map((plan) => plan.date === date ? { ...plan, mealsPerDay } : plan)
      : [...plans, { id: `forecast-plan-${forecast.id}-${date}`, date, mealsPerDay }]
  }, settings.planning.dailyOperatingPlans.map((plan) => ({ ...plan })))
  return {
    ...settings,
    business: { ...settings.business, simulationStartDate: forecast.targetStart },
    planning: {
      ...settings.planning,
      horizonDays: forecast.forecastPoints.length,
      dailyOperatingPlans,
      demandSource: { type: 'forecastSnapshot', forecastId: forecast.id, demandCase, sampleUncertainty },
    },
  }
}

export const compareForecastSnapshotActuals = (forecast: DemandForecast, observations: DemandObservation[]) => forecast.forecastPoints.flatMap((point) => {
  const actual = observations.find((item) => item.date === point.date)
  return actual ? [{ date: point.date, forecast: point.pointForecast, actual: actual.value, error: point.pointForecast - actual.value }] : []
})

export const forecastPeriodDistribution = (forecast: DemandForecast, runs: number, baseSeed: number) => {
  const totals = Array.from({ length: Math.max(0, Math.trunc(runs)) }, (_, runIndex) => sum(forecast.forecastPoints.map((point, dayIndex) => (
    sampleForecastDemand(forecast, point.date, (baseSeed ^ Math.imul(runIndex + 1, 0x9e3779b1) ^ Math.imul(dayIndex + 1, 0x85ebca6b)) >>> 0, 'bootstrap')
  ))))
  return {
    values: totals,
    mean: average(totals),
    median: forecastPercentile(totals, 0.5) ?? 0,
    p10: forecastPercentile(totals, 0.1) ?? 0,
    p90: forecastPercentile(totals, 0.9) ?? 0,
  }
}

export interface ForecastWarning {
  code: string
  message: string
  date?: string
}

export const buildForecastWarnings = (
  settings: AppSettings,
  observations: DemandObservation[],
  summary?: ForecastBacktestSummary,
  forecast?: DemandForecast,
): ForecastWarning[] => {
  const warnings: ForecastWarning[] = []
  const usable = observations.filter((item) => !item.excluded)
  if (usable.length < settings.forecastSettings.minimumObservations) warnings.push({ code: 'insufficient-observations', message: `履歴が${usable.length}営業日だけです。` })
  if (usable.some((item) => item.source === 'salesCount')) warnings.push({ code: 'sales-demand-proxy', message: '販売数を需要の近似として使用しています。潜在需要と一致しない場合があります。' })
  if (settings.forecastSettings.includeCensored && usable.some((item) => item.quality === 'censored')) warnings.push({ code: 'censored-used', message: 'stockout・離脱・Capacity制約のあるcensoredデータを学習に含めています。' })
  if (summary && summary.residuals.length < settings.forecastSettings.minimumIntervalResiduals) warnings.push({ code: 'insufficient-residuals', message: '経験的予測幅に必要なResidualが不足しています。' })
  if (summary?.bias !== null && summary?.mae !== null && summary && Math.abs(summary.bias ?? 0) > (summary.mae ?? 0) * 0.5) warnings.push({ code: 'large-bias', message: 'Backtest BiasがMAEの50%を超えています。過大・過小予測傾向を確認してください。' })
  const median = forecastPercentile(usable.map((item) => item.value), 0.5)
  if (median !== null && usable.some((item) => Math.abs(item.value - median) > Math.max(10, median * 0.5))) warnings.push({ code: 'outlier-candidate', message: '中央値から大きく離れたObservationがあります。自動除外していません。' })
  if (forecast && usable.length && dayDifference(parseLocalDate(usable[0].date)!, parseLocalDate(forecast.targetEnd)!) > usable.length * 4) warnings.push({ code: 'long-horizon', message: 'Forecast期間が履歴範囲に対して長いため、不確実性が大きい可能性があります。' })
  return warnings
}
