import { describe, expect, it } from 'vitest'
import { createBenchmarkStore } from './fixtures/benchmarkStore'
import { simulate } from './engine'
import { deriveMultiDaySeed, resolveDailyOperatingSettings, runMultiDayMonteCarlo, simulateMultiDay } from './multiDayEngine'
import type { AppSettings, Process } from '../models/types'

const baseStore = (start = '2026-08-17'): AppSettings => {
  const settings = createBenchmarkStore(start)
  settings.business.mealsPerDay = 8
  settings.business.weekdays = settings.business.weekdays.map((day) => ({ ...day, enabled: true }))
  settings.planning.horizonDays = 2
  settings.planning.weekdayTemplates = settings.business.weekdays.map((day) => ({ ...day, mealsPerDay: 8 }))
  settings.capacity.demandProfile.timeSlots = [{ id: 'demand', startTime: '09:00', endTime: '17:00', meals: 8 }]
  settings.capacity.stochasticDemand.arrivalProfile.slots = [{ id: 'arrival', startTime: '09:00', endTime: '17:00', expectedGuests: 8, arrivalDistribution: 'uniform' }]
  settings.resources = [{
    ...settings.resources[0], id: 'item', name: '品目', purchaseQuantity: 10, purchaseUnit: '個', purchasePrice: 1_000,
    usableQuantity: 10, shelfLifeDays: 30, minimumPurchaseLot: 1, procurementLeadTimeDays: 0, procurementLookaheadDays: 0,
  }]
  settings.menuItems = [{ ...settings.menuItems[0], sellingPrice: 300, consumption: [{ sourceType: 'resource', sourceId: 'item', quantity: 1, unit: '個' }] }]
  settings.labor = settings.labor.map((role) => ({ ...role, hourlyWage: 0 }))
  settings.utilities.water.uses = []
  settings.utilities.gas.uses = []
  settings.utilities.electricity.uses = []
  settings.otherCosts = []
  settings.fryingOil = { ...settings.fryingOil, inventoryResourceId: undefined }
  return settings
}

const processStore = (shelfLifeDays = 10) => {
  const settings = baseStore()
  settings.resources[0].purchaseQuantity = 100
  settings.resources[0].purchasePrice = 1_000
  const process: Process = {
    id: 'prep', name: '仕込み', inputs: [{ sourceType: 'resource', sourceId: 'item', quantity: 20, unit: '個' }],
    outputs: [{ id: 'prepared', name: '仕込品', quantity: 20, unit: '個', costAllocation: 1, storageType: 'refrigerated', shelfLifeDays }],
    batchSize: 20, processDurationMinutes: 20, activeLaborMinutes: 10, laborRole: settings.labor[0].id,
    laborCostTreatment: 'additionalLabor', gasUsageM3: 0, electricUsageKWh: 0, waterUsageL: 0,
    wasteRate: 0, wasteReason: 'cookingLoss', prepLookaheadDays: 0,
  }
  settings.processes = [process]
  settings.menuItems[0].consumption = [{ sourceType: 'output', sourceId: 'prepared', quantity: 1, unit: '個' }]
  return settings
}

describe('multi-day state carryover / inventory', () => {
  it('Day1期末在庫をDay2期首へ引き継ぐ', () => {
    const result = simulateMultiDay(baseStore(), { horizonDays: 2 })
    const rows = result.inventoryTimeline.filter((row) => row.sourceId === 'item')
    expect(rows[0].endingQuantity).toBeCloseTo(2)
    expect(rows[1].openingQuantity).toBeCloseTo(2)
    expect(rows[1].endingQuantity).toBeCloseTo(4)
  })

  it('複数価格Lotを翌日もFIFOで消費する', () => {
    const settings = baseStore()
    settings.business.mealsPerDay = 1
    settings.planning.weekdayTemplates.forEach((day) => { day.mealsPerDay = 1 })
    settings.inventory.openingLots = [
      { id: 'old', sourceType: 'resource', sourceId: 'item', quantity: 1, unit: '個', acquiredDate: '2026-08-15', unitCost: 100 },
      { id: 'new', sourceType: 'resource', sourceId: 'item', quantity: 2, unit: '個', acquiredDate: '2026-08-16', unitCost: 130 },
    ]
    const result = simulateMultiDay(settings, { horizonDays: 2 })
    expect(result.usageCost).toBeCloseTo(230)
    expect(result.endingLots).toHaveLength(1)
    expect(result.endingLots[0]).toMatchObject({ id: 'new', quantity: 1, unitCost: 130 })
  })

  it('休業日でも賞味期限が進みspoilageになる', () => {
    const settings = baseStore()
    settings.inventory.openingLots = [{ id: 'short', sourceType: 'resource', sourceId: 'item', quantity: 20, unit: '個', acquiredDate: '2026-08-16', expiryDate: '2026-08-18', unitCost: 100 }]
    settings.planning.weekdayTemplates.find((day) => day.day === 1)!.enabled = false
    const result = simulateMultiDay(settings, { horizonDays: 2 })
    expect(result.dailyResults[1].operating).toBe(false)
    expect(result.dailyResults[1].wasteCost).toBeCloseTo(1_200)
    expect(result.endingLots.some((lot) => lot.id === 'short')).toBe(false)
  })

  it('1日Horizonは従来Engineの使用原価・利益と一致する', () => {
    const settings = createBenchmarkStore('2026-01-05')
    const legacy = simulate(settings, 'day')
    const multiDay = simulateMultiDay(settings, { horizonDays: 1 })
    expect(multiDay.revenue).toBeCloseTo(legacy.revenue)
    expect(multiDay.usageCost).toBeCloseTo(legacy.inventory.usageCost)
    expect(multiDay.operatingProfit).toBeCloseTo(legacy.operatingProfit)
  })

  it('期間全体の数量Equationが成立する', () => {
    const result = simulateMultiDay(baseStore(), { horizonDays: 2 })
    const rows = result.inventoryTimeline.filter((row) => row.sourceId === 'item')
    const opening = rows[0].openingQuantity
    const delivered = rows.reduce((total, row) => total + row.deliveredQuantity, 0)
    const consumed = rows.reduce((total, row) => total + row.consumedQuantity, 0)
    const wasted = rows.reduce((total, row) => total + row.wastedQuantity, 0)
    expect(opening + delivered - consumed - wasted).toBeCloseTo(rows.at(-1)!.endingQuantity)
  })
})

describe('multi-day prep planning', () => {
  it('Process batchの余剰を翌日へ持ち越す', () => {
    const result = simulateMultiDay(processStore(), { horizonDays: 2 })
    const output = result.inventoryTimeline.filter((row) => row.sourceId === 'prepared')
    expect(output[0].producedQuantity).toBe(20)
    expect(output[0].endingQuantity).toBe(12)
    expect(output[1].producedQuantity).toBe(0)
    expect(output[1].endingQuantity).toBe(4)
  })

  it('prepLookaheadで2日需要を1バッチへまとめる', () => {
    const settings = processStore()
    settings.processes[0].prepLookaheadDays = 1
    settings.planning.weekdayTemplates.find((day) => day.day === 2)!.enabled = false
    const result = simulateMultiDay(settings, { horizonDays: 2 })
    expect(result.prepTimeline.reduce((total, row) => total + row.batches, 0)).toBe(1)
  })

  it('保存期限以上のprepLookaheadを自動的に制限する', () => {
    const settings = processStore(1)
    settings.processes[0].prepLookaheadDays = 5
    const result = simulateMultiDay(settings, { horizonDays: 2 })
    expect(result.dailyResults[0].inventory.endingLots.find((lot) => lot.sourceId === 'prepared')?.expiryDate).toBe('2026-08-18')
  })

  it('休業日は自動仕込みを実行しない', () => {
    const settings = processStore()
    settings.planning.weekdayTemplates[0].enabled = false
    settings.processes[0].prepLookaheadDays = 2
    const result = simulateMultiDay(settings, { horizonDays: 1 })
    expect(result.prepTimeline).toHaveLength(0)
  })

  it('Manual Prep Planは指定日の追加batchを在庫化する', () => {
    const settings = processStore()
    settings.planning.dailyOperatingPlans = [{ id: 'manual', date: '2026-08-17', manualPrepBatches: { prep: 2 } }]
    const result = simulateMultiDay(settings, { horizonDays: 1 })
    expect(result.prepTimeline[0].batches).toBe(2)
    expect(result.prepTimeline[0].endingQuantity).toBe(32)
  })

  it('まとめ仕込みは保存期限内なら日別追加仕込みよりactive laborが少ない', () => {
    const planA = processStore()
    planA.planning.dailyOperatingPlans = [{ id: 'a', date: '2026-08-17', manualPrepBatches: { prep: 1 } }]
    const planB = processStore()
    planB.planning.dailyOperatingPlans = [{ id: 'b1', date: '2026-08-17', manualPrepBatches: { prep: 1 } }, { id: 'b2', date: '2026-08-18', manualPrepBatches: { prep: 1 } }]
    const laborA = simulateMultiDay(planA, { horizonDays: 2 }).prepTimeline.reduce((total, row) => total + row.activeLaborMinutes, 0)
    const laborB = simulateMultiDay(planB, { horizonDays: 2 }).prepTimeline.reduce((total, row) => total + row.activeLaborMinutes, 0)
    expect(laborA).toBeLessThan(laborB)
  })
})

describe('procurement lead time / stockout', () => {
  it('Lead Time 0は不足日にpackage購入して使用できる', () => {
    const result = simulateMultiDay(baseStore(), { horizonDays: 1 })
    expect(result.realizedMeals).toBe(8)
    expect(result.purchaseExpenditure).toBe(1_000)
  })

  it('Lead Time 1はDay1発注・Day2入荷になる', () => {
    const settings = baseStore()
    settings.resources[0].procurementLeadTimeDays = 1
    settings.resources[0].procurementLookaheadDays = 1
    const result = simulateMultiDay(settings, { horizonDays: 2 })
    expect(result.dailyResults[0].realizedMeals).toBe(0)
    expect(result.dailyResults[1].deliveredOrders.length).toBeGreaterThan(0)
    expect(result.dailyResults[1].realizedMeals).toBe(8)
  })

  it('Lead Time 2のPending OrderはDay3まで在庫に入らない', () => {
    const settings = baseStore()
    settings.resources[0].procurementLeadTimeDays = 2
    settings.resources[0].procurementLookaheadDays = 2
    const result = simulateMultiDay(settings, { horizonDays: 3 })
    expect(result.dailyResults.slice(0, 2).every((day) => day.realizedMeals === 0)).toBe(true)
    expect(result.dailyResults[2].deliveredOrders.length).toBeGreaterThan(0)
  })

  it('delivery日にPurchaseOrderをInventoryLotへ変換する', () => {
    const settings = baseStore()
    settings.resources[0].procurementLeadTimeDays = 1
    settings.resources[0].procurementLookaheadDays = 1
    const result = simulateMultiDay(settings, { horizonDays: 2 })
    expect(result.dailyResults[1].inventory.endingLots.some((lot) => lot.source === 'purchase')).toBe(true)
  })

  it('minimumPurchaseLotを維持する', () => {
    const settings = baseStore()
    settings.resources[0].minimumPurchaseLot = 2
    const result = simulateMultiDay(settings, { horizonDays: 1 })
    expect(result.dailyResults[0].inventory.purchases[0].packages).toBe(2)
    expect(result.endingLots[0].quantity).toBeCloseTo(12)
  })

  it('procurementLookaheadが未来必要量をpackageへ切り上げる', () => {
    const settings = baseStore()
    settings.resources[0].procurementLeadTimeDays = 1
    settings.resources[0].procurementLookaheadDays = 2
    const result = simulateMultiDay(settings, { horizonDays: 1 })
    expect(result.pendingOrders[0].packageCount).toBe(3)
  })

  it('在庫不足をstockoutとして記録する', () => {
    const settings = baseStore()
    settings.resources[0].procurementLeadTimeDays = 2
    settings.resources[0].procurementLookaheadDays = 2
    const result = simulateMultiDay(settings, { horizonDays: 1 })
    expect(result.stockoutDays).toBe(1)
    expect(result.dailyResults[0].stockouts[0].resourceIds).toContain('item')
  })

  it('stockoutでも在庫を負にしない', () => {
    const settings = baseStore()
    settings.resources[0].procurementLeadTimeDays = 2
    settings.resources[0].procurementLookaheadDays = 2
    const result = simulateMultiDay(settings, { horizonDays: 1 })
    expect(result.inventoryTimeline.every((row) => row.endingQuantity >= 0)).toBe(true)
  })

  it('stockout lost salesを食数と売上へ分離する', () => {
    const settings = baseStore()
    settings.resources[0].procurementLeadTimeDays = 2
    settings.resources[0].procurementLookaheadDays = 2
    const result = simulateMultiDay(settings, { horizonDays: 1 })
    expect(result.stockoutLostMeals).toBe(8)
    expect(result.stockoutLostRevenue).toBe(2_400)
  })

  it('Manual PurchaseOrderを指定入荷日に受け入れる', () => {
    const settings = baseStore()
    settings.resources[0].procurementLeadTimeDays = 2
    settings.resources[0].procurementLookaheadDays = 0
    settings.planning.purchaseOrders = [{ id: 'manual', resourceId: 'item', orderedDate: '2026-08-17', deliveryDate: '2026-08-17', packageCount: 1, quantity: 10, cost: 1_000, status: 'planned' }]
    const result = simulateMultiDay(settings, { horizonDays: 1 })
    expect(result.realizedMeals).toBe(8)
    expect(result.purchaseExpenditure).toBe(1_000)
  })

  it('期間終了後入荷の注文をPendingとして保持する', () => {
    const settings = baseStore()
    settings.resources[0].procurementLeadTimeDays = 2
    settings.resources[0].procurementLookaheadDays = 2
    const result = simulateMultiDay(settings, { horizonDays: 1 })
    expect(result.pendingOrders.length).toBeGreaterThan(0)
  })
})

describe('multi-day economic / calendar / random seed', () => {
  it('2日売上を日次Realized Salesから集計する', () => expect(simulateMultiDay(baseStore(), { horizonDays: 2 }).revenue).toBe(4_800))
  it('2日使用原価をFIFO消費価額で集計する', () => expect(simulateMultiDay(baseStore(), { horizonDays: 2 }).usageCost).toBe(1_600))
  it('2日購入支出は2package分になる', () => expect(simulateMultiDay(baseStore(), { horizonDays: 2 }).purchaseExpenditure).toBe(2_000))
  it('期末在庫価額を残量4個として計算する', () => expect(simulateMultiDay(baseStore(), { horizonDays: 2 }).endingInventoryValue).toBe(400))

  it('shelfLifeDays=2はDay3開始時に残Lotをspoilageへ回す', () => {
    const settings = baseStore()
    settings.business.mealsPerDay = 2
    settings.planning.weekdayTemplates.forEach((day) => { day.mealsPerDay = 2 })
    settings.resources[0].shelfLifeDays = 2
    const result = simulateMultiDay(settings, { horizonDays: 3 })
    expect(result.dailyResults[2].wasteCost).toBe(600)
  })

  it('曜日Overrideを日次設定へ適用する', () => {
    const settings = baseStore()
    settings.planning.weekdayTemplates[0].mealsPerDay = 12
    expect(resolveDailyOperatingSettings(settings, new Date(2026, 7, 17)).business.mealsPerDay).toBe(12)
  })

  it('日付Overrideを曜日Overrideより優先する', () => {
    const settings = baseStore()
    settings.planning.weekdayTemplates[0].mealsPerDay = 12
    settings.planning.dailyOperatingPlans = [{ id: 'special', date: '2026-08-17', mealsPerDay: 3 }]
    expect(resolveDailyOperatingSettings(settings, new Date(2026, 7, 17)).business.mealsPerDay).toBe(3)
  })

  it('休業Overrideで売上・営業由来費用を0にする', () => {
    const settings = baseStore()
    settings.planning.dailyOperatingPlans = [{ id: 'closed', date: '2026-08-17', enabled: false }]
    const day = simulateMultiDay(settings, { horizonDays: 1 }).dailyResults[0]
    expect(day.operating).toBe(false)
    expect(day.revenue).toBe(0)
    expect(day.laborCost).toBe(0)
  })

  it('run/day seedを衝突しない形で導出する', () => {
    expect(deriveMultiDaySeed(123, 0, 1)).not.toBe(deriveMultiDaySeed(123, 1, 0))
    expect(deriveMultiDaySeed(123, 2, 3)).toBe(deriveMultiDaySeed(123, 2, 3))
  })

  it('同一seedの週間Monte Carloは同じ結果になる', () => {
    const settings = baseStore()
    settings.capacity.demandMode = 'stochastic'
    const a = runMultiDayMonteCarlo(settings, 3, 123, 7)
    const b = runMultiDayMonteCarlo(settings, 3, 123, 7)
    expect(a.summaries).toEqual(b.summaries)
  })

  it('週間Monte Carloはp10利益と赤字期間率を返す', () => {
    const settings = baseStore()
    settings.capacity.demandMode = 'stochastic'
    const result = runMultiDayMonteCarlo(settings, 5, 321, 7)
    expect(result.horizonDays).toBe(7)
    expect(Number.isFinite(result.statistics.operatingProfit.p10)).toBe(true)
    expect(result.lossPeriodRate).toBeGreaterThanOrEqual(0)
    expect(result.lossPeriodRate).toBeLessThanOrEqual(1)
  })
})
