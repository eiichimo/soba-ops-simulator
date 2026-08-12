import { createSampleSettings } from '../data/sampleData'
import type { AppSettings } from '../models/types'

export const STORAGE_KEY = 'sobaops.settings.v1'
export const CURRENT_SCHEMA_VERSION = 1

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

export const parseSettingsJson = (json: string): AppSettings => {
  const parsed: unknown = JSON.parse(json)
  if (!isSettingsShape(parsed)) throw new Error('SobaOpsの設定JSONとして認識できません。')
  if (parsed.schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(`この設定は新しいバージョン（v${parsed.schemaVersion}）で作成されています。`)
  }
  if (parsed.schemaVersion < CURRENT_SCHEMA_VERSION) {
    throw new Error(`設定バージョン v${parsed.schemaVersion} の移行処理はまだ用意されていません。`)
  }
  return parsed
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
