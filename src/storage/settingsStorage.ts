import { createSampleSettings } from '../data/sampleData'
import { createDefaultCapacitySettings } from '../data/capacityDefaults'
import { createDefaultStochasticDemand } from '../data/demandDefaults'
import { todayLocalDate } from '../calculations/calendar'
import type { AppSettings, OpeningInventoryLot, Process } from '../models/types'

export const STORAGE_KEY = 'sobaops.settings.v1'
export const CURRENT_SCHEMA_VERSION = 6

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
    && (candidate.schemaVersion < 4 || (Array.isArray(candidate.actualPeriods) && Array.isArray(candidate.scenarios)))
    && (candidate.schemaVersion < 5 || !!candidate.capacity)
    && (candidate.schemaVersion < 6 || (!!candidate.capacity?.stochasticDemand && !!candidate.capacity?.demandMode))
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

export const migrateV2ToV3 = (settings: AppSettings): AppSettings => {
  const legacyEntries = settings.inventory?.entries ?? []
  const openingLots: OpeningInventoryLot[] = settings.inventory?.openingLots ?? legacyEntries
    .filter((entry) => entry.carryOverQuantity > 0)
    .map((entry) => ({
      id: `migrated-${entry.id}`,
      sourceType: entry.sourceType,
      sourceId: entry.sourceId,
      quantity: entry.carryOverQuantity,
      unit: entry.unit,
      acquiredDate: settings.business.simulationStartDate,
    }))
  return {
    ...settings,
    schemaVersion: 3,
    resources: settings.resources.map((resource) => ({
      ...resource,
      minimumPurchaseLot: resource.minimumPurchaseLot > 0 ? resource.minimumPurchaseLot : 1,
    })),
    inventory: {
      carryOverEnabled: true,
      entries: legacyEntries,
      openingLots,
    },
  }
}

export const migrateV3ToV4 = (settings: AppSettings): AppSettings => ({
  ...settings,
  schemaVersion: 4,
  actualPeriods: settings.actualPeriods ?? [],
  scenarios: settings.scenarios ?? [],
})

export const migrateV4ToV5 = (settings: AppSettings): AppSettings => {
  const capacity = createDefaultCapacitySettings(settings)
  return {
    ...settings,
    schemaVersion: 5,
    menuItems: settings.menuItems.map((menu) => ({
      ...menu,
      kitchenWorkflowId: menu.kitchenWorkflowId ?? `workflow-${menu.id}`,
    })),
    capacity,
  }
}

export const migrateV5ToV6 = (settings: AppSettings): AppSettings => ({
  ...settings,
  schemaVersion: 6,
  capacity: {
    ...settings.capacity,
    demandMode: settings.capacity.demandMode ?? 'deterministic',
    stochasticDemand: settings.capacity.stochasticDemand ?? createDefaultStochasticDemand(settings.business, settings.capacity.demandProfile),
  },
})

export const migrateSettings = (settings: AppSettings): AppSettings => {
  let migrated = settings
  if (migrated.schemaVersion === 1) migrated = migrateV1ToV2(migrated)
  if (migrated.schemaVersion === 2) migrated = migrateV2ToV3(migrated)
  if (migrated.schemaVersion === 3) migrated = migrateV3ToV4(migrated)
  if (migrated.schemaVersion === 4) migrated = migrateV4ToV5(migrated)
  if (migrated.schemaVersion === 5) migrated = migrateV5ToV6(migrated)
  return migrated
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
