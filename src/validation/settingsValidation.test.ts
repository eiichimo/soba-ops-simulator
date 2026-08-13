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
      'invalid-purchase-quantity',
      'negative-purchase-price',
      'invalid-yield-rate',
      'negative-selling-price',
      'invalid-business-hours',
      'invalid-batch-size',
      'invalid-output-quantity',
      'invalid-cost-allocation',
      'menu-ratio-total',
    ]))
  })
})
