import { describe, expect, it } from 'vitest'
import { createBenchmarkStore } from './fixtures/benchmarkStore'
import { createSeededRandom, generateStochasticParties, samplePartySize, samplePoisson } from './demandEngine'

const stochasticStore = () => {
  const settings = createBenchmarkStore('2026-01-05')
  settings.business.closingTime = '10:00'
  settings.business.hoursPerDay = 1
  settings.business.weekdays = settings.business.weekdays.map((day) => ({ ...day, closingTime: '10:00' }))
  settings.capacity.demandMode = 'stochastic'
  settings.capacity.stochasticDemand.arrivalProfile.slots = [{
    id: 'arrival', startTime: '09:00', endTime: '10:00', expectedGuests: 40, arrivalDistribution: 'uniform',
  }]
  return settings
}

describe('seeded demand generation', () => {
  it('同じseedから完全に同じParty列を生成する', () => {
    const settings = stochasticStore()
    expect(generateStochasticParties(settings, 12345)).toEqual(generateStochasticParties(settings, 12345))
  })

  it('異なるseedではstochastic Party列が変わる', () => {
    const settings = stochasticStore()
    expect(generateStochasticParties(settings, 12345)).not.toEqual(generateStochasticParties(settings, 12346))
  })

  it('uniform arrivalを時間帯内へ生成する', () => {
    const settings = stochasticStore()
    const parties = generateStochasticParties(settings, 20)
    expect(parties.length).toBeGreaterThan(0)
    expect(parties.every((party) => party.arrivalMinute >= 540 && party.arrivalMinute < 600)).toBe(true)
    expect(generateStochasticParties(settings, 21)).toHaveLength(parties.length)
  })

  it('poisson process相当のarrivalを時間帯内へ生成する', () => {
    const settings = stochasticStore()
    settings.capacity.stochasticDemand.arrivalProfile.slots[0].arrivalDistribution = 'poisson'
    const parties = generateStochasticParties(settings, 20)
    expect(parties.length).toBeGreaterThan(0)
    expect(parties.every((party) => party.arrivalMinute >= 540 && party.arrivalMinute < 600)).toBe(true)
  })

  it('営業時間外へarrivalを生成しない', () => {
    const settings = stochasticStore()
    settings.capacity.stochasticDemand.arrivalProfile.slots = [
      { id: 'before', startTime: '08:00', endTime: '09:30', expectedGuests: 20, arrivalDistribution: 'uniform' },
      { id: 'after', startTime: '09:30', endTime: '11:00', expectedGuests: 20, arrivalDistribution: 'uniform' },
    ]
    expect(generateStochasticParties(settings, 7).every((party) => party.arrivalMinute >= 540 && party.arrivalMinute < 600)).toBe(true)
  })

  it('Party Size Distributionをseed付きで再現する', () => {
    const distribution = [{ size: 1, probability: 40 }, { size: 2, probability: 60 }]
    const first = createSeededRandom(99)
    const second = createSeededRandom(99)
    expect(Array.from({ length: 20 }, () => samplePartySize(distribution, first))).toEqual(Array.from({ length: 20 }, () => samplePartySize(distribution, second)))
  })

  it('Party人数合計を生成結果へ保持する', () => {
    const parties = generateStochasticParties(stochasticStore(), 100)
    expect(parties.reduce((total, party) => total + party.size, 0)).toBeGreaterThan(0)
    expect(parties.every((party) => party.menuItemIds.length === party.size)).toBe(true)
  })

  it('Poisson samplerを同じseedで再現する', () => {
    expect(samplePoisson(20, createSeededRandom(5))).toBe(samplePoisson(20, createSeededRandom(5)))
  })
})
