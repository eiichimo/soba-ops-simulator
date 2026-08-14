import type { CalibrationSettings } from '../models/types'

export const createDefaultCalibrationSettings = (): CalibrationSettings => ({
  minimumPeriods: 1,
  varianceWarningThreshold: 0.2,
})
