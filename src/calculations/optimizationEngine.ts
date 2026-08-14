import type {
  AppSettings,
  GeneratedParty,
  OptimizationBoundaryVariable,
  OptimizationCandidateMetrics,
  OptimizationCandidateResult,
  OptimizationConstraint,
  OptimizationConstraintMetric,
  OptimizationObjective,
  OptimizationRunResult,
  OptimizationStudy,
  OptimizationStudySavedResult,
  OptimizationVariable,
  Scenario,
  ScenarioOverrides,
} from '../models/types'
import { applyScenarioOverrides } from './decisionSupport'
import { calculateCapacityStaffCost, createDeterministicOrders, getCapacityBusinessDay } from './capacityEngine'
import { runMonteCarlo, runMonteCarloAsync } from './monteCarloEngine'
import { simulateCustomerJourney } from './seatingEngine'
import { timeToMinutes } from './calendar'
import { deriveMultiDaySeed, runMultiDayMonteCarlo, runMultiDayMonteCarloAsync, simulateMultiDay } from './multiDayEngine'

const EPSILON = 1e-9

export const OPTIMIZATION_WARNING_CANDIDATES = 1_000

export class OptimizationCancelledError extends Error {
  constructor() {
    super('Optimizationがキャンセルされました。')
    this.name = 'OptimizationCancelledError'
  }
}

const roundCandidateValue = (value: number) => Math.round(value * 1_000_000_000) / 1_000_000_000

export const expandOptimizationVariableValues = (variable: OptimizationVariable): Array<number | string> => {
  if (variable.values.length > 0) return [...new Map(variable.values.map((value) => [String(value), value])).values()]
  if (variable.min === undefined || variable.max === undefined || variable.step === undefined || variable.step <= 0 || variable.min > variable.max) return []
  const values: number[] = []
  for (let value = variable.min; value <= variable.max + EPSILON && values.length < 100_000; value += variable.step) {
    values.push(roundCandidateValue(value))
  }
  return values
}

export const calculateOptimizationCandidateCount = (variables: OptimizationVariable[]) => {
  if (variables.length === 0) return 0
  return variables.reduce((count, variable) => count * expandOptimizationVariableValues(variable).length, 1)
}

export const generateOptimizationCandidates = (
  variables: OptimizationVariable[],
  hardLimit = 50_000,
): Array<Record<string, number | string>> => {
  const count = calculateOptimizationCandidateCount(variables)
  if (count > hardLimit) throw new Error(`総候補数${count.toLocaleString('ja-JP')}件がhard limit ${hardLimit.toLocaleString('ja-JP')}件を超えています。`)
  if (count === 0) return []
  return variables.reduce<Array<Record<string, number | string>>>((combinations, variable) => {
    const values = expandOptimizationVariableValues(variable)
    return combinations.flatMap((combination) => values.map((value) => ({ ...combination, [variable.id]: value })))
  }, [{}])
}

const mergeOverrideMap = (current: Record<string, number> | undefined, id: string, value: number) => ({ ...current, [id]: value })

export const optimizationValuesToOverrides = (
  variables: OptimizationVariable[],
  values: Record<string, number | string>,
): ScenarioOverrides => variables.reduce<ScenarioOverrides>((overrides, variable) => {
  const value = values[variable.id]
  if (value === undefined) return overrides
  if (variable.type === 'staffShiftHeadcount' && variable.targetId && typeof value === 'number') {
    return { ...overrides, staffShiftHeadcountOverrides: mergeOverrideMap(overrides.staffShiftHeadcountOverrides, variable.targetId, value) }
  }
  if (variable.type === 'equipmentCapacity' && variable.targetId && typeof value === 'number') {
    return { ...overrides, equipmentCapacityOverrides: mergeOverrideMap(overrides.equipmentCapacityOverrides, variable.targetId, value) }
  }
  if (variable.type === 'seatingUnitCount' && variable.targetId && typeof value === 'number') {
    return { ...overrides, seatingUnitCountOverrides: mergeOverrideMap(overrides.seatingUnitCountOverrides, variable.targetId, value) }
  }
  if (variable.type === 'kitchenOperationDuration' && variable.targetId && typeof value === 'number') {
    return { ...overrides, kitchenOperationDurationOverrides: mergeOverrideMap(overrides.kitchenOperationDurationOverrides, variable.targetId, value) }
  }
  if (variable.type === 'openingTime' && typeof value === 'string') return { ...overrides, kitchenOpeningTime: value }
  if (variable.type === 'closingTime' && typeof value === 'string') return { ...overrides, kitchenClosingTime: value }
  if (variable.type === 'weekdayStaffHeadcount' && variable.targetId && variable.day !== undefined && typeof value === 'number') {
    return { ...overrides, weekdayStaffHeadcountOverrides: mergeOverrideMap(overrides.weekdayStaffHeadcountOverrides, `${variable.day}:${variable.targetId}`, value) }
  }
  if (variable.type === 'weekdayOpeningTime' && variable.day !== undefined && typeof value === 'string') {
    return { ...overrides, weekdayOpeningTimeOverrides: { ...overrides.weekdayOpeningTimeOverrides, [String(variable.day)]: value } }
  }
  if (variable.type === 'weekdayClosingTime' && variable.day !== undefined && typeof value === 'string') {
    return { ...overrides, weekdayClosingTimeOverrides: { ...overrides.weekdayClosingTimeOverrides, [String(variable.day)]: value } }
  }
  if (variable.type === 'processPrepLookaheadDays' && variable.targetId && typeof value === 'number') {
    return { ...overrides, processPrepLookaheadDaysOverrides: mergeOverrideMap(overrides.processPrepLookaheadDaysOverrides, variable.targetId, value) }
  }
  if (variable.type === 'resourceProcurementLookaheadDays' && variable.targetId && typeof value === 'number') {
    return { ...overrides, resourceProcurementLookaheadDaysOverrides: mergeOverrideMap(overrides.resourceProcurementLookaheadDaysOverrides, variable.targetId, value) }
  }
  return overrides
}, {})

export const applyOptimizationCandidate = (
  settings: AppSettings,
  study: OptimizationStudy,
  values: Record<string, number | string>,
) => applyScenarioOverrides(settings, {
  id: `optimization-${study.id}`,
  name: study.name,
  overrides: optimizationValuesToOverrides(study.variables, values),
})

const createDeterministicParties = (settings: AppSettings): GeneratedParty[] => createDeterministicOrders(settings).map((order, index) => ({
  id: `optimization-party-${String(index + 1).padStart(5, '0')}`,
  arrivalMinute: order.arrivalMinute,
  arrivalTime: order.arrivalTime,
  size: 1,
  orderDelayMinutes: settings.capacity.stochasticDemand.orderDelay.meanMinutes,
  dwellMinutes: settings.capacity.stochasticDemand.dwellTime.meanMinutes,
  menuItemIds: [order.menuItemId],
  sourceSlotId: 'deterministic-demand',
}))

const totalStaff = (settings: AppSettings) => {
  const boundaries = [...new Set(settings.capacity.staffShifts.flatMap((shift) => [timeToMinutes(shift.startTime), timeToMinutes(shift.endTime)]).filter((minute): minute is number => minute !== null))]
  return boundaries.reduce((maximum, minute) => Math.max(maximum, settings.capacity.staffShifts.reduce((sum, shift) => {
    const start = timeToMinutes(shift.startTime)
    const end = timeToMinutes(shift.endTime)
    return start !== null && end !== null && start <= minute && minute < end ? sum + Math.max(0, shift.headcount) : sum
  }, 0)), 0)
}
const totalSeats = (settings: AppSettings) => settings.capacity.stochasticDemand.seatingUnits.filter((unit) => unit.enabled).reduce((sum, unit) => sum + Math.max(0, unit.capacity * unit.count), 0)
const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0

const deterministicMetrics = (settings: AppSettings, seed: number): OptimizationCandidateMetrics => {
  const journey = simulateCustomerJourney(settings, seed, createDeterministicParties(settings))
  return {
    meanOperatingProfit: journey.economic.realizedOperatingProfit,
    p10OperatingProfit: journey.economic.realizedOperatingProfit,
    realizedSales: journey.realizedSalesMeals,
    abandonmentRate: journey.abandonmentRate,
    averageKitchenWait: journey.averageKitchenWaitMinutes,
    p90KitchenWait: journey.p90KitchenWaitMinutes,
    laborCost: journey.capacity.economic.staffShiftCost,
    staffCount: totalStaff(settings),
    totalSeats: totalSeats(settings),
    serviceLevel: journey.capacity.withinTargetRate,
    afterClosingMinutes: Math.max(0, journey.capacity.finalCompletionMinute - journey.capacity.closingMinute),
    periodWasteCost: 0,
    stockoutLostRevenue: 0,
    purchaseExpenditure: 0,
    endingInventoryValue: 0,
  }
}

const monteCarloMetrics = (settings: AppSettings, study: OptimizationStudy): OptimizationCandidateMetrics => {
  const result = runMonteCarlo(settings, study.monteCarloRuns, study.baseSeed)
  const closing = timeToMinutes(getCapacityBusinessDay(settings).schedule.closingTime) ?? 0
  return {
    meanOperatingProfit: result.statistics.operatingProfit.mean,
    p10OperatingProfit: result.statistics.operatingProfit.p10,
    realizedSales: result.statistics.realizedSalesMeals.mean,
    abandonmentRate: result.statistics.abandonmentRate.mean,
    averageKitchenWait: result.statistics.kitchenWait.mean,
    p90KitchenWait: result.statistics.kitchenWait.p90,
    laborCost: calculateCapacityStaffCost(settings),
    staffCount: totalStaff(settings),
    totalSeats: totalSeats(settings),
    serviceLevel: average(result.summaries.map((summary) => summary.withinTargetRate)),
    afterClosingMinutes: Math.max(0, result.statistics.finalCompletionMinute.mean - closing),
    periodWasteCost: 0,
    stockoutLostRevenue: 0,
    purchaseExpenditure: 0,
    endingInventoryValue: 0,
  }
}

const monteCarloMetricsAsync = async (settings: AppSettings, study: OptimizationStudy): Promise<OptimizationCandidateMetrics> => {
  const result = await runMonteCarloAsync(settings, study.monteCarloRuns, study.baseSeed)
  const closing = timeToMinutes(getCapacityBusinessDay(settings).schedule.closingTime) ?? 0
  return {
    meanOperatingProfit: result.statistics.operatingProfit.mean,
    p10OperatingProfit: result.statistics.operatingProfit.p10,
    realizedSales: result.statistics.realizedSalesMeals.mean,
    abandonmentRate: result.statistics.abandonmentRate.mean,
    averageKitchenWait: result.statistics.kitchenWait.mean,
    p90KitchenWait: result.statistics.kitchenWait.p90,
    laborCost: calculateCapacityStaffCost(settings),
    staffCount: totalStaff(settings),
    totalSeats: totalSeats(settings),
    serviceLevel: average(result.summaries.map((summary) => summary.withinTargetRate)),
    afterClosingMinutes: Math.max(0, result.statistics.finalCompletionMinute.mean - closing),
    periodWasteCost: 0,
    stockoutLostRevenue: 0,
    purchaseExpenditure: 0,
    endingInventoryValue: 0,
  }
}

const multiDayMetrics = (settings: AppSettings, study: OptimizationStudy): OptimizationCandidateMetrics => {
  const horizon = Math.max(1, study.planningHorizonDays ?? 1)
  if (study.evaluationMode === 'monteCarlo') {
    const result = runMultiDayMonteCarlo(settings, study.monteCarloRuns, study.baseSeed, horizon)
    const deterministic = simulateMultiDay(settings, { horizonDays: horizon })
    return {
      meanOperatingProfit: result.statistics.operatingProfit.mean,
      p10OperatingProfit: result.statistics.operatingProfit.p10,
      realizedSales: result.statistics.realizedMeals.mean,
      abandonmentRate: result.statistics.abandonmentRate.mean,
      averageKitchenWait: result.statistics.averageWaitMinutes.mean,
      p90KitchenWait: result.statistics.averageWaitMinutes.p90,
      laborCost: deterministic.laborCost,
      staffCount: totalStaff(settings),
      totalSeats: totalSeats(settings),
      serviceLevel: 1 - result.statistics.abandonmentRate.mean,
      afterClosingMinutes: 0,
      periodWasteCost: result.statistics.wasteCost.mean,
      stockoutLostRevenue: result.statistics.stockoutLostRevenue.mean,
      purchaseExpenditure: deterministic.purchaseExpenditure,
      endingInventoryValue: result.statistics.endingInventoryValue.mean,
    }
  }
  const result = simulateMultiDay(settings, { horizonDays: horizon, stochastic: false, baseSeed: study.baseSeed })
  return {
    meanOperatingProfit: result.operatingProfit,
    p10OperatingProfit: result.operatingProfit,
    realizedSales: result.realizedMeals,
    abandonmentRate: result.demandMeals > 0 ? Math.max(0, result.demandMeals - result.capacityCompletedMeals) / result.demandMeals : 0,
    averageKitchenWait: result.averageWaitMinutes,
    p90KitchenWait: Math.max(0, ...result.dailyResults.map((day) => day.averageWaitMinutes)),
    laborCost: result.laborCost,
    staffCount: totalStaff(settings),
    totalSeats: totalSeats(settings),
    serviceLevel: result.serviceLevel,
    afterClosingMinutes: 0,
    periodWasteCost: result.wasteCost,
    stockoutLostRevenue: result.stockoutLostRevenue,
    purchaseExpenditure: result.purchaseExpenditure,
    endingInventoryValue: result.endingInventoryValue,
  }
}

const multiDayMetricsAsync = async (settings: AppSettings, study: OptimizationStudy): Promise<OptimizationCandidateMetrics> => {
  const horizon = Math.max(1, study.planningHorizonDays ?? 1)
  if (study.evaluationMode !== 'monteCarlo') return multiDayMetrics(settings, study)
  const result = await runMultiDayMonteCarloAsync(settings, study.monteCarloRuns, study.baseSeed, horizon)
  const deterministic = simulateMultiDay(settings, { horizonDays: horizon })
  return {
    meanOperatingProfit: result.statistics.operatingProfit.mean,
    p10OperatingProfit: result.statistics.operatingProfit.p10,
    realizedSales: result.statistics.realizedMeals.mean,
    abandonmentRate: result.statistics.abandonmentRate.mean,
    averageKitchenWait: result.statistics.averageWaitMinutes.mean,
    p90KitchenWait: result.statistics.averageWaitMinutes.p90,
    laborCost: deterministic.laborCost,
    staffCount: totalStaff(settings),
    totalSeats: totalSeats(settings),
    serviceLevel: 1 - result.statistics.abandonmentRate.mean,
    afterClosingMinutes: 0,
    periodWasteCost: result.statistics.wasteCost.mean,
    stockoutLostRevenue: result.statistics.stockoutLostRevenue.mean,
    purchaseExpenditure: deterministic.purchaseExpenditure,
    endingInventoryValue: result.statistics.endingInventoryValue.mean,
  }
}

export const metricValue = (metrics: OptimizationCandidateMetrics, metric: OptimizationConstraintMetric) => {
  if (metric === 'laborCost') return metrics.laborCost
  if (metric === 'meanOperatingProfit') return metrics.meanOperatingProfit
  if (metric === 'p10OperatingProfit') return metrics.p10OperatingProfit
  if (metric === 'averageKitchenWait') return metrics.averageKitchenWait
  if (metric === 'p90KitchenWait') return metrics.p90KitchenWait
  if (metric === 'abandonmentRate') return metrics.abandonmentRate
  if (metric === 'realizedSales') return metrics.realizedSales
  if (metric === 'serviceLevel') return metrics.serviceLevel
  if (metric === 'staffCount') return metrics.staffCount
  if (metric === 'totalSeats') return metrics.totalSeats
  if (metric === 'periodWasteCost') return metrics.periodWasteCost ?? 0
  if (metric === 'stockoutLostRevenue') return metrics.stockoutLostRevenue ?? 0
  if (metric === 'purchaseExpenditure') return metrics.purchaseExpenditure ?? 0
  if (metric === 'endingInventoryValue') return metrics.endingInventoryValue ?? 0
  return metrics.afterClosingMinutes
}

export const evaluateOptimizationConstraints = (metrics: OptimizationCandidateMetrics, constraints: OptimizationConstraint[]) => constraints.flatMap((constraint) => {
  const actual = metricValue(metrics, constraint.metric)
  const amount = constraint.operator === '<=' ? Math.max(0, actual - constraint.value) : Math.max(0, constraint.value - actual)
  if (amount <= EPSILON) return []
  return [{
    constraintId: constraint.id,
    metric: constraint.metric,
    operator: constraint.operator,
    limit: constraint.value,
    actual,
    amount,
    normalizedAmount: amount / Math.max(1, Math.abs(constraint.value)),
  }]
})

const objectiveValue = (metrics: OptimizationCandidateMetrics, objective: OptimizationObjective) => {
  if (objective === 'maximizeMeanOperatingProfit') return metrics.meanOperatingProfit
  if (objective === 'maximizeP10OperatingProfit') return metrics.p10OperatingProfit
  if (objective === 'minimizeAverageWait') return metrics.averageKitchenWait
  if (objective === 'minimizeLaborCost') return metrics.laborCost
  if (objective === 'maximizeMeanPeriodProfit') return metrics.meanOperatingProfit
  if (objective === 'maximizeP10PeriodProfit') return metrics.p10OperatingProfit
  if (objective === 'minimizePeriodWaste') return metrics.periodWasteCost ?? 0
  if (objective === 'minimizeStockoutLoss') return metrics.stockoutLostRevenue ?? 0
  return metrics.realizedSales
}

const objectiveIsMinimized = (objective: OptimizationObjective) => objective === 'minimizeAverageWait' || objective === 'minimizeLaborCost' || objective === 'minimizePeriodWaste' || objective === 'minimizeStockoutLoss'

const compareByObjective = (objective: OptimizationObjective) => (a: OptimizationCandidateResult, b: OptimizationCandidateResult) => {
  if (a.feasible !== b.feasible) return a.feasible ? -1 : 1
  if (!a.feasible && Math.abs(a.violationScore - b.violationScore) > EPSILON) return a.violationScore - b.violationScore
  const difference = objectiveValue(a.metrics, objective) - objectiveValue(b.metrics, objective)
  if (Math.abs(difference) > EPSILON) return objectiveIsMinimized(objective) ? difference : -difference
  return a.candidateIndex - b.candidateIndex
}

export const rankOptimizationCandidates = (candidates: OptimizationCandidateResult[], objective: OptimizationObjective) => [...candidates].sort(compareByObjective(objective))

export const dominatesOptimizationCandidate = (candidate: OptimizationCandidateResult, other: OptimizationCandidateResult, metric: OptimizationStudy['paretoMetric'] = 'profitWait') => {
  const candidateCost = metric === 'profitWaste' ? candidate.metrics.periodWasteCost ?? 0
    : metric === 'profitStockout' ? candidate.metrics.stockoutLostRevenue ?? 0
      : candidate.metrics.p90KitchenWait
  const otherCost = metric === 'profitWaste' ? other.metrics.periodWasteCost ?? 0
    : metric === 'profitStockout' ? other.metrics.stockoutLostRevenue ?? 0
      : other.metrics.p90KitchenWait
  return candidate.metrics.meanOperatingProfit >= other.metrics.meanOperatingProfit - EPSILON
    && candidateCost <= otherCost + EPSILON
    && (candidate.metrics.meanOperatingProfit > other.metrics.meanOperatingProfit + EPSILON || candidateCost < otherCost - EPSILON)
}

export const findOptimizationParetoFrontier = (candidates: OptimizationCandidateResult[], metric: OptimizationStudy['paretoMetric'] = 'profitWait') => candidates.filter((candidate) => (
  !candidates.some((other) => other.id !== candidate.id && dominatesOptimizationCandidate(other, candidate, metric))
))

const boundaryVariables = (study: OptimizationStudy, values: Record<string, number | string>): OptimizationBoundaryVariable[] => study.variables.flatMap((variable) => {
  const candidates = expandOptimizationVariableValues(variable)
  const selected = values[variable.id]
  if (candidates.length <= 1 || selected === undefined) return []
  const sorted = [...candidates].sort((a, b) => typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)))
  const result: OptimizationBoundaryVariable[] = []
  if (String(selected) === String(sorted[0])) result.push({ variableId: variable.id, edge: 'min' })
  if (String(selected) === String(sorted.at(-1))) result.push({ variableId: variable.id, edge: 'max' })
  return result
})

const investmentCost = (settings: AppSettings, study: OptimizationStudy, values: Record<string, number | string>) => study.variables.reduce((sum, variable) => {
  const selected = values[variable.id]
  if (selected === undefined) return sum
  const explicit = variable.adjustmentCosts?.[String(selected)]
  if (explicit !== undefined) return sum + Math.max(0, explicit)
  if (variable.type !== 'equipmentCapacity' || !variable.targetId || typeof selected !== 'number') return sum
  const equipment = settings.capacity.equipment.find((item) => item.id === variable.targetId)
  return sum + Math.max(0, selected - (equipment?.capacity ?? selected)) * Math.max(0, equipment?.upgradeCostPerCapacityUnit ?? 0)
}, 0)

const demandCoverageWarning = (settings: AppSettings, candidate: AppSettings) => {
  const baseOpening = timeToMinutes(settings.business.openingTime) ?? 0
  const baseClosing = timeToMinutes(settings.business.closingTime) ?? 0
  const opening = timeToMinutes(candidate.business.openingTime) ?? baseOpening
  const closing = timeToMinutes(candidate.business.closingTime) ?? baseClosing
  if (opening >= baseOpening && closing <= baseClosing) return undefined
  const slots = candidate.capacity.demandMode === 'stochastic'
    ? candidate.capacity.stochasticDemand.arrivalProfile.slots
    : candidate.capacity.demandProfile.timeSlots
  const minimum = slots.length ? Math.min(...slots.map((slot) => timeToMinutes(slot.startTime) ?? 24 * 60)) : 24 * 60
  const maximum = slots.length ? Math.max(...slots.map((slot) => timeToMinutes(slot.endTime) ?? 0)) : 0
  return opening < minimum || closing > maximum
    ? '営業時間延長部分を覆う需要Profileがありません。明示的な0需要を含む時間帯を設定してから解釈してください。'
    : undefined
}

const nearConstraintWarnings = (metrics: OptimizationCandidateMetrics, constraints: OptimizationConstraint[]) => constraints.flatMap((constraint) => {
  const actual = metricValue(metrics, constraint.metric)
  return Math.abs(actual - constraint.value) / Math.max(1, Math.abs(constraint.value)) <= 0.05
    ? [`${constraint.metric}がConstraint境界に近い値です（${actual.toFixed(2)} ${constraint.operator} ${constraint.value}）。`]
    : []
})

const evaluateCandidate = (
  settings: AppSettings,
  study: OptimizationStudy,
  values: Record<string, number | string>,
  candidateIndex: number,
): OptimizationCandidateResult => {
  const candidateSettings = applyOptimizationCandidate(settings, study, values)
  const metrics = (study.planningHorizonDays ?? 1) > 1
    ? multiDayMetrics(candidateSettings, study)
    : study.evaluationMode === 'monteCarlo' ? monteCarloMetrics(candidateSettings, study) : deterministicMetrics(candidateSettings, study.baseSeed)
  const violations = evaluateOptimizationConstraints(metrics, study.constraints)
  const coverageWarning = demandCoverageWarning(settings, candidateSettings)
  return {
    id: `candidate-${String(candidateIndex + 1).padStart(6, '0')}`,
    candidateIndex,
    values,
    overrides: optimizationValuesToOverrides(study.variables, values),
    feasible: violations.length === 0,
    constraintViolations: violations,
    violationScore: violations.reduce((sum, violation) => sum + violation.normalizedAmount, 0),
    objectiveValue: objectiveValue(metrics, study.objective),
    metrics,
    investmentCost: investmentCost(settings, study, values),
    paybackOperatingDays: null,
    boundaryVariables: boundaryVariables(study, values),
    pareto: false,
    warnings: [...nearConstraintWarnings(metrics, study.constraints), ...(coverageWarning ? [coverageWarning] : [])],
  }
}

const evaluateCandidateAsync = async (
  settings: AppSettings,
  study: OptimizationStudy,
  values: Record<string, number | string>,
  candidateIndex: number,
): Promise<OptimizationCandidateResult> => {
  const candidateSettings = applyOptimizationCandidate(settings, study, values)
  const metrics = (study.planningHorizonDays ?? 1) > 1
    ? await multiDayMetricsAsync(candidateSettings, study)
    : study.evaluationMode === 'monteCarlo'
      ? await monteCarloMetricsAsync(candidateSettings, study)
      : deterministicMetrics(candidateSettings, study.baseSeed)
  const violations = evaluateOptimizationConstraints(metrics, study.constraints)
  const coverageWarning = demandCoverageWarning(settings, candidateSettings)
  return {
    id: `candidate-${String(candidateIndex + 1).padStart(6, '0')}`,
    candidateIndex,
    values,
    overrides: optimizationValuesToOverrides(study.variables, values),
    feasible: violations.length === 0,
    constraintViolations: violations,
    violationScore: violations.reduce((sum, violation) => sum + violation.normalizedAmount, 0),
    objectiveValue: objectiveValue(metrics, study.objective),
    metrics,
    investmentCost: investmentCost(settings, study, values),
    paybackOperatingDays: null,
    boundaryVariables: boundaryVariables(study, values),
    pareto: false,
    warnings: [...nearConstraintWarnings(metrics, study.constraints), ...(coverageWarning ? [coverageWarning] : [])],
  }
}

const finalizeOptimization = (
  study: OptimizationStudy,
  baseMetrics: OptimizationCandidateMetrics,
  evaluatedCandidates: OptimizationCandidateResult[],
): OptimizationRunResult => {
  const feasible = evaluatedCandidates.filter((candidate) => candidate.feasible)
  const paretoSource = feasible.length > 0 ? feasible : evaluatedCandidates
  const paretoIds = new Set(findOptimizationParetoFrontier(paretoSource, study.paretoMetric).map((candidate) => candidate.id))
  const candidates = evaluatedCandidates.map((candidate) => {
    const profitDifference = candidate.metrics.meanOperatingProfit - baseMetrics.meanOperatingProfit
    return {
      ...candidate,
      pareto: paretoIds.has(candidate.id),
      paybackOperatingDays: candidate.investmentCost > 0 && profitDifference > 0 ? candidate.investmentCost / profitDifference : null,
    }
  })
  const rankedCandidates = rankOptimizationCandidates(candidates, study.objective)
  const best = rankedCandidates[0]
  const warnings = [
    ...(evaluatedCandidates.length >= OPTIMIZATION_WARNING_CANDIDATES ? [`${evaluatedCandidates.length.toLocaleString('ja-JP')}候補を評価しました。探索範囲を必要な条件へ絞ると再検証しやすくなります。`] : []),
    ...(feasible.length === 0 ? ['Constraintをすべて満たす候補はありません。違反量が最も小さい候補を上位表示します。'] : []),
    ...(best?.boundaryVariables.length ? ['上位候補が探索範囲の境界にあります。範囲外でさらに改善する可能性があります。'] : []),
    ...(study.evaluationMode === 'monteCarlo' && study.monteCarloRuns < 30 ? ['Monte Carlo run数が少ないため、上位候補は通常のMonte Carlo画面でも再検証してください。'] : []),
  ]
  return {
    studyId: study.id,
    candidateCount: candidates.length,
    feasibleCount: feasible.length,
    baseMetrics,
    candidates,
    rankedCandidates,
    paretoCandidates: candidates.filter((candidate) => candidate.pareto),
    evaluationSeeds: study.evaluationMode === 'monteCarlo'
      ? Array.from({ length: study.monteCarloRuns }, (_, index) => (
        (study.planningHorizonDays ?? 1) > 1
          ? deriveMultiDaySeed(study.baseSeed, index, 0)
          : (Math.trunc(study.baseSeed) + index) >>> 0
      ))
      : [study.baseSeed],
    warnings,
  }
}

const assertStudyCanRun = (study: OptimizationStudy) => {
  const count = calculateOptimizationCandidateCount(study.variables)
  if (count === 0) throw new Error('探索Variableに候補値がありません。')
  if (count > study.hardCandidateLimit) throw new Error(`総候補数${count.toLocaleString('ja-JP')}件がhard limit ${study.hardCandidateLimit.toLocaleString('ja-JP')}件を超えています。`)
  if (count > study.maxCandidates) throw new Error(`総候補数${count.toLocaleString('ja-JP')}件がStudy上限 ${study.maxCandidates.toLocaleString('ja-JP')}件を超えています。Variable範囲を狭めてください。`)
  if ((study.objective === 'maximizeP10OperatingProfit' || study.objective === 'maximizeP10PeriodProfit') && study.evaluationMode !== 'monteCarlo') throw new Error('p10営業利益ObjectiveにはMonte Carlo評価が必要です。')
  if (study.evaluationMode === 'monteCarlo' && study.monteCarloRuns <= 0) throw new Error('Monte Carlo run数は1以上にしてください。')
}

const assertCandidateBusinessHours = (
  settings: AppSettings,
  study: OptimizationStudy,
  combinations: Array<Record<string, number | string>>,
) => {
  const invalid = combinations.some((values) => {
    const overrides = optimizationValuesToOverrides(study.variables, values)
    const opening = timeToMinutes(overrides.kitchenOpeningTime ?? settings.business.openingTime)
    const closing = timeToMinutes(overrides.kitchenClosingTime ?? settings.business.closingTime)
    return opening === null || closing === null || closing <= opening
  })
  if (invalid) throw new Error('開店時刻以上の閉店時刻となる候補があります。営業時間候補を見直してください。')
}

export const runOptimization = (settings: AppSettings, study: OptimizationStudy): OptimizationRunResult => {
  assertStudyCanRun(study)
  const combinations = generateOptimizationCandidates(study.variables, study.hardCandidateLimit)
  assertCandidateBusinessHours(settings, study, combinations)
  const baseMetrics = (study.planningHorizonDays ?? 1) > 1
    ? multiDayMetrics(settings, study)
    : study.evaluationMode === 'monteCarlo' ? monteCarloMetrics(settings, study) : deterministicMetrics(settings, study.baseSeed)
  const candidates = combinations.map((values, index) => evaluateCandidate(settings, study, values, index))
  return finalizeOptimization(study, baseMetrics, candidates)
}

export const runOptimizationAsync = async (
  settings: AppSettings,
  study: OptimizationStudy,
  onProgress?: (completed: number, total: number) => void,
  isCancelled?: () => boolean,
): Promise<OptimizationRunResult> => {
  assertStudyCanRun(study)
  const combinations = generateOptimizationCandidates(study.variables, study.hardCandidateLimit)
  assertCandidateBusinessHours(settings, study, combinations)
  const baseMetrics = (study.planningHorizonDays ?? 1) > 1
    ? await multiDayMetricsAsync(settings, study)
    : study.evaluationMode === 'monteCarlo' ? await monteCarloMetricsAsync(settings, study) : deterministicMetrics(settings, study.baseSeed)
  const candidates: OptimizationCandidateResult[] = []
  for (let index = 0; index < combinations.length; index += 1) {
    if (isCancelled?.()) throw new OptimizationCancelledError()
    candidates.push(await evaluateCandidateAsync(settings, study, combinations[index], index))
    onProgress?.(index + 1, combinations.length)
    if ((index + 1) % 2 === 0 && index + 1 < combinations.length) await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  return finalizeOptimization(study, baseMetrics, candidates)
}

export const optimizationCandidateToScenario = (candidate: OptimizationCandidateResult, name: string): Scenario => ({
  id: `optimization-scenario-${Date.now()}-${candidate.candidateIndex + 1}`,
  name,
  overrides: {
    ...candidate.overrides,
    staffShiftHeadcountOverrides: candidate.overrides.staffShiftHeadcountOverrides ? { ...candidate.overrides.staffShiftHeadcountOverrides } : undefined,
    equipmentCapacityOverrides: candidate.overrides.equipmentCapacityOverrides ? { ...candidate.overrides.equipmentCapacityOverrides } : undefined,
    seatingUnitCountOverrides: candidate.overrides.seatingUnitCountOverrides ? { ...candidate.overrides.seatingUnitCountOverrides } : undefined,
    kitchenOperationDurationOverrides: candidate.overrides.kitchenOperationDurationOverrides ? { ...candidate.overrides.kitchenOperationDurationOverrides } : undefined,
    weekdayStaffHeadcountOverrides: candidate.overrides.weekdayStaffHeadcountOverrides ? { ...candidate.overrides.weekdayStaffHeadcountOverrides } : undefined,
    weekdayOpeningTimeOverrides: candidate.overrides.weekdayOpeningTimeOverrides ? { ...candidate.overrides.weekdayOpeningTimeOverrides } : undefined,
    weekdayClosingTimeOverrides: candidate.overrides.weekdayClosingTimeOverrides ? { ...candidate.overrides.weekdayClosingTimeOverrides } : undefined,
    processPrepLookaheadDaysOverrides: candidate.overrides.processPrepLookaheadDaysOverrides ? { ...candidate.overrides.processPrepLookaheadDaysOverrides } : undefined,
    resourceProcurementLookaheadDaysOverrides: candidate.overrides.resourceProcurementLookaheadDaysOverrides ? { ...candidate.overrides.resourceProcurementLookaheadDaysOverrides } : undefined,
  },
  notes: 'Optimization候補から保存。Base Settingsは変更していません。',
})

export const savedOptimizationResult = (result: OptimizationRunResult): OptimizationStudySavedResult => ({
  evaluatedAt: new Date().toISOString(),
  candidateCount: result.candidateCount,
  feasibleCount: result.feasibleCount,
  baseMetrics: result.baseMetrics,
  topCandidates: result.rankedCandidates.slice(0, 20),
  paretoCandidates: result.paretoCandidates.slice(0, 50),
})
