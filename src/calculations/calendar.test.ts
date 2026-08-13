import { describe, expect, it } from 'vitest'
import { createBenchmarkStore } from './fixtures/benchmarkStore'
import { calculateCalendarRange, calculateCalendarSummary, parseLocalDate } from './calendar'

describe('business calendar', () => {
  it('月曜開始の7日間で平日5日・40時間を集計する', () => {
    const settings = createBenchmarkStore()
    const summary = calculateCalendarRange(settings, parseLocalDate('2026-01-05')!, parseLocalDate('2026-01-12')!)
    expect(summary.operatingDays).toBe(5)
    expect(summary.totalOperatingHours).toBe(40)
  })

  it('金曜日のみ10時間営業なら週42時間になる', () => {
    const settings = createBenchmarkStore()
    settings.business.weekdays[4].closingTime = '19:00'
    const summary = calculateCalendarRange(settings, parseLocalDate('2026-01-05')!, parseLocalDate('2026-01-12')!)
    expect(summary.operatingDays).toBe(5)
    expect(summary.totalOperatingHours).toBe(42)
  })

  it('30日プリセットを月境界を跨いで数える', () => {
    const settings = createBenchmarkStore('2026-01-30')
    const summary = calculateCalendarSummary(settings, 'month')
    expect(summary.startDate).toBe('2026-01-30')
    expect(summary.endDateExclusive).toBe('2026-03-01')
    expect(summary.calendarDays).toBe(30)
    expect(summary.operatingDays).toBe(21)
  })

  it('3か月プリセットを年境界を跨いで数える', () => {
    const settings = createBenchmarkStore('2026-11-30')
    const summary = calculateCalendarSummary(settings, 'quarter')
    expect(summary.startDate).toBe('2026-11-30')
    expect(summary.endDateExclusive).toBe('2027-02-28')
    expect(summary.calendarMonths).toBe(3)
    expect(summary.calendarDays).toBe(90)
    expect(summary.operatingDays).toBe(65)
  })
})
