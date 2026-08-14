import type { ForecastSettings } from '../models/types'

export const createDefaultForecastSettings = (): ForecastSettings => ({
  method: 'weekdayWeightedAverage',
  horizonDays: 7,
  windowSize: 7,
  minimumObservations: 3,
  includeCensored: false,
  includeLimitedDays: false,
  trainingWindow: 'last12Weeks',
  selectionMetric: 'mae',
  intervalLowerPercentile: 0.1,
  intervalUpperPercentile: 0.9,
  minimumIntervalResiduals: 5,
  menuMixMethod: 'weekday',
  bootstrapRuns: 100,
})
