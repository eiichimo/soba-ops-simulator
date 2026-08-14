import type {
  AppSettings,
  ContextAdjustment,
  ContextEffect,
  ContextFeature,
  ContextForecastSettings,
  ContextTag,
  DayContext,
  DemandObservation,
} from '../models/types'
import { parseLocalDate } from './calendar'

export interface ContextResidualRecord {
  date: string
  actual: number
  baseForecast: number
  residual: number
}

export interface ContextWarning {
  code: string
  message: string
  contextKey?: string
}

const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
const standardDeviation = (values: number[]) => {
  if (!values.length) return 0
  const mean = average(values)
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)))
}
const median = (values: number[]) => {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export const temperatureBucket = (temperatureC: number) => {
  if (temperatureC < 10) return 'under10'
  if (temperatureC < 20) return '10to20'
  if (temperatureC < 30) return '20to30'
  return '30plus'
}

export const precipitationBucket = (precipitationMm: number) => {
  if (precipitationMm === 0) return 'zero'
  if (precipitationMm < 5) return 'under5'
  if (precipitationMm < 20) return '5to20'
  return '20plus'
}

const featureEnabled = (settings: ContextForecastSettings, feature: ContextFeature) => settings.enabledContexts.includes(feature)

export const contextKeysForDate = (
  context: DayContext | undefined,
  tags: ContextTag[],
  date: string,
  settings: ContextForecastSettings,
) => {
  const keys: Array<{ key: string; label: string }> = []
  if (context?.excludedFromEffect) return keys
  const parsed = parseLocalDate(date)
  if (featureEnabled(settings, 'monthStart') && parsed && parsed.getDate() <= 3) keys.push({ key: 'monthStart:true', label: '月初' })
  if (featureEnabled(settings, 'monthEnd') && parsed) {
    const lastDate = new Date(parsed.getFullYear(), parsed.getMonth() + 1, 0).getDate()
    if (parsed.getDate() >= lastDate - 2) keys.push({ key: 'monthEnd:true', label: '月末' })
  }
  if (!context) return keys
  if (featureEnabled(settings, 'holiday') && context.holidayType !== 'none') keys.push({ key: `holiday:${context.holidayType}`, label: `祝日 ${context.holidayType}` })
  if (featureEnabled(settings, 'dayBeforeHoliday') && context.dayBeforeHoliday) keys.push({ key: 'dayBeforeHoliday:true', label: '祝前日' })
  if (featureEnabled(settings, 'dayAfterHoliday') && context.dayAfterHoliday) keys.push({ key: 'dayAfterHoliday:true', label: '祝日翌日' })
  if (featureEnabled(settings, 'longWeekend') && context.longWeekend) keys.push({ key: 'longWeekend:true', label: '連休' })
  if (featureEnabled(settings, 'weather') && context.weatherCategory && context.weatherCategory !== 'unknown') keys.push({ key: `weather:${context.weatherCategory}`, label: `天気 ${context.weatherCategory}` })
  if (featureEnabled(settings, 'temperature') && context.temperatureC !== undefined) {
    const bucket = temperatureBucket(context.temperatureC)
    keys.push({ key: `temperature:${bucket}`, label: `代表気温 ${bucket}` })
  }
  if (featureEnabled(settings, 'precipitation') && context.precipitationMm !== undefined) {
    const bucket = precipitationBucket(context.precipitationMm)
    keys.push({ key: `precipitation:${bucket}`, label: `降水量 ${bucket}` })
  }
  if (featureEnabled(settings, 'event')) {
    for (const event of context.events) {
      const tag = tags.find((item) => item.id === event.tagId)
      keys.push({ key: `event:${event.tagId}`, label: `Event ${tag?.name ?? event.tagId}` })
    }
    for (const tagId of context.customTagIds ?? []) {
      const tag = tags.find((item) => item.id === tagId)
      keys.push({ key: `custom:${tagId}`, label: `Context ${tag?.name ?? tagId}` })
    }
  }
  if (featureEnabled(settings, 'store')) {
    if (context.specialBusinessDay !== 'normal') keys.push({ key: `store:${context.specialBusinessDay}`, label: `特殊営業 ${context.specialBusinessDay}` })
    if (context.promotion) keys.push({ key: 'store:promotion', label: '販促' })
    if (context.equipmentTrouble) keys.push({ key: 'store:equipmentTrouble', label: '設備トラブル' })
    if (context.unusualOperation) keys.push({ key: 'store:unusualOperation', label: '通常外運営' })
  }
  return [...new Map(keys.map((item) => [item.key, item])).values()]
}

export const calculateContextEffects = (
  residuals: ContextResidualRecord[],
  contexts: DayContext[],
  tags: ContextTag[],
  settings: ContextForecastSettings,
): ContextEffect[] => {
  const groups = new Map<string, { label: string; rows: ContextResidualRecord[] }>()
  for (const residual of residuals) {
    const context = contexts.find((item) => item.date === residual.date)
    for (const entry of contextKeysForDate(context, tags, residual.date, settings)) {
      const group = groups.get(entry.key) ?? { label: entry.label, rows: [] }
      group.rows.push(residual)
      groups.set(entry.key, group)
    }
  }
  return [...groups].map(([contextKey, group]) => {
    const values = group.rows.map((item) => item.residual)
    const dates = group.rows.map((item) => item.date).sort()
    const weekdays = [...new Set(dates.map((date) => parseLocalDate(date)?.getDay()).filter((day): day is number => day !== undefined))]
    return {
      contextKey,
      label: group.label,
      observationCount: values.length,
      meanResidual: average(values),
      medianResidual: median(values),
      standardDeviation: standardDeviation(values),
      minimumResidual: Math.min(...values),
      maximumResidual: Math.max(...values),
      sufficientData: values.length >= settings.minimumContextObservations,
      weekdays,
      firstDate: dates[0],
      lastDate: dates.at(-1)!,
    }
  }).sort((left, right) => left.contextKey.localeCompare(right.contextKey))
}

export const applyContextEffects = (
  baseForecast: number,
  date: string,
  context: DayContext | undefined,
  tags: ContextTag[],
  effects: ContextEffect[],
  settings: ContextForecastSettings,
) => {
  const adjustments: ContextAdjustment[] = contextKeysForDate(context, tags, date, settings).flatMap(({ key, label }) => {
    const effect = effects.find((item) => item.contextKey === key)
    if (!effect || !effect.sufficientData) return []
    return [{
      contextKey: key,
      label,
      adjustment: effect.meanResidual,
      observationCount: effect.observationCount,
      standardDeviation: effect.standardDeviation,
      sufficientData: true,
    }]
  })
  let totalAdjustment = adjustments.reduce((total, item) => total + item.adjustment, 0)
  if (settings.adjustmentCapEnabled && settings.maximumAbsoluteAdjustment !== undefined) {
    const limit = Math.max(0, settings.maximumAbsoluteAdjustment)
    totalAdjustment = Math.max(-limit, Math.min(limit, totalAdjustment))
  }
  return { adjustedForecast: Math.max(0, baseForecast + totalAdjustment), totalAdjustment, adjustments }
}

export const buildContextWarnings = (
  settings: AppSettings,
  observations: DemandObservation[],
  effects: ContextEffect[],
  baseMae?: number | null,
  contextMae?: number | null,
): ContextWarning[] => {
  const warnings: ContextWarning[] = []
  for (const effect of effects) {
    if (!effect.sufficientData) warnings.push({ code: 'insufficient-context-observations', message: `${effect.label}は${effect.observationCount}件のため補正へ使用しません。`, contextKey: effect.contextKey })
    if (effect.sufficientData && effect.weekdays.length <= 1) warnings.push({ code: 'context-weekday-concentration', message: `${effect.label}の履歴が特定曜日に偏っています。`, contextKey: effect.contextKey })
    const first = parseLocalDate(effect.firstDate)
    const last = parseLocalDate(effect.lastDate)
    if (effect.sufficientData && first && last && last.getTime() - first.getTime() < 28 * 86_400_000) warnings.push({ code: 'context-period-concentration', message: `${effect.label}の履歴期間が4週間未満です。`, contextKey: effect.contextKey })
    if (effect.sufficientData && Math.abs(effect.meanResidual) > 50) warnings.push({ code: 'extreme-context-effect', message: `${effect.label}の補正が${effect.meanResidual.toFixed(1)}人と大きいため根拠日を確認してください。`, contextKey: effect.contextKey })
  }
  const enabled = settings.contextForecastSettings.enabledContexts
  if (enabled.includes('holiday') && enabled.includes('longWeekend')) warnings.push({ code: 'overlapping-calendar-contexts', message: 'HolidayとLong Weekendは重複しやすく、加法補正が過大になる可能性があります。' })
  if (enabled.includes('weather') && enabled.includes('precipitation')) warnings.push({ code: 'overlapping-weather-contexts', message: 'Weather Categoryと降水量Bucketは相関が強い可能性があります。' })
  if (contextMae !== undefined && contextMae !== null && baseMae !== undefined && baseMae !== null && contextMae > baseMae) warnings.push({ code: 'context-backtest-worsened', message: `Context追加でBacktest MAEが${baseMae.toFixed(1)}→${contextMae.toFixed(1)}へ悪化しています。` })
  if (settings.contextForecastSettings.includeCensored && observations.some((item) => item.quality === 'censored')) warnings.push({ code: 'context-censored-dependency', message: 'Context Effectがcensored需要を含んでいます。' })
  if (observations.some((item) => item.source === 'salesCount')) warnings.push({ code: 'context-sales-proxy', message: 'Context分析の一部が販売数による需要近似へ依存しています。' })
  if (enabled.some((item) => ['weather', 'temperature', 'precipitation'].includes(item)) && settings.dayContexts.some((item) => item.weatherCategory === 'unknown')) warnings.push({ code: 'unknown-weather-context', message: 'unknown Weatherは補正へ使用しません。' })
  return warnings
}
