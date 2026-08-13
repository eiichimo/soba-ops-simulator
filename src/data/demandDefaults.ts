import type { BusinessSettings, DemandProfile, StochasticDemandSettings } from '../models/types'

export const createDefaultStochasticDemand = (
  business: BusinessSettings,
  demandProfile: DemandProfile,
): StochasticDemandSettings => ({
  seed: 12_345,
  arrivalProfile: {
    id: 'default-arrival-profile',
    name: '移行時来店Profile',
    slots: demandProfile.timeSlots.map((slot) => ({
      id: `arrival-${slot.id}`,
      startTime: slot.startTime,
      endTime: slot.endTime,
      expectedGuests: slot.meals,
      arrivalDistribution: 'uniform',
    })),
  },
  partySizeDistribution: [
    { size: 1, probability: 40 },
    { size: 2, probability: 40 },
    { size: 3, probability: 10 },
    { size: 4, probability: 8 },
    { size: 5, probability: 2 },
  ],
  seatingUnits: [
    { id: 'counter-seats', name: 'カウンター', capacity: 1, count: 8, category: 'counter', enabled: true },
    { id: 'two-seat-tables', name: '2名席', capacity: 2, count: 4, category: 'table', enabled: true },
    { id: 'four-seat-tables', name: '4名席', capacity: 4, count: 3, category: 'table', enabled: true },
  ],
  orderDelay: { distribution: 'fixed', meanMinutes: 3, minMinutes: 2, maxMinutes: 4 },
  dwellTime: { distribution: 'fixed', meanMinutes: 25, minMinutes: 20, maxMinutes: 30 },
  maxSeatingWaitMinutes: 20,
  monteCarlo: {
    runs: 100,
    maximumRuns: 1_000,
    baseSeed: 12_345,
    targetProfit: 50_000,
    targetServiceLevelRate: 0.9,
  },
  isReferenceDemand: true,
})

export const createSampleStochasticDemand = (
  business: BusinessSettings,
  demandProfile: DemandProfile,
) => createDefaultStochasticDemand(business, demandProfile)

