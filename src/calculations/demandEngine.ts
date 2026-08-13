import type { AppSettings, GeneratedParty, PartySizeProbability, RandomDurationSettings } from '../models/types'
import { timeToMinutes } from './calendar'
import { formatCapacityTime, getCapacityBusinessDay } from './capacityEngine'

export type SeededRandom = () => number

export const createSeededRandom = (seed: number): SeededRandom => {
  let state = Math.trunc(seed) >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let value = state
    value = Math.imul(value ^ value >>> 15, value | 1)
    value ^= value + Math.imul(value ^ value >>> 7, value | 61)
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296
  }
}

export const generateSeed = () => {
  const clock = Date.now() >>> 0
  const fine = typeof performance === 'undefined' ? 0 : Math.trunc(performance.now() * 1_000) >>> 0
  return (clock ^ fine ^ 0x9E3779B9) >>> 0
}

export const samplePoisson = (mean: number, random: SeededRandom) => {
  if (!Number.isFinite(mean) || mean <= 0) return 0
  let count = 0
  let position = 0
  while (count < 100_000) {
    position += -Math.log(Math.max(Number.MIN_VALUE, 1 - random())) / mean
    if (position > 1) return count
    count += 1
  }
  return count
}

const normalizedPartyDistribution = (distribution: PartySizeProbability[]) => {
  const valid = distribution.filter((item) => item.size > 0 && item.probability > 0)
  const total = valid.reduce((sum, item) => sum + item.probability, 0)
  return total > 0 ? valid.map((item) => ({ ...item, probability: item.probability / total })) : [{ size: 1, probability: 1 }]
}

export const samplePartySize = (distribution: PartySizeProbability[], random: SeededRandom) => {
  const normalized = normalizedPartyDistribution(distribution)
  const target = random()
  let cumulative = 0
  for (const item of normalized) {
    cumulative += item.probability
    if (target <= cumulative) return Math.max(1, Math.round(item.size))
  }
  return Math.max(1, Math.round(normalized.at(-1)?.size ?? 1))
}

const expectedPartySize = (distribution: PartySizeProbability[]) => {
  const normalized = normalizedPartyDistribution(distribution)
  return normalized.reduce((sum, item) => sum + item.size * item.probability, 0)
}

export const sampleDuration = (settings: RandomDurationSettings, random: SeededRandom) => {
  if (settings.distribution === 'fixed') return settings.meanMinutes
  const minimum = Math.min(settings.minMinutes, settings.maxMinutes)
  const maximum = Math.max(settings.minMinutes, settings.maxMinutes)
  return minimum + random() * (maximum - minimum)
}

const sampleMenu = (settings: AppSettings, random: SeededRandom) => {
  const menus = settings.menuItems.filter((menu) => menu.enabled && menu.expectedSalesRatio > 0)
  const total = menus.reduce((sum, menu) => sum + menu.expectedSalesRatio, 0)
  if (menus.length === 0 || total <= 0) return ''
  const target = random() * total
  let cumulative = 0
  for (const menu of menus) {
    cumulative += menu.expectedSalesRatio
    if (target <= cumulative) return menu.id
  }
  return menus.at(-1)?.id ?? ''
}

export const generateStochasticParties = (settings: AppSettings, seed = settings.capacity.stochasticDemand.seed): GeneratedParty[] => {
  const random = createSeededRandom(seed)
  const stochastic = settings.capacity.stochasticDemand
  const { schedule } = getCapacityBusinessDay(settings)
  const openingMinute = timeToMinutes(schedule.openingTime) ?? 0
  const closingMinute = timeToMinutes(schedule.closingTime) ?? 24 * 60
  const meanPartySize = Math.max(0.01, expectedPartySize(stochastic.partySizeDistribution))
  const generated: GeneratedParty[] = []

  for (const slot of stochastic.arrivalProfile.slots) {
    const start = Math.max(openingMinute, timeToMinutes(slot.startTime) ?? openingMinute)
    const end = Math.min(closingMinute, timeToMinutes(slot.endTime) ?? closingMinute)
    if (end <= start || slot.expectedGuests <= 0) continue
    const expectedParties = slot.expectedGuests / meanPartySize
    const arrivals: number[] = []
    if (slot.arrivalDistribution === 'uniform') {
      // Uniform mode keeps the number of Parties near the entered mean and randomizes
      // only their positions. Poisson mode below also varies the number of arrivals.
      const partyCount = Math.max(1, Math.round(expectedParties))
      for (let index = 0; index < partyCount; index += 1) arrivals.push(start + random() * (end - start))
    } else {
      let minute = start
      const ratePerMinute = expectedParties / (end - start)
      while (ratePerMinute > 0) {
        minute += -Math.log(Math.max(Number.MIN_VALUE, 1 - random())) / ratePerMinute
        if (minute >= end) break
        arrivals.push(minute)
      }
    }
    for (const arrivalMinute of arrivals) {
      const size = samplePartySize(stochastic.partySizeDistribution, random)
      generated.push({
        id: '',
        arrivalMinute,
        arrivalTime: formatCapacityTime(arrivalMinute),
        size,
        orderDelayMinutes: sampleDuration(stochastic.orderDelay, random),
        dwellMinutes: sampleDuration(stochastic.dwellTime, random),
        menuItemIds: Array.from({ length: size }, () => sampleMenu(settings, random)),
        sourceSlotId: slot.id,
      })
    }
  }

  return generated
    .sort((a, b) => a.arrivalMinute - b.arrivalMinute || a.sourceSlotId?.localeCompare(b.sourceSlotId ?? '') || 0)
    .map((party, index) => ({ ...party, id: `party-${String(index + 1).padStart(4, '0')}` }))
}
