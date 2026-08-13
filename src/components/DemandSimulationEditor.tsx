import { useId, useMemo, useState } from 'react'
import { generateSeed } from '../calculations/demandEngine'
import { compareMonteCarloScenariosAsync, runMonteCarloAsync } from '../calculations/monteCarloEngine'
import { simulateCustomerJourney } from '../calculations/seatingEngine'
import type {
  AppSettings,
  ArrivalTimeSlot,
  MonteCarloResult,
  MonteCarloScenarioComparison,
  PartySizeProbability,
  SeatingUnit,
  StochasticDemandSettings,
} from '../models/types'
import { formatNumber, formatPercent, formatYen } from '../utils/format'
import { validateSettings } from '../validation/settingsValidation'
import { Badge, Button, NumberField, PageTitle, Panel, SelectField, TextField, Toggle } from './ui'

type Props = { settings: AppSettings; onChange: (settings: AppSettings) => void }

let idSequence = 0
const uniqueId = (prefix: string) => `${prefix}-${Date.now()}-${idSequence += 1}`
const valueNumber = (value: string) => Number.isFinite(Number(value)) ? Number(value) : 0

const ProfitHistogram = ({ result }: { result: MonteCarloResult }) => {
  const gradientId = useId().replaceAll(':', '')
  const values = result.summaries.map((run) => run.operatingProfit)
  const minimum = Math.min(...values)
  const maximum = Math.max(...values)
  const bucketCount = Math.min(12, Math.max(5, Math.ceil(Math.sqrt(values.length))))
  const widthValue = Math.max(1, (maximum - minimum) / bucketCount)
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    start: minimum + index * widthValue,
    end: index === bucketCount - 1 ? maximum : minimum + (index + 1) * widthValue,
    count: 0,
  }))
  values.forEach((value) => {
    const index = Math.min(bucketCount - 1, Math.floor((value - minimum) / widthValue))
    buckets[index].count += 1
  })
  const width = 860
  const height = 260
  const pad = { top: 22, right: 24, bottom: 48, left: 54 }
  const innerWidth = width - pad.left - pad.right
  const innerHeight = height - pad.top - pad.bottom
  const barWidth = innerWidth / buckets.length
  const maxCount = Math.max(1, ...buckets.map((bucket) => bucket.count))
  return <div className="chart-wrap monte-histogram"><svg role="img" aria-label="営業利益分布ヒストグラム" viewBox={`0 0 ${width} ${height}`}>
    <defs><linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#355f50"/><stop offset="1" stopColor="#7da08d"/></linearGradient></defs>
    {buckets.map((bucket, index) => {
      const barHeight = bucket.count / maxCount * innerHeight
      return <g key={bucket.start}><rect x={pad.left + index * barWidth + 2} y={pad.top + innerHeight - barHeight} width={Math.max(1, barWidth - 4)} height={barHeight} rx="3" fill={`url(#${gradientId})`}/><text className="axis-label" x={pad.left + (index + 0.5) * barWidth} y={height - 20} textAnchor="middle">{index % 2 === 0 ? `${Math.round(bucket.start / 1_000)}k` : ''}</text><text className="axis-label" x={pad.left + (index + 0.5) * barWidth} y={Math.max(14, pad.top + innerHeight - barHeight - 6)} textAnchor="middle">{bucket.count}</text></g>
    })}
    <line className="zero-line" x1={pad.left} x2={width - pad.right} y1={pad.top + innerHeight} y2={pad.top + innerHeight}/>
  </svg></div>
}

const SingleRunDashboard = ({ settings, seed }: { settings: AppSettings; seed: number }) => {
  const result = useMemo(() => simulateCustomerJourney(settings, seed), [settings, seed])
  return <>
    <div className="journey-kpi-grid">
      <article><span>潜在 / 実来店</span><strong>{formatNumber(result.potentialGuests, 0)} / {result.arrivedGuests}人</strong><small>{result.arrivedParties} Party</small></article>
      <article><span>着席 / 離脱</span><strong>{result.seatedGuests} / {result.abandonedGuests}人</strong><small>離脱率 {formatPercent(result.abandonmentRate)}</small></article>
      <article><span>Realized Sales</span><strong>{result.realizedSalesMeals}食</strong><small>{formatYen(result.economic.realizedRevenue)}</small></article>
      <article><span>実現営業利益</span><strong>{formatYen(result.economic.realizedOperatingProfit)}</strong><small>需要仮定 {formatYen(result.economic.demandOperatingProfit)}</small></article>
      <article><span>平均着席待ち</span><strong>{formatNumber(result.averageSeatingWaitMinutes, 1)}分</strong><small>p90 {formatNumber(result.p90SeatingWaitMinutes, 1)}分</small></article>
      <article><span>平均厨房待ち</span><strong>{formatNumber(result.averageKitchenWaitMinutes, 1)}分</strong><small>p90 {formatNumber(result.p90KitchenWaitMinutes, 1)}分</small></article>
      <article><span>p90総待ち</span><strong>{formatNumber(result.p90TotalWaitMinutes, 1)}分</strong><small>到着から全品提供</small></article>
      <article><span>Seat utilization</span><strong>{formatPercent(result.seatUtilization)}</strong><small>回転 {formatNumber(result.seatTurnover, 2)}回 / 席</small></article>
    </div>
    <Panel title="Customer Journey Funnel" caption={`Single Run seed ${seed}`}>
      <div className="journey-funnel"><div><span>来店</span><strong>{result.arrivedGuests}</strong></div><i>→</i><div><span>着席</span><strong>{result.seatedGuests}</strong></div><i>→</i><div><span>注文</span><strong>{result.orderedGuests}</strong></div><i>→</i><div><span>厨房完了</span><strong>{result.kitchenCompletedGuests}</strong></div><i>→</i><div><span>売上</span><strong>{result.realizedSalesMeals}</strong></div></div>
    </Panel>
    {result.warnings.length > 0 && <div className="capacity-warning-list">{result.warnings.map((warning) => <div key={warning}><Badge tone="warning">候補</Badge><span>{warning}</span></div>)}</div>}
    <div className="capacity-util-grid">
      <Panel title="SeatingUnit別回転・利用" caption={`空席損失 ${formatNumber(result.unusedSeatMinutes, 0)} seat-minutes`}>
        <div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>客席</th><th>Party</th><th>回転</th><th>Unit利用</th><th>Seat利用</th><th>空席損失</th></tr></thead><tbody>{result.seatingUtilization.map((item) => <tr key={item.seatingUnitId}><td>{item.name}</td><td>{item.seatedParties}</td><td>{formatNumber(item.turnover, 2)}</td><td>{formatPercent(item.unitUtilization)}</td><td>{formatPercent(item.seatUtilization)}</td><td>{formatNumber(item.unusedSeatMinutes, 0)}分</td></tr>)}</tbody></table></div>
      </Panel>
      <Panel title="客席 / 厨房Queue" caption="客席側と厨房側を別指標で確認します。"><div className="journey-queue-summary"><div><span>最大着席Queue</span><strong>{result.maxSeatingQueueParties} Party / {result.maxSeatingQueueGuests}人</strong><small>{result.maxSeatingQueueTime}</small></div><div><span>最大Kitchen Queue</span><strong>{result.capacity.maxQueueLength}食</strong><small>{result.capacity.maxQueueTime}</small></div><div><span>最終提供 / 最終退店</span><strong>{result.capacity.finalCompletionTime}</strong><small>{result.finalDepartureTime}</small></div></div></Panel>
    </div>
    <details className="calculation-details party-inspector"><summary><span>Single Run Party / Queue Inspector</span><small>{result.parties.length} Party · 離脱 {result.abandonedParties}</small></summary><div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>Party</th><th>人数</th><th>来店</th><th>着席</th><th>注文</th><th>提供</th><th>退店</th><th>状態</th></tr></thead><tbody>{result.parties.map((party) => <tr key={party.id}><td>{party.id}</td><td>{party.size}</td><td>{party.arrivalTime}</td><td>{party.seatedTime ?? '—'}</td><td>{party.orderTime ?? '—'}</td><td>{party.servedTime ?? '—'}</td><td>{party.departureTime ?? party.abandonmentTime ?? '—'}</td><td>{party.state}{party.abandonmentReason ? ` (${party.abandonmentReason})` : ''}</td></tr>)}</tbody></table></div><div className="queue-inspector-grid"><div><h3>着席Queue推移</h3><div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>時刻</th><th>Party</th><th>人数</th></tr></thead><tbody>{result.seatingQueueTimeline.map((point) => <tr key={`${point.minute}-${point.partyCount}`}><td>{point.time}</td><td>{point.partyCount}</td><td>{point.guestCount}</td></tr>)}</tbody></table></div></div><div><h3>Kitchen Queue推移</h3><div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>時刻</th><th>待機食数</th></tr></thead><tbody>{result.capacity.queueTimeline.map((point) => <tr key={`${point.minute}-${point.queueLength}`}><td>{point.time}</td><td>{point.queueLength}</td></tr>)}</tbody></table></div></div></div></details>
  </>
}

export const DemandSimulationEditor = ({ settings, onChange }: Props) => {
  const stochastic = settings.capacity.stochasticDemand
  const [monteCarlo, setMonteCarlo] = useState<MonteCarloResult>()
  const [scenarioComparison, setScenarioComparison] = useState<MonteCarloScenarioComparison[]>()
  const [inspectorSeed, setInspectorSeed] = useState(stochastic.seed)
  const [singleRunRevision, setSingleRunRevision] = useState(0)
  const [running, setRunning] = useState(false)
  const [runProgress, setRunProgress] = useState('')
  const [runError, setRunError] = useState('')
  const updateStochastic = (patch: Partial<StochasticDemandSettings>) => onChange({
    ...settings,
    capacity: { ...settings.capacity, stochasticDemand: { ...stochastic, ...patch, isReferenceDemand: false } },
  })
  const updateArrival = (id: string, patch: Partial<ArrivalTimeSlot>) => updateStochastic({ arrivalProfile: { ...stochastic.arrivalProfile, slots: stochastic.arrivalProfile.slots.map((slot) => slot.id === id ? { ...slot, ...patch } : slot) } })
  const updatePartySize = (index: number, patch: Partial<PartySizeProbability>) => updateStochastic({ partySizeDistribution: stochastic.partySizeDistribution.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) })
  const updateSeating = (id: string, patch: Partial<SeatingUnit>) => updateStochastic({ seatingUnits: stochastic.seatingUnits.map((unit) => unit.id === id ? { ...unit, ...patch } : unit) })
  const issues = validateSettings(settings).filter((item) => item.path?.startsWith('capacity.stochasticDemand') || item.code === 'reference-demand-seating')
  const executeMonteCarlo = (compareScenarios: boolean) => {
    setRunning(true)
    setRunError('')
    setRunProgress(compareScenarios ? 'Scenarioを計算中' : '準備中')
    window.setTimeout(async () => {
      try {
        if (compareScenarios) setScenarioComparison(await compareMonteCarloScenariosAsync(settings, stochastic.monteCarlo.runs, stochastic.monteCarlo.baseSeed))
        else {
          const result = await runMonteCarloAsync(settings, stochastic.monteCarlo.runs, stochastic.monteCarlo.baseSeed, (completed, total) => setRunProgress(`${completed} / ${total} run`))
          setMonteCarlo(result)
          setInspectorSeed(result.medianProfitSeed)
        }
      } catch (error) {
        setRunError(error instanceof Error ? error.message : 'Monte Carloを実行できませんでした。')
      } finally {
        setRunning(false)
        setRunProgress('')
      }
    }, 0)
  }

  return <>
    <PageTitle eyebrow="STOCHASTIC DEMAND / SEATING" title="来店・客席・Monte Carlo" description="来客数、Party構成、着席待ち、離脱、厨房提供、退店までをseed付きで追跡し、平均だけでなく下振れ側を確認します。"/>
    {issues.length > 0 && <div className="capacity-warning-list">{issues.map((item, index) => <div key={`${item.code}-${index}`}><Badge tone={item.severity === 'error' ? 'warning' : 'reference'}>{item.severity === 'error' ? 'Error' : 'Warning'}</Badge><span>{item.message}</span></div>)}</div>}
    <Panel title="Simulation mode / Seed" caption="deterministicはPhase 5の均等配置、stochasticはseed付き来店・客席モデルです。"><div className="form-grid form-grid-3"><SelectField label="需要モード" value={settings.capacity.demandMode} onChange={(event) => onChange({ ...settings, capacity: { ...settings.capacity, demandMode: event.target.value as AppSettings['capacity']['demandMode'] } })}><option value="deterministic">deterministic（Phase 5）</option><option value="stochastic">stochastic（Phase 6）</option></SelectField><NumberField label="Single Run seed" value={stochastic.seed} onChange={(event) => updateStochastic({ seed: Math.trunc(valueNumber(event.target.value)) })}/><div className="field"><span className="field-label">Seed操作</span><div className="seed-actions"><Button onClick={() => setSingleRunRevision((revision) => revision + 1)}>同じseedで再実行</Button><Button variant="primary" onClick={() => { const seed = generateSeed(); updateStochastic({ seed }); setInspectorSeed(seed); setSingleRunRevision((revision) => revision + 1) }}>新しいseed</Button></div></div></div></Panel>

    {settings.capacity.demandMode === 'deterministic' ? <div className="alert success"><span>Phase 5 deterministic modeです。「厨房能力」画面の均等配置結果を使用します。stochastic設定は保存されていますが通常計算へ混在しません。</span></div> : <SingleRunDashboard key={`${stochastic.seed}-${singleRunRevision}`} settings={settings} seed={stochastic.seed}/>}

    <PageTitle eyebrow="ARRIVAL / PARTY" title="来店需要・Party構成" description="expectedGuestsはParty数ではなく時間帯の平均来店人数です。Poissonではrunごとの人数も変動します。"/>
    <Panel title="ArrivalProfile" caption="uniformはParty時刻をランダム均等配置、poissonは指数分布の到着間隔です。" actions={<Button onClick={() => updateStochastic({ arrivalProfile: { ...stochastic.arrivalProfile, slots: [...stochastic.arrivalProfile.slots, { id: uniqueId('arrival'), startTime: settings.business.openingTime, endTime: settings.business.closingTime, expectedGuests: 0, arrivalDistribution: 'uniform' }] } })}>＋ 時間帯</Button>}><div className="editor-list">{stochastic.arrivalProfile.slots.map((slot) => <div className="editor-row arrival-slot-row" key={slot.id}><label>開始<input type="time" value={slot.startTime} onChange={(event) => updateArrival(slot.id, { startTime: event.target.value })}/></label><label>終了<input type="time" value={slot.endTime} onChange={(event) => updateArrival(slot.id, { endTime: event.target.value })}/></label><NumberField label="平均来店人数" suffix="人" min={0} value={slot.expectedGuests} onChange={(event) => updateArrival(slot.id, { expectedGuests: valueNumber(event.target.value) })}/><SelectField label="到着分布" value={slot.arrivalDistribution} onChange={(event) => updateArrival(slot.id, { arrivalDistribution: event.target.value as ArrivalTimeSlot['arrivalDistribution'] })}><option value="uniform">uniform</option><option value="poisson">poisson</option></SelectField><Button variant="danger" onClick={() => updateStochastic({ arrivalProfile: { ...stochastic.arrivalProfile, slots: stochastic.arrivalProfile.slots.filter((item) => item.id !== slot.id) } })}>削除</Button></div>)}</div></Panel>
    <Panel title="Party Size Distribution" caption={`確率合計 ${formatNumber(stochastic.partySizeDistribution.reduce((sum, item) => sum + item.probability, 0), 1)}%`} actions={<Button onClick={() => updateStochastic({ partySizeDistribution: [...stochastic.partySizeDistribution, { size: (stochastic.partySizeDistribution.at(-1)?.size ?? 0) + 1, probability: 0 }] })}>＋ 人数区分</Button>}><div className="party-probability-grid">{stochastic.partySizeDistribution.map((item, index) => <article key={`${item.size}-${index}`}><NumberField label="Party人数" suffix="人" min={1} value={item.size} onChange={(event) => updatePartySize(index, { size: valueNumber(event.target.value) })}/><NumberField label="確率" suffix="%" min={0} value={item.probability} onChange={(event) => updatePartySize(index, { probability: valueNumber(event.target.value) })}/><Button variant="danger" onClick={() => updateStochastic({ partySizeDistribution: stochastic.partySizeDistribution.filter((_, itemIndex) => itemIndex !== index) })}>削除</Button></article>)}</div></Panel>

    <PageTitle eyebrow="SEATING / TURNOVER" title="客席・滞在" description="Partyは分割せず、収容可能な空席のうち最小容量へ案内します。待ち列では収容可能な最古Partyを選びます。"/>
    <Panel title="Seating Units" actions={<Button onClick={() => updateStochastic({ seatingUnits: [...stochastic.seatingUnits, { id: uniqueId('seat'), name: '新しいテーブル', capacity: 2, count: 1, category: 'table', enabled: true }] })}>＋ 客席</Button>}><div className="capacity-card-grid">{stochastic.seatingUnits.map((unit) => <article className="editor-card" key={unit.id}><div className="form-grid form-grid-2"><TextField label="名称" value={unit.name} onChange={(event) => updateSeating(unit.id, { name: event.target.value })}/><SelectField label="種類" value={unit.category} onChange={(event) => updateSeating(unit.id, { category: event.target.value as SeatingUnit['category'] })}><option value="counter">カウンター</option><option value="table">テーブル</option></SelectField><NumberField label="1席・卓の容量" suffix="人" min={1} value={unit.capacity} onChange={(event) => updateSeating(unit.id, { capacity: valueNumber(event.target.value) })}/><NumberField label="席・卓数" suffix="台" min={0} value={unit.count} onChange={(event) => updateSeating(unit.id, { count: valueNumber(event.target.value) })}/></div><div className="card-actions"><Toggle checked={unit.enabled} label="有効" onChange={(enabled) => updateSeating(unit.id, { enabled })}/><Button variant="danger" onClick={() => updateStochastic({ seatingUnits: stochastic.seatingUnits.filter((item) => item.id !== unit.id) })}>削除</Button></div></article>)}</div></Panel>
    <Panel title="Order Delay / Dwell / Abandonment"><div className="form-grid form-grid-4"><SelectField label="注文遅延分布" value={stochastic.orderDelay.distribution} onChange={(event) => updateStochastic({ orderDelay: { ...stochastic.orderDelay, distribution: event.target.value as StochasticDemandSettings['orderDelay']['distribution'] } })}><option value="fixed">fixed</option><option value="uniform">uniform</option></SelectField><NumberField label="注文まで" suffix="分" min={0} value={stochastic.orderDelay.meanMinutes} onChange={(event) => updateStochastic({ orderDelay: { ...stochastic.orderDelay, meanMinutes: valueNumber(event.target.value), minMinutes: stochastic.orderDelay.distribution === 'fixed' ? valueNumber(event.target.value) : stochastic.orderDelay.minMinutes, maxMinutes: stochastic.orderDelay.distribution === 'fixed' ? valueNumber(event.target.value) : stochastic.orderDelay.maxMinutes } })}/><NumberField label="注文遅延 min" suffix="分" min={0} disabled={stochastic.orderDelay.distribution === 'fixed'} value={stochastic.orderDelay.minMinutes} onChange={(event) => updateStochastic({ orderDelay: { ...stochastic.orderDelay, minMinutes: valueNumber(event.target.value) } })}/><NumberField label="注文遅延 max" suffix="分" min={0} disabled={stochastic.orderDelay.distribution === 'fixed'} value={stochastic.orderDelay.maxMinutes} onChange={(event) => updateStochastic({ orderDelay: { ...stochastic.orderDelay, maxMinutes: valueNumber(event.target.value) } })}/><SelectField label="滞在時間分布" value={stochastic.dwellTime.distribution} onChange={(event) => updateStochastic({ dwellTime: { ...stochastic.dwellTime, distribution: event.target.value as StochasticDemandSettings['dwellTime']['distribution'] } })}><option value="fixed">fixed</option><option value="uniform">uniform</option></SelectField><NumberField label="食事・滞在" suffix="分" min={0.01} value={stochastic.dwellTime.meanMinutes} onChange={(event) => updateStochastic({ dwellTime: { ...stochastic.dwellTime, meanMinutes: valueNumber(event.target.value), minMinutes: stochastic.dwellTime.distribution === 'fixed' ? valueNumber(event.target.value) : stochastic.dwellTime.minMinutes, maxMinutes: stochastic.dwellTime.distribution === 'fixed' ? valueNumber(event.target.value) : stochastic.dwellTime.maxMinutes } })}/><NumberField label="滞在 min" suffix="分" min={0.01} disabled={stochastic.dwellTime.distribution === 'fixed'} value={stochastic.dwellTime.minMinutes} onChange={(event) => updateStochastic({ dwellTime: { ...stochastic.dwellTime, minMinutes: valueNumber(event.target.value) } })}/><NumberField label="滞在 max" suffix="分" min={0.01} disabled={stochastic.dwellTime.distribution === 'fixed'} value={stochastic.dwellTime.maxMinutes} onChange={(event) => updateStochastic({ dwellTime: { ...stochastic.dwellTime, maxMinutes: valueNumber(event.target.value) } })}/><NumberField label="最大着席待ち" suffix="分" min={0} value={stochastic.maxSeatingWaitMinutes} onChange={(event) => updateStochastic({ maxSeatingWaitMinutes: valueNumber(event.target.value) })}/></div></Panel>

    <PageTitle eyebrow="MONTE CARLO / RISK" title="Monte Carlo" description="入力中は自動再計算せず、実行ボタンで指定seed集合をまとめて計算します。最大1,000 runです。"/>
    <Panel title="実行条件"><div className="form-grid form-grid-4"><SelectField label="Run数" value={stochastic.monteCarlo.runs} onChange={(event) => updateStochastic({ monteCarlo: { ...stochastic.monteCarlo, runs: valueNumber(event.target.value) } })}>{[10, 50, 100, 500, 1000].map((runs) => <option key={runs} value={runs}>{runs}</option>)}</SelectField><NumberField label="Base seed" value={stochastic.monteCarlo.baseSeed} onChange={(event) => updateStochastic({ monteCarlo: { ...stochastic.monteCarlo, baseSeed: Math.trunc(valueNumber(event.target.value)) } })}/><NumberField label="目標営業利益" suffix="円 / 日" value={stochastic.monteCarlo.targetProfit} onChange={(event) => updateStochastic({ monteCarlo: { ...stochastic.monteCarlo, targetProfit: valueNumber(event.target.value) } })}/><NumberField label="目標Service Level" suffix="%" min={0} max={100} value={stochastic.monteCarlo.targetServiceLevelRate * 100} onChange={(event) => updateStochastic({ monteCarlo: { ...stochastic.monteCarlo, targetServiceLevelRate: valueNumber(event.target.value) / 100 } })}/></div><div className="monte-actions"><Button variant="primary" disabled={running} onClick={() => executeMonteCarlo(false)}>{running ? runProgress || '計算中…' : 'Monte Carlo実行'}</Button><Button disabled={running || settings.scenarios.length === 0} onClick={() => executeMonteCarlo(true)}>共通seedでScenario比較</Button></div>{runError && <div className="alert error"><span>{runError}</span></div>}</Panel>
    {monteCarlo && <>
      <div className="monte-kpi-grid"><article><span>平均営業利益</span><strong>{formatYen(monteCarlo.statistics.operatingProfit.mean)}</strong><small>中央値 {formatYen(monteCarlo.statistics.operatingProfit.median)}</small></article><article><span>p10 / p90利益</span><strong>{formatYen(monteCarlo.statistics.operatingProfit.p10)}</strong><small>{formatYen(monteCarlo.statistics.operatingProfit.p90)}</small></article><article><span>赤字Run率</span><strong>{formatPercent(monteCarlo.lossRunRate)}</strong><small>{monteCarlo.runs} run</small></article><article><span>目標利益達成率</span><strong>{formatPercent(monteCarlo.targetProfitProbability)}</strong><small>{formatYen(stochastic.monteCarlo.targetProfit)}以上</small></article><article><span>Service Level達成率</span><strong>{formatPercent(monteCarlo.serviceLevelProbability)}</strong><small>許容内提供率 {formatPercent(stochastic.monteCarlo.targetServiceLevelRate)}以上</small></article><article><span>平均離脱率</span><strong>{formatPercent(monteCarlo.statistics.abandonmentRate.mean)}</strong><small>p90 {formatPercent(monteCarlo.statistics.abandonmentRate.p90)}</small></article></div>
      <Panel title="営業利益分布" caption="棒の高さは該当利益帯のrun数です。"><ProfitHistogram result={monteCarlo}/></Panel>
      <Panel title="Monte Carlo指標" caption="percentileはソート済みrun間の線形補間です。"><div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>指標</th><th>平均</th><th>中央値</th><th>p10</th><th>p90</th><th>min</th><th>max</th></tr></thead><tbody>{([
        ['営業利益', monteCarlo.statistics.operatingProfit, 'yen'], ['Realized Sales', monteCarlo.statistics.realizedSalesMeals, 'number'], ['来店人数', monteCarlo.statistics.arrivedGuests, 'number'], ['離脱率', monteCarlo.statistics.abandonmentRate, 'percent'], ['着席待ち', monteCarlo.statistics.seatingWait, 'minutes'], ['厨房待ち', monteCarlo.statistics.kitchenWait, 'minutes'],
      ] as const).map(([label, stats, type]) => { const display = (value: number) => type === 'yen' ? formatYen(value) : type === 'percent' ? formatPercent(value) : type === 'minutes' ? `${formatNumber(value, 1)}分` : formatNumber(value, 1); return <tr key={label}><td><strong>{label}</strong></td><td>{display(stats.mean)}</td><td>{display(stats.median)}</td><td>{display(stats.p10)}</td><td>{display(stats.p90)}</td><td>{display(stats.min)}</td><td>{display(stats.max)}</td></tr> })}</tbody></table></div></Panel>
      <Panel title="代表Run Inspector" caption="p10・中央値・p90営業利益に最も近いseedを再実行できます。"><div className="representative-runs"><Button onClick={() => setInspectorSeed(monteCarlo.lowProfitSeed)}>低利益ケース · {monteCarlo.lowProfitSeed}</Button><Button onClick={() => setInspectorSeed(monteCarlo.medianProfitSeed)}>中央値付近 · {monteCarlo.medianProfitSeed}</Button><Button onClick={() => setInspectorSeed(monteCarlo.highProfitSeed)}>高利益ケース · {monteCarlo.highProfitSeed}</Button><SelectField label="全run" value={inspectorSeed} onChange={(event) => setInspectorSeed(valueNumber(event.target.value))}>{monteCarlo.summaries.map((run) => <option key={run.seed} value={run.seed}>#{run.runIndex + 1} seed {run.seed} · {formatYen(run.operatingProfit)}</option>)}</SelectField></div></Panel>
      <PageTitle eyebrow="RUN INSPECTOR" title={`Seed ${inspectorSeed}`} description="集計値だけでなく、選択runのParty・離脱・客席Queue・Kitchen Queueを再現します。"/>
      <SingleRunDashboard settings={settings} seed={inspectorSeed}/>
    </>}
    {scenarioComparison && <Panel title="Monte Carlo Scenario共通seed比較" caption="Baseと各Scenarioのrun indexへ同じseedを割り当てます。"><div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>Scenario</th><th>平均利益</th><th>平均差</th><th>p10利益</th><th>p10差</th><th>平均離脱率</th><th>離脱率差</th><th>総待ち差</th></tr></thead><tbody>{scenarioComparison.map((row) => <tr key={row.id}><td><strong>{row.name}</strong></td><td>{formatYen(row.result.statistics.operatingProfit.mean)}</td><td>{formatYen(row.meanProfitDifference)}</td><td>{formatYen(row.result.statistics.operatingProfit.p10)}</td><td>{formatYen(row.p10ProfitDifference)}</td><td>{formatPercent(row.result.statistics.abandonmentRate.mean)}</td><td>{formatPercent(row.abandonmentRateDifference)}</td><td>{formatNumber(row.totalWaitDifference, 1)}分</td></tr>)}</tbody></table></div></Panel>}
    <div className="calculation-note"><Badge>日次近似</Badge><span>Realized SalesのMenu Mixと提供食数を既存Economic / Inventory Engineへ日単位で渡します。Inventoryの分単位消費と厨房工程時間の乱数化は未実装です。</span></div>
  </>
}
