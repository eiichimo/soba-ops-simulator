import type { AppSettings, BusinessSettings, PlanningSettings } from '../models/types'

export const createDefaultPlanningSettings = (business: BusinessSettings): PlanningSettings => ({
  horizonDays: 7,
  hardMaximumDays: 366,
  maxPrepActiveLaborMinutesPerDay: 120,
  weekdayTemplates: business.weekdays.map((schedule) => ({
    day: schedule.day,
    enabled: schedule.enabled,
    openingTime: schedule.openingTime,
    closingTime: schedule.closingTime,
  })),
  dailyOperatingPlans: [],
  purchaseOrders: [],
  monteCarloRuns: 100,
  baseSeed: 8_017,
  targetProfit: 300_000,
  demandSource: { type: 'base' },
})

export const planningSettingsFor = (settings: Pick<AppSettings, 'business' | 'planning'>): PlanningSettings => (
  settings.planning ?? createDefaultPlanningSettings(settings.business)
)
