import type { OptimizationStudy } from '../models/types'

export const OPTIMIZATION_DEFAULT_MAX_CANDIDATES = 10_000
export const OPTIMIZATION_HARD_CANDIDATE_LIMIT = 50_000

export const createSampleOptimizationStudy = (): OptimizationStudy => ({
  id: 'sample-optimization-study',
  name: 'ピーク運営条件探索（初期参考）',
  evaluationMode: 'deterministic',
  objective: 'maximizeMeanOperatingProfit',
  variables: [
    {
      id: 'variable-cook-shift',
      name: '調理スタッフ人数',
      type: 'staffShiftHeadcount',
      targetId: 'shift-cook',
      values: [],
      min: 1,
      max: 3,
      step: 1,
    },
    {
      id: 'variable-soba-boiler',
      name: 'そば釜容量',
      type: 'equipmentCapacity',
      targetId: 'soba-boiler',
      values: [4, 6, 8],
    },
  ],
  constraints: [
    { id: 'constraint-p90-wait', metric: 'p90KitchenWait', operator: '<=', value: 10 },
    { id: 'constraint-abandonment', metric: 'abandonmentRate', operator: '<=', value: 0.05 },
  ],
  monteCarloRuns: 30,
  baseSeed: 12_345,
  maxCandidates: OPTIMIZATION_DEFAULT_MAX_CANDIDATES,
  hardCandidateLimit: OPTIMIZATION_HARD_CANDIDATE_LIMIT,
  planningHorizonDays: 1,
  paretoMetric: 'profitWait',
  isReferenceStudy: true,
})

export const createEmptyOptimizationStudy = (id: string): OptimizationStudy => ({
  id,
  name: '新しい運営条件探索',
  evaluationMode: 'deterministic',
  objective: 'maximizeMeanOperatingProfit',
  variables: [],
  constraints: [],
  monteCarloRuns: 30,
  baseSeed: 12_345,
  maxCandidates: OPTIMIZATION_DEFAULT_MAX_CANDIDATES,
  hardCandidateLimit: OPTIMIZATION_HARD_CANDIDATE_LIMIT,
  planningHorizonDays: 1,
  paretoMetric: 'profitWait',
})
