import { describe, expect, it } from 'vitest'
import { createSampleSettings } from '../data/sampleData'
import { parseSettingsJson } from './settingsStorage'

describe('settings schema migration', () => {
  it('schemaVersion v1を旧人件費計算を維持するv4へ連続移行する', () => {
    const legacy = createSampleSettings() as unknown as Record<string, unknown>
    legacy.schemaVersion = 1
    const business = legacy.business as Record<string, unknown>
    delete business.simulationStartDate
    for (const process of legacy.processes as Record<string, unknown>[]) delete process.laborCostTreatment
    delete legacy.actualPeriods
    delete legacy.scenarios

    const migrated = parseSettingsJson(JSON.stringify(legacy))
    expect(migrated.schemaVersion).toBe(4)
    expect(migrated.business.simulationStartDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(migrated.processes.every((process) => process.laborCostTreatment === 'additionalLabor')).toBe(true)
    expect(migrated.inventory.carryOverEnabled).toBe(true)
    expect(migrated.inventory.openingLots).toEqual([])
    expect(migrated.actualPeriods).toEqual([])
    expect(migrated.scenarios).toEqual([])
  })

  it('schemaVersion v2を安全な在庫初期値を持つv4へ連続移行する', () => {
    const legacy = createSampleSettings() as unknown as Record<string, unknown>
    legacy.schemaVersion = 2
    const inventory = legacy.inventory as Record<string, unknown>
    inventory.carryOverEnabled = false
    delete inventory.openingLots
    const resources = legacy.resources as Record<string, unknown>[]
    resources[0].minimumPurchaseLot = 0

    const migrated = parseSettingsJson(JSON.stringify(legacy))
    expect(migrated.schemaVersion).toBe(4)
    expect(migrated.inventory.carryOverEnabled).toBe(true)
    expect(migrated.inventory.openingLots).toEqual([])
    expect(migrated.resources[0].minimumPurchaseLot).toBe(1)
  })

  it('schemaVersion v3をActualとScenarioの空配列を持つv4へ移行する', () => {
    const legacy = createSampleSettings() as unknown as Record<string, unknown>
    legacy.schemaVersion = 3
    delete legacy.actualPeriods
    delete legacy.scenarios

    const migrated = parseSettingsJson(JSON.stringify(legacy))
    expect(migrated.schemaVersion).toBe(4)
    expect(migrated.actualPeriods).toEqual([])
    expect(migrated.scenarios).toEqual([])
  })

  it('schemaVersion v4のActualとScenarioをJSONで往復する', () => {
    const settings = createSampleSettings()
    settings.actualPeriods = [{
      id: 'actual', name: '8月実績', startDate: '2026-08-01', endDate: '2026-08-31',
      actuals: { revenue: 1_000_000, menuSales: [], resourceRecords: [], utilities: { water: {}, gas: {}, electricity: {} } },
    }]
    settings.scenarios = [{ id: 'scenario', name: '営業時間短縮', overrides: { business: { hoursPerDay: 8 } } }]

    const restored = parseSettingsJson(JSON.stringify(settings))
    expect(restored.actualPeriods[0].actuals.revenue).toBe(1_000_000)
    expect(restored.scenarios[0].overrides.business?.hoursPerDay).toBe(8)
  })
})
