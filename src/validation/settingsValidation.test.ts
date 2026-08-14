import { describe, expect, it } from 'vitest'
import { createBenchmarkStore } from '../calculations/fixtures/benchmarkStore'
import { createSampleSettings } from '../data/sampleData'
import type { Process } from '../models/types'
import { validateSettings } from './settingsValidation'

const process = (id: string, outputId: string, inputOutputId: string): Process => ({
  id,
  name: id,
  inputs: [{ sourceType: 'output', sourceId: inputOutputId, quantity: 1, unit: 'L' }],
  outputs: [{ id: outputId, name: outputId, quantity: 1, unit: 'L', costAllocation: 1, storageType: 'refrigerated', shelfLifeDays: 1 }],
  batchSize: 1,
  processDurationMinutes: 1,
  activeLaborMinutes: 1,
  laborRole: 'benchmark-staff',
  laborCostTreatment: 'withinScheduledShift',
  gasUsageM3: 0,
  electricUsageKWh: 0,
  waterUsageL: 0,
  wasteRate: 0,
  wasteReason: 'cookingLoss',
})

describe('settings validation', () => {
  it('初期サンプルには致命的Errorがない', () => {
    expect(validateSettings(createSampleSettings()).filter((validationIssue) => validationIssue.severity === 'error')).toEqual([])
  })

  it('互換性のないSource単位をErrorとして検出する', () => {
    const settings = createBenchmarkStore()
    settings.menuItems[0].consumption[0].unit = 'L'
    const issues = validateSettings(settings)
    expect(issues).toContainEqual(expect.objectContaining({ severity: 'error', code: 'unit-mismatch' }))
  })

  it('Process循環参照をErrorとして明示する', () => {
    const settings = createBenchmarkStore()
    settings.processes = [process('process-a', 'output-a', 'output-b'), process('process-b', 'output-b', 'output-a')]
    const issues = validateSettings(settings)
    expect(issues).toContainEqual(expect.objectContaining({ severity: 'error', code: 'process-cycle' }))
  })

  it('存在しないSource参照をErrorとして検出する', () => {
    const settings = createBenchmarkStore()
    settings.menuItems[0].consumption[0].sourceId = 'missing-resource'
    const issues = validateSettings(settings)
    expect(issues).toContainEqual(expect.objectContaining({ severity: 'error', code: 'missing-source' }))
  })

  it('計算を壊す数値・営業時間と構成比をまとめて検証する', () => {
    const settings = createBenchmarkStore()
    settings.resources[0].purchaseQuantity = 0
    settings.resources[0].purchasePrice = -1
    settings.resources[0].yieldRate = 0
    settings.resources[0].minimumPurchaseLot = 0
    settings.menuItems[0].sellingPrice = -1
    settings.menuItems[0].expectedSalesRatio = 90
    settings.business.weekdays[0].closingTime = settings.business.weekdays[0].openingTime
    const invalidProcess = process('invalid-process', 'invalid-output', 'unused-output')
    invalidProcess.inputs = [{ sourceType: 'resource', sourceId: 'benchmark-noodle', quantity: 1, unit: 'kg' }]
    invalidProcess.batchSize = 0
    invalidProcess.outputs[0].quantity = 0
    invalidProcess.outputs[0].costAllocation = 1.2
    settings.processes = [invalidProcess]

    const codes = new Set(validateSettings(settings).map((validationIssue) => validationIssue.code))
    expect([...codes]).toEqual(expect.arrayContaining([
      'invalid-purchase-package-quantity',
      'negative-purchase-package-price',
      'invalid-minimum-purchase-packages',
      'invalid-yield-rate',
      'negative-selling-price',
      'invalid-business-hours',
      'invalid-batch-size',
      'invalid-output-quantity',
      'invalid-cost-allocation',
      'menu-ratio-total',
    ]))
  })

  it('期首Inventory Lotの負数・不存在参照・単位不整合・取得日を検証する', () => {
    const settings = createBenchmarkStore()
    settings.inventory.openingLots = [
      { id: 'negative', sourceType: 'resource', sourceId: 'benchmark-noodle', quantity: -1, unit: 'L', acquiredDate: '' },
      { id: 'missing', sourceType: 'resource', sourceId: 'missing-resource', quantity: 1, unit: 'g', acquiredDate: '2026-01-01' },
    ]
    const codes = validateSettings(settings).map((validationIssue) => validationIssue.code)
    expect(codes).toEqual(expect.arrayContaining([
      'negative-inventory',
      'inventory-unit-mismatch',
      'opening-inventory-missing-date',
      'missing-inventory-source',
    ]))
  })

  it('Actual期間・実績値とScenario Overrideを検証する', () => {
    const settings = createBenchmarkStore()
    settings.actualPeriods = [{
      id: 'actual', name: '不正実績', startDate: '2026-02-01', endDate: '2026-01-01',
      actuals: {
        revenue: -1, menuSales: [],
        resourceRecords: [{ resourceId: 'missing', purchasedQuantity: 1, purchaseUnit: '本' }],
        utilities: { water: {}, gas: {}, electricity: {} },
      },
    }]
    settings.scenarios = [{ id: 'scenario', name: '不正Scenario', overrides: { laborWageMultiplier: -1, business: { operatingDaysPerWeek: 8 } } }]
    const codes = validateSettings(settings).map((validationIssue) => validationIssue.code)
    expect(codes).toEqual(expect.arrayContaining([
      'invalid-actual-period',
      'negative-actual-value',
      'missing-actual-resource',
      'negative-scenario-multiplier',
      'invalid-scenario-operating-days',
    ]))
  })

  it('Equipment・KitchenOperation・StaffShiftの不正値と参照を検証する', () => {
    const settings = createBenchmarkStore()
    settings.capacity.equipment[0].capacity = 0
    settings.capacity.equipment[0].concurrentJobs = 0
    settings.capacity.equipment[0].upgradeCostPerCapacityUnit = -1
    settings.capacity.operations[0].durationMinutes = 0
    settings.capacity.operations[0].activeLaborMinutes = -1
    settings.capacity.operations[0].batchCapacity = 0
    settings.capacity.operations[0].equipmentRequirements = [{ equipmentId: 'missing-equipment', occupationMinutes: 0, units: 0 }]
    settings.capacity.operations[0].laborRequirements = [{ laborRoleIds: ['missing-role'], headcount: -1 }]
    settings.capacity.staffShifts[0].headcount = -1
    settings.capacity.staffShifts[0].startTime = '08:00'
    const codes = validateSettings(settings).map((validationIssue) => validationIssue.code)
    expect(codes).toEqual(expect.arrayContaining([
      'invalid-equipment-capacity',
      'invalid-equipment-concurrency',
      'negative-equipment-upgrade-cost',
      'invalid-kitchen-duration',
      'invalid-active-labor-minutes',
      'invalid-kitchen-batch-capacity',
      'missing-kitchen-equipment',
      'invalid-equipment-requirement',
      'missing-kitchen-labor-role',
      'negative-kitchen-headcount',
      'negative-shift-headcount',
      'staff-shift-outside-business-hours',
    ]))
  })

  it('Capacity Scenario Overrideの不存在参照と不正値を検証する', () => {
    const settings = createBenchmarkStore()
    settings.scenarios = [{
      id: 'invalid-capacity-scenario', name: '不正Capacity', overrides: {
        staffShiftHeadcountOverrides: { missing: -1 },
        equipmentCapacityOverrides: { missing: 0 },
        kitchenOperationDurationOverrides: { missing: 0 },
      },
    }]
    const codes = validateSettings(settings).map((validationIssue) => validationIssue.code)
    expect(codes).toEqual(expect.arrayContaining([
      'missing-scenario-shift',
      'negative-scenario-shift-headcount',
      'missing-scenario-equipment',
      'invalid-scenario-equipment-capacity',
      'missing-scenario-kitchen-operation',
      'invalid-scenario-kitchen-duration',
    ]))
  })

  it('Phase 6のParty・客席・滞在・Monte Carlo設定を検証する', () => {
    const settings = createBenchmarkStore()
    const stochastic = settings.capacity.stochasticDemand
    stochastic.arrivalProfile.slots[0] = {
      ...stochastic.arrivalProfile.slots[0], startTime: '12:00', endTime: '11:00', expectedGuests: -1,
    }
    stochastic.partySizeDistribution = [{ size: 0, probability: -1 }]
    stochastic.seatingUnits[0].capacity = 0
    stochastic.seatingUnits[0].count = -1
    stochastic.orderDelay.meanMinutes = -1
    stochastic.dwellTime.meanMinutes = 0
    stochastic.maxSeatingWaitMinutes = -1
    stochastic.monteCarlo.runs = 1_001
    stochastic.monteCarlo.maximumRuns = 1_000

    const codes = validateSettings(settings).map((validationIssue) => validationIssue.code)
    expect(codes).toEqual(expect.arrayContaining([
      'invalid-arrival-range',
      'negative-expected-guests',
      'invalid-party-size',
      'negative-party-probability',
      'party-probability-total',
      'invalid-seating-capacity',
      'negative-seating-count',
      'invalid-order-delay',
      'invalid-dwell-time',
      'invalid-max-seating-wait',
      'monte-carlo-runs-exceeded',
    ]))
  })

  it('Phase 6 Scenarioの客席Overrideを検証する', () => {
    const settings = createBenchmarkStore()
    settings.scenarios = [{
      id: 'invalid-seating-scenario', name: '不正客席', overrides: {
        seatingUnitCountOverrides: { missing: -1 },
      },
    }]
    const codes = validateSettings(settings).map((validationIssue) => validationIssue.code)
    expect(codes).toEqual(expect.arrayContaining([
      'missing-scenario-seating-unit',
      'negative-scenario-seating-count',
    ]))
  })

  it('Phase 7の空候補・不正range・不存在targetをErrorにする', () => {
    const settings = createSampleSettings()
    settings.optimizationStudies[0].variables = [{
      id: 'invalid-variable', name: '不正設備', type: 'equipmentCapacity', targetId: 'missing', values: [], min: 10, max: 1, step: 0,
    }]
    const codes = validateSettings(settings).map((validationIssue) => validationIssue.code)
    expect(codes).toEqual(expect.arrayContaining([
      'optimization-min-greater-than-max',
      'invalid-optimization-step',
      'optimization-variable-empty',
      'missing-optimization-target',
    ]))
  })

  it('Phase 7のhard limit超過とMonte Carlo必須ObjectiveをErrorにする', () => {
    const settings = createSampleSettings()
    const study = settings.optimizationStudies[0]
    study.objective = 'maximizeP10OperatingProfit'
    study.evaluationMode = 'deterministic'
    study.hardCandidateLimit = 2
    const codes = validateSettings(settings).map((validationIssue) => validationIssue.code)
    expect(codes).toEqual(expect.arrayContaining([
      'optimization-objective-requires-monte-carlo',
      'optimization-hard-limit-exceeded',
    ]))
  })

  it('Phase 7の負数Staff・0 Equipment候補と不正ConstraintをErrorにする', () => {
    const settings = createSampleSettings()
    const study = settings.optimizationStudies[0]
    study.variables = [
      { id: 'staff', name: 'Staff', type: 'staffShiftHeadcount', targetId: settings.capacity.staffShifts[0].id, values: [-1] },
      { id: 'equipment', name: 'Equipment', type: 'equipmentCapacity', targetId: settings.capacity.equipment[0].id, values: [0] },
    ]
    study.constraints = [{ id: 'invalid', metric: 'laborCost', operator: '<=', value: Number.NaN }]
    const codes = validateSettings(settings).map((validationIssue) => validationIssue.code)
    expect(codes).toEqual(expect.arrayContaining([
      'negative-optimization-candidate',
      'invalid-optimization-candidate',
      'invalid-optimization-constraint',
    ]))
  })

  it('Phase 7の不正な営業時間候補をErrorにする', () => {
    const settings = createSampleSettings()
    settings.optimizationStudies[0].variables = [
      { id: 'opening', name: '開店', type: 'openingTime', values: ['20:00'] },
      { id: 'closing', name: '閉店', type: 'closingTime', values: ['19:00'] },
    ]
    expect(validateSettings(settings)).toContainEqual(expect.objectContaining({ severity: 'error', code: 'invalid-optimization-business-hours' }))
  })

  it('Phase 8の負Lead Time・Lookaheadと不正HorizonをErrorにする', () => {
    const settings = createSampleSettings()
    settings.resources[0].procurementLeadTimeDays = -1
    settings.resources[0].procurementLookaheadDays = -1
    settings.processes[0].prepLookaheadDays = -1
    settings.planning.horizonDays = 0
    const codes = validateSettings(settings).map((validationIssue) => validationIssue.code)
    expect(codes).toEqual(expect.arrayContaining(['negative-procurement-lead-time', 'negative-procurement-lookahead', 'negative-prep-lookahead', 'invalid-planning-horizon']))
  })

  it('Phase 8の不存在Resource注文と逆転入荷日をErrorにする', () => {
    const settings = createSampleSettings()
    settings.planning.purchaseOrders = [{ id: 'invalid', resourceId: 'missing', orderedDate: '2026-08-20', deliveryDate: '2026-08-19', packageCount: 0, quantity: -1, cost: -1, status: 'planned' }]
    const codes = validateSettings(settings).map((validationIssue) => validationIssue.code)
    expect(codes).toEqual(expect.arrayContaining(['missing-purchase-order-resource', 'invalid-purchase-order-date', 'invalid-purchase-order-quantity']))
  })

  it('Phase 8のLead Time・保存期限・Horizon超過をWarningにする', () => {
    const settings = createSampleSettings()
    settings.resources[0].procurementLeadTimeDays = 3
    settings.resources[0].procurementLookaheadDays = 1
    settings.processes[0].prepLookaheadDays = settings.processes[0].outputs[0].shelfLifeDays
    settings.planning.purchaseOrders = [{ id: 'late', resourceId: settings.resources[0].id, orderedDate: settings.business.simulationStartDate, deliveryDate: '2099-01-01', packageCount: 1, quantity: 1, cost: 1, status: 'planned' }]
    const codes = validateSettings(settings).map((validationIssue) => validationIssue.code)
    expect(codes).toEqual(expect.arrayContaining(['lead-time-exceeds-lookahead', 'prep-lookahead-exceeds-shelf-life', 'purchase-order-after-horizon']))
  })

  it('Phase 8の不正run数・仕込み上限・Daily参照をErrorにする', () => {
    const settings = createSampleSettings()
    settings.planning.monteCarloRuns = 0
    settings.planning.maxPrepActiveLaborMinutesPerDay = -1
    settings.planning.dailyOperatingPlans = [{ id: 'invalid-plan', date: settings.business.simulationStartDate, staffHeadcountOverrides: { missing: 1 }, manualPrepBatches: { missing: 1 } }]
    const codes = validateSettings(settings).map((validationIssue) => validationIssue.code)
    expect(codes).toEqual(expect.arrayContaining(['invalid-planning-monte-carlo-runs', 'invalid-planning-prep-capacity', 'invalid-daily-override']))
  })
})
