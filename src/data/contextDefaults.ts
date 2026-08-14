import type { ContextFeature, ContextForecastSettings } from '../models/types'

export const CALENDAR_CONTEXTS: ContextFeature[] = ['holiday', 'dayBeforeHoliday', 'dayAfterHoliday', 'longWeekend', 'monthStart', 'monthEnd']
export const WEATHER_CONTEXTS: ContextFeature[] = ['weather', 'temperature', 'precipitation']

export const createDefaultContextForecastSettings = (): ContextForecastSettings => ({
  preset: 'baseOnly',
  enabledContexts: [],
  minimumContextObservations: 3,
  includeCensored: false,
  includeLimitedDays: false,
  adjustmentCapEnabled: false,
})

export const contextFeaturesForPreset = (preset: ContextForecastSettings['preset']): ContextFeature[] => {
  if (preset === 'calendar') return [...CALENDAR_CONTEXTS]
  if (preset === 'weather') return [...WEATHER_CONTEXTS]
  if (preset === 'calendarWeather') return [...CALENDAR_CONTEXTS, ...WEATHER_CONTEXTS]
  return []
}
