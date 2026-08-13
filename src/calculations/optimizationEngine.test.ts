import { describe, expect, it } from 'vitest'
import type {
  OptimizationCandidateMetrics,
  OptimizationCandidateResult,
  OptimizationConstraint,
  OptimizationObjective,
  OptimizationStudy,
  OptimizationVariable,
} from '../models/types'
import { createBenchmarkStore } from './fixtures/benchmarkStore'
import {
  applyOptimizationCandidate,
  calculateOptimizationCandidateCount,
  dominatesOptimizationCandidate,
  evaluateOptimizationConstraints,
  expandOptimizationVariableValues,
  findOptimizationParetoFrontier,
  generateOptimizationCandidates,
  optimizationCandidateToScenario,
  optimizationValuesToOverrides,
  rankOptimizationCandidates,
  runOptimization,
} from './optimizationEngine'

const variable = (patch: Partial<OptimizationVariable> = {}): OptimizationVariable => ({
  id: 'staff', name: 'スタッフ', type: 'staffShiftHeadcount', targetId: 'benchmark-shift', values: [1, 2], ...patch,
})

const study = (patch: Partial<OptimizationStudy> = {}): OptimizationStudy => ({
  id: 'study', name: '検算Study', evaluationMode: 'deterministic', variables: [variable()], constraints: [],
  objective: 'maximizeMeanOperatingProfit', monteCarloRuns: 3, baseSeed: 100, maxCandidates: 100, hardCandidateLimit: 1_000,
  ...patch,
})

const operationalStore = () => {
  const settings = createBenchmarkStore('2026-01-05')
  settings.business.mealsPerDay = 20
  settings.business.openingTime = '09:00'
  settings.business.closingTime = '10:00'
  settings.business.hoursPerDay = 1
  settings.business.weekdays = settings.business.weekdays.map((day) => ({ ...day, openingTime: '09:00', closingTime: '10:00' }))
  settings.capacity.demandProfile.timeSlots = [{ id: 'peak', startTime: '09:00', endTime: '10:00', meals: 20 }]
  settings.capacity.stochasticDemand.arrivalProfile.slots = [{ id: 'arrival', startTime: '09:00', endTime: '10:00', expectedGuests: 20, arrivalDistribution: 'uniform' }]
  settings.capacity.stochasticDemand.partySizeDistribution = [{ size: 1, probability: 100 }]
  settings.capacity.stochasticDemand.seatingUnits = [{ id: 'seats', name: '1名席', capacity: 1, count: 30, category: 'counter', enabled: true }]
  settings.capacity.stochasticDemand.orderDelay = { distribution: 'fixed', meanMinutes: 0, minMinutes: 0, maxMinutes: 0 }
  settings.capacity.stochasticDemand.dwellTime = { distribution: 'fixed', meanMinutes: 20, minMinutes: 20, maxMinutes: 20 }
  settings.capacity.stochasticDemand.maxSeatingWaitMinutes = 5
  settings.capacity.staffShifts = [{ id: 'benchmark-shift', name: '検算Shift', laborRoleId: 'benchmark-staff', startTime: '09:00', endTime: '10:00', headcount: 1 }]
  settings.capacity.equipment = [{ id: 'benchmark-station', name: '検算設備', category: 'other', capacity: 1, capacityUnit: '食', concurrentJobs: 2, enabled: true, isReferenceCapacity: false, upgradeCostPerCapacityUnit: 5_000 }]
  settings.capacity.operations[0] = {
    ...settings.capacity.operations[0], durationMinutes: 5, activeLaborMinutes: 5, batchCapacity: 4,
    equipmentRequirements: [{ equipmentId: 'benchmark-station', occupationMinutes: 5, units: 1 }],
  }
  settings.capacity.fulfillmentPolicy = 'dropAtClosing'
  return settings
}

const metrics = (patch: Partial<OptimizationCandidateMetrics> = {}): OptimizationCandidateMetrics => ({
  meanOperatingProfit: 10_000, p10OperatingProfit: 8_000, realizedSales: 20, abandonmentRate: 0.02,
  averageKitchenWait: 5, p90KitchenWait: 8, laborCost: 5_000, staffCount: 2, totalSeats: 20,
  serviceLevel: 0.95, afterClosingMinutes: 0, ...patch,
})

const candidate = (id: string, candidateMetrics: OptimizationCandidateMetrics, feasible = true): OptimizationCandidateResult => ({
  id, candidateIndex: Number(id.replace(/\D/g, '')) || 0, values: {}, overrides: {}, feasible, constraintViolations: [],
  violationScore: feasible ? 0 : 0.1, objectiveValue: candidateMetrics.meanOperatingProfit, metrics: candidateMetrics,
  investmentCost: 0, paybackOperatingDays: null, boundaryVariables: [], pareto: false, warnings: [],
})

describe('Optimization candidate generation', () => {
  it('1 Variableの候補を生成する', () => {
    expect(generateOptimizationCandidates([variable()], 10)).toEqual([{ staff: 1 }, { staff: 2 }])
  })

  it('複数VariableのCartesian productを生成する', () => {
    const combinations = generateOptimizationCandidates([variable(), variable({ id: 'seat', values: [2, 3] })], 10)
    expect(combinations).toHaveLength(4)
    expect(combinations).toContainEqual({ staff: 2, seat: 3 })
  })

  it('min / max / stepを離散候補へ展開する', () => {
    expect(expandOptimizationVariableValues(variable({ values: [], min: 1, max: 2, step: 0.25 }))).toEqual([1, 1.25, 1.5, 1.75, 2])
  })

  it('候補数を各Variable候補数の積で計算する', () => {
    expect(calculateOptimizationCandidateCount([variable(), variable({ id: 'seat', values: [1, 2, 3] })])).toBe(6)
  })

  it('hard limit超過を拒否する', () => {
    expect(() => generateOptimizationCandidates([variable(), variable({ id: 'seat', values: [1, 2, 3] })], 5)).toThrow(/hard limit/)
  })

  it('候補0件を空配列として返す', () => {
    expect(generateOptimizationCandidates([variable({ values: [], min: 2, max: 1, step: 1 })])).toEqual([])
  })
})

describe('Optimization objectives and ranking', () => {
  const first = candidate('candidate-1', metrics({ meanOperatingProfit: 10_000, p10OperatingProfit: 4_000, averageKitchenWait: 3, laborCost: 8_000, realizedSales: 10 }))
  const second = candidate('candidate-2', metrics({ meanOperatingProfit: 9_000, p10OperatingProfit: 7_000, averageKitchenWait: 2, laborCost: 7_000, realizedSales: 12 }))
  const rankedFirst = (objective: OptimizationObjective) => rankOptimizationCandidates([first, second], objective)[0].id

  it('平均利益最大化で最大値を選ぶ', () => expect(rankedFirst('maximizeMeanOperatingProfit')).toBe('candidate-1'))
  it('p10利益最大化で下振れが高い候補を選ぶ', () => expect(rankedFirst('maximizeP10OperatingProfit')).toBe('candidate-2'))
  it('待ち時間最小化で最小値を選ぶ', () => expect(rankedFirst('minimizeAverageWait')).toBe('candidate-2'))
  it('人件費最小化で最小値を選ぶ', () => expect(rankedFirst('minimizeLaborCost')).toBe('candidate-2'))
  it('Realized Sales最大化で最大値を選ぶ', () => expect(rankedFirst('maximizeRealizedSales')).toBe('candidate-2'))

  it('feasible候補をObjective値より優先する', () => {
    const infeasible = { ...first, feasible: false, violationScore: 0.01, objectiveValue: 99_999 }
    expect(rankOptimizationCandidates([infeasible, second], 'maximizeMeanOperatingProfit')[0].id).toBe('candidate-2')
  })
})

describe('Optimization constraints', () => {
  it('最大待ち時間Constraintを判定する', () => {
    expect(evaluateOptimizationConstraints(metrics({ p90KitchenWait: 12 }), [{ id: 'c', metric: 'p90KitchenWait', operator: '<=', value: 10 }])).toHaveLength(1)
  })

  it('最大離脱率Constraintを判定する', () => {
    expect(evaluateOptimizationConstraints(metrics({ abandonmentRate: 0.06 }), [{ id: 'c', metric: 'abandonmentRate', operator: '<=', value: 0.05 }])[0].amount).toBeCloseTo(0.01)
  })

  it('最小利益Constraintを判定する', () => {
    expect(evaluateOptimizationConstraints(metrics({ meanOperatingProfit: 9_000 }), [{ id: 'c', metric: 'meanOperatingProfit', operator: '>=', value: 10_000 }])[0].amount).toBe(1_000)
  })

  it('最大人件費Constraintを判定する', () => {
    expect(evaluateOptimizationConstraints(metrics({ laborCost: 12_000 }), [{ id: 'c', metric: 'laborCost', operator: '<=', value: 10_000 }])).toHaveLength(1)
  })

  it('複数Constraint違反を保持する', () => {
    const constraints: OptimizationConstraint[] = [
      { id: 'wait', metric: 'p90KitchenWait', operator: '<=', value: 5 },
      { id: 'profit', metric: 'meanOperatingProfit', operator: '>=', value: 20_000 },
    ]
    expect(evaluateOptimizationConstraints(metrics(), constraints)).toHaveLength(2)
  })

  it('条件内候補はConstraint違反0件になる', () => {
    expect(evaluateOptimizationConstraints(metrics(), [{ id: 'wait', metric: 'p90KitchenWait', operator: '<=', value: 10 }])).toEqual([])
  })

  it('総席数Constraintを判定する', () => {
    expect(evaluateOptimizationConstraints(metrics({ totalSeats: 31 }), [{ id: 'seats', metric: 'totalSeats', operator: '<=', value: 30 }])).toHaveLength(1)
  })
})

describe('Optimization application and evaluation', () => {
  it('Staff headcount候補をOverrideへ変換する', () => {
    expect(optimizationValuesToOverrides([variable()], { staff: 2 }).staffShiftHeadcountOverrides).toEqual({ 'benchmark-shift': 2 })
  })

  it('Staff headcount探索を人件費へ反映する', () => {
    const result = runOptimization(operationalStore(), study({ objective: 'minimizeLaborCost' }))
    expect(result.rankedCandidates[0].values.staff).toBe(1)
    expect(result.candidates.find((item) => item.values.staff === 2)?.metrics.laborCost).toBeGreaterThan(result.candidates.find((item) => item.values.staff === 1)?.metrics.laborCost ?? 0)
  })

  it('Staff追加をCapacityとRealized Salesへ反映する', () => {
    const result = runOptimization(operationalStore(), study({ objective: 'maximizeRealizedSales' }))
    const one = result.candidates.find((item) => item.values.staff === 1)
    const two = result.candidates.find((item) => item.values.staff === 2)
    expect(two?.metrics.realizedSales).toBeGreaterThan(one?.metrics.realizedSales ?? 0)
  })

  it('最大Staff人数Constraintを候補の同時在席人数へ反映する', () => {
    const result = runOptimization(operationalStore(), study({ constraints: [{ id: 'staff-limit', metric: 'staffCount', operator: '<=', value: 1 }] }))
    expect(result.candidates.find((item) => item.values.staff === 1)?.feasible).toBe(true)
    expect(result.candidates.find((item) => item.values.staff === 2)?.feasible).toBe(false)
  })

  it('Equipment capacityを探索設定へ反映する', () => {
    const settings = operationalStore()
    const equipmentVariable = variable({ id: 'equipment', type: 'equipmentCapacity', targetId: 'benchmark-station', values: [1, 2] })
    const changed = applyOptimizationCandidate(settings, study({ variables: [equipmentVariable] }), { equipment: 2 })
    expect(changed.capacity.equipment[0].capacity).toBe(2)
  })

  it('Equipment capacityがthroughputへ反映される', () => {
    const equipmentVariable = variable({ id: 'equipment', type: 'equipmentCapacity', targetId: 'benchmark-station', values: [1, 2] })
    const result = runOptimization(operationalStore(), study({ variables: [equipmentVariable], objective: 'maximizeRealizedSales' }))
    expect(result.candidates.find((item) => item.values.equipment === 2)?.metrics.realizedSales).toBeGreaterThanOrEqual(result.candidates.find((item) => item.values.equipment === 1)?.metrics.realizedSales ?? 0)
  })

  it('Seating countを候補設定へ反映する', () => {
    const seatingVariable = variable({ id: 'seating', type: 'seatingUnitCount', targetId: 'seats', values: [1, 10] })
    const changed = applyOptimizationCandidate(operationalStore(), study({ variables: [seatingVariable] }), { seating: 10 })
    expect(changed.capacity.stochasticDemand.seatingUnits[0].count).toBe(10)
  })

  it('Seating count増加を離脱率へ反映する', () => {
    const settings = operationalStore()
    settings.capacity.stochasticDemand.dwellTime = { distribution: 'fixed', meanMinutes: 60, minMinutes: 60, maxMinutes: 60 }
    const seatingVariable = variable({ id: 'seating', type: 'seatingUnitCount', targetId: 'seats', values: [1, 10] })
    const result = runOptimization(settings, study({ variables: [seatingVariable], objective: 'maximizeRealizedSales' }))
    expect(result.candidates.find((item) => item.values.seating === 10)?.metrics.abandonmentRate).toBeLessThan(result.candidates.find((item) => item.values.seating === 1)?.metrics.abandonmentRate ?? 1)
  })

  it('営業時間候補をBusinessSettingsへ反映する', () => {
    const opening = variable({ id: 'opening', type: 'openingTime', targetId: undefined, values: ['08:00', '09:00'] })
    const closing = variable({ id: 'closing', type: 'closingTime', targetId: undefined, values: ['10:00', '11:00'] })
    const changed = applyOptimizationCandidate(operationalStore(), study({ variables: [opening, closing] }), { opening: '08:00', closing: '11:00' })
    expect(changed.business).toMatchObject({ openingTime: '08:00', closingTime: '11:00', hoursPerDay: 3 })
  })

  it('閉店が開店以下になる営業時間候補を実行前に拒否する', () => {
    const opening = variable({ id: 'opening', type: 'openingTime', targetId: undefined, values: ['10:00'] })
    const closing = variable({ id: 'closing', type: 'closingTime', targetId: undefined, values: ['09:00'] })
    expect(() => runOptimization(operationalStore(), study({ variables: [opening, closing] }))).toThrow(/営業時間候補/)
  })

  it('需要Profile外の営業時間延長へWarningを付ける', () => {
    const closing = variable({ id: 'closing', type: 'closingTime', targetId: undefined, values: ['11:00'] })
    const result = runOptimization(operationalStore(), study({ variables: [closing] }))
    expect(result.candidates[0].warnings.join(' ')).toMatch(/需要Profile/)
  })

  it('設備投資額と回収営業日数を計算する', () => {
    const equipmentVariable = variable({ id: 'equipment', type: 'equipmentCapacity', targetId: 'benchmark-station', values: [2], adjustmentCosts: { '2': 10_000 } })
    const result = runOptimization(operationalStore(), study({ variables: [equipmentVariable], objective: 'maximizeRealizedSales' }))
    expect(result.candidates[0].investmentCost).toBe(10_000)
    expect(result.candidates[0].paybackOperatingDays === null || result.candidates[0].paybackOperatingDays > 0).toBe(true)
  })
})

describe('Monte Carlo optimization', () => {
  it('全候補へ共通seed集合を記録する', () => {
    const result = runOptimization(operationalStore(), study({ evaluationMode: 'monteCarlo', monteCarloRuns: 3, baseSeed: 500 }))
    expect(result.evaluationSeeds).toEqual([500, 501, 502])
  })

  it('同じStudyは同じ結果を再現する', () => {
    const settings = operationalStore()
    const target = study({ evaluationMode: 'monteCarlo', monteCarloRuns: 2 })
    expect(runOptimization(settings, target)).toEqual(runOptimization(settings, target))
  })

  it('runs変更をseed集合へ反映する', () => {
    const result = runOptimization(operationalStore(), study({ evaluationMode: 'monteCarlo', monteCarloRuns: 4, baseSeed: 700 }))
    expect(result.evaluationSeeds).toHaveLength(4)
  })

  it('p10利益ObjectiveをMonte Carloで評価する', () => {
    const result = runOptimization(operationalStore(), study({ evaluationMode: 'monteCarlo', monteCarloRuns: 2, objective: 'maximizeP10OperatingProfit' }))
    expect(result.rankedCandidates[0].objectiveValue).toBe(result.rankedCandidates[0].metrics.p10OperatingProfit)
  })
})

describe('Pareto frontier and boundary handling', () => {
  const a = candidate('candidate-1', metrics({ meanOperatingProfit: 10_000, p90KitchenWait: 10 }))
  const b = candidate('candidate-2', metrics({ meanOperatingProfit: 12_000, p90KitchenWait: 8 }))
  const c = candidate('candidate-3', metrics({ meanOperatingProfit: 11_000, p90KitchenWait: 6 }))

  it('利益以上・待ち以下の候補をdominateと判定する', () => expect(dominatesOptimizationCandidate(b, a)).toBe(true))
  it('dominated候補をParetoから除外する', () => expect(findOptimizationParetoFrontier([a, b, c]).map((item) => item.id)).not.toContain('candidate-1'))
  it('trade-offのある複数候補をParetoへ残す', () => expect(findOptimizationParetoFrontier([a, b, c]).map((item) => item.id)).toEqual(['candidate-2', 'candidate-3']))

  it('最良候補が探索上限ならBoundaryを記録する', () => {
    const result = runOptimization(operationalStore(), study({ objective: 'maximizeRealizedSales' }))
    expect(result.rankedCandidates[0].boundaryVariables.some((item) => item.edge === 'max')).toBe(true)
    expect(result.warnings.join(' ')).toMatch(/境界/)
  })

  it('feasible 0件では違反量の小さい候補を上位表示する', () => {
    const result = runOptimization(operationalStore(), study({ constraints: [{ id: 'impossible', metric: 'meanOperatingProfit', operator: '>=', value: 1_000_000 }] }))
    expect(result.feasibleCount).toBe(0)
    expect(result.rankedCandidates[0].violationScore).toBeLessThanOrEqual(result.rankedCandidates[1].violationScore)
    expect(result.warnings.join(' ')).toMatch(/満たす候補はありません/)
  })
})

describe('Optimization Scenario conversion', () => {
  it('候補を既存Scenario Overrideへ変換する', () => {
    const result = runOptimization(operationalStore(), study())
    const scenario = optimizationCandidateToScenario(result.rankedCandidates[0], '有力候補')
    expect(scenario.name).toBe('有力候補')
    expect(scenario.overrides.staffShiftHeadcountOverrides).toBeDefined()
  })

  it('Scenario化してもBase設定を破壊しない', () => {
    const settings = operationalStore()
    const original = settings.capacity.staffShifts[0].headcount
    optimizationCandidateToScenario(runOptimization(settings, study()).rankedCandidates[0], '候補')
    expect(settings.capacity.staffShifts[0].headcount).toBe(original)
  })
})
