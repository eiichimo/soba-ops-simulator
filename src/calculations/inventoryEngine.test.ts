import { describe, expect, it } from 'vitest'
import type { InventoryLot, Process, Resource } from '../models/types'
import { createBenchmarkStore } from './fixtures/benchmarkStore'
import { calculatePurchaseOrder, consumeInventoryFIFO } from './inventoryEngine'
import { simulate } from './engine'

const lot = (id: string, quantity: number, acquiredDate: string, unitCost: number): InventoryLot => ({
  id,
  sourceType: 'resource',
  sourceId: 'ingredient',
  quantity,
  unit: 'g',
  acquiredDate,
  unitCost,
  purchaseCost: quantity * unitCost,
  source: 'purchase',
})

const resource = (patch: Partial<Resource> = {}): Resource => ({
  id: 'ingredient',
  name: '材料',
  category: 'other',
  purchaseQuantity: 40,
  purchaseUnit: '本',
  purchasePrice: 4_000,
  yieldRate: 1,
  usableQuantity: 40,
  storageType: 'frozen',
  shelfLifeDays: 90,
  minimumPurchaseLot: 1,
  isReferencePrice: false,
  ...patch,
})

describe('inventory and purchasing engine', () => {
  it('FIFOで古いLotから600gを消費する', () => {
    const result = consumeInventoryFIFO([
      lot('lot-a', 500, '2026-08-01', 1),
      lot('lot-b', 700, '2026-08-02', 1),
    ], 'resource', 'ingredient', 600, 'g')
    expect(result.consumedQuantity).toBeCloseTo(600)
    expect(result.lots.find((item) => item.id === 'lot-a')).toBeUndefined()
    expect(result.lots.find((item) => item.id === 'lot-b')?.quantity).toBeCloseTo(600)
  })

  it('不足45本に対して40本箱を2箱購入する', () => {
    const order = calculatePurchaseOrder(resource(), 5, 50)
    expect(order.packages).toBe(2)
    expect(order.purchasedQuantity).toBe(80)
    expect(order.stockedQuantity).toBe(80)
    expect(order.expenditure).toBe(8_000)
  })

  it('最低購入パッケージ数を適用する', () => {
    const order = calculatePurchaseOrder(resource({ minimumPurchaseLot: 2 }), 0, 10)
    expect(order.packages).toBe(2)
    expect(order.stockedQuantity).toBe(80)
  })

  it('5本の期首在庫から50本必要な日に2箱購入して35本を残す', () => {
    const settings = createBenchmarkStore('2026-08-03')
    settings.resources = [resource()]
    settings.menuItems[0].consumption = [{ sourceType: 'resource', sourceId: 'ingredient', quantity: 0.5, unit: '本' }]
    settings.inventory.openingLots = [{ id: 'opening-shrimp', sourceType: 'resource', sourceId: 'ingredient', quantity: 5, unit: '本', acquiredDate: '2026-08-01', unitCost: 100 }]
    const result = simulate(settings, 'day')
    const item = result.inventory.items.find((summary) => summary.sourceId === 'ingredient')!
    expect(result.inventory.purchases[0].packages).toBe(2)
    expect(result.inventory.purchases[0].purchasedQuantity).toBe(80)
    expect(item.endingQuantity).toBeCloseTo(35)
  })

  it('1Lの内製品在庫に2L必要なら5Lを1batch生産して4Lを持ち越す', () => {
    const settings = createBenchmarkStore('2026-08-03')
    settings.resources = []
    settings.processes = [{
      id: 'stock-process',
      name: '5L仕込み',
      inputs: [],
      outputs: [{ id: 'stock-output', name: '仕込品', quantity: 5, unit: 'L', costAllocation: 1, storageType: 'refrigerated', shelfLifeDays: 10 }],
      batchSize: 5,
      processDurationMinutes: 10,
      activeLaborMinutes: 0,
      laborRole: 'benchmark-staff',
      laborCostTreatment: 'withinScheduledShift',
      gasUsageM3: 0,
      electricUsageKWh: 0,
      waterUsageL: 0,
      wasteRate: 0,
      wasteReason: 'cookingLoss',
    }]
    settings.menuItems[0].consumption = [{ sourceType: 'output', sourceId: 'stock-output', quantity: 0.02, unit: 'L' }]
    settings.inventory.openingLots = [{ id: 'opening-output', sourceType: 'output', sourceId: 'stock-output', quantity: 1, unit: 'L', acquiredDate: '2026-08-01', unitCost: 10 }]

    const result = simulate(settings, 'day')
    const output = result.inventory.items.find((item) => item.sourceId === 'stock-output')!
    expect(result.details.processes[0].batches).toBe(1)
    expect(output.consumedQuantity).toBeCloseTo(2)
    expect(output.endingQuantity).toBeCloseTo(4)
    expect(output.openingValue + output.productionValue - output.usageCost - output.wasteCost).toBeCloseTo(output.endingValue)
  })

  it('内製品の余剰を翌営業日に持ち越して再生産を避ける', () => {
    const settings = createBenchmarkStore('2026-08-03')
    settings.resources = []
    settings.processes = [{
      id: 'carry-process', name: '5L仕込み', inputs: [],
      outputs: [{ id: 'carry-output', name: '持越品', quantity: 5, unit: 'L', costAllocation: 1, storageType: 'refrigerated', shelfLifeDays: 365 }],
      batchSize: 5, processDurationMinutes: 10, activeLaborMinutes: 0, laborRole: 'benchmark-staff', laborCostTreatment: 'withinScheduledShift',
      gasUsageM3: 0, electricUsageKWh: 0, waterUsageL: 0, wasteRate: 0, wasteReason: 'cookingLoss',
    }]
    settings.menuItems[0].consumption = [{ sourceType: 'output', sourceId: 'carry-output', quantity: 0.01, unit: 'L' }]
    const result = simulate(settings, 'month')
    const item = result.inventory.items.find((summary) => summary.sourceId === 'carry-output')!
    expect(item.dailyMovements[0]).toMatchObject({ producedQuantity: 5, consumedQuantity: 1, endingQuantity: 4 })
    expect(item.dailyMovements[1]).toMatchObject({ openingQuantity: 4, producedQuantity: 0, consumedQuantity: 1, endingQuantity: 3 })
  })

  it('期限切れLotを営業前にspoilageとして廃棄する', () => {
    const settings = createBenchmarkStore('2026-08-02')
    settings.business.weekdays.forEach((day) => { day.enabled = false })
    settings.inventory.openingLots = [{
      id: 'expired-noodle', sourceType: 'resource', sourceId: 'benchmark-noodle', quantity: 2, unit: 'kg', acquiredDate: '2026-07-30', expiryDate: '2026-08-02', unitCost: 1_000,
    }]
    const result = simulate(settings, 'day')
    const noodle = result.inventory.items.find((item) => item.sourceId === 'benchmark-noodle')!
    expect(result.meals).toBe(0)
    expect(noodle.wastedQuantity).toBeCloseTo(2)
    expect(noodle.endingQuantity).toBe(0)
    expect(result.inventory.wasteCost).toBeCloseTo(2_000)
    expect(result.inventory.wastes).toContainEqual(expect.objectContaining({ sourceId: 'benchmark-noodle', reason: 'spoilage', cost: 2_000 }))
  })

  it('shelfLifeDays 3は取得日から3日目の終了まで使用できる', () => {
    const usableSettings = createBenchmarkStore('2026-08-03')
    usableSettings.business.weekdays.forEach((day) => { day.enabled = false })
    usableSettings.resources[0].shelfLifeDays = 3
    usableSettings.inventory.openingLots = [{ id: 'three-day', sourceType: 'resource', sourceId: 'benchmark-noodle', quantity: 1, unit: 'kg', acquiredDate: '2026-08-01', unitCost: 1_000 }]
    expect(simulate(usableSettings, 'day').inventory.endingInventoryValue).toBeCloseTo(1_000)

    const expiredSettings = { ...usableSettings, business: { ...usableSettings.business, simulationStartDate: '2026-08-04' } }
    const expired = simulate(expiredSettings, 'day')
    expect(expired.inventory.endingInventoryValue).toBe(0)
    expect(expired.inventory.wastes[0].reason).toBe('spoilage')
  })

  it('18Lを6,840円で購入して2L使用した原価を760円とする', () => {
    const settings = createBenchmarkStore('2026-08-03')
    settings.resources = [resource({
      id: 'oil', name: '揚げ油', category: 'oil', purchaseQuantity: 18, purchaseUnit: 'L', purchasePrice: 6_840, usableQuantity: 18, shelfLifeDays: 365,
    })]
    settings.menuItems[0].consumption = [{ sourceType: 'resource', sourceId: 'oil', quantity: 0.02, unit: 'L' }]
    const result = simulate(settings, 'day')
    const oil = result.inventory.items.find((item) => item.sourceId === 'oil')!
    expect(result.inventory.purchaseExpenditure).toBeCloseTo(6_840)
    expect(result.inventory.usageCost).toBeCloseTo(760)
    expect(oil.endingQuantity).toBeCloseTo(16)
    expect(result.inventory.simpleCashFlow).toBeCloseTo(80_580)
  })

  it('揚げ油設備使用量をInventory Resourceへ接続し二重計上しない', () => {
    const settings = createBenchmarkStore('2026-08-03')
    settings.resources = [resource({
      id: 'oil', name: '揚げ油', category: 'oil', purchaseQuantity: 18, purchaseUnit: 'L', purchasePrice: 6_840, usableQuantity: 18, shelfLifeDays: 365,
    })]
    settings.menuItems[0].consumption = []
    settings.fryingOil = {
      ...settings.fryingOil,
      inventoryResourceId: 'oil',
      initialFillL: 6,
      replacementIntervalDays: 3,
    }

    const result = simulate(settings, 'day')
    const oil = result.inventory.items.find((item) => item.sourceId === 'oil')!
    expect(result.inventory.purchaseExpenditure).toBeCloseTo(6_840)
    expect(result.inventory.usageCost).toBeCloseTo(760)
    expect(result.costs.fryingOil).toBeCloseTo(760)
    expect(result.details.fryingOilLiters).toBeCloseTo(2)
    expect(oil.endingQuantity).toBeCloseTo(16)
  })

  it('価格の異なるLotもFIFO取得原価で消費する', () => {
    const older = lot('old', 1, '2026-08-01', 100)
    const newer = lot('new', 1, '2026-09-01', 130)
    const result = consumeInventoryFIFO([newer, older], 'resource', 'ingredient', 1.5, 'g')
    expect(result.consumedCost).toBeCloseTo(165)
    expect(result.lots).toHaveLength(1)
    expect(result.lots[0].id).toBe('new')
    expect(result.lots[0].quantity).toBeCloseTo(0.5)
  })

  it('副産物をInventoryへ投入して後日利用可能にする', () => {
    const settings = createBenchmarkStore('2026-08-03')
    settings.resources = []
    const process: Process = {
      id: 'byproduct-process', name: '副産物工程', inputs: [],
      outputs: [
        { id: 'primary', name: '主生成物', quantity: 100, unit: '食', costAllocation: 1, storageType: 'refrigerated', shelfLifeDays: 2 },
        { id: 'byproduct', name: '副産物', quantity: 50, unit: '食', costAllocation: 0, storageType: 'refrigerated', shelfLifeDays: 3 },
      ],
      batchSize: 100, processDurationMinutes: 10, activeLaborMinutes: 0, laborRole: 'benchmark-staff', laborCostTreatment: 'withinScheduledShift',
      gasUsageM3: 0, electricUsageKWh: 0, waterUsageL: 0, wasteRate: 0, wasteReason: 'cookingLoss',
    }
    settings.processes = [process]
    settings.menuItems[0].consumption = [{ sourceType: 'output', sourceId: 'primary', quantity: 1, unit: '食' }]
    const result = simulate(settings, 'day')
    const byproduct = result.inventory.items.find((item) => item.sourceId === 'byproduct')!
    expect(byproduct.byProductQuantity).toBe(50)
    expect(byproduct.endingQuantity).toBe(50)
    expect(byproduct.endingLots[0].source).toBe('byProduct')
  })

  it('30日集計で購入支出・使用原価・期末価額が整合する', () => {
    const result = simulate(createBenchmarkStore('2026-01-03'), 'month')
    expect(result.operatingDays).toBe(20)
    expect(result.inventory.purchaseExpenditure).toBeCloseTo(300_000)
    expect(result.inventory.usageCost).toBeCloseTo(300_000)
    expect(result.inventory.endingInventoryValue).toBeCloseTo(0)
  })

  it('Resourceごとの数量・金額在庫方程式が成立する', () => {
    const result = simulate(createBenchmarkStore('2026-01-05'), 'day')
    const item = result.inventory.items.find((summary) => summary.sourceId === 'benchmark-noodle')!
    expect(item.openingQuantity + item.purchasedQuantity - item.consumedQuantity - item.wastedQuantity).toBeCloseTo(item.endingQuantity)
    expect(item.openingValue + item.purchaseExpenditure - item.usageCost - item.wasteCost).toBeCloseTo(item.endingValue)
  })

  it('1年の日次在庫シミュレーションを完走する', () => {
    const result = simulate(createBenchmarkStore('2026-01-01'), 'year')
    expect(result.calendarDays).toBe(365)
    expect(result.inventory.purchaseCount).toBeGreaterThan(0)
    expect(Number.isFinite(result.inventory.endingInventoryValue)).toBe(true)
  })
})
