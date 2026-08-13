import { useMemo, useRef, useState } from 'react'
import {
  calculateOptimizationCandidateCount,
  OptimizationCancelledError,
  optimizationCandidateToScenario,
  runOptimizationAsync,
  savedOptimizationResult,
} from '../calculations/optimizationEngine'
import { createEmptyOptimizationStudy } from '../data/optimizationDefaults'
import type {
  AppSettings,
  OptimizationCandidateResult,
  OptimizationConstraint,
  OptimizationConstraintMetric,
  OptimizationObjective,
  OptimizationRunResult,
  OptimizationStudy,
  OptimizationVariable,
  OptimizationVariableType,
} from '../models/types'
import { formatNumber, formatPercent, formatYen } from '../utils/format'
import { Badge, Button, EmptyState, NumberField, PageTitle, Panel, SelectField, TextField } from './ui'

type Props = { settings: AppSettings; onChange: (settings: AppSettings) => void }
type CandidateFilter = 'all' | 'feasible' | 'pareto'

let idSequence = 0
const uniqueId = (prefix: string) => `${prefix}-${Date.now()}-${idSequence += 1}`
const numeric = (value: string) => Number.isFinite(Number(value)) ? Number(value) : 0

const objectiveLabels: Record<OptimizationObjective, string> = {
  maximizeMeanOperatingProfit: '平均営業利益を最大化',
  maximizeP10OperatingProfit: 'p10営業利益を最大化',
  minimizeAverageWait: '平均厨房待ちを最小化',
  minimizeLaborCost: '人件費を最小化',
  maximizeRealizedSales: 'Realized Salesを最大化',
}

const variableLabels: Record<OptimizationVariableType, string> = {
  staffShiftHeadcount: 'StaffShift人数',
  equipmentCapacity: 'Equipment容量',
  seatingUnitCount: 'SeatingUnit卓数',
  openingTime: '開店時刻',
  closingTime: '閉店時刻',
  kitchenOperationDuration: 'KitchenOperation時間',
}

const constraintLabels: Record<OptimizationConstraintMetric, string> = {
  laborCost: '人件費',
  meanOperatingProfit: '平均営業利益',
  p10OperatingProfit: 'p10営業利益',
  averageKitchenWait: '平均厨房待ち',
  p90KitchenWait: 'p90厨房待ち',
  abandonmentRate: '離脱率',
  realizedSales: 'Realized Sales',
  serviceLevel: 'Service Level',
  staffCount: 'Staff人数',
  totalSeats: '総座席数',
  afterClosingMinutes: '閉店後処理時間',
}

const rateMetrics = new Set<OptimizationConstraintMetric>(['abandonmentRate', 'serviceLevel'])
const yenMetrics = new Set<OptimizationConstraintMetric>(['laborCost', 'meanOperatingProfit', 'p10OperatingProfit'])
const waitMetrics = new Set<OptimizationConstraintMetric>(['averageKitchenWait', 'p90KitchenWait', 'afterClosingMinutes'])

const formatConstraintValue = (metric: OptimizationConstraintMetric, value: number) => {
  if (rateMetrics.has(metric)) return formatPercent(value)
  if (yenMetrics.has(metric)) return formatYen(value)
  if (waitMetrics.has(metric)) return `${formatNumber(value, 1)}分`
  return formatNumber(value, 1)
}

const formatVariableValue = (variable: OptimizationVariable | undefined, value: number | string) => {
  if (!variable || typeof value === 'string') return String(value)
  if (variable.type === 'staffShiftHeadcount') return `${formatNumber(value)}人`
  if (variable.type === 'seatingUnitCount') return `${formatNumber(value)}卓`
  if (variable.type === 'kitchenOperationDuration') return `${formatNumber(value)}分`
  return formatNumber(value)
}

const targetOptions = (settings: AppSettings, type: OptimizationVariableType) => {
  if (type === 'staffShiftHeadcount') return settings.capacity.staffShifts.map((item) => ({ id: item.id, name: item.name }))
  if (type === 'equipmentCapacity') return settings.capacity.equipment.map((item) => ({ id: item.id, name: item.name }))
  if (type === 'seatingUnitCount') return settings.capacity.stochasticDemand.seatingUnits.map((item) => ({ id: item.id, name: item.name }))
  if (type === 'kitchenOperationDuration') return settings.capacity.operations.map((item) => ({ id: item.id, name: item.name }))
  return []
}

const baseVariableValue = (settings: AppSettings, variable: OptimizationVariable): number | string | undefined => {
  if (variable.type === 'staffShiftHeadcount') return settings.capacity.staffShifts.find((item) => item.id === variable.targetId)?.headcount
  if (variable.type === 'equipmentCapacity') return settings.capacity.equipment.find((item) => item.id === variable.targetId)?.capacity
  if (variable.type === 'seatingUnitCount') return settings.capacity.stochasticDemand.seatingUnits.find((item) => item.id === variable.targetId)?.count
  if (variable.type === 'kitchenOperationDuration') return settings.capacity.operations.find((item) => item.id === variable.targetId)?.durationMinutes
  if (variable.type === 'openingTime') return settings.business.openingTime
  return settings.business.closingTime
}

const defaultVariable = (settings: AppSettings): OptimizationVariable => ({
  id: uniqueId('optimization-variable'),
  name: '調理スタッフ人数',
  type: 'staffShiftHeadcount',
  targetId: settings.capacity.staffShifts[0]?.id,
  values: [],
  min: 1,
  max: 3,
  step: 1,
})

const ParetoChart = ({ candidates }: { candidates: OptimizationCandidateResult[] }) => {
  if (candidates.length === 0) return <EmptyState>表示できる候補がありません。</EmptyState>
  const width = 820
  const height = 300
  const pad = { top: 25, right: 30, bottom: 48, left: 78 }
  const waits = candidates.map((candidate) => candidate.metrics.p90KitchenWait)
  const profits = candidates.map((candidate) => candidate.metrics.meanOperatingProfit)
  const minWait = Math.min(...waits)
  const maxWait = Math.max(...waits)
  const minProfit = Math.min(...profits)
  const maxProfit = Math.max(...profits)
  const x = (value: number) => pad.left + (value - minWait) / Math.max(1, maxWait - minWait) * (width - pad.left - pad.right)
  const y = (value: number) => pad.top + (maxProfit - value) / Math.max(1, maxProfit - minProfit) * (height - pad.top - pad.bottom)
  return <div className="chart-wrap optimization-chart"><svg role="img" aria-label="利益と待ち時間のPareto散布図" viewBox={`0 0 ${width} ${height}`}>
    {[0, 0.25, 0.5, 0.75, 1].map((ratio) => <g key={ratio}><line className="grid-line" x1={pad.left} x2={width - pad.right} y1={pad.top + ratio * (height - pad.top - pad.bottom)} y2={pad.top + ratio * (height - pad.top - pad.bottom)}/></g>)}
    {candidates.map((candidate) => <circle key={candidate.id} className={candidate.pareto ? 'pareto-dot' : 'candidate-dot'} cx={x(candidate.metrics.p90KitchenWait)} cy={y(candidate.metrics.meanOperatingProfit)} r={candidate.pareto ? 6 : 3.5}/>) }
    <text className="axis-label" x={pad.left} y={height - 14}>p90待ち {formatNumber(minWait, 1)}分</text>
    <text className="axis-label" x={width - pad.right} y={height - 14} textAnchor="end">{formatNumber(maxWait, 1)}分</text>
    <text className="axis-label" x={pad.left - 9} y={pad.top + 4} textAnchor="end">{formatYen(maxProfit)}</text>
    <text className="axis-label" x={pad.left - 9} y={height - pad.bottom} textAnchor="end">{formatYen(minProfit)}</text>
  </svg></div>
}

export const OptimizationEditor = ({ settings, onChange }: Props) => {
  const [selectedStudyId, setSelectedStudyId] = useState(settings.optimizationStudies[0]?.id ?? '')
  const [runResult, setRunResult] = useState<OptimizationRunResult>()
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ completed: 0, total: 0 })
  const [runMessage, setRunMessage] = useState<string>()
  const [filter, setFilter] = useState<CandidateFilter>('all')
  const [selectedCandidateId, setSelectedCandidateId] = useState<string>()
  const cancelRef = useRef(false)
  const study = settings.optimizationStudies.find((item) => item.id === selectedStudyId) ?? settings.optimizationStudies[0]
  const candidateCount = study ? calculateOptimizationCandidateCount(study.variables) : 0
  const savedCandidates = useMemo(() => {
    const combined = [...(study?.result?.topCandidates ?? []), ...(study?.result?.paretoCandidates ?? [])]
    return [...new Map(combined.map((candidate) => [candidate.id, candidate])).values()]
  }, [study?.result])

  const updateStudy = (patch: Partial<OptimizationStudy>) => {
    if (!study) return
    setRunResult(undefined)
    setSelectedCandidateId(undefined)
    onChange({
      ...settings,
      optimizationStudies: settings.optimizationStudies.map((item) => item.id === study.id
        ? { ...item, ...patch, result: undefined, isReferenceStudy: false }
        : item),
    })
  }
  const updateVariable = (id: string, patch: Partial<OptimizationVariable>) => updateStudy({ variables: study?.variables.map((item) => item.id === id ? { ...item, ...patch } : item) })
  const updateConstraint = (id: string, patch: Partial<OptimizationConstraint>) => updateStudy({ constraints: study?.constraints.map((item) => item.id === id ? { ...item, ...patch } : item) })

  const displayCandidates = useMemo(() => {
    const source = runResult?.rankedCandidates ?? savedCandidates
    if (filter === 'feasible') return source.filter((candidate) => candidate.feasible)
    if (filter === 'pareto') return source.filter((candidate) => candidate.pareto)
    return source
  }, [filter, runResult, savedCandidates])
  const selectedCandidate = displayCandidates.find((candidate) => candidate.id === selectedCandidateId) ?? displayCandidates[0]
  const baseMetrics = runResult?.baseMetrics ?? study?.result?.baseMetrics

  const execute = async () => {
    if (!study || running) return
    cancelRef.current = false
    setRunning(true)
    setRunMessage(undefined)
    setProgress({ completed: 0, total: candidateCount })
    try {
      const result = await runOptimizationAsync(settings, study, (completed, total) => setProgress({ completed, total }), () => cancelRef.current)
      setRunResult(result)
      setSelectedCandidateId(result.rankedCandidates[0]?.id)
      onChange({
        ...settings,
        optimizationStudies: settings.optimizationStudies.map((item) => item.id === study.id ? { ...item, result: savedOptimizationResult(result) } : item),
      })
      setRunMessage(`${result.candidateCount.toLocaleString('ja-JP')}候補を評価し、${result.feasibleCount.toLocaleString('ja-JP')}候補がConstraintを満たしました。`)
    } catch (error) {
      setRunMessage(error instanceof OptimizationCancelledError ? '探索をキャンセルしました。' : error instanceof Error ? error.message : 'Optimizationを実行できませんでした。')
    } finally {
      setRunning(false)
    }
  }

  const addStudy = () => {
    const next = createEmptyOptimizationStudy(uniqueId('optimization-study'))
    onChange({ ...settings, optimizationStudies: [...settings.optimizationStudies, next] })
    setSelectedStudyId(next.id)
    setRunResult(undefined)
  }

  const deleteStudy = () => {
    if (!study || !window.confirm(`「${study.name}」を削除しますか？`)) return
    const remaining = settings.optimizationStudies.filter((item) => item.id !== study.id)
    onChange({ ...settings, optimizationStudies: remaining })
    setSelectedStudyId(remaining[0]?.id ?? '')
    setRunResult(undefined)
  }

  const saveScenario = (candidate: OptimizationCandidateResult) => {
    if (settings.scenarios.length >= 5) {
      setRunMessage('Scenarioは現在5件です。既存Scenarioを整理してから保存してください。')
      return
    }
    const scenario = optimizationCandidateToScenario(candidate, `${study?.name ?? 'Optimization'} 候補${candidate.candidateIndex + 1}`)
    onChange({ ...settings, scenarios: [...settings.scenarios, scenario] })
    setRunMessage('候補をScenarioとして保存しました。Base Settingsは変更していません。')
  }

  if (!study) return <>
    <PageTitle eyebrow="OPTIMIZATION / CONSTRAINT / PARETO" title="最適化" description="離散候補を既存Simulation Engine群で評価し、制約内の有力候補とtrade-offを比較します。" actions={<Button variant="primary" onClick={addStudy}>＋ Study</Button>}/>
    <EmptyState>Optimization Studyがありません。「＋ Study」から追加してください。</EmptyState>
  </>

  return <>
    <PageTitle eyebrow="OPTIMIZATION / CONSTRAINT / PARETO" title="最適化" description="唯一の正解を断定せず、既存Engineで評価した有力候補・下振れ・待ち時間のtrade-offを提示します。" actions={<div className="page-action-row"><select aria-label="Optimization Study" value={study.id} onChange={(event) => { setSelectedStudyId(event.target.value); setRunResult(undefined) }}>{settings.optimizationStudies.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><Button onClick={addStudy}>＋ Study</Button><Button variant="danger" onClick={deleteStudy}>削除</Button></div>}/>

    <div className="optimization-flow"><span>1 Objective</span><i>→</i><span>2 Variables</span><i>→</i><span>3 Constraints</span><i>→</i><span>4 評価</span><i>→</i><span>5 Pareto</span></div>

    <Panel title="Study / Objective" caption="価格・需要・Actualは需要弾力性モデルがないため探索対象にしません。">
      <div className="form-grid form-grid-3">
        <TextField label="Study名" value={study.name} onChange={(event) => updateStudy({ name: event.target.value })}/>
        <SelectField label="Objective" value={study.objective} onChange={(event) => updateStudy({ objective: event.target.value as OptimizationObjective })}>{Object.entries(objectiveLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</SelectField>
        <SelectField label="評価方式" value={study.evaluationMode} onChange={(event) => updateStudy({ evaluationMode: event.target.value as OptimizationStudy['evaluationMode'] })}><option value="deterministic">deterministic（高速）</option><option value="monteCarlo">Monte Carlo（共通seed）</option></SelectField>
        <NumberField label="Monte Carlo runs" min={1} max={100} value={study.monteCarloRuns} disabled={study.evaluationMode !== 'monteCarlo'} onChange={(event) => updateStudy({ monteCarloRuns: Math.trunc(numeric(event.target.value)) })}/>
        <NumberField label="Base seed" value={study.baseSeed} onChange={(event) => updateStudy({ baseSeed: Math.trunc(numeric(event.target.value)) })}/>
        <NumberField label="Study候補上限" min={1} max={study.hardCandidateLimit} value={study.maxCandidates} onChange={(event) => updateStudy({ maxCandidates: Math.trunc(numeric(event.target.value)) })}/>
      </div>
    </Panel>

    <Panel title="Optimization Variables" caption="各Variableは候補値リスト、またはmin / max / stepから離散候補を生成します。" actions={<Button onClick={() => updateStudy({ variables: [...study.variables, defaultVariable(settings)] })}>＋ Variable</Button>}>
      <div className="optimization-variable-list">{study.variables.map((variable) => {
        const targets = targetOptions(settings, variable.type)
        const usesRange = variable.values.length === 0 && variable.type !== 'openingTime' && variable.type !== 'closingTime'
        return <article className="editor-card" key={variable.id}>
          <div className="form-grid form-grid-4">
            <TextField label="Variable名" value={variable.name} onChange={(event) => updateVariable(variable.id, { name: event.target.value })}/>
            <SelectField label="種類" value={variable.type} onChange={(event) => {
              const type = event.target.value as OptimizationVariableType
              const options = targetOptions(settings, type)
              updateVariable(variable.id, { type, targetId: options[0]?.id, values: type === 'openingTime' ? [settings.business.openingTime] : type === 'closingTime' ? [settings.business.closingTime] : [], min: type === 'openingTime' || type === 'closingTime' ? undefined : 1, max: type === 'openingTime' || type === 'closingTime' ? undefined : 3, step: type === 'openingTime' || type === 'closingTime' ? undefined : 1 })
            }}>{Object.entries(variableLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</SelectField>
            {targets.length > 0 ? <SelectField label="対象" value={variable.targetId ?? ''} onChange={(event) => updateVariable(variable.id, { targetId: event.target.value })}>{targets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}</SelectField> : <div className="optimization-base-value"><span>Base</span><strong>{formatVariableValue(variable, baseVariableValue(settings, variable) ?? '—')}</strong></div>}
            <SelectField label="候補入力" value={usesRange ? 'range' : 'values'} onChange={(event) => updateVariable(variable.id, event.target.value === 'range' ? { values: [], min: 1, max: 3, step: 1 } : { values: [baseVariableValue(settings, variable) ?? 1], min: undefined, max: undefined, step: undefined })}><option value="range" disabled={variable.type === 'openingTime' || variable.type === 'closingTime'}>min / max / step</option><option value="values">候補値リスト</option></SelectField>
          </div>
          {usesRange ? <div className="form-grid form-grid-3 optimization-range"><NumberField label="min" value={variable.min ?? 0} onChange={(event) => updateVariable(variable.id, { min: numeric(event.target.value) })}/><NumberField label="max" value={variable.max ?? 0} onChange={(event) => updateVariable(variable.id, { max: numeric(event.target.value) })}/><NumberField label="step" min={0.01} value={variable.step ?? 1} onChange={(event) => updateVariable(variable.id, { step: numeric(event.target.value) })}/></div>
            : <TextField label={variable.type === 'openingTime' || variable.type === 'closingTime' ? '候補時刻（カンマ区切り）' : '候補値（カンマ区切り）'} value={variable.values.join(', ')} onChange={(event) => {
              const isTime = variable.type === 'openingTime' || variable.type === 'closingTime'
              const values: Array<number | string> = event.target.value.split(',').map((value) => value.trim()).filter(Boolean).flatMap<number | string>((value) => isTime ? [value] : Number.isFinite(Number(value)) ? [Number(value)] : [])
              updateVariable(variable.id, { values })
            }}/>} 
          <div className="card-actions"><small>Base: {formatVariableValue(variable, baseVariableValue(settings, variable) ?? '—')}</small><Button variant="danger" onClick={() => updateStudy({ variables: study.variables.filter((item) => item.id !== variable.id) })}>削除</Button></div>
        </article>
      })}</div>
      {study.variables.length === 0 && <EmptyState>探索Variableを追加してください。</EmptyState>}
    </Panel>

    <Panel title="Constraints" caption="Objectiveとは別に、サービス水準・費用・人員・席数など守る条件を指定します。" actions={<Button onClick={() => updateStudy({ constraints: [...study.constraints, { id: uniqueId('optimization-constraint'), metric: 'p90KitchenWait', operator: '<=', value: 10 }] })}>＋ Constraint</Button>}>
      <div className="editor-list">{study.constraints.map((constraint) => <div className="editor-row optimization-constraint-row" key={constraint.id}>
        <SelectField label="指標" value={constraint.metric} onChange={(event) => updateConstraint(constraint.id, { metric: event.target.value as OptimizationConstraintMetric })}>{Object.entries(constraintLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</SelectField>
        <SelectField label="条件" value={constraint.operator} onChange={(event) => updateConstraint(constraint.id, { operator: event.target.value as OptimizationConstraint['operator'] })}><option value="<=">≤</option><option value=">=">≥</option></SelectField>
        <NumberField label="基準値" suffix={rateMetrics.has(constraint.metric) ? '%' : waitMetrics.has(constraint.metric) ? '分' : yenMetrics.has(constraint.metric) ? '円' : undefined} value={rateMetrics.has(constraint.metric) ? constraint.value * 100 : constraint.value} onChange={(event) => updateConstraint(constraint.id, { value: numeric(event.target.value) / (rateMetrics.has(constraint.metric) ? 100 : 1) })}/>
        <Button variant="danger" onClick={() => updateStudy({ constraints: study.constraints.filter((item) => item.id !== constraint.id) })}>削除</Button>
      </div>)}</div>
      {study.constraints.length === 0 && <EmptyState>Constraintなし。Objectiveだけで全候補を順位付けします。</EmptyState>}
    </Panel>

    <Panel className="optimization-run-panel" title="実行前Summary" caption="入力変更だけでは実行しません。Monte Carloでは全候補に同じseed集合を使用します。" actions={<div className="optimization-run-actions">{running && <Button variant="danger" onClick={() => { cancelRef.current = true }}>キャンセル</Button>}<Button variant="primary" disabled={running || candidateCount === 0} onClick={execute}>{running ? '評価中…' : 'Optimization実行'}</Button></div>}>
      <div className="optimization-summary-grid"><div><span>Objective</span><strong>{objectiveLabels[study.objective]}</strong></div><div><span>Variables</span><strong>{study.variables.length}項目</strong></div><div><span>Constraints</span><strong>{study.constraints.length}件</strong></div><div><span>総候補数</span><strong>{candidateCount.toLocaleString('ja-JP')}通り</strong></div><div><span>評価</span><strong>{study.evaluationMode === 'monteCarlo' ? `MC ${study.monteCarloRuns} runs` : 'deterministic'}</strong></div></div>
      {running && <div className="optimization-progress"><progress max={Math.max(1, progress.total)} value={progress.completed}/><span>{progress.completed.toLocaleString('ja-JP')} / {progress.total.toLocaleString('ja-JP')}候補評価済み</span></div>}
      {runMessage && <div className="alert success"><span>{runMessage}</span></div>}
    </Panel>

    {(runResult || study.result) && <>
      <PageTitle eyebrow="CANDIDATES / TRADE-OFF" title="探索結果" description="条件内で高評価の候補です。モデル入力と探索範囲の中での比較であり、現実の唯一解ではありません。"/>
      <div className="optimization-result-kpis"><article><span>評価候補</span><strong>{(runResult?.candidateCount ?? study.result?.candidateCount ?? 0).toLocaleString('ja-JP')}</strong></article><article><span>Feasible</span><strong>{(runResult?.feasibleCount ?? study.result?.feasibleCount ?? 0).toLocaleString('ja-JP')}</strong></article><article><span>Pareto候補</span><strong>{(runResult?.paretoCandidates.length ?? study.result?.paretoCandidates.length ?? 0).toLocaleString('ja-JP')}</strong></article><article><span>共通seed</span><strong>{study.evaluationMode === 'monteCarlo' ? `${study.baseSeed}〜` : study.baseSeed}</strong></article></div>
      {(runResult?.warnings ?? []).length > 0 && <div className="capacity-warning-list">{runResult!.warnings.map((warning) => <div key={warning}><Badge tone="warning">確認</Badge><span>{warning}</span></div>)}</div>}
      <Panel title="Ranking" caption="Feasible候補を優先し、0件の場合は正規化したConstraint違反量が小さい順に表示します。" actions={<div className="optimization-filter"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>すべて</button><button className={filter === 'feasible' ? 'active' : ''} onClick={() => setFilter('feasible')}>Feasibleのみ</button><button className={filter === 'pareto' ? 'active' : ''} onClick={() => setFilter('pareto')}>Paretoのみ</button></div>}>
        <div className="resource-table-wrap"><table className="resource-table optimization-ranking"><thead><tr><th>順位</th><th>条件</th><th>平均利益</th><th>p10利益</th><th>p90待ち</th><th>離脱率</th><th>人件費</th><th>Status</th></tr></thead><tbody>{displayCandidates.slice(0, 20).map((candidate, index) => <tr key={candidate.id} className={selectedCandidate?.id === candidate.id ? 'selected' : ''} onClick={() => setSelectedCandidateId(candidate.id)}><td>{index + 1}</td><td>{Object.entries(candidate.values).map(([id, value]) => `${study.variables.find((variable) => variable.id === id)?.name ?? id}: ${value}`).join(' / ')}</td><td>{formatYen(candidate.metrics.meanOperatingProfit)}</td><td>{formatYen(candidate.metrics.p10OperatingProfit)}</td><td>{formatNumber(candidate.metrics.p90KitchenWait, 1)}分</td><td>{formatPercent(candidate.metrics.abandonmentRate)}</td><td>{formatYen(candidate.metrics.laborCost)}</td><td>{candidate.feasible ? <Badge tone="positive">Feasible</Badge> : <Badge tone="warning">違反 {candidate.constraintViolations.length}</Badge>} {candidate.pareto && <Badge tone="reference">Pareto</Badge>}</td></tr>)}</tbody></table></div>
        {displayCandidates.length === 0 && <EmptyState>この条件に該当する候補はありません。</EmptyState>}
      </Panel>

      <Panel title="Pareto Frontier" caption="横軸はp90厨房待ち（短いほど良い）、縦軸は平均営業利益（高いほど良い）。金色が他候補に全面的に劣らない候補です。"><ParetoChart candidates={(runResult?.candidates ?? savedCandidates).slice(0, 1_000)}/></Panel>

      {selectedCandidate && <Panel title="Candidate Detail" caption="Baseとの差、Constraint、境界解、設備投資の簡易回収日数を確認します。" actions={<Button variant="primary" onClick={() => saveScenario(selectedCandidate)}>Scenarioとして保存</Button>}>
        <div className="optimization-recommendation"><Badge tone={selectedCandidate.feasible ? 'positive' : 'warning'}>{selectedCandidate.feasible ? '条件内の有力候補' : '条件に最も近い候補'}</Badge><p>Base比で平均営業利益 {formatYen(selectedCandidate.metrics.meanOperatingProfit - (baseMetrics?.meanOperatingProfit ?? 0))}、p90厨房待ち {formatNumber(selectedCandidate.metrics.p90KitchenWait - (baseMetrics?.p90KitchenWait ?? 0), 1)}分、離脱率 {formatPercent(selectedCandidate.metrics.abandonmentRate - (baseMetrics?.abandonmentRate ?? 0))}です。採用判断ではPareto候補と下振れp10も併せて確認してください。</p></div>
        <div className="candidate-detail-grid">
          <div><h3>Variable / Base差</h3>{Object.entries(selectedCandidate.values).map(([id, value]) => { const variable = study.variables.find((item) => item.id === id); const base = variable ? baseVariableValue(settings, variable) : undefined; return <p key={id}><span>{variable?.name ?? id}</span><strong>{formatVariableValue(variable, base ?? '—')} → {formatVariableValue(variable, value)}</strong></p> })}</div>
          <div><h3>Performance / Base差</h3><p><span>平均営業利益</span><strong>{formatYen(selectedCandidate.metrics.meanOperatingProfit)} <small>({formatYen(selectedCandidate.metrics.meanOperatingProfit - (baseMetrics?.meanOperatingProfit ?? 0))})</small></strong></p><p><span>p90厨房待ち</span><strong>{formatNumber(selectedCandidate.metrics.p90KitchenWait, 1)}分 <small>({formatNumber(selectedCandidate.metrics.p90KitchenWait - (baseMetrics?.p90KitchenWait ?? 0), 1)}分)</small></strong></p><p><span>Realized Sales</span><strong>{formatNumber(selectedCandidate.metrics.realizedSales)}食</strong></p><p><span>離脱率</span><strong>{formatPercent(selectedCandidate.metrics.abandonmentRate)}</strong></p></div>
          <div><h3>Investment / Risk</h3><p><span>設備変更初期投資</span><strong>{formatYen(selectedCandidate.investmentCost)}</strong></p><p><span>回収営業日数</span><strong>{selectedCandidate.investmentCost === 0 ? '投資設定なし' : selectedCandidate.paybackOperatingDays === null ? '回収不可' : `${formatNumber(selectedCandidate.paybackOperatingDays, 1)}日`}</strong></p><p><span>下振れp10利益</span><strong>{formatYen(selectedCandidate.metrics.p10OperatingProfit)}</strong></p></div>
        </div>
        {selectedCandidate.constraintViolations.length > 0 && <div className="constraint-violation-list"><h3>Constraint違反</h3>{selectedCandidate.constraintViolations.map((violation) => <p key={violation.constraintId}><Badge tone="warning">Infeasible</Badge><span>{constraintLabels[violation.metric]}: 実績 {formatConstraintValue(violation.metric, violation.actual)} / 条件 {violation.operator} {formatConstraintValue(violation.metric, violation.limit)}</span></p>)}</div>}
        {selectedCandidate.boundaryVariables.length > 0 && <div className="calculation-note"><Badge tone="warning">境界解</Badge><span>{selectedCandidate.boundaryVariables.map((boundary) => `${study.variables.find((variable) => variable.id === boundary.variableId)?.name ?? boundary.variableId}が${boundary.edge === 'max' ? '上限' : '下限'}`).join('、')}です。探索範囲外でさらに改善する可能性があります。</span></div>}
        {selectedCandidate.warnings.map((warning) => <div className="calculation-note" key={warning}><Badge tone="warning">確認</Badge><span>{warning}</span></div>)}
      </Panel>}
    </>}
  </>
}
