import { describe, expect, it } from 'vitest'
import type { GeneratedParty } from '../models/types'
import { createBenchmarkStore } from './fixtures/benchmarkStore'
import { simulateCustomerJourney } from './seatingEngine'

const party = (id: string, arrivalMinute: number, size: number, patch: Partial<GeneratedParty> = {}): GeneratedParty => ({
  id,
  arrivalMinute,
  arrivalTime: `${String(Math.floor(arrivalMinute / 60)).padStart(2, '0')}:${String(arrivalMinute % 60).padStart(2, '0')}`,
  size,
  orderDelayMinutes: 0,
  dwellMinutes: 10,
  menuItemIds: Array.from({ length: size }, () => 'benchmark-menu'),
  ...patch,
})

const journeyStore = () => {
  const settings = createBenchmarkStore('2026-01-05')
  settings.business.openingTime = '09:00'
  settings.business.closingTime = '10:00'
  settings.business.weekdays = settings.business.weekdays.map((day) => ({ ...day, openingTime: '09:00', closingTime: '10:00' }))
  settings.capacity.demandMode = 'stochastic'
  settings.capacity.equipment[0].capacity = 20
  settings.capacity.operations[0] = {
    ...settings.capacity.operations[0],
    durationMinutes: 1,
    activeLaborMinutes: 0,
    laborRequirements: [],
    batchCapacity: 20,
    equipmentRequirements: [{ equipmentId: 'benchmark-station', occupationMinutes: 1, units: 1 }],
  }
  settings.capacity.staffShifts = []
  settings.capacity.stochasticDemand.orderDelay = { distribution: 'fixed', meanMinutes: 0, minMinutes: 0, maxMinutes: 0 }
  settings.capacity.stochasticDemand.dwellTime = { distribution: 'fixed', meanMinutes: 10, minMinutes: 10, maxMinutes: 10 }
  settings.capacity.stochasticDemand.maxSeatingWaitMinutes = 20
  settings.capacity.stochasticDemand.seatingUnits = [
    { id: 'counter', name: 'カウンター', capacity: 1, count: 1, category: 'counter', enabled: true },
    { id: 'table-2', name: '2名席', capacity: 2, count: 1, category: 'table', enabled: true },
    { id: 'table-4', name: '4名席', capacity: 4, count: 1, category: 'table', enabled: true },
  ]
  return settings
}

describe('seating policy and queue', () => {
  it('1人Partyを最小容量のカウンターへ案内する', () => {
    const result = simulateCustomerJourney(journeyStore(), 1, [party('p1', 540, 1)])
    expect(result.parties[0].seatingUnitId).toBe('counter')
  })

  it('2人Partyは4名席より2名席を優先する', () => {
    const result = simulateCustomerJourney(journeyStore(), 1, [party('p1', 540, 2)])
    expect(result.parties[0].seatingUnitId).toBe('table-2')
  })

  it('空席がない場合に着席Queueが発生する', () => {
    const settings = journeyStore()
    settings.capacity.stochasticDemand.seatingUnits = [{ id: 'counter', name: '席', capacity: 1, count: 1, category: 'counter', enabled: true }]
    const result = simulateCustomerJourney(settings, 1, [party('p1', 540, 1), party('p2', 540, 1)])
    expect(result.maxSeatingQueueParties).toBe(1)
    expect(result.parties.find((item) => item.id === 'p2')?.seatedMinute).toBe(551)
  })

  it('Party退店後に席を解放して次Partyを案内する', () => {
    const settings = journeyStore()
    settings.capacity.stochasticDemand.seatingUnits = [{ id: 'counter', name: '席', capacity: 1, count: 1, category: 'counter', enabled: true }]
    const result = simulateCustomerJourney(settings, 1, [party('p1', 540, 1), party('p2', 541, 1)])
    expect(result.parties.find((item) => item.id === 'p1')?.departureMinute).toBe(551)
    expect(result.parties.find((item) => item.id === 'p2')?.seatedMinute).toBe(551)
  })

  it('収容不能な大Partyを待たせても収容可能な最古小Partyを案内する', () => {
    const settings = journeyStore()
    settings.capacity.stochasticDemand.seatingUnits = [{ id: 'counter', name: '席', capacity: 1, count: 1, category: 'counter', enabled: true }]
    const result = simulateCustomerJourney(settings, 1, [party('large', 540, 4), party('small', 541, 1)])
    expect(result.parties.find((item) => item.id === 'small')?.seatedMinute).toBe(541)
    expect(result.parties.find((item) => item.id === 'large')?.state).toBe('abandoned')
  })
})

describe('abandonment, ordering and dwell', () => {
  it('max seating wait到達時に閾値型で離脱する', () => {
    const settings = journeyStore()
    settings.capacity.stochasticDemand.seatingUnits = []
    settings.capacity.stochasticDemand.maxSeatingWaitMinutes = 5
    const result = simulateCustomerJourney(settings, 1, [party('p1', 540, 2)])
    expect(result.parties[0]).toMatchObject({ state: 'abandoned', abandonmentMinute: 545, abandonmentReason: 'maxWait' })
  })

  it('離脱Partyから厨房Orderを生成しない', () => {
    const settings = journeyStore()
    settings.capacity.stochasticDemand.seatingUnits = []
    const result = simulateCustomerJourney(settings, 1, [party('p1', 540, 2)])
    expect(result.orderedGuests).toBe(0)
    expect(result.capacity.totalOrders).toBe(0)
  })

  it('orderDelay後にParty人数分のOrderを厨房へ渡す', () => {
    const result = simulateCustomerJourney(journeyStore(), 1, [party('p1', 540, 2, { orderDelayMinutes: 3 })])
    expect(result.parties[0].orderMinute).toBe(543)
    expect(result.parties[0].orderIds).toHaveLength(2)
    expect(result.capacity.totalOrders).toBe(2)
  })

  it('全注文提供時刻+dwellTimeを退店時刻とする', () => {
    const result = simulateCustomerJourney(journeyStore(), 1, [party('p1', 540, 1, { dwellMinutes: 12 })])
    expect(result.parties[0].departureMinute).toBe((result.parties[0].servedMinute ?? 0) + 12)
  })

  it('退店後の席解放でSeat turnoverを算出する', () => {
    const settings = journeyStore()
    settings.capacity.stochasticDemand.seatingUnits = [{ id: 'counter', name: '席', capacity: 1, count: 1, category: 'counter', enabled: true }]
    const result = simulateCustomerJourney(settings, 1, [party('p1', 540, 1), party('p2', 552, 1)])
    expect(result.seatingUtilization[0].turnover).toBe(2)
    expect(result.seatTurnover).toBe(2)
  })
})

describe('kitchen and seating metrics', () => {
  it('Party Orderを既存Capacity Engineへ接続する', () => {
    const result = simulateCustomerJourney(journeyStore(), 1, [party('p1', 540, 2)])
    expect(result.capacity.completedOrders).toBe(2)
    expect(result.realizedSalesMeals).toBe(2)
  })

  it('Kitchen工程時間増加で厨房提供待ちが増える', () => {
    const fast = journeyStore()
    const slow = journeyStore()
    slow.capacity.operations[0].durationMinutes = 10
    slow.capacity.operations[0].equipmentRequirements[0].occupationMinutes = 10
    expect(simulateCustomerJourney(slow, 1, [party('p1', 540, 1)]).averageKitchenWaitMinutes)
      .toBeGreaterThan(simulateCustomerJourney(fast, 1, [party('p1', 540, 1)]).averageKitchenWaitMinutes)
  })

  it('Seat utilizationを実客席占有時間÷利用可能席時間で算出する', () => {
    const settings = journeyStore()
    settings.capacity.stochasticDemand.seatingUnits = [{ id: 'counter', name: '席', capacity: 1, count: 1, category: 'counter', enabled: true }]
    const result = simulateCustomerJourney(settings, 1, [party('p1', 540, 1)])
    expect(result.seatUtilization).toBeCloseTo(11 / 60)
  })

  it('大きいテーブルの未使用席時間をunusedSeatMinutesにする', () => {
    const settings = journeyStore()
    settings.capacity.stochasticDemand.seatingUnits = [{ id: 'table', name: '4名席', capacity: 4, count: 1, category: 'table', enabled: true }]
    const result = simulateCustomerJourney(settings, 1, [party('p1', 540, 2)])
    expect(result.unusedSeatMinutes).toBeCloseTo(22)
  })

  it('完成Orderの実Menu MixでRealized Salesを算出する', () => {
    const result = simulateCustomerJourney(journeyStore(), 1, [party('p1', 540, 2)])
    expect(result.economic.realizedMeals).toBe(2)
    expect(result.economic.realizedRevenue).toBe(2_000)
  })
})

