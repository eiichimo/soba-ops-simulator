import { parseLocalDate } from './calendar'
import { applyScenarioOverrides, deriveActualMetrics } from './decisionSupport'
import { simulateMultiDay } from './multiDayEngine'
import { tryConvertQuantity } from './units'
import type {
  ActualPeriod,
  AppSettings,
  BacktestAccuracyMetric,
  BacktestMetricKey,
  BacktestMetricResult,
  BacktestResult,
  CalibrationCandidate,
  CalibrationConfidence,
  CalibrationEvidence,
  CalibrationHistoryEntry,
  CalibrationTargetType,
  Scenario,
} from '../models/types'

const confidenceFor = (periodCount: number): CalibrationConfidence => periodCount >= 6 ? 'high' : periodCount >= 3 ? 'medium' : 'low'
const candidateId = (type: CalibrationTargetType, targetId: string | undefined, periods: string[]) => `calibration-${type}-${targetId ?? 'store'}-${periods.join('-')}`

const evidence = (description: string, periodCount: number, totalAmount?: number, totalQuantity?: number, unit?: string): CalibrationEvidence => ({
  description, periodCount, totalAmount, totalQuantity, unit,
})

const selectedPeriods = (settings: AppSettings, periodIds?: string[]) => {
  const selected = periodIds?.length ? new Set(periodIds) : null
  return settings.actualPeriods.filter((period) => !selected || selected.has(period.id))
}

export const buildCalibrationCandidates = (settings: AppSettings, periodIds?: string[]): CalibrationCandidate[] => {
  const periods = selectedPeriods(settings, periodIds)
  const candidates: CalibrationCandidate[] = []
  const utilities = [
    ['water', '水道', 'L', settings.utilities.water.unitPrice],
    ['gas', 'ガス', 'm³', settings.utilities.gas.unitPrice],
    ['electricity', '電気', 'kWh', settings.utilities.electricity.unitPrice],
  ] as const
  for (const [utility, label, unit, currentValue] of utilities) {
    const sources = periods.filter((period) => {
      const record = period.actuals.utilities[utility]
      return record.cost !== undefined && record.quantity !== undefined && record.quantity > 0
    })
    const totalAmount = sources.reduce((total, period) => total + (period.actuals.utilities[utility].cost ?? 0), 0)
    const totalQuantity = sources.reduce((total, period) => total + (period.actuals.utilities[utility].quantity ?? 0), 0)
    if (totalQuantity > 0) candidates.push({
      id: candidateId('utilityUnitPrice', utility, sources.map((period) => period.id)),
      category: 'utility', targetType: 'utilityUnitPrice', targetId: utility, field: 'unitPrice', currentValue,
      suggestedValue: totalAmount / totalQuantity,
      evidence: evidence(`${sources.map((period) => period.name).join('、')}の総${label}料金 ÷ 総使用量`, sources.length, totalAmount, totalQuantity, unit),
      confidence: confidenceFor(sources.length), sourceActualPeriodIds: sources.map((period) => period.id),
    })
  }

  for (const resource of settings.resources) {
    let totalAmount = 0
    let totalQuantity = 0
    const sourceIds: string[] = []
    for (const period of periods) {
      const record = period.actuals.resourceRecords.find((item) => item.resourceId === resource.id)
      if (record?.purchasedQuantity === undefined || record.purchaseExpenditure === undefined) continue
      const converted = tryConvertQuantity(record.purchasedQuantity, record.purchaseUnit, resource.purchaseUnit)
      if (converted === null || converted <= 0) continue
      totalQuantity += converted
      totalAmount += record.purchaseExpenditure
      sourceIds.push(period.id)
    }
    if (totalQuantity > 0) candidates.push({
      id: candidateId('resourceUnitPrice', resource.id, sourceIds),
      category: 'resource', targetType: 'resourceUnitPrice', targetId: resource.id, field: 'purchasePrice',
      currentValue: resource.purchaseQuantity > 0 ? resource.purchasePrice / resource.purchaseQuantity : 0,
      suggestedValue: totalAmount / totalQuantity,
      evidence: evidence(`${resource.name}の総購入支出 ÷ 単位換算後購入数量`, sourceIds.length, totalAmount, totalQuantity, resource.purchaseUnit),
      confidence: confidenceFor(sourceIds.length), sourceActualPeriodIds: sourceIds,
    })
  }

  for (const role of settings.labor) {
    let totalAmount = 0
    let totalHours = 0
    const sourceIds: string[] = []
    for (const period of periods) {
      const record = period.actuals.laborRecords?.find((item) => item.laborRoleId === role.id)
      const useOverall = settings.labor.length === 1 && !record && period.actuals.laborHours !== undefined && period.actuals.laborCost !== undefined
      const hours = record?.hours ?? (useOverall ? period.actuals.laborHours : undefined)
      const cost = record?.cost ?? (useOverall ? period.actuals.laborCost : undefined)
      if (hours === undefined || cost === undefined || hours <= 0) continue
      totalHours += hours
      totalAmount += cost
      sourceIds.push(period.id)
    }
    if (totalHours > 0) candidates.push({
      id: candidateId('laborHourlyWage', role.id, sourceIds),
      category: 'labor', targetType: 'laborHourlyWage', targetId: role.id, field: 'hourlyWage', currentValue: role.hourlyWage,
      suggestedValue: totalAmount / totalHours,
      evidence: evidence(`${role.name}の実人件費 ÷ 実労働時間`, sourceIds.length, totalAmount, totalHours, '時間'),
      confidence: confidenceFor(sourceIds.length), sourceActualPeriodIds: sourceIds,
    })
  }

  const demandSources = periods.filter((period) => period.actuals.meals !== undefined && period.actuals.operatingDays !== undefined && period.actuals.operatingDays > 0)
  const totalMeals = demandSources.reduce((total, period) => total + (period.actuals.meals ?? 0), 0)
  const totalDays = demandSources.reduce((total, period) => total + (period.actuals.operatingDays ?? 0), 0)
  if (totalDays > 0) candidates.push({
    id: candidateId('demandMeals', undefined, demandSources.map((period) => period.id)), category: 'demand', targetType: 'demandMeals', field: 'mealsPerDay',
    currentValue: settings.business.mealsPerDay, suggestedValue: totalMeals / totalDays,
    evidence: evidence('販売食数 ÷ 営業日数。離脱・厨房能力・stockoutを含む潜在需要ではありません。', demandSources.length, undefined, totalMeals, '販売食'),
    confidence: confidenceFor(demandSources.length), sourceActualPeriodIds: demandSources.map((period) => period.id),
  })

  for (const menu of settings.menuItems) {
    let totalRevenue = 0
    let totalQuantity = 0
    const sourceIds: string[] = []
    for (const period of periods) {
      const record = period.actuals.menuSales.find((item) => item.menuItemId === menu.id)
      if (!record || record.revenue === undefined || record.quantity <= 0) continue
      totalRevenue += record.revenue
      totalQuantity += record.quantity
      sourceIds.push(period.id)
    }
    if (totalQuantity > 0) candidates.push({
      id: candidateId('menuAveragePrice', menu.id, sourceIds), category: 'menu', targetType: 'menuAveragePrice', targetId: menu.id, field: 'sellingPrice',
      currentValue: menu.sellingPrice, suggestedValue: totalRevenue / totalQuantity,
      evidence: evidence(`${menu.name}の実売上 ÷ 実販売食数。値引き・追加注文を含む可能性があります。`, sourceIds.length, totalRevenue, totalQuantity, '食'),
      confidence: confidenceFor(sourceIds.length), sourceActualPeriodIds: sourceIds, informationalOnly: true,
    })
  }
  return candidates
}

export interface CalibrationWarning {
  code: 'few-periods' | 'outlier' | 'large-variance'
  message: string
  candidateId?: string
}

export const buildCalibrationWarnings = (settings: AppSettings, candidates: CalibrationCandidate[]): CalibrationWarning[] => {
  const warnings: CalibrationWarning[] = []
  for (const candidate of candidates) {
    if (candidate.evidence.periodCount < settings.calibrationSettings.minimumPeriods) warnings.push({ code: 'few-periods', candidateId: candidate.id, message: `${candidate.field}は対象期間が${candidate.evidence.periodCount}件だけです。` })
    if (candidate.currentValue !== 0 && Math.abs(candidate.suggestedValue - candidate.currentValue) / Math.abs(candidate.currentValue) >= settings.calibrationSettings.varianceWarningThreshold) warnings.push({ code: 'large-variance', candidateId: candidate.id, message: `${candidate.field}候補は現在値と${Math.round(Math.abs(candidate.suggestedValue / candidate.currentValue - 1) * 100)}%異なります。` })
  }
  const unitSeries: Array<{ label: string; candidate: CalibrationCandidate; values: number[] }> = candidates.filter((candidate) => candidate.targetType === 'utilityUnitPrice' || candidate.targetType === 'resourceUnitPrice').map((candidate) => {
    const values = candidate.sourceActualPeriodIds.flatMap((id) => {
      const period = settings.actualPeriods.find((item) => item.id === id)
      if (!period) return []
      if (candidate.targetType === 'utilityUnitPrice') {
        const record = period.actuals.utilities[candidate.targetId as 'water' | 'gas' | 'electricity']
        return record.cost !== undefined && record.quantity !== undefined && record.quantity > 0 ? [record.cost / record.quantity] : []
      }
      const record = period.actuals.resourceRecords.find((item) => item.resourceId === candidate.targetId)
      const resource = settings.resources.find((item) => item.id === candidate.targetId)
      const quantity = record && resource && record.purchasedQuantity !== undefined ? tryConvertQuantity(record.purchasedQuantity, record.purchaseUnit, resource.purchaseUnit) : null
      return record?.purchaseExpenditure !== undefined && quantity !== null && quantity !== undefined && quantity > 0 ? [record.purchaseExpenditure / quantity] : []
    })
    return { label: candidate.field, candidate, values }
  })
  for (const series of unitSeries) {
    if (series.values.length >= 3 && series.values.some((value) => Math.abs(value / series.candidate.suggestedValue - 1) >= 0.5)) warnings.push({ code: 'outlier', candidateId: series.candidate.id, message: `${series.label}に加重平均から50%以上離れた期間があります。自動除外していません。` })
  }
  return warnings
}

const scenarioOverridesFor = (candidate: CalibrationCandidate): Scenario['overrides'] => {
  if (candidate.targetType === 'utilityUnitPrice' && candidate.targetId) return { utilityUnitPriceMultipliers: { [candidate.targetId]: candidate.currentValue === 0 ? 1 : candidate.suggestedValue / candidate.currentValue } }
  if (candidate.targetType === 'resourceUnitPrice' && candidate.targetId) return { resourcePurchasePriceMultipliers: { [candidate.targetId]: candidate.currentValue === 0 ? 1 : candidate.suggestedValue / candidate.currentValue } }
  if (candidate.targetType === 'laborHourlyWage' && candidate.targetId) return { laborHourlyWageOverrides: { [candidate.targetId]: candidate.suggestedValue } }
  if (candidate.targetType === 'demandMeals') return { business: { mealsPerDay: candidate.suggestedValue } }
  return {}
}

export const calibrationCandidateToScenario = (candidate: CalibrationCandidate, now = new Date().toISOString()): Scenario => {
  if (candidate.informationalOnly) throw new Error('この候補は情報表示のみでScenarioへ適用しません。')
  return {
    id: `scenario-${candidate.id}-${now}`,
    name: `校正: ${candidate.field}`,
    overrides: scenarioOverridesFor(candidate),
    notes: `${candidate.evidence.description} / ${candidate.sourceActualPeriodIds.join(', ')}`,
  }
}

const changeTargetValue = (settings: AppSettings, targetType: CalibrationTargetType, targetId: string | undefined, value: number): AppSettings => {
  if (targetType === 'utilityUnitPrice' && (targetId === 'water' || targetId === 'gas' || targetId === 'electricity')) return { ...settings, utilities: { ...settings.utilities, [targetId]: { ...settings.utilities[targetId], unitPrice: value } } }
  if (targetType === 'resourceUnitPrice' && targetId) return { ...settings, resources: settings.resources.map((resource) => resource.id === targetId ? { ...resource, purchasePrice: value * resource.purchaseQuantity } : resource) }
  if (targetType === 'laborHourlyWage' && targetId) return { ...settings, labor: settings.labor.map((role) => role.id === targetId ? { ...role, hourlyWage: value } : role) }
  if (targetType === 'demandMeals') return applyScenarioOverrides(settings, { id: 'calibration-demand-apply', name: 'Demand校正適用', overrides: { business: { mealsPerDay: value } } })
  throw new Error('このCalibration CandidateはBaseへ適用できません。')
}

const targetCurrentValue = (settings: AppSettings, entry: Pick<CalibrationHistoryEntry, 'targetType' | 'targetId'>) => {
  if (entry.targetType === 'utilityUnitPrice' && (entry.targetId === 'water' || entry.targetId === 'gas' || entry.targetId === 'electricity')) return settings.utilities[entry.targetId].unitPrice
  if (entry.targetType === 'resourceUnitPrice' && entry.targetId) {
    const resource = settings.resources.find((item) => item.id === entry.targetId)
    return resource && resource.purchaseQuantity > 0 ? resource.purchasePrice / resource.purchaseQuantity : undefined
  }
  if (entry.targetType === 'laborHourlyWage' && entry.targetId) return settings.labor.find((role) => role.id === entry.targetId)?.hourlyWage
  if (entry.targetType === 'demandMeals') return settings.business.mealsPerDay
  return undefined
}

export const applyCalibrationCandidate = (settings: AppSettings, candidate: CalibrationCandidate, now = new Date().toISOString()): AppSettings => {
  if (candidate.informationalOnly) throw new Error('実販売単価候補は情報表示のみです。')
  const changed = changeTargetValue(settings, candidate.targetType, candidate.targetId, candidate.suggestedValue)
  const history: CalibrationHistoryEntry = {
    id: `history-${candidate.id}-${now}`,
    appliedAt: now,
    targetType: candidate.targetType,
    targetId: candidate.targetId,
    field: candidate.field,
    previousValue: candidate.currentValue,
    newValue: candidate.suggestedValue,
    evidence: structuredClone(candidate.evidence),
    sourceActualPeriodIds: [...candidate.sourceActualPeriodIds],
  }
  return { ...changed, calibrationHistory: [...settings.calibrationHistory, history] }
}

export const revertCalibration = (settings: AppSettings, historyId: string, now = new Date().toISOString()): AppSettings => {
  const entry = settings.calibrationHistory.find((item) => item.id === historyId)
  if (!entry || entry.revertedAt) throw new Error('戻せるCalibration履歴が見つかりません。')
  const current = targetCurrentValue(settings, entry)
  if (current === undefined || Math.abs(current - entry.newValue) > 1e-9) throw new Error('適用後に対象設定が変更されているため、安全にRevertできません。')
  const changed = changeTargetValue(settings, entry.targetType, entry.targetId, entry.previousValue)
  return { ...changed, calibrationHistory: settings.calibrationHistory.map((item) => item.id === entry.id ? { ...item, revertedAt: now } : item) }
}

const horizonDaysFor = (period: ActualPeriod) => {
  const start = parseLocalDate(period.startDate)
  const end = parseLocalDate(period.endDate)
  if (!start || !end || end < start) return 0
  return Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1
}

const metricDefinitions: Array<[BacktestMetricKey, string]> = [
  ['revenue', '売上'], ['meals', '販売食数'], ['usageCost', '使用原価'], ['purchaseExpenditure', '購入支出'], ['laborCost', '人件費'],
  ['water', '水道'], ['gas', 'ガス'], ['electricity', '電気'], ['operatingProfit', '営業利益'],
]

export const runBacktest = (settings: AppSettings, period: ActualPeriod, modelLabel = 'Base Model'): BacktestResult => {
  const horizonDays = horizonDaysFor(period)
  if (horizonDays <= 0) throw new Error('ActualPeriodの日付が正しくありません。')
  if (horizonDays > settings.planning.hardMaximumDays) throw new Error(`Backtest期間は${settings.planning.hardMaximumDays}日以下にしてください。`)
  const simulation = simulateMultiDay({ ...settings, business: { ...settings.business, simulationStartDate: period.startDate } }, { horizonDays })
  const predicted: Record<BacktestMetricKey, number> = {
    revenue: simulation.revenue,
    meals: simulation.realizedMeals,
    usageCost: simulation.usageCost,
    purchaseExpenditure: simulation.purchaseExpenditure,
    laborCost: simulation.laborCost,
    water: simulation.dailyResults.reduce((total, day) => total + day.simulation.costs.water, 0),
    gas: simulation.dailyResults.reduce((total, day) => total + day.simulation.costs.gas, 0),
    electricity: simulation.dailyResults.reduce((total, day) => total + day.simulation.costs.electricity, 0),
    operatingProfit: simulation.operatingProfit,
  }
  const derived = deriveActualMetrics(period.actuals)
  const actual: Record<BacktestMetricKey, number | undefined> = {
    revenue: period.actuals.revenue,
    meals: period.actuals.meals,
    usageCost: derived.usageCost,
    purchaseExpenditure: period.actuals.purchaseExpenditure,
    laborCost: period.actuals.laborCost,
    water: period.actuals.utilities.water.cost,
    gas: period.actuals.utilities.gas.cost,
    electricity: period.actuals.utilities.electricity.cost,
    operatingProfit: derived.operatingProfit,
  }
  const metrics: BacktestMetricResult[] = metricDefinitions.map(([key, label]) => {
    const actualValue = actual[key]
    const error = actualValue === undefined ? null : predicted[key] - actualValue
    return {
      key, label, predicted: predicted[key], actual: actualValue ?? null, error,
      absoluteError: error === null ? null : Math.abs(error),
      absolutePercentageError: actualValue === undefined || actualValue === 0 ? null : Math.abs(error!) / Math.abs(actualValue),
    }
  })
  return { actualPeriodId: period.id, actualPeriodName: period.name, startDate: period.startDate, endDate: period.endDate, modelLabel, metrics }
}

export const runBacktests = (settings: AppSettings, periodIds?: string[], modelLabel = 'Base Model') => selectedPeriods(settings, periodIds).map((period) => runBacktest(settings, period, modelLabel))

export const calculateBacktestAccuracy = (results: BacktestResult[]): BacktestAccuracyMetric[] => metricDefinitions.map(([key, label]) => {
  const rows = results.map((result) => result.metrics.find((metric) => metric.key === key)).filter((metric): metric is BacktestMetricResult => !!metric && metric.actual !== null)
  const percentageRows = rows.filter((metric) => metric.absolutePercentageError !== null)
  return {
    key,
    label,
    mae: rows.length ? rows.reduce((total, metric) => total + (metric.absoluteError ?? 0), 0) / rows.length : null,
    mape: percentageRows.length ? percentageRows.reduce((total, metric) => total + (metric.absolutePercentageError ?? 0), 0) / percentageRows.length : null,
    sampleCount: rows.length,
    mapeSampleCount: percentageRows.length,
  }
})

export const compareCalibrationScenarioBacktests = (settings: AppSettings, scenario: Scenario, periodIds?: string[]) => {
  const base = runBacktests(settings, periodIds, 'Base Model')
  const calibrated = runBacktests(applyScenarioOverrides(settings, scenario), periodIds, scenario.name)
  return {
    base,
    calibrated,
    baseAccuracy: calculateBacktestAccuracy(base),
    calibratedAccuracy: calculateBacktestAccuracy(calibrated),
  }
}
