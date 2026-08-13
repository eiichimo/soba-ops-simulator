import { describe, expect, it } from 'vitest'
import type { AppSettings, CapacityOrder, KitchenOperation } from '../models/types'
import { validateSettings } from '../validation/settingsValidation'
import { createSampleSettings } from '../data/sampleData'
import { applyScenarioOverrides } from './decisionSupport'
import { createDeterministicOrders, simulateCapacity } from './capacityEngine'
import { createBenchmarkStore } from './fixtures/benchmarkStore'

const atOpening = (count: number, menuItemId = 'benchmark-menu'): CapacityOrder[] => Array.from({ length: count }, (_, index) => ({
  id: `order-${index + 1}`,
  arrivalMinute: 9 * 60,
  arrivalTime: '09:00',
  menuItemId,
  quantity: 1,
}))

const simpleStore = (orders = 10, duration = 5): AppSettings => {
  const settings = createBenchmarkStore('2026-01-05')
  settings.business.openingTime = '09:00'
  settings.business.closingTime = '10:00'
  settings.business.hoursPerDay = 1
  settings.business.mealsPerDay = orders
  settings.business.weekdays = settings.business.weekdays.map((day) => ({ ...day, openingTime: '09:00', closingTime: '10:00' }))
  settings.labor[0].hoursPerDay = 1
  settings.capacity.equipment = [{ id: 'station', name: '単純設備', category: 'other', capacity: 1, capacityUnit: '食', concurrentJobs: 1, enabled: true, isReferenceCapacity: false }]
  settings.capacity.operations = [{
    id: 'service', name: '単純工程', durationMinutes: duration, activeLaborMinutes: duration,
    equipmentRequirements: [{ equipmentId: 'station', occupationMinutes: duration, units: 1 }],
    laborRequirements: [{ laborRoleIds: ['benchmark-staff'], headcount: 1 }],
    batchCapacity: 1, enabled: true, isReferenceCapacity: false,
  }]
  settings.capacity.workflows = [{ id: 'workflow', name: '単純Workflow', menuItemId: 'benchmark-menu', nodes: [{ id: 'service-node', operationId: 'service', dependencies: [] }] }]
  settings.menuItems[0].kitchenWorkflowId = 'workflow'
  settings.capacity.staffShifts = [{ id: 'shift', name: '単純Shift', laborRoleId: 'benchmark-staff', startTime: '09:00', endTime: '10:00', headcount: 1 }]
  settings.capacity.demandProfile = { id: 'demand', name: '単純需要', timeSlots: [{ id: 'slot', startTime: '09:00', endTime: '10:00', meals: orders }] }
  settings.capacity.targetWaitMinutes = 10
  settings.capacity.fulfillmentPolicy = 'completeAfterClosing'
  return settings
}

const operation = (patch: Partial<KitchenOperation> & Pick<KitchenOperation, 'id'>): KitchenOperation => ({
  name: patch.id,
  durationMinutes: 5,
  activeLaborMinutes: 0,
  equipmentRequirements: [],
  laborRequirements: [],
  batchCapacity: 1,
  enabled: true,
  isReferenceCapacity: false,
  ...patch,
})

describe('Equipment batch and FIFO Queue', () => {
  it('初期サンプル100食を決定論的に完了する', () => {
    const first = simulateCapacity(createSampleSettings())
    const second = simulateCapacity(createSampleSettings())
    expect(first.totalOrders).toBe(100)
    expect(first.completedOrders).toBe(100)
    expect(first.orders).toEqual(second.orders)
  })

  it('釜容量6食で6食を同一バッチ処理する', () => {
    const settings = simpleStore(6)
    settings.capacity.equipment[0].capacity = 6
    settings.capacity.operations[0].batchCapacity = 6
    const result = simulateCapacity(settings, atOpening(6))
    const batches = new Set(result.orders.map((order) => order.operations[0].batchId))
    expect(batches.size).toBe(1)
    expect(result.orders.every((order) => order.completedMinute === 545)).toBe(true)
  })

  it('釜容量6食では7食目を次バッチにする', () => {
    const settings = simpleStore(7)
    settings.capacity.equipment[0].capacity = 6
    settings.capacity.operations[0].batchCapacity = 7
    const result = simulateCapacity(settings, atOpening(7))
    expect(new Set(result.orders.map((order) => order.operations[0].batchId)).size).toBe(2)
    expect(result.orders[6].operations[0].startMinute).toBe(545)
  })

  it('処理能力を超える同時注文でQueueが発生する', () => {
    const result = simulateCapacity(simpleStore(3), atOpening(3))
    expect(result.maxQueueLength).toBe(2)
    expect(result.maxQueueTime).toBe('09:00')
  })

  it('注文到着順のFIFOを維持する', () => {
    const orders = atOpening(3).map((order, index) => ({ ...order, arrivalMinute: 540 + index, arrivalTime: `09:0${index}` }))
    const result = simulateCapacity(simpleStore(3), orders)
    expect(result.orders.map((order) => order.operations[0].startMinute)).toEqual([540, 545, 550])
    expect(result.orders.map((order) => order.id)).toEqual(['order-1', 'order-2', 'order-3'])
  })
})

describe('Waiting time regression', () => {
  it('60分・5分/食・10食の検算店舗はすべて営業時間内に完了する', () => {
    const result = simulateCapacity(simpleStore(10), atOpening(10))
    expect(result.completedWithinBusinessHours).toBe(10)
    expect(result.maximumHourlyThroughput).toBe(10)
    expect(result.finalCompletionTime).toBe('09:50')
  })

  it('3食同時到着の平均待ち時間を10分とする', () => {
    expect(simulateCapacity(simpleStore(3), atOpening(3)).averageWaitMinutes).toBe(10)
  })

  it('偶数件の中央値は中央2件の平均とする', () => {
    expect(simulateCapacity(simpleStore(4), atOpening(4)).medianWaitMinutes).toBe(12.5)
  })

  it('3食同時到着の最大待ち時間を15分とする', () => {
    expect(simulateCapacity(simpleStore(3), atOpening(3)).maxWaitMinutes).toBe(15)
  })

  it('nearest-rankのp90を算出する', () => {
    expect(simulateCapacity(simpleStore(10), atOpening(10)).p90WaitMinutes).toBe(45)
  })

  it('20食では営業時間内完了12食となりQueueが発生する', () => {
    const result = simulateCapacity(simpleStore(20), atOpening(20))
    expect(result.completedWithinBusinessHours).toBe(12)
    expect(result.maxQueueLength).toBe(19)
    expect(result.unfinishedAtClosing).toBe(8)
  })
})

describe('Labor occupancy and parallel DAG', () => {
  it('1人を2つのactive workへ同時割当しない', () => {
    const settings = simpleStore(2)
    settings.capacity.equipment[0].concurrentJobs = 2
    const result = simulateCapacity(settings, atOpening(2))
    expect(result.orders.map((order) => order.operations[0].startMinute)).toEqual([540, 545])
  })

  it('人員追加でQueueを減らす', () => {
    const settings = simpleStore(2)
    settings.capacity.equipment[0].concurrentJobs = 2
    const one = simulateCapacity(settings, atOpening(2))
    settings.capacity.staffShifts[0].headcount = 2
    const two = simulateCapacity(settings, atOpening(2))
    expect(two.maxQueueLength).toBeLessThan(one.maxQueueLength)
    expect(two.averageWaitMinutes).toBeLessThan(one.averageWaitMinutes)
  })

  it('蕎麦茹でと天ぷらを別設備で並行処理する', () => {
    const settings = simpleStore(1)
    settings.capacity.equipment = [
      { id: 'boiler', name: '釜', category: 'sobaBoiler', capacity: 1, capacityUnit: '食', concurrentJobs: 1, enabled: true },
      { id: 'fryer', name: 'フライヤー', category: 'fryer', capacity: 1, capacityUnit: '本', concurrentJobs: 1, enabled: true },
    ]
    settings.capacity.operations = [
      operation({ id: 'boil', equipmentRequirements: [{ equipmentId: 'boiler', occupationMinutes: 5, units: 1 }] }),
      operation({ id: 'fry', durationMinutes: 7, equipmentRequirements: [{ equipmentId: 'fryer', occupationMinutes: 7, units: 1 }] }),
      operation({ id: 'plate', durationMinutes: 1 }),
    ]
    settings.capacity.workflows[0].nodes = [
      { id: 'boil-node', operationId: 'boil', dependencies: [] },
      { id: 'fry-node', operationId: 'fry', dependencies: [] },
      { id: 'plate-node', operationId: 'plate', dependencies: ['boil-node', 'fry-node'] },
    ]
    const orderResult = simulateCapacity(settings, atOpening(1)).orders[0]
    expect(orderResult.operations.find((item) => item.operationId === 'boil')?.startMinute).toBe(540)
    expect(orderResult.operations.find((item) => item.operationId === 'fry')?.startMinute).toBe(540)
  })

  it('並行する両工程の完了後に盛付を開始する', () => {
    const settings = simpleStore(1)
    settings.capacity.operations = [operation({ id: 'boil', durationMinutes: 5 }), operation({ id: 'fry', durationMinutes: 7 }), operation({ id: 'plate', durationMinutes: 1 })]
    settings.capacity.workflows[0].nodes = [
      { id: 'boil-node', operationId: 'boil', dependencies: [] },
      { id: 'fry-node', operationId: 'fry', dependencies: [] },
      { id: 'plate-node', operationId: 'plate', dependencies: ['boil-node', 'fry-node'] },
    ]
    const plate = simulateCapacity(settings, atOpening(1)).orders[0].operations.find((item) => item.operationId === 'plate')
    expect(plate?.startMinute).toBe(547)
  })
})

describe('Bottleneck, closing and utilization', () => {
  it('釜容量増加で同時注文の処理時間を短縮する', () => {
    const settings = simpleStore(6)
    settings.capacity.operations[0].batchCapacity = 6
    const base = simulateCapacity(settings, atOpening(6))
    settings.capacity.equipment[0].capacity = 6
    const expanded = simulateCapacity(settings, atOpening(6))
    expect(expanded.finalCompletionMinute).toBeLessThan(base.finalCompletionMinute)
  })

  it('completeAfterClosingは閉店前受付を最後まで提供する', () => {
    const result = simulateCapacity(simpleStore(20), atOpening(20))
    expect(result.completedOrders).toBe(20)
    expect(result.ordersCompletedAfterClosing).toBe(8)
    expect(result.droppedOrders).toBe(0)
  })

  it('dropAtClosingは閉店時未完了を失注にする', () => {
    const settings = simpleStore(20)
    settings.capacity.fulfillmentPolicy = 'dropAtClosing'
    const result = simulateCapacity(settings, atOpening(20))
    expect(result.completedOrders).toBe(12)
    expect(result.droppedOrders).toBe(8)
    expect(result.economic.fulfilledMeals).toBe(12)
  })

  it('設備利用率を占有時間÷利用可能時間で算出する', () => {
    const result = simulateCapacity(simpleStore(10), atOpening(10))
    expect(result.equipmentUtilization[0].busyMinutes).toBe(50)
    expect(result.equipmentUtilization[0].utilization).toBeCloseTo(50 / 60)
  })

  it('人員利用率をactive作業時間÷Shift時間で算出する', () => {
    const result = simulateCapacity(simpleStore(10), atOpening(10))
    expect(result.laborUtilization[0].busyMinutes).toBe(50)
    expect(result.laborUtilization[0].utilization).toBeCloseTo(50 / 60)
  })
})

describe('DemandProfile, workflow validation and Scenario', () => {
  it('simulationStartDateの曜日別営業時間をCapacity境界に使う', () => {
    const settings = simpleStore(1)
    settings.business.simulationStartDate = '2026-01-09'
    settings.business.weekdays[4] = { ...settings.business.weekdays[4], closingTime: '11:00' }
    const result = simulateCapacity(settings)
    expect(result.openingTime).toBe('09:00')
    expect(result.closingTime).toBe('11:00')
    expect(result.closingMinute).toBe(11 * 60)
  })

  it('時間帯食数の合計だけ決定論的Orderを生成する', () => {
    const settings = simpleStore(15)
    settings.capacity.demandProfile.timeSlots = [
      { id: 'a', startTime: '09:00', endTime: '09:30', meals: 5 },
      { id: 'b', startTime: '09:30', endTime: '10:00', meals: 10 },
    ]
    const first = createDeterministicOrders(settings)
    const second = createDeterministicOrders(settings)
    expect(first).toHaveLength(15)
    expect(first).toEqual(second)
  })

  it('DemandProfileとmealsPerDay不一致をWarningにする', () => {
    const settings = simpleStore(10)
    settings.capacity.demandProfile.timeSlots[0].meals = 9
    expect(validateSettings(settings).some((item) => item.code === 'demand-profile-total-mismatch' && item.severity === 'warning')).toBe(true)
  })

  it('厨房Workflow循環参照をErrorにする', () => {
    const settings = simpleStore(1)
    settings.capacity.workflows[0].nodes = [
      { id: 'a', operationId: 'service', dependencies: ['b'] },
      { id: 'b', operationId: 'service', dependencies: ['a'] },
    ]
    expect(validateSettings(settings).some((item) => item.code === 'kitchen-workflow-cycle' && item.severity === 'error')).toBe(true)
  })

  it('ScenarioのShift人数・設備容量・工程時間をBase非破壊で適用する', () => {
    const settings = simpleStore(2)
    const changed = applyScenarioOverrides(settings, {
      id: 'capacity-scenario', name: '増員', overrides: {
        staffShiftHeadcountOverrides: { shift: 2 },
        equipmentCapacityOverrides: { station: 2 },
        kitchenOperationDurationOverrides: { service: 4 },
      },
    })
    expect(changed.capacity.staffShifts[0].headcount).toBe(2)
    expect(changed.capacity.equipment[0].capacity).toBe(2)
    expect(changed.capacity.operations[0].durationMinutes).toBe(4)
    expect(settings.capacity.staffShifts[0].headcount).toBe(1)
    expect(settings.capacity.equipment[0].capacity).toBe(1)
    expect(settings.capacity.operations[0].durationMinutes).toBe(5)
  })

  it('Scenario販売食数をDemandProfileへ合計一致で配分する', () => {
    const settings = simpleStore(10)
    settings.capacity.demandProfile.timeSlots = [
      { id: 'morning', startTime: '09:00', endTime: '09:30', meals: 3 },
      { id: 'noon', startTime: '09:30', endTime: '10:00', meals: 7 },
    ]
    const changed = applyScenarioOverrides(settings, { id: 'demand', name: '需要', overrides: { business: { mealsPerDay: 11 } } })
    expect(changed.capacity.demandProfile.timeSlots.reduce((total, slot) => total + slot.meals, 0)).toBe(11)
    expect(settings.capacity.demandProfile.timeSlots.reduce((total, slot) => total + slot.meals, 0)).toBe(10)
  })

  it('能力制約後売上を提供完了食数で既存Economic Engineへ再計算する', () => {
    const settings = simpleStore(20)
    settings.capacity.fulfillmentPolicy = 'dropAtClosing'
    const result = simulateCapacity(settings, atOpening(20))
    expect(result.economic.demandMeals).toBe(20)
    expect(result.economic.fulfilledMeals).toBe(12)
    expect(result.economic.feasibleRevenue).toBeLessThan(result.economic.demandRevenue)
  })
})
