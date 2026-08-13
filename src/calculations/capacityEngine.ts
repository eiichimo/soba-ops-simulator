import type {
  AppSettings,
  CapacityOrder,
  CapacityOrderResult,
  CapacitySimulationResult,
  CapacityTimeBucket,
  CapacityUtilization,
  Equipment,
  KitchenOperation,
  KitchenWorkflow,
  KitchenWorkflowNode,
  LaborRequirement,
  OrderOperationResult,
  QueueTimelinePoint,
  StaffShift,
} from '../models/types'
import { formatLocalDate, getScheduleForDate, parseLocalDate, timeToMinutes } from './calendar'
import { simulate } from './engine'

const EPSILON = 1e-7
const MAX_SIMULATION_MINUTES = 24 * 60

interface MutableOrder extends CapacityOrder {
  workflow?: KitchenWorkflow
  completedNodes: Set<string>
  scheduledNodes: Set<string>
  completedMinute?: number
  operations: OrderOperationResult[]
}

interface ReadyTask {
  id: string
  sequence: number
  order: MutableOrder
  node: KitchenWorkflowNode
  readyMinute: number
}

interface ScheduledJob {
  id: string
  completionMinute: number
  tasks: ReadyTask[]
}

interface EquipmentSlot {
  id: string
  equipmentId: string
  availableMinute: number
}

interface StaffUnit {
  id: string
  shiftId: string
  laborRoleId: string
  startMinute: number
  endMinute: number
  availableMinute: number
}

interface ResourceAllocation {
  equipmentSlots: Array<{ requirementIndex: number; slots: EquipmentSlot[] }>
  staffUnits: Array<{ requirementIndex: number; units: StaffUnit[] }>
}

const minuteOfDay = (value: string) => timeToMinutes(value) ?? 0

export const getCapacityBusinessDay = (settings: AppSettings) => {
  const start = parseLocalDate(settings.business.simulationStartDate) ?? new Date()
  for (let offset = 0; offset < 7; offset += 1) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset)
    const schedule = getScheduleForDate(settings, date)
    if (schedule?.enabled) return { date: formatLocalDate(date), schedule }
  }
  return {
    date: settings.business.simulationStartDate,
    schedule: { day: 0, enabled: true, openingTime: settings.business.openingTime, closingTime: settings.business.closingTime },
  }
}

export const formatCapacityTime = (minute: number) => {
  const safe = Math.max(0, minute)
  const days = Math.floor(safe / (24 * 60))
  const minuteInDay = safe % (24 * 60)
  const time = `${String(Math.floor(minuteInDay / 60)).padStart(2, '0')}:${String(Math.floor(minuteInDay % 60)).padStart(2, '0')}`
  return days > 0 ? `${time} (+${days}日)` : time
}

const percentile = (sorted: number[], ratio: number) => {
  if (sorted.length === 0) return 0
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]
}

const median = (sorted: number[]) => {
  if (sorted.length === 0) return 0
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

const largestRemainderCounts = (settings: AppSettings, total: number) => {
  const menus = settings.menuItems.filter((menu) => menu.enabled && menu.expectedSalesRatio > 0)
  if (menus.length === 0 || total <= 0) return []
  const ratioTotal = menus.reduce((sum, menu) => sum + menu.expectedSalesRatio, 0)
  const rows = menus.map((menu, index) => {
    const exact = total * menu.expectedSalesRatio / ratioTotal
    return { menu, count: Math.floor(exact), remainder: exact - Math.floor(exact), index }
  })
  let remaining = total - rows.reduce((sum, row) => sum + row.count, 0)
  for (const row of [...rows].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (remaining <= 0) break
    row.count += 1
    remaining -= 1
  }
  return rows
}

const balancedMenuSequence = (settings: AppSettings, total: number) => {
  const counts = largestRemainderCounts(settings, total)
  const assigned = new Map(counts.map((row) => [row.menu.id, 0]))
  const sequence: string[] = []
  for (let index = 0; index < total; index += 1) {
    const candidate = counts
      .filter((row) => (assigned.get(row.menu.id) ?? 0) < row.count)
      .sort((a, b) => {
        const deficitA = (index + 1) * a.count / total - (assigned.get(a.menu.id) ?? 0)
        const deficitB = (index + 1) * b.count / total - (assigned.get(b.menu.id) ?? 0)
        return deficitB - deficitA || a.index - b.index
      })[0]
    if (!candidate) break
    sequence.push(candidate.menu.id)
    assigned.set(candidate.menu.id, (assigned.get(candidate.menu.id) ?? 0) + 1)
  }
  return sequence
}

export const createDeterministicOrders = (settings: AppSettings): CapacityOrder[] => {
  const { schedule } = getCapacityBusinessDay(settings)
  const openingMinute = minuteOfDay(schedule.openingTime)
  const closingMinute = minuteOfDay(schedule.closingTime)
  const arrivals: number[] = []
  for (const slot of [...settings.capacity.demandProfile.timeSlots].sort((a, b) => minuteOfDay(a.startTime) - minuteOfDay(b.startTime) || a.id.localeCompare(b.id))) {
    const start = Math.max(openingMinute, minuteOfDay(slot.startTime))
    const end = Math.min(closingMinute, minuteOfDay(slot.endTime))
    const meals = Math.max(0, Math.round(slot.meals))
    if (end <= start || meals <= 0) continue
    const interval = (end - start) / meals
    for (let index = 0; index < meals; index += 1) arrivals.push(start + interval * index)
  }
  arrivals.sort((a, b) => a - b)
  const menus = balancedMenuSequence(settings, arrivals.length)
  return arrivals.map((arrivalMinute, index) => ({
    id: `order-${String(index + 1).padStart(4, '0')}`,
    arrivalMinute,
    arrivalTime: formatCapacityTime(arrivalMinute),
    menuItemId: menus[index] ?? '',
    quantity: 1,
  }))
}

const effectiveBatchCapacity = (operation: KitchenOperation, equipment: Map<string, Equipment>) => {
  let capacity = Math.max(1, Math.floor(operation.batchCapacity))
  for (const requirement of operation.equipmentRequirements) {
    const target = equipment.get(requirement.equipmentId)
    if (target) capacity = Math.min(capacity, Math.max(1, Math.floor(target.capacity * requirement.units)))
  }
  return capacity
}

const buildEquipmentSlots = (equipment: Equipment[], openingMinute: number) => equipment.flatMap((item) => (
  Array.from({ length: Math.max(0, Math.floor(item.concurrentJobs)) }, (_, index): EquipmentSlot => ({
    id: `${item.id}-slot-${index + 1}`,
    equipmentId: item.id,
    availableMinute: openingMinute,
  }))
))

const buildStaffUnits = (shifts: StaffShift[], openingMinute: number) => shifts.flatMap((shift) => (
  Array.from({ length: Math.max(0, Math.floor(shift.headcount)) }, (_, index): StaffUnit => ({
    id: `${shift.id}-staff-${index + 1}`,
    shiftId: shift.id,
    laborRoleId: shift.laborRoleId,
    startMinute: minuteOfDay(shift.startTime),
    endMinute: minuteOfDay(shift.endTime),
    availableMinute: Math.max(openingMinute, minuteOfDay(shift.startTime)),
  }))
))

const staffCanWork = (
  unit: StaffUnit,
  currentMinute: number,
  activeMinutes: number,
  closingMinute: number,
  completeAfterClosing: boolean,
) => {
  if (unit.startMinute > currentMinute + EPSILON || unit.availableMinute > currentMinute + EPSILON) return false
  const effectiveEnd = completeAfterClosing && unit.endMinute >= closingMinute - EPSILON ? Number.POSITIVE_INFINITY : unit.endMinute
  return currentMinute + activeMinutes <= effectiveEnd + EPSILON
}

const selectStaffForRequirement = (
  requirement: LaborRequirement,
  staffUnits: StaffUnit[],
  reserved: Set<string>,
  currentMinute: number,
  activeMinutes: number,
  closingMinute: number,
  completeAfterClosing: boolean,
) => {
  if (activeMinutes <= EPSILON || requirement.headcount <= 0) return []
  for (const roleId of requirement.laborRoleIds) {
    const candidates = staffUnits
      .filter((unit) => unit.laborRoleId === roleId && !reserved.has(unit.id) && staffCanWork(unit, currentMinute, activeMinutes, closingMinute, completeAfterClosing))
      .sort((a, b) => a.availableMinute - b.availableMinute || a.id.localeCompare(b.id))
    if (candidates.length >= requirement.headcount) return candidates.slice(0, requirement.headcount)
  }
  return null
}

const allocateResources = (
  operation: KitchenOperation,
  equipmentById: Map<string, Equipment>,
  equipmentSlots: EquipmentSlot[],
  staffUnits: StaffUnit[],
  currentMinute: number,
  closingMinute: number,
  completeAfterClosing: boolean,
): ResourceAllocation | null => {
  const equipmentAllocation: ResourceAllocation['equipmentSlots'] = []
  const reservedEquipment = new Set<string>()
  for (const [requirementIndex, requirement] of operation.equipmentRequirements.entries()) {
    const equipment = equipmentById.get(requirement.equipmentId)
    if (!equipment?.enabled) return null
    const candidates = equipmentSlots
      .filter((slot) => slot.equipmentId === equipment.id && !reservedEquipment.has(slot.id) && slot.availableMinute <= currentMinute + EPSILON)
      .sort((a, b) => a.availableMinute - b.availableMinute || a.id.localeCompare(b.id))
    if (candidates.length < requirement.units) return null
    const selected = candidates.slice(0, requirement.units)
    selected.forEach((slot) => reservedEquipment.add(slot.id))
    equipmentAllocation.push({ requirementIndex, slots: selected })
  }

  const staffAllocation: ResourceAllocation['staffUnits'] = []
  const reservedStaff = new Set<string>()
  for (const [requirementIndex, requirement] of operation.laborRequirements.entries()) {
    const selected = selectStaffForRequirement(requirement, staffUnits, reservedStaff, currentMinute, operation.activeLaborMinutes, closingMinute, completeAfterClosing)
    if (selected === null) return null
    selected.forEach((unit) => reservedStaff.add(unit.id))
    staffAllocation.push({ requirementIndex, units: selected })
  }
  return { equipmentSlots: equipmentAllocation, staffUnits: staffAllocation }
}

const nextOpenDate = (settings: AppSettings) => {
  return getCapacityBusinessDay(settings).date
}

export const calculateCapacityStaffCost = (settings: AppSettings) => settings.capacity.staffShifts.reduce((total, shift) => {
  const role = settings.labor.find((item) => item.id === shift.laborRoleId)
  const duration = Math.max(0, minuteOfDay(shift.endTime) - minuteOfDay(shift.startTime))
  return total + (role?.hourlyWage ?? 0) * shift.headcount * duration / 60
}, 0)

const recordQueuePoint = (timeline: QueueTimelinePoint[], minute: number, readyQueues: Map<string, ReadyTask[]>) => {
  const queueLength = new Set([...readyQueues.values()].flat().filter((task) => task.readyMinute <= minute + EPSILON).map((task) => task.order.id)).size
  const point = { minute, time: formatCapacityTime(minute), queueLength }
  if (timeline.at(-1)?.minute === minute) timeline[timeline.length - 1] = point
  else timeline.push(point)
}

const createTimeBuckets = (
  openingMinute: number,
  closingMinute: number,
  finalMinute: number,
  bucketMinutes: number,
  orders: CapacityOrderResult[],
  timeline: QueueTimelinePoint[],
): CapacityTimeBucket[] => {
  const buckets: CapacityTimeBucket[] = []
  const end = Math.max(closingMinute, finalMinute)
  for (let start = openingMinute; start < end - EPSILON; start += bucketMinutes) {
    const bucketEnd = Math.min(end, start + bucketMinutes)
    const completed = orders.filter((order) => order.completedMinute !== undefined && order.completedMinute >= start && order.completedMinute < bucketEnd)
    const waits = completed.map((order) => order.waitMinutes ?? 0)
    const points = timeline.filter((point) => point.minute >= start && point.minute < bucketEnd)
    const lastPoint = [...timeline].reverse().find((point) => point.minute <= bucketEnd + EPSILON)
    buckets.push({
      startMinute: start,
      endMinute: bucketEnd,
      startTime: formatCapacityTime(start),
      arrivals: orders.filter((order) => order.arrivalMinute >= start && order.arrivalMinute < bucketEnd).length,
      completions: completed.length,
      waitingOrders: lastPoint?.queueLength ?? 0,
      averageWaitMinutes: waits.length ? waits.reduce((sum, wait) => sum + wait, 0) / waits.length : 0,
      maxQueueLength: points.length ? Math.max(...points.map((point) => point.queueLength)) : lastPoint?.queueLength ?? 0,
    })
  }
  return buckets
}

export const simulateCapacity = (
  settings: AppSettings,
  suppliedOrders?: CapacityOrder[],
  options: { includeEconomic?: boolean } = {},
): CapacitySimulationResult => {
  const { schedule } = getCapacityBusinessDay(settings)
  const openingMinute = minuteOfDay(schedule.openingTime)
  const closingMinute = minuteOfDay(schedule.closingTime)
  const completeAfterClosing = settings.capacity.fulfillmentPolicy === 'completeAfterClosing'
  const equipmentById = new Map(settings.capacity.equipment.map((equipment) => [equipment.id, equipment]))
  const operationById = new Map(settings.capacity.operations.map((operation) => [operation.id, operation]))
  const workflowsById = new Map(settings.capacity.workflows.map((workflow) => [workflow.id, workflow]))
  const workflowsByMenu = new Map(settings.capacity.workflows.map((workflow) => [workflow.menuItemId, workflow]))
  const generated = suppliedOrders ? [...suppliedOrders].sort((a, b) => a.arrivalMinute - b.arrivalMinute || a.id.localeCompare(b.id)) : createDeterministicOrders(settings)
  const orders: MutableOrder[] = generated.map((order) => {
    const menu = settings.menuItems.find((item) => item.id === order.menuItemId)
    return {
      ...order,
      workflow: (menu?.kitchenWorkflowId ? workflowsById.get(menu.kitchenWorkflowId) : undefined) ?? workflowsByMenu.get(order.menuItemId),
      completedNodes: new Set(),
      scheduledNodes: new Set(),
      operations: [],
    }
  })
  const equipmentSlots = buildEquipmentSlots(settings.capacity.equipment.filter((equipment) => equipment.enabled), openingMinute)
  const staffUnits = buildStaffUnits(settings.capacity.staffShifts, openingMinute)
  const equipmentBusy = new Map(settings.capacity.equipment.map((equipment) => [equipment.id, 0]))
  const laborBusy = new Map(settings.labor.map((role) => [role.id, 0]))
  const readyQueues = new Map<string, ReadyTask[]>()
  const jobs: ScheduledJob[] = []
  const timeline: QueueTimelinePoint[] = []
  let taskSequence = 0
  let batchSequence = 0
  let currentMinute = openingMinute
  let arrivalIndex = 0
  let iterations = 0

  const enqueueReady = (order: MutableOrder, node: KitchenWorkflowNode, readyMinute: number) => {
    if (order.scheduledNodes.has(node.id)) return
    order.scheduledNodes.add(node.id)
    const task: ReadyTask = { id: `${order.id}:${node.id}`, sequence: taskSequence += 1, order, node, readyMinute }
    const queue = readyQueues.get(node.operationId) ?? []
    queue.push(task)
    queue.sort((a, b) => a.readyMinute - b.readyMinute || a.order.arrivalMinute - b.order.arrivalMinute || a.sequence - b.sequence)
    readyQueues.set(node.operationId, queue)
  }

  const completeJob = (job: ScheduledJob) => {
    for (const task of job.tasks) {
      task.order.completedNodes.add(task.node.id)
      const workflow = task.order.workflow
      if (!workflow) continue
      for (const node of workflow.nodes) {
        if (!task.order.scheduledNodes.has(node.id) && node.dependencies.every((dependency) => task.order.completedNodes.has(dependency))) {
          enqueueReady(task.order, node, job.completionMinute)
        }
      }
      if (workflow.nodes.every((node) => task.order.completedNodes.has(node.id))) task.order.completedMinute = job.completionMinute
    }
  }

  const processEvents = () => {
    const completedJobs = jobs.filter((job) => job.completionMinute <= currentMinute + EPSILON)
      .sort((a, b) => a.completionMinute - b.completionMinute || a.id.localeCompare(b.id))
    completedJobs.forEach(completeJob)
    for (const job of completedJobs) jobs.splice(jobs.indexOf(job), 1)

    while (arrivalIndex < orders.length && orders[arrivalIndex].arrivalMinute <= currentMinute + EPSILON) {
      const order = orders[arrivalIndex]
      arrivalIndex += 1
      const workflow = order.workflow
      if (!workflow || workflow.nodes.length === 0) {
        order.completedMinute = order.arrivalMinute
        continue
      }
      for (const node of workflow.nodes.filter((candidate) => candidate.dependencies.length === 0)) enqueueReady(order, node, order.arrivalMinute)
    }
  }

  const scheduleOneBatch = () => {
    const candidates = [...readyQueues.entries()]
      .map(([operationId, queue]) => ({ operationId, queue, first: queue.find((task) => task.readyMinute <= currentMinute + EPSILON) }))
      .filter((candidate): candidate is { operationId: string; queue: ReadyTask[]; first: ReadyTask } => !!candidate.first)
      .sort((a, b) => a.first.readyMinute - b.first.readyMinute || a.first.order.arrivalMinute - b.first.order.arrivalMinute || a.first.sequence - b.first.sequence || a.operationId.localeCompare(b.operationId))
    for (const candidate of candidates) {
      const operation = operationById.get(candidate.operationId)
      if (!operation?.enabled || operation.durationMinutes <= 0) continue
      const allocation = allocateResources(operation, equipmentById, equipmentSlots, staffUnits, currentMinute, closingMinute, completeAfterClosing)
      if (!allocation) continue
      const batchSize = effectiveBatchCapacity(operation, equipmentById)
      const tasks = candidate.queue.filter((task) => task.readyMinute <= currentMinute + EPSILON).slice(0, batchSize)
      if (tasks.length === 0) continue
      const batchId = `batch-${batchSequence += 1}`
      const completionMinute = currentMinute + operation.durationMinutes
      allocation.equipmentSlots.forEach(({ requirementIndex, slots }) => {
        const requirement = operation.equipmentRequirements[requirementIndex]
        slots.forEach((slot) => { slot.availableMinute = currentMinute + requirement.occupationMinutes })
        equipmentBusy.set(requirement.equipmentId, (equipmentBusy.get(requirement.equipmentId) ?? 0) + requirement.occupationMinutes * slots.length)
      })
      allocation.staffUnits.forEach(({ units }) => {
        units.forEach((unit) => {
          unit.availableMinute = currentMinute + operation.activeLaborMinutes
          laborBusy.set(unit.laborRoleId, (laborBusy.get(unit.laborRoleId) ?? 0) + operation.activeLaborMinutes)
        })
      })
      tasks.forEach((task) => task.order.operations.push({
        nodeId: task.node.id,
        operationId: operation.id,
        batchId,
        readyMinute: task.readyMinute,
        startMinute: currentMinute,
        completedMinute: completionMinute,
      }))
      readyQueues.set(candidate.operationId, candidate.queue.filter((task) => !tasks.includes(task)))
      jobs.push({ id: batchId, completionMinute, tasks })
      return true
    }
    return false
  }

  const nextEventMinute = () => {
    const values: number[] = []
    if (arrivalIndex < orders.length) values.push(orders[arrivalIndex].arrivalMinute)
    values.push(...jobs.map((job) => job.completionMinute))
    values.push(...equipmentSlots.map((slot) => slot.availableMinute))
    values.push(...staffUnits.flatMap((unit) => [unit.startMinute, unit.availableMinute]))
    if (currentMinute < closingMinute - EPSILON) values.push(closingMinute)
    return values.filter((value) => Number.isFinite(value) && value > currentMinute + EPSILON).sort((a, b) => a - b)[0]
  }

  while (iterations < 200_000 && currentMinute <= closingMinute + MAX_SIMULATION_MINUTES) {
    iterations += 1
    processEvents()
    if (!completeAfterClosing && currentMinute >= closingMinute - EPSILON) {
      recordQueuePoint(timeline, currentMinute, readyQueues)
      break
    }
    while (scheduleOneBatch()) {
      // 同一時刻に設備・人員が許す限り、FIFO候補を連続して開始する。
    }
    recordQueuePoint(timeline, currentMinute, readyQueues)

    const allArrived = arrivalIndex >= orders.length
    const allComplete = orders.every((order) => order.completedMinute !== undefined)
    if (allArrived && allComplete) break
    const next = nextEventMinute()
    if (next === undefined) break
    currentMinute = next
  }

  const completedWithinClosing = orders.filter((order) => order.completedMinute !== undefined && order.completedMinute <= closingMinute + EPSILON).length
  const completedOrders = completeAfterClosing
    ? orders.filter((order) => order.completedMinute !== undefined).length
    : completedWithinClosing
  const results: CapacityOrderResult[] = orders.map((order) => {
    const completed = order.completedMinute !== undefined && (completeAfterClosing || order.completedMinute <= closingMinute + EPSILON)
    return {
      id: order.id,
      arrivalMinute: order.arrivalMinute,
      arrivalTime: order.arrivalTime,
      menuItemId: order.menuItemId,
      quantity: order.quantity,
      status: completed ? 'completed' : 'dropped',
      completedMinute: completed ? order.completedMinute : undefined,
      completedTime: completed && order.completedMinute !== undefined ? formatCapacityTime(order.completedMinute) : undefined,
      waitMinutes: completed && order.completedMinute !== undefined ? order.completedMinute - order.arrivalMinute : undefined,
      operations: order.operations,
    }
  })
  const completedResults = results.filter((order) => order.status === 'completed')
  const waits = completedResults.map((order) => order.waitMinutes ?? 0).sort((a, b) => a - b)
  const finalCompletionMinute = completedResults.length ? Math.max(...completedResults.map((order) => order.completedMinute ?? openingMinute)) : openingMinute
  recordQueuePoint(timeline, Math.min(Math.max(currentMinute, closingMinute), finalCompletionMinute || closingMinute), readyQueues)
  const maxQueueLength = timeline.length ? Math.max(...timeline.map((point) => point.queueLength)) : 0
  const maxQueueMinute = timeline.find((point) => point.queueLength === maxQueueLength)?.minute ?? openingMinute
  const businessMinutes = Math.max(1, closingMinute - openingMinute)

  const equipmentUtilization: CapacityUtilization[] = settings.capacity.equipment.map((equipment) => {
    const availableMinutes = businessMinutes * Math.max(0, equipment.concurrentJobs)
    const busyMinutes = equipmentBusy.get(equipment.id) ?? 0
    return { id: equipment.id, name: equipment.name, busyMinutes, availableMinutes, utilization: availableMinutes > 0 ? busyMinutes / availableMinutes : 0 }
  })
  const laborUtilization: CapacityUtilization[] = settings.labor.map((role) => {
    const availableMinutes = settings.capacity.staffShifts.filter((shift) => shift.laborRoleId === role.id).reduce((total, shift) => total + Math.max(0, minuteOfDay(shift.endTime) - minuteOfDay(shift.startTime)) * shift.headcount, 0)
    const busyMinutes = laborBusy.get(role.id) ?? 0
    return { id: role.id, name: role.name, busyMinutes, availableMinutes, utilization: availableMinutes > 0 ? busyMinutes / availableMinutes : 0 }
  })
  const bucketMinutes = Math.max(1, settings.capacity.bucketMinutes)
  const timeBuckets = createTimeBuckets(openingMinute, closingMinute, finalCompletionMinute, bucketMinutes, results, timeline)
  const hourlyCompletions = new Map<number, number>()
  completedResults.forEach((order) => {
    const bucket = Math.max(0, Math.floor(((order.completedMinute ?? openingMinute) - openingMinute) / 60))
    hourlyCompletions.set(bucket, (hourlyCompletions.get(bucket) ?? 0) + 1)
  })
  const equipmentBottleneck = [...equipmentUtilization].sort((a, b) => b.utilization - a.utilization || a.id.localeCompare(b.id))[0]
  const laborBottleneck = [...laborUtilization].sort((a, b) => b.utilization - a.utilization || a.id.localeCompare(b.id))[0]
  const targetExceededCount = waits.filter((wait) => wait > settings.capacity.targetWaitMinutes).length
  const warnings = [
    ...equipmentUtilization.filter((item) => item.utilization >= 0.95).map((item) => `${item.name}の設備利用率が${Math.round(item.utilization * 100)}%です。待ち時間増加要因の候補です。`),
    ...laborUtilization.filter((item) => item.utilization >= 0.95).map((item) => `${item.name}の人員利用率が${Math.round(item.utilization * 100)}%です。ピーク負荷要因の候補です。`),
    ...(completedResults.length > 0 && targetExceededCount / completedResults.length >= 0.2 ? [`許容待ち時間を超えた注文が${targetExceededCount}件あります。工程・設備・Shiftを確認してください。`] : []),
  ]

  const staffShiftCost = calculateCapacityStaffCost(settings)
  const includeEconomic = options.includeEconomic ?? true
  const economicSettings: AppSettings = {
    ...settings,
    business: { ...settings.business, simulationStartDate: nextOpenDate(settings) },
  }
  const demandEconomic = includeEconomic ? simulate(economicSettings, 'day', orders.length) : undefined
  const feasibleEconomic = includeEconomic ? simulate(economicSettings, 'day', completedOrders) : undefined
  const legacyShiftCost = demandEconomic?.labor.shiftLaborCost ?? 0
  const laborAdjustment = staffShiftCost - legacyShiftCost

  return {
    openingTime: schedule.openingTime,
    closingTime: schedule.closingTime,
    openingMinute,
    closingMinute,
    totalOrders: orders.length,
    completedOrders,
    completedWithinBusinessHours: completedWithinClosing,
    ordersCompletedAfterClosing: completedResults.filter((order) => (order.completedMinute ?? 0) > closingMinute + EPSILON).length,
    droppedOrders: orders.length - completedOrders,
    unfinishedAtClosing: orders.filter((order) => order.completedMinute === undefined || order.completedMinute > closingMinute + EPSILON).length,
    averageWaitMinutes: waits.length ? waits.reduce((sum, wait) => sum + wait, 0) / waits.length : 0,
    medianWaitMinutes: median(waits),
    p90WaitMinutes: percentile(waits, 0.9),
    maxWaitMinutes: waits.at(-1) ?? 0,
    withinTargetCount: waits.filter((wait) => wait <= settings.capacity.targetWaitMinutes).length,
    withinTargetRate: waits.length ? waits.filter((wait) => wait <= settings.capacity.targetWaitMinutes).length / waits.length : 0,
    targetExceededCount,
    maxQueueLength,
    maxQueueMinute,
    maxQueueTime: formatCapacityTime(maxQueueMinute),
    finalCompletionMinute,
    finalCompletionTime: formatCapacityTime(finalCompletionMinute),
    maximumHourlyThroughput: hourlyCompletions.size ? Math.max(...hourlyCompletions.values()) : 0,
    completionRateWithinBusinessHours: orders.length ? completedWithinClosing / orders.length : 0,
    equipmentUtilization,
    laborUtilization,
    timeBuckets,
    queueTimeline: timeline,
    orders: results,
    economic: {
      demandMeals: orders.length,
      fulfilledMeals: completedOrders,
      demandRevenue: demandEconomic?.revenue ?? 0,
      feasibleRevenue: feasibleEconomic?.revenue ?? 0,
      demandOperatingProfit: demandEconomic ? demandEconomic.operatingProfit - laborAdjustment : 0,
      capacityAdjustedOperatingProfit: feasibleEconomic ? feasibleEconomic.operatingProfit - laborAdjustment : 0,
      staffShiftCost,
      legacyShiftCost,
    },
    bottleneckEquipmentId: equipmentBottleneck?.id,
    bottleneckLaborRoleId: laborBottleneck?.id,
    warnings,
  }
}
