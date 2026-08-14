import type {
  AppSettings,
  MetricStatistics,
  MonteCarloResult,
  MonteCarloRunSummary,
  MonteCarloScenarioComparison,
} from '../models/types'
import { applyScenarioOverrides } from './decisionSupport'
import { simulateCustomerJourney } from './seatingEngine'
import { applyForecastDemandToSettings } from './forecastEngine'

export const quantile = (values: number[], probability: number) => {
  if (values.length === 0) return 0
  const ordered = [...values].sort((a, b) => a - b)
  const position = Math.min(1, Math.max(0, probability)) * (ordered.length - 1)
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return ordered[lower]
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)
}

export const calculateStatistics = (values: number[]): MetricStatistics => ({
  mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0,
  median: quantile(values, 0.5),
  p5: quantile(values, 0.05),
  p10: quantile(values, 0.1),
  p90: quantile(values, 0.9),
  p95: quantile(values, 0.95),
  min: values.length ? Math.min(...values) : 0,
  max: values.length ? Math.max(...values) : 0,
})

const summaryFromRun = (runIndex: number, seed: number, result: ReturnType<typeof simulateCustomerJourney>): MonteCarloRunSummary => ({
  runIndex,
  seed,
  arrivedGuests: result.arrivedGuests,
  abandonedGuests: result.abandonedGuests,
  abandonmentRate: result.abandonmentRate,
  realizedSalesMeals: result.realizedSalesMeals,
  revenue: result.economic.realizedRevenue,
  operatingProfit: result.economic.realizedOperatingProfit,
  averageSeatingWaitMinutes: result.averageSeatingWaitMinutes,
  averageKitchenWaitMinutes: result.averageKitchenWaitMinutes,
  averageTotalWaitMinutes: result.averageTotalWaitMinutes,
  maxQueueLength: Math.max(result.maxSeatingQueueParties, result.capacity.maxQueueLength),
  finalCompletionMinute: result.capacity.finalCompletionMinute,
  withinTargetRate: result.capacity.withinTargetRate,
  seatUtilization: result.seatUtilization,
})

const closestSeed = (summaries: MonteCarloRunSummary[], value: number) => [...summaries]
  .sort((a, b) => Math.abs(a.operatingProfit - value) - Math.abs(b.operatingProfit - value) || a.runIndex - b.runIndex)[0]?.seed ?? 0

const assertRunCount = (settings: AppSettings, requestedRuns: number) => {
  const maximum = Math.min(1_000, settings.capacity.stochasticDemand.monteCarlo.maximumRuns)
  if (!Number.isInteger(requestedRuns) || requestedRuns <= 0 || requestedRuns > maximum) {
    throw new Error(`Monte Carlo run数は1〜${maximum}にしてください。`)
  }
}

const aggregateRuns = (
  settings: AppSettings,
  requestedRuns: number,
  baseSeed: number,
  summaries: MonteCarloRunSummary[],
): MonteCarloResult => {
  const values = <K extends keyof MonteCarloRunSummary>(key: K) => summaries.map((summary) => Number(summary[key]))
  const operatingProfit = calculateStatistics(values('operatingProfit'))
  const monteCarlo = settings.capacity.stochasticDemand.monteCarlo
  return {
    runs: requestedRuns,
    baseSeed,
    summaries,
    statistics: {
      arrivedGuests: calculateStatistics(values('arrivedGuests')),
      abandonedGuests: calculateStatistics(values('abandonedGuests')),
      abandonmentRate: calculateStatistics(values('abandonmentRate')),
      realizedSalesMeals: calculateStatistics(values('realizedSalesMeals')),
      revenue: calculateStatistics(values('revenue')),
      operatingProfit,
      seatingWait: calculateStatistics(values('averageSeatingWaitMinutes')),
      kitchenWait: calculateStatistics(values('averageKitchenWaitMinutes')),
      totalWait: calculateStatistics(values('averageTotalWaitMinutes')),
      maxQueue: calculateStatistics(values('maxQueueLength')),
      finalCompletionMinute: calculateStatistics(values('finalCompletionMinute')),
      seatUtilization: calculateStatistics(values('seatUtilization')),
    },
    lossRunRate: summaries.filter((summary) => summary.operatingProfit < 0).length / summaries.length,
    targetProfitProbability: summaries.filter((summary) => summary.operatingProfit >= monteCarlo.targetProfit).length / summaries.length,
    serviceLevelProbability: summaries.filter((summary) => summary.withinTargetRate >= monteCarlo.targetServiceLevelRate).length / summaries.length,
    lowProfitSeed: closestSeed(summaries, operatingProfit.p10),
    medianProfitSeed: closestSeed(summaries, operatingProfit.median),
    highProfitSeed: closestSeed(summaries, operatingProfit.p90),
  }
}

export const runMonteCarlo = (
  settings: AppSettings,
  requestedRuns = settings.capacity.stochasticDemand.monteCarlo.runs,
  baseSeed = settings.capacity.stochasticDemand.monteCarlo.baseSeed,
): MonteCarloResult => {
  assertRunCount(settings, requestedRuns)
  const summaries = Array.from({ length: requestedRuns }, (_, runIndex) => {
    const seed = (Math.trunc(baseSeed) + runIndex) >>> 0
    const runSettings = applyForecastDemandToSettings(settings, settings.business.simulationStartDate, seed, true)
    return summaryFromRun(runIndex, seed, simulateCustomerJourney(runSettings, seed))
  })
  return aggregateRuns(settings, requestedRuns, baseSeed, summaries)
}

export const runMonteCarloAsync = async (
  settings: AppSettings,
  requestedRuns = settings.capacity.stochasticDemand.monteCarlo.runs,
  baseSeed = settings.capacity.stochasticDemand.monteCarlo.baseSeed,
  onProgress?: (completed: number, total: number) => void,
): Promise<MonteCarloResult> => {
  assertRunCount(settings, requestedRuns)
  const summaries: MonteCarloRunSummary[] = []
  const chunkSize = 5
  for (let runIndex = 0; runIndex < requestedRuns; runIndex += 1) {
    const seed = (Math.trunc(baseSeed) + runIndex) >>> 0
    const runSettings = applyForecastDemandToSettings(settings, settings.business.simulationStartDate, seed, true)
    summaries.push(summaryFromRun(runIndex, seed, simulateCustomerJourney(runSettings, seed)))
    onProgress?.(runIndex + 1, requestedRuns)
    if ((runIndex + 1) % chunkSize === 0 && runIndex + 1 < requestedRuns) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }
  return aggregateRuns(settings, requestedRuns, baseSeed, summaries)
}

export const compareMonteCarloScenarios = (
  settings: AppSettings,
  runs = settings.capacity.stochasticDemand.monteCarlo.runs,
  baseSeed = settings.capacity.stochasticDemand.monteCarlo.baseSeed,
): MonteCarloScenarioComparison[] => {
  const base = runMonteCarlo(settings, runs, baseSeed)
  return [
    { id: 'base', name: 'Base', result: base, meanProfitDifference: 0, p10ProfitDifference: 0, abandonmentRateDifference: 0, totalWaitDifference: 0 },
    ...settings.scenarios.slice(0, 5).map((scenario) => {
      const scenarioSettings = applyScenarioOverrides(settings, scenario)
      const result = runMonteCarlo(scenarioSettings, runs, baseSeed)
      return {
        id: scenario.id,
        name: scenario.name,
        result,
        meanProfitDifference: result.statistics.operatingProfit.mean - base.statistics.operatingProfit.mean,
        p10ProfitDifference: result.statistics.operatingProfit.p10 - base.statistics.operatingProfit.p10,
        abandonmentRateDifference: result.statistics.abandonmentRate.mean - base.statistics.abandonmentRate.mean,
        totalWaitDifference: result.statistics.totalWait.mean - base.statistics.totalWait.mean,
      }
    }),
  ]
}

export const compareMonteCarloScenariosAsync = async (
  settings: AppSettings,
  runs = settings.capacity.stochasticDemand.monteCarlo.runs,
  baseSeed = settings.capacity.stochasticDemand.monteCarlo.baseSeed,
): Promise<MonteCarloScenarioComparison[]> => {
  const base = await runMonteCarloAsync(settings, runs, baseSeed)
  const compared: MonteCarloScenarioComparison[] = [
    { id: 'base', name: 'Base', result: base, meanProfitDifference: 0, p10ProfitDifference: 0, abandonmentRateDifference: 0, totalWaitDifference: 0 },
  ]
  for (const scenario of settings.scenarios.slice(0, 5)) {
    const result = await runMonteCarloAsync(applyScenarioOverrides(settings, scenario), runs, baseSeed)
    compared.push({
      id: scenario.id,
      name: scenario.name,
      result,
      meanProfitDifference: result.statistics.operatingProfit.mean - base.statistics.operatingProfit.mean,
      p10ProfitDifference: result.statistics.operatingProfit.p10 - base.statistics.operatingProfit.p10,
      abandonmentRateDifference: result.statistics.abandonmentRate.mean - base.statistics.abandonmentRate.mean,
      totalWaitDifference: result.statistics.totalWait.mean - base.statistics.totalWait.mean,
    })
  }
  return compared
}
