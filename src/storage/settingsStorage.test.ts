import { describe, expect, it } from 'vitest'
import { createSampleSettings } from '../data/sampleData'
import { parseSettingsJson } from './settingsStorage'

describe('settings schema migration', () => {
  it('schemaVersion v1を旧人件費計算を維持するv2へ移行する', () => {
    const legacy = createSampleSettings() as unknown as Record<string, unknown>
    legacy.schemaVersion = 1
    const business = legacy.business as Record<string, unknown>
    delete business.simulationStartDate
    for (const process of legacy.processes as Record<string, unknown>[]) delete process.laborCostTreatment

    const migrated = parseSettingsJson(JSON.stringify(legacy))
    expect(migrated.schemaVersion).toBe(2)
    expect(migrated.business.simulationStartDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(migrated.processes.every((process) => process.laborCostTreatment === 'additionalLabor')).toBe(true)
  })
})
