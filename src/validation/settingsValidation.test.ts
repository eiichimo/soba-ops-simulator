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
})
