import type {
  AppSettings,
  CapacityOrder,
  CapacitySimulationResult,
  CustomerJourneyResult,
  GeneratedParty,
  PartyResult,
  SeatingQueuePoint,
  SeatingUtilizationResult,
} from '../models/types'
import { simulateCapacity, formatCapacityTime, getCapacityBusinessDay } from './capacityEngine'
import { generateStochasticParties } from './demandEngine'
import { simulate } from './engine'
import { timeToMinutes } from './calendar'

const EPSILON = 1e-7

interface SeatInstance {
  id: string
  seatingUnitId: string
  capacity: number
  occupiedPartyId?: string
}

interface MutableParty extends PartyResult {
  sequence: number
}

const sorted = (values: number[]) => [...values].sort((a, b) => a - b)

const percentileNearestRank = (values: number[], ratio: number) => {
  const ordered = sorted(values)
  if (ordered.length === 0) return 0
  return ordered[Math.max(0, Math.ceil(ordered.length * ratio) - 1)]
}

const median = (values: number[]) => {
  const ordered = sorted(values)
  if (ordered.length === 0) return 0
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle]
}

const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0

const buildSeatInstances = (settings: AppSettings): SeatInstance[] => settings.capacity.stochasticDemand.seatingUnits
  .filter((unit) => unit.enabled && unit.capacity > 0 && unit.count > 0)
  .flatMap((unit) => Array.from({ length: Math.floor(unit.count) }, (_, index) => ({
    id: `${unit.id}-instance-${index + 1}`,
    seatingUnitId: unit.id,
    capacity: unit.capacity,
  })))

const smallestSeatForParty = (party: MutableParty, seats: SeatInstance[]) => seats
  .filter((seat) => !seat.occupiedPartyId && seat.capacity >= party.size)
  .sort((a, b) => a.capacity - b.capacity || a.id.localeCompare(b.id))[0]

const settingsWithRealizedMix = (settings: AppSettings, completedMenuIds: string[]) => {
  const counts = new Map<string, number>()
  completedMenuIds.forEach((menuId) => counts.set(menuId, (counts.get(menuId) ?? 0) + 1))
  const total = completedMenuIds.length
  return {
    ...settings,
    business: { ...settings.business, simulationStartDate: getCapacityBusinessDay(settings).date },
    menuItems: settings.menuItems.map((menu) => ({
      ...menu,
      expectedSalesRatio: total > 0 ? (counts.get(menu.id) ?? 0) / total * 100 : 0,
      enabled: menu.enabled && (counts.get(menu.id) ?? 0) > 0,
    })),
  }
}

const emptyCapacity = (settings: AppSettings) => simulateCapacity(settings, [], { includeEconomic: false })

export const simulateCustomerJourney = (
  settings: AppSettings,
  seed = settings.capacity.stochasticDemand.seed,
  suppliedParties?: GeneratedParty[],
): CustomerJourneyResult => {
  const stochastic = settings.capacity.stochasticDemand
  const { schedule } = getCapacityBusinessDay(settings)
  const openingMinute = timeToMinutes(schedule.openingTime) ?? 0
  const closingMinute = timeToMinutes(schedule.closingTime) ?? 24 * 60
  const generated = suppliedParties ?? generateStochasticParties(settings, seed)
  const parties: MutableParty[] = [...generated]
    .sort((a, b) => a.arrivalMinute - b.arrivalMinute || a.id.localeCompare(b.id))
    .map((party, sequence) => ({ ...party, sequence, state: 'waiting', orderIds: [] }))
  const seats = buildSeatInstances(settings)
  const waiting: MutableParty[] = []
  const orders: CapacityOrder[] = []
  const queueTimeline: SeatingQueuePoint[] = []
  let arrivalIndex = 0
  let currentMinute = Math.min(openingMinute, parties[0]?.arrivalMinute ?? openingMinute)
  let capacity: CapacitySimulationResult = emptyCapacity(settings)
  let iterations = 0

  const recordQueue = () => {
    const point = {
      minute: currentMinute,
      time: formatCapacityTime(currentMinute),
      partyCount: waiting.length,
      guestCount: waiting.reduce((sum, party) => sum + party.size, 0),
    }
    const previous = queueTimeline.at(-1)
    if (previous?.minute === point.minute) queueTimeline[queueTimeline.length - 1] = point
    else queueTimeline.push(point)
  }

  const refreshKitchen = (includeEconomic = false) => {
    capacity = simulateCapacity(settings, orders, { includeEconomic })
    const results = new Map(capacity.orders.map((order) => [order.id, order]))
    for (const party of parties.filter((item) => item.orderIds.length > 0 && item.state !== 'abandoned' && item.state !== 'departed')) {
      const partyOrders = party.orderIds.map((orderId) => results.get(orderId)).filter((order) => !!order)
      const allCompleted = partyOrders.length === party.orderIds.length && partyOrders.every((order) => order.status === 'completed' && order.completedMinute !== undefined)
      if (allCompleted) {
        party.servedMinute = Math.max(...partyOrders.map((order) => order.completedMinute ?? party.orderMinute ?? currentMinute))
        party.servedTime = formatCapacityTime(party.servedMinute)
        party.kitchenWaitMinutes = party.servedMinute - (party.orderMinute ?? party.servedMinute)
        party.totalWaitMinutes = party.servedMinute - party.arrivalMinute
        party.departureMinute = party.servedMinute + party.dwellMinutes
        party.departureTime = formatCapacityTime(party.departureMinute)
        party.state = 'served'
      } else if (settings.capacity.fulfillmentPolicy === 'dropAtClosing') {
        party.departureMinute = closingMinute
        party.departureTime = formatCapacityTime(closingMinute)
      }
    }
  }

  const releaseSeats = () => {
    for (const seat of seats.filter((item) => item.occupiedPartyId)) {
      const party = parties.find((item) => item.id === seat.occupiedPartyId)
      if (party?.departureMinute !== undefined && party.departureMinute <= currentMinute + EPSILON) {
        party.state = 'departed'
        seat.occupiedPartyId = undefined
      }
    }
  }

  const abandon = (party: MutableParty, reason: PartyResult['abandonmentReason']) => {
    party.state = 'abandoned'
    party.abandonmentMinute = currentMinute
    party.abandonmentTime = formatCapacityTime(currentMinute)
    party.abandonmentReason = reason
  }

  while (iterations < 100_000) {
    iterations += 1
    releaseSeats()

    while (arrivalIndex < parties.length && parties[arrivalIndex].arrivalMinute <= currentMinute + EPSILON) {
      waiting.push(parties[arrivalIndex])
      arrivalIndex += 1
    }
    waiting.sort((a, b) => a.arrivalMinute - b.arrivalMinute || a.sequence - b.sequence)

    for (let index = waiting.length - 1; index >= 0; index -= 1) {
      const party = waiting[index]
      if (currentMinute >= closingMinute - EPSILON) {
        abandon(party, 'closing')
        waiting.splice(index, 1)
      } else if (currentMinute - party.arrivalMinute >= stochastic.maxSeatingWaitMinutes - EPSILON) {
        abandon(party, 'maxWait')
        waiting.splice(index, 1)
      }
    }

    let seatedAny = false
    if (currentMinute < closingMinute - EPSILON) {
      while (true) {
        const candidateIndex = waiting.findIndex((party) => !!smallestSeatForParty(party, seats))
        if (candidateIndex < 0) break
        const party = waiting[candidateIndex]
        const seat = smallestSeatForParty(party, seats)
        if (!seat) break
        waiting.splice(candidateIndex, 1)
        seat.occupiedPartyId = party.id
        party.state = 'ordered'
        party.seatingInstanceId = seat.id
        party.seatingUnitId = seat.seatingUnitId
        party.seatedMinute = currentMinute
        party.seatedTime = formatCapacityTime(currentMinute)
        party.seatingWaitMinutes = currentMinute - party.arrivalMinute
        party.orderMinute = currentMinute + party.orderDelayMinutes
        party.orderTime = formatCapacityTime(party.orderMinute)
        party.orderIds = party.menuItemIds.map((menuItemId, guestIndex) => `${party.id}-order-${guestIndex + 1}`)
        party.orderIds.forEach((orderId, guestIndex) => orders.push({
          id: orderId,
          arrivalMinute: party.orderMinute ?? currentMinute,
          arrivalTime: party.orderTime ?? formatCapacityTime(currentMinute),
          menuItemId: party.menuItemIds[guestIndex] ?? '',
          quantity: 1,
        }))
        seatedAny = true
      }
    }
    recordQueue()
    if (seatedAny) refreshKitchen()

    const allArrived = arrivalIndex >= parties.length
    const activeSeats = seats.some((seat) => !!seat.occupiedPartyId)
    if (allArrived && waiting.length === 0 && !activeSeats) break

    const nextEvents: number[] = []
    if (arrivalIndex < parties.length) nextEvents.push(parties[arrivalIndex].arrivalMinute)
    if (currentMinute < closingMinute - EPSILON) nextEvents.push(closingMinute)
    waiting.forEach((party) => nextEvents.push(Math.min(closingMinute, party.arrivalMinute + stochastic.maxSeatingWaitMinutes)))
    seats.filter((seat) => seat.occupiedPartyId).forEach((seat) => {
      const party = parties.find((item) => item.id === seat.occupiedPartyId)
      if (party?.departureMinute !== undefined) nextEvents.push(party.departureMinute)
    })
    const next = nextEvents.filter((minute) => Number.isFinite(minute) && minute > currentMinute + EPSILON).sort((a, b) => a - b)[0]
    if (next === undefined) break
    currentMinute = next
  }

  refreshKitchen(true)
  for (const seat of seats.filter((item) => item.occupiedPartyId)) {
    const party = parties.find((item) => item.id === seat.occupiedPartyId)
    if (party?.departureMinute !== undefined) {
      party.state = 'departed'
      seat.occupiedPartyId = undefined
    }
  }

  const seated = parties.filter((party) => party.seatedMinute !== undefined)
  const abandoned = parties.filter((party) => party.state === 'abandoned')
  const seatingWaits = seated.map((party) => party.seatingWaitMinutes ?? 0)
  const kitchenWaits = parties.filter((party) => party.kitchenWaitMinutes !== undefined).map((party) => party.kitchenWaitMinutes ?? 0)
  const totalWaits = parties.filter((party) => party.totalWaitMinutes !== undefined).map((party) => party.totalWaitMinutes ?? 0)
  const maxQueueParties = queueTimeline.length ? Math.max(...queueTimeline.map((point) => point.partyCount)) : 0
  const maxQueuePoint = queueTimeline.find((point) => point.partyCount === maxQueueParties)
  const businessMinutes = Math.max(1, closingMinute - openingMinute)
  const totalSeats = stochastic.seatingUnits.filter((unit) => unit.enabled).reduce((sum, unit) => sum + unit.capacity * unit.count, 0)

  const seatingUtilization: SeatingUtilizationResult[] = stochastic.seatingUnits.map((unit) => {
    const unitParties = seated.filter((party) => party.seatingUnitId === unit.id && party.seatedMinute !== undefined && party.departureMinute !== undefined)
    const occupiedUnitMinutes = unitParties.reduce((sum, party) => sum + Math.max(0, (party.departureMinute ?? 0) - (party.seatedMinute ?? 0)), 0)
    const occupiedSeatMinutes = unitParties.reduce((sum, party) => sum + Math.max(0, (party.departureMinute ?? 0) - (party.seatedMinute ?? 0)) * party.size, 0)
    const unusedSeatMinutes = unitParties.reduce((sum, party) => sum + Math.max(0, (party.departureMinute ?? 0) - (party.seatedMinute ?? 0)) * Math.max(0, unit.capacity - party.size), 0)
    const availableUnitMinutes = businessMinutes * unit.count
    const availableSeatMinutes = availableUnitMinutes * unit.capacity
    return {
      seatingUnitId: unit.id,
      name: unit.name,
      capacity: unit.capacity,
      count: unit.count,
      seatedParties: unitParties.length,
      seatedGuests: unitParties.reduce((sum, party) => sum + party.size, 0),
      occupiedUnitMinutes,
      occupiedSeatMinutes,
      unusedSeatMinutes,
      availableUnitMinutes,
      availableSeatMinutes,
      unitUtilization: availableUnitMinutes > 0 ? occupiedUnitMinutes / availableUnitMinutes : 0,
      seatUtilization: availableSeatMinutes > 0 ? occupiedSeatMinutes / availableSeatMinutes : 0,
      turnover: unit.count > 0 ? unitParties.length / unit.count : 0,
    }
  })

  const completedOrders = capacity.orders.filter((order) => order.status === 'completed')
  const completedMenuIds = completedOrders.map((order) => order.menuItemId)
  const realizedSettings = settingsWithRealizedMix(settings, completedMenuIds)
  const realizedRaw = simulate(realizedSettings, 'day', completedOrders.length)
  const demandRaw = simulate({ ...settings, business: { ...settings.business, simulationStartDate: getCapacityBusinessDay(settings).date } }, 'day', stochastic.arrivalProfile.slots.reduce((sum, slot) => sum + slot.expectedGuests, 0))
  const realizedLaborAdjustment = capacity.economic.staffShiftCost - realizedRaw.labor.shiftLaborCost
  const demandLaborAdjustment = capacity.economic.staffShiftCost - demandRaw.labor.shiftLaborCost
  const totalAvailableSeatMinutes = seatingUtilization.reduce((sum, item) => sum + item.availableSeatMinutes, 0)
  const totalOccupiedSeatMinutes = seatingUtilization.reduce((sum, item) => sum + item.occupiedSeatMinutes, 0)
  const unusedSeatMinutes = seatingUtilization.reduce((sum, item) => sum + item.unusedSeatMinutes, 0)
  const arrivedGuests = parties.reduce((sum, party) => sum + party.size, 0)
  const abandonedGuests = abandoned.reduce((sum, party) => sum + party.size, 0)
  const largePartyWaits = seated.filter((party) => party.size >= 4).map((party) => party.seatingWaitMinutes ?? 0)
  const warnings = [
    ...(arrivedGuests > 0 && abandonedGuests / arrivedGuests >= 0.1 ? [`席待ち離脱率が${Math.round(abandonedGuests / arrivedGuests * 100)}%です。客席数・構成・最大待ち時間を確認してください。`] : []),
    ...(totalAvailableSeatMinutes > 0 && unusedSeatMinutes / totalAvailableSeatMinutes >= 0.15 ? ['空席損失時間が大きく、総席数よりテーブル構成が制約になっている可能性があります。'] : []),
    ...(largePartyWaits.length > 0 && mean(largePartyWaits) > mean(seatingWaits) + 5 ? ['4名以上Partyの着席待ちが長く、大容量テーブル不足の可能性があります。'] : []),
    ...(mean(seatingWaits) >= 5 && mean(kitchenWaits) < 5 ? ['厨房待ちより着席待ちが長く、客席側がボトルネック候補です。'] : []),
    ...(mean(kitchenWaits) >= 5 && mean(seatingWaits) < 5 ? ['着席待ちより厨房待ちが長く、厨房側がボトルネック候補です。'] : []),
    ...(mean(kitchenWaits) >= 5 && mean(seatingWaits) >= 5 ? ['着席待ちと厨房待ちの両方が長く、複合ボトルネック候補です。'] : []),
  ]

  return {
    seed,
    potentialGuests: stochastic.arrivalProfile.slots.reduce((sum, slot) => sum + slot.expectedGuests, 0),
    arrivedGuests,
    arrivedParties: parties.length,
    seatedGuests: seated.reduce((sum, party) => sum + party.size, 0),
    seatedParties: seated.length,
    abandonedGuests,
    abandonedParties: abandoned.length,
    abandonmentRate: arrivedGuests > 0 ? abandonedGuests / arrivedGuests : 0,
    orderedGuests: orders.length,
    kitchenCompletedGuests: completedOrders.length,
    realizedSalesMeals: completedOrders.length,
    averageSeatingWaitMinutes: mean(seatingWaits),
    medianSeatingWaitMinutes: median(seatingWaits),
    p90SeatingWaitMinutes: percentileNearestRank(seatingWaits, 0.9),
    maxSeatingWaitMinutes: seatingWaits.length ? Math.max(...seatingWaits) : 0,
    averageKitchenWaitMinutes: mean(kitchenWaits),
    p90KitchenWaitMinutes: percentileNearestRank(kitchenWaits, 0.9),
    averageTotalWaitMinutes: mean(totalWaits),
    p90TotalWaitMinutes: percentileNearestRank(totalWaits, 0.9),
    maxSeatingQueueParties: maxQueueParties,
    maxSeatingQueueGuests: queueTimeline.length ? Math.max(...queueTimeline.map((point) => point.guestCount)) : 0,
    maxSeatingQueueMinute: maxQueuePoint?.minute ?? openingMinute,
    maxSeatingQueueTime: maxQueuePoint?.time ?? formatCapacityTime(openingMinute),
    totalSeats,
    seatTurnover: totalSeats > 0 ? seated.reduce((sum, party) => sum + party.size, 0) / totalSeats : 0,
    seatUtilization: totalAvailableSeatMinutes > 0 ? totalOccupiedSeatMinutes / totalAvailableSeatMinutes : 0,
    unusedSeatMinutes,
    finalDepartureMinute: seated.length ? Math.max(...seated.map((party) => party.departureMinute ?? closingMinute)) : openingMinute,
    finalDepartureTime: formatCapacityTime(seated.length ? Math.max(...seated.map((party) => party.departureMinute ?? closingMinute)) : openingMinute),
    parties,
    seatingQueueTimeline: queueTimeline,
    seatingUtilization,
    capacity,
    economic: {
      potentialDemandMeals: stochastic.arrivalProfile.slots.reduce((sum, slot) => sum + slot.expectedGuests, 0),
      realizedMeals: completedOrders.length,
      realizedRevenue: realizedRaw.revenue,
      realizedUsageCost: realizedRaw.inventory.usageCost,
      realizedOperatingProfit: realizedRaw.operatingProfit - realizedLaborAdjustment,
      demandRevenue: demandRaw.revenue,
      demandOperatingProfit: demandRaw.operatingProfit - demandLaborAdjustment,
    },
    warnings,
  }
}
