import type { AppSettings, CalendarSummary, PeriodKey, WeekdaySchedule } from '../models/types'

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

export const formatLocalDate = (date: Date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export const todayLocalDate = () => formatLocalDate(new Date())

export const parseLocalDate = (value: string) => {
  const match = DATE_PATTERN.exec(value)
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return formatLocalDate(date) === value ? date : null
}

export const timeToMinutes = (value: string) => {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

export const scheduleHours = (schedule: Pick<WeekdaySchedule, 'openingTime' | 'closingTime'>) => {
  const opening = timeToMinutes(schedule.openingTime)
  const closing = timeToMinutes(schedule.closingTime)
  if (opening === null || closing === null || closing <= opening) return 0
  return (closing - opening) / 60
}

const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)

const daysInMonth = (year: number, monthIndex: number) => new Date(year, monthIndex + 1, 0).getDate()

const addCalendarMonths = (date: Date, months: number) => {
  const targetMonthIndex = date.getMonth() + months
  const targetYear = date.getFullYear() + Math.floor(targetMonthIndex / 12)
  const normalizedMonth = ((targetMonthIndex % 12) + 12) % 12
  return new Date(targetYear, normalizedMonth, Math.min(date.getDate(), daysInMonth(targetYear, normalizedMonth)))
}

export const getPeriodEndExclusive = (startDate: Date, period: PeriodKey) => {
  if (period === 'day') return addDays(startDate, 1)
  if (period === 'month') return addDays(startDate, 30)
  if (period === 'quarter') return addCalendarMonths(startDate, 3)
  if (period === 'halfYear') return addCalendarMonths(startDate, 6)
  return addCalendarMonths(startDate, 12)
}

export const getScheduleForDate = (settings: AppSettings, date: Date) => {
  const mondayFirstDay = (date.getDay() + 6) % 7
  return settings.business.weekdays.find((schedule) => schedule.day === mondayFirstDay)
}

export const calculateCalendarRange = (
  settings: AppSettings,
  startDate: Date,
  endDate: Date,
  calendarMonthsOverride?: number,
): CalendarSummary => {
  let calendarDays = 0
  let operatingDays = 0
  let totalOperatingHours = 0
  let proratedMonths = 0

  for (let date = startDate; date < endDate; date = addDays(date, 1)) {
    calendarDays += 1
    proratedMonths += 1 / daysInMonth(date.getFullYear(), date.getMonth())
    const schedule = getScheduleForDate(settings, date)
    if (schedule?.enabled && scheduleHours(schedule) > 0) {
      operatingDays += 1
      totalOperatingHours += scheduleHours(schedule)
    }
  }

  return {
    startDate: formatLocalDate(startDate),
    endDateExclusive: formatLocalDate(endDate),
    calendarDays,
    operatingDays,
    totalOperatingHours,
    calendarMonths: calendarMonthsOverride ?? proratedMonths,
  }
}

export const calculateCalendarSummary = (settings: AppSettings, period: PeriodKey): CalendarSummary => {
  const startDate = parseLocalDate(settings.business.simulationStartDate) ?? new Date()
  const endDate = getPeriodEndExclusive(startDate, period)
  const calendarMonthsOverride = period === 'quarter' ? 3
    : period === 'halfYear' ? 6
      : period === 'year' ? 12
        : undefined
  return calculateCalendarRange(settings, startDate, endDate, calendarMonthsOverride)
}
