import { describe, expect, it } from 'vitest'
import { createSampleSettings } from '../data/sampleData'
import { parseSettingsJson } from './settingsStorage'

describe('settings schema migration', () => {
  it('schemaVersion v1を旧人件費計算を維持するv8へ連続移行する', () => {
    const legacy = createSampleSettings() as unknown as Record<string, unknown>
    legacy.schemaVersion = 1
    const business = legacy.business as Record<string, unknown>
    delete business.simulationStartDate
    for (const process of legacy.processes as Record<string, unknown>[]) delete process.laborCostTreatment
    delete legacy.actualPeriods
    delete legacy.scenarios
    delete legacy.optimizationStudies

    const migrated = parseSettingsJson(JSON.stringify(legacy))
    expect(migrated.schemaVersion).toBe(8)
    expect(migrated.business.simulationStartDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(migrated.processes.every((process) => process.laborCostTreatment === 'additionalLabor')).toBe(true)
    expect(migrated.inventory.carryOverEnabled).toBe(true)
    expect(migrated.inventory.openingLots).toEqual([])
    expect(migrated.actualPeriods).toEqual([])
    expect(migrated.scenarios).toEqual([])
    expect(migrated.capacity.equipment.length).toBeGreaterThan(0)
    expect(migrated.menuItems.every((menu) => !!menu.kitchenWorkflowId)).toBe(true)
    expect(migrated.capacity.demandMode).toBe('deterministic')
    expect(migrated.capacity.stochasticDemand.seatingUnits.length).toBeGreaterThan(0)
    expect(migrated.optimizationStudies).toEqual([])
  })

  it('schemaVersion v2を安全な在庫初期値を持つv7へ連続移行する', () => {
    const legacy = createSampleSettings() as unknown as Record<string, unknown>
    legacy.schemaVersion = 2
    const inventory = legacy.inventory as Record<string, unknown>
    inventory.carryOverEnabled = false
    delete inventory.openingLots
    const resources = legacy.resources as Record<string, unknown>[]
    resources[0].minimumPurchaseLot = 0

    const migrated = parseSettingsJson(JSON.stringify(legacy))
    expect(migrated.schemaVersion).toBe(8)
    expect(migrated.inventory.carryOverEnabled).toBe(true)
    expect(migrated.inventory.openingLots).toEqual([])
    expect(migrated.resources[0].minimumPurchaseLot).toBe(1)
  })

  it('schemaVersion v3をActual・Scenario・Capacity・Demand・Optimizationを持つv7へ連続移行する', () => {
    const legacy = createSampleSettings() as unknown as Record<string, unknown>
    legacy.schemaVersion = 3
    delete legacy.actualPeriods
    delete legacy.scenarios

    const migrated = parseSettingsJson(JSON.stringify(legacy))
    expect(migrated.schemaVersion).toBe(8)
    expect(migrated.actualPeriods).toEqual([])
    expect(migrated.scenarios).toEqual([])
  })

  it('schemaVersion v4へ安全な参考CapacityとDemandを補完してv7へ移行する', () => {
    const legacy = createSampleSettings() as unknown as Record<string, unknown>
    legacy.schemaVersion = 4
    delete legacy.capacity
    for (const menu of legacy.menuItems as Record<string, unknown>[]) delete menu.kitchenWorkflowId

    const migrated = parseSettingsJson(JSON.stringify(legacy))
    expect(migrated.schemaVersion).toBe(8)
    expect(migrated.capacity.equipment[0]).toMatchObject({ id: 'default-service-station', capacity: 4, isReferenceCapacity: true })
    expect(migrated.capacity.operations[0]).toMatchObject({ id: 'default-service-operation', durationMinutes: 1 })
    expect(migrated.capacity.demandProfile.timeSlots[0].meals).toBe(migrated.business.mealsPerDay)
    expect(migrated.capacity.workflows).toHaveLength(migrated.menuItems.length)
  })

  it('schemaVersion v5へStochastic Demandの安全な参考値を補完してv7へ移行する', () => {
    const legacy = createSampleSettings() as unknown as Record<string, unknown>
    legacy.schemaVersion = 5
    const capacity = legacy.capacity as Record<string, unknown>
    delete capacity.demandMode
    delete capacity.stochasticDemand

    const migrated = parseSettingsJson(JSON.stringify(legacy))
    expect(migrated.schemaVersion).toBe(8)
    expect(migrated.capacity.demandMode).toBe('deterministic')
    expect(migrated.capacity.stochasticDemand.partySizeDistribution).toHaveLength(5)
    expect(migrated.capacity.stochasticDemand.seatingUnits).toHaveLength(3)
    expect(migrated.capacity.stochasticDemand.monteCarlo.runs).toBe(100)
  })

  it('schemaVersion v6へOptimizationの安全な空配列を補完してv7へ移行する', () => {
    const legacy = createSampleSettings() as unknown as Record<string, unknown>
    legacy.schemaVersion = 6
    delete legacy.optimizationStudies

    const migrated = parseSettingsJson(JSON.stringify(legacy))
    expect(migrated.schemaVersion).toBe(8)
    expect(migrated.optimizationStudies).toEqual([])
  })

  it('schemaVersion v7のActual・Scenario・Capacity・Demand・OptimizationをJSONで往復する', () => {
    const settings = createSampleSettings()
    settings.actualPeriods = [{
      id: 'actual', name: '8月実績', startDate: '2026-08-01', endDate: '2026-08-31',
      actuals: { revenue: 1_000_000, menuSales: [], resourceRecords: [], utilities: { water: {}, gas: {}, electricity: {} } },
    }]
    settings.scenarios = [{ id: 'scenario', name: '営業時間短縮', overrides: { business: { hoursPerDay: 8 } } }]

    const restored = parseSettingsJson(JSON.stringify(settings))
    expect(restored.actualPeriods[0].actuals.revenue).toBe(1_000_000)
    expect(restored.scenarios[0].overrides.business?.hoursPerDay).toBe(8)
    expect(restored.capacity.equipment).toEqual(settings.capacity.equipment)
    expect(restored.capacity.stochasticDemand).toEqual(settings.capacity.stochasticDemand)
    expect(restored.optimizationStudies).toEqual(settings.optimizationStudies)
  })

  it('schemaVersion v7からv8へPlanning・Lead Time・Lookaheadを安全に補完する', () => {
    const legacy = createSampleSettings() as unknown as Record<string, unknown>
    legacy.schemaVersion = 7
    delete legacy.planning
    for (const resource of legacy.resources as Record<string, unknown>[]) {
      delete resource.procurementLeadTimeDays
      delete resource.procurementLookaheadDays
    }
    for (const process of legacy.processes as Record<string, unknown>[]) delete process.prepLookaheadDays
    const study = (legacy.optimizationStudies as Record<string, unknown>[])[0]
    delete study.planningHorizonDays
    delete study.paretoMetric

    const migrated = parseSettingsJson(JSON.stringify(legacy))
    expect(migrated.schemaVersion).toBe(8)
    expect(migrated.planning.horizonDays).toBe(7)
    expect(migrated.resources.every((resource) => resource.procurementLeadTimeDays === 0 && resource.procurementLookaheadDays === 0)).toBe(true)
    expect(migrated.processes.every((process) => process.prepLookaheadDays === 0)).toBe(true)
    expect(migrated.optimizationStudies[0]).toMatchObject({ planningHorizonDays: 1, paretoMetric: 'profitWait' })
  })

  it('schemaVersion v8のDaily PlanとPurchaseOrderをJSONで往復する', () => {
    const settings = createSampleSettings()
    settings.planning.dailyOperatingPlans = [{ id: 'special', date: '2026-08-21', mealsPerDay: 150, staffHeadcountOverrides: { 'shift-cook': 4 } }]
    settings.planning.purchaseOrders = [{ id: 'order', resourceId: settings.resources[0].id, orderedDate: '2026-08-20', deliveryDate: '2026-08-21', packageCount: 2, quantity: 2_000, cost: 1_500, status: 'planned' }]
    const restored = parseSettingsJson(JSON.stringify(settings))
    expect(restored.planning).toEqual(settings.planning)
  })
})
