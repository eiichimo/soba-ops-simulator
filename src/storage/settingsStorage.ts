import { createSampleSettings } from '../data/sampleData'
import { todayLocalDate } from '../calculations/calendar'
import type { AppSettings, Process } from '../models/types'

export const STORAGE_KEY = 'sobaops.settings.v1'
export const CURRENT_SCHEMA_VERSION = 2

const isSettingsShape = (value: unknown): value is AppSettings => {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AppSettings>
  return typeof candidate.schemaVersion === 'number'
    && !!candidate.business
    && Array.isArray(candidate.resources)
    && Array.isArray(candidate.processes)
    && Array.isArray(candidate.menuItems)
    && Array.isArray(candidate.labor)
    && !!candidate.utilities
}

export const migrateV1ToV2 = (settings: AppSettings): AppSettings => ({
  ...settings,
  schemaVersion: 2,
  business: {
    ...settings.business,
    simulationStartDate: settings.business.simulationStartDate ?? todayLocalDate(),
  },
  processes: settings.processes.map((process) => ({
    ...process,
    // v1では全仕込み人件費を総コストへ加算していたため、移行後も同じ結果を維持する。
    laborCostTreatment: process.laborCostTreatment ?? 'additionalLabor',
  } as Process)),
})

export const migrateSettings = (settings: AppSettings): AppSettings => {
  if (settings.schemaVersion === 1) return migrateV1ToV2(settings)
  return settings
}

export const parseSettingsJson = (json: string): AppSettings => {
  const parsed: unknown = JSON.parse(json)
  if (!isSettingsShape(parsed)) throw new Error('SobaOpsの設定JSONとして認識できません。')
  if (parsed.schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(`この設定は新しいバージョン（v${parsed.schemaVersion}）で作成されています。`)
  }
  if (parsed.schemaVersion < 1) throw new Error(`設定バージョン v${parsed.schemaVersion} は読み込めません。`)
  return migrateSettings(parsed)
}

export const loadSettings = (): AppSettings => {
  if (typeof window === 'undefined') return createSampleSettings()
  const stored = window.localStorage.getItem(STORAGE_KEY)
  if (!stored) return createSampleSettings()
  try {
    return parseSettingsJson(stored)
  } catch {
    return createSampleSettings()
  }
}

export const saveSettings = (settings: AppSettings) => {
  if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

export const clearSettings = () => {
  if (typeof window !== 'undefined') window.localStorage.removeItem(STORAGE_KEY)
}
