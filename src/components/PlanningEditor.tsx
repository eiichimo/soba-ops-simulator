import { useMemo, useRef, useState } from 'react'
import { runMultiDayMonteCarloAsync, simulateMultiDay } from '../calculations/multiDayEngine'
import type { AppSettings, DailyOperatingPlan, MultiDayMonteCarloResult, MultiDaySimulationResult, PlanningSettings, PurchaseOrder } from '../models/types'
import { formatNumber, formatPercent, formatYen } from '../utils/format'
import { Badge, Button, NumberField, PageTitle, Panel, SelectField, TextField, Toggle } from './ui'

type Props = { settings: AppSettings; onChange: (settings: AppSettings) => void }
const dayNames = ['月', '火', '水', '木', '金', '土', '日']
const numeric = (value: string) => Number.isFinite(Number(value)) ? Number(value) : 0
const addDays = (value: string, days: number) => {
  const date = new Date(`${value}T00:00:00`)
  date.setDate(date.getDate() + days)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export const PlanningEditor = ({ settings, onChange }: Props) => {
  const [result, setResult] = useState<MultiDaySimulationResult>()
  const [monteCarlo, setMonteCarlo] = useState<MultiDayMonteCarloResult>()
  const [progress, setProgress] = useState<{ completed: number; total: number }>()
  const [message, setMessage] = useState<string>()
  const [selectedResourceId, setSelectedResourceId] = useState(settings.resources[0]?.id ?? '')
  const [orderResourceId, setOrderResourceId] = useState(settings.resources[0]?.id ?? '')
  const cancelled = useRef(false)
  const planning = settings.planning
  const updatePlanning = (patch: Partial<PlanningSettings>) => onChange({ ...settings, planning: { ...planning, ...patch } })
  const updateDaily = (id: string, patch: Partial<DailyOperatingPlan>) => updatePlanning({
    dailyOperatingPlans: planning.dailyOperatingPlans.map((plan) => plan.id === id ? { ...plan, ...patch } : plan),
  })

  const runPlan = () => {
    setMessage(undefined)
    setProgress({ completed: 0, total: planning.horizonDays })
    try {
      setResult(simulateMultiDay(settings, { horizonDays: planning.horizonDays, onProgress: (completed, total) => setProgress({ completed, total }) }))
      setMonteCarlo(undefined)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '運営計画を計算できませんでした。')
    } finally {
      setProgress(undefined)
    }
  }

  const runMonteCarlo = async () => {
    cancelled.current = false
    setMessage(undefined)
    setProgress({ completed: 0, total: planning.monteCarloRuns })
    try {
      const next = await runMultiDayMonteCarloAsync(
        settings,
        planning.monteCarloRuns,
        planning.baseSeed,
        planning.horizonDays,
        (completed, total) => setProgress({ completed, total }),
        () => cancelled.current,
      )
      setMonteCarlo(next)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Monte Carloを計算できませんでした。')
    } finally {
      setProgress(undefined)
    }
  }

  const selectedTimeline = useMemo(() => result?.inventoryTimeline.filter((row) => row.sourceId === selectedResourceId) ?? [], [result, selectedResourceId])
  const addDailyOverride = () => {
    const date = addDays(settings.business.simulationStartDate, planning.dailyOperatingPlans.length)
    updatePlanning({ dailyOperatingPlans: [...planning.dailyOperatingPlans, { id: `daily-plan-${Date.now()}`, date, name: '日付Override' }] })
  }
  const addPurchaseOrder = () => {
    const resource = settings.resources.find((item) => item.id === orderResourceId)
    if (!resource) return
    const packages = Math.max(1, resource.minimumPurchaseLot)
    const orderedDate = settings.business.simulationStartDate
    const deliveryDate = addDays(orderedDate, Math.max(0, resource.procurementLeadTimeDays ?? 0))
    const order: PurchaseOrder = {
      id: `purchase-plan-${Date.now()}`,
      resourceId: resource.id,
      orderedDate,
      deliveryDate,
      packageCount: packages,
      quantity: packages * resource.purchaseQuantity * resource.yieldRate,
      cost: packages * resource.purchasePrice,
      status: 'planned',
    }
    updatePlanning({ purchaseOrders: [...planning.purchaseOrders, order] })
  }

  return <>
    <PageTitle eyebrow="MULTI-DAY STATE / WEEKLY PLANNING" title="運営計画" description="在庫Lot・仕込品・賞味期限・未入荷注文を翌日へ渡し、日別判断ではなく期間全体を連続評価します。" actions={<div className="page-action-row"><Button variant="primary" onClick={runPlan}>計画を実行</Button><Button onClick={runMonteCarlo}>Monte Carlo</Button>{progress && <Button variant="danger" onClick={() => { cancelled.current = true }}>キャンセル</Button>}</div>}/>
    {message && <div className="alert error">{message}</div>}
    {progress && <div className="alert"><b>{progress.completed} / {progress.total}</b> {monteCarlo ? 'runs' : '日'} を評価中です。</div>}

    <Panel title="Planning Horizon" caption="7日を標準とし、休業日も日付・賞味期限・入荷状態を進めます。">
      <div className="form-grid form-grid-4">
        <SelectField label="期間Preset" value={String([7, 14, 30].includes(planning.horizonDays) ? planning.horizonDays : 'custom')} onChange={(event) => event.target.value !== 'custom' && updatePlanning({ horizonDays: numeric(event.target.value) })}>
          <option value="7">7日</option><option value="14">14日</option><option value="30">30日</option><option value="custom">カスタム</option>
        </SelectField>
        <NumberField label="Horizon" suffix="日" min={1} max={planning.hardMaximumDays} value={planning.horizonDays} onChange={(event) => updatePlanning({ horizonDays: numeric(event.target.value) })}/>
        <NumberField label="Monte Carlo runs" suffix="runs" min={1} max={1000} value={planning.monteCarloRuns} onChange={(event) => updatePlanning({ monteCarloRuns: numeric(event.target.value) })}/>
        <NumberField label="Base seed" value={planning.baseSeed} onChange={(event) => updatePlanning({ baseSeed: numeric(event.target.value) })}/>
        <NumberField label="目標期間利益" suffix="円" value={planning.targetProfit} onChange={(event) => updatePlanning({ targetProfit: numeric(event.target.value) })}/>
        <NumberField label="仕込みactive上限" suffix="分/日" min={0} value={planning.maxPrepActiveLaborMinutesPerDay ?? 0} onChange={(event) => updatePlanning({ maxPrepActiveLaborMinutesPerDay: numeric(event.target.value) })}/>
      </div>
    </Panel>

    <Panel title="曜日別 Operating Plan" caption="Base営業条件へ曜日Templateを重ねます。StaffはShift単位、需要は食数単位でOverrideします。">
      <div className="weekday-grid planning-weekday-grid">
        {planning.weekdayTemplates.map((template, index) => <div className={template.enabled === false ? 'weekday-card' : 'weekday-card enabled'} key={template.day}>
          <Toggle label={dayNames[template.day]} checked={template.enabled !== false} onChange={(enabled) => updatePlanning({ weekdayTemplates: planning.weekdayTemplates.map((item, itemIndex) => itemIndex === index ? { ...item, enabled } : item) })}/>
          <div className="weekday-times"><input type="time" value={template.openingTime ?? settings.business.openingTime} onChange={(event) => updatePlanning({ weekdayTemplates: planning.weekdayTemplates.map((item, itemIndex) => itemIndex === index ? { ...item, openingTime: event.target.value } : item) })}/><span>–</span><input type="time" value={template.closingTime ?? settings.business.closingTime} onChange={(event) => updatePlanning({ weekdayTemplates: planning.weekdayTemplates.map((item, itemIndex) => itemIndex === index ? { ...item, closingTime: event.target.value } : item) })}/></div>
          <label className="mini-field">需要<input type="number" min="0" value={template.mealsPerDay ?? settings.business.mealsPerDay} onChange={(event) => updatePlanning({ weekdayTemplates: planning.weekdayTemplates.map((item, itemIndex) => itemIndex === index ? { ...item, mealsPerDay: numeric(event.target.value) } : item) })}/><span>食</span></label>
          {settings.capacity.staffShifts.map((shift) => <label className="mini-field" key={shift.id}>{shift.name}<input type="number" min="0" value={template.staffHeadcountOverrides?.[shift.id] ?? shift.headcount} onChange={(event) => updatePlanning({ weekdayTemplates: planning.weekdayTemplates.map((item, itemIndex) => itemIndex === index ? { ...item, staffHeadcountOverrides: { ...item.staffHeadcountOverrides, [shift.id]: numeric(event.target.value) } } : item) })}/><span>人</span></label>)}
        </div>)}
      </div>
    </Panel>

    <Panel title="日付Override / Manual Prep" caption="特定日の臨時休業・増員・需要・Processバッチを曜日Templateより優先します。" actions={<Button onClick={addDailyOverride}>＋ 日付Override</Button>}>
      <div className="planning-override-list">
        {planning.dailyOperatingPlans.map((plan) => <details className="menu-card" key={plan.id} open>
          <summary><span>{plan.date} · {plan.name ?? 'Override'}</span><Badge>{plan.enabled === false ? '休業' : '営業'}</Badge></summary>
          <div className="menu-card-body">
            <div className="form-grid form-grid-4 compact-grid">
              <TextField label="日付" type="date" value={plan.date} onChange={(event) => updateDaily(plan.id, { date: event.target.value })}/>
              <TextField label="名称" value={plan.name ?? ''} onChange={(event) => updateDaily(plan.id, { name: event.target.value })}/>
              <TextField label="開店" type="time" value={plan.openingTime ?? settings.business.openingTime} onChange={(event) => updateDaily(plan.id, { openingTime: event.target.value })}/>
              <TextField label="閉店" type="time" value={plan.closingTime ?? settings.business.closingTime} onChange={(event) => updateDaily(plan.id, { closingTime: event.target.value })}/>
              <NumberField label="需要Override" suffix="食" min={0} value={plan.mealsPerDay ?? settings.business.mealsPerDay} onChange={(event) => updateDaily(plan.id, { mealsPerDay: numeric(event.target.value) })}/>
              <div className="field toggle-field"><span className="field-label">営業</span><Toggle label={plan.enabled === false ? '臨時休業' : '営業'} checked={plan.enabled !== false} onChange={(enabled) => updateDaily(plan.id, { enabled })}/></div>
              {settings.capacity.staffShifts.map((shift) => <NumberField key={shift.id} label={`${shift.name} Override`} suffix="人" min={0} value={plan.staffHeadcountOverrides?.[shift.id] ?? shift.headcount} onChange={(event) => updateDaily(plan.id, { staffHeadcountOverrides: { ...plan.staffHeadcountOverrides, [shift.id]: numeric(event.target.value) } })}/>)}
              {settings.processes.map((process) => <NumberField key={process.id} label={`${process.name} Manual`} suffix="batch" min={0} value={plan.manualPrepBatches?.[process.id] ?? 0} onChange={(event) => updateDaily(plan.id, { manualPrepBatches: { ...plan.manualPrepBatches, [process.id]: numeric(event.target.value) } })}/>)}
            </div>
            <Button variant="danger" onClick={() => updatePlanning({ dailyOperatingPlans: planning.dailyOperatingPlans.filter((item) => item.id !== plan.id) })}>削除</Button>
          </div>
        </details>)}
      </div>
    </Panel>

    <Panel title="Prep / Procurement Rules" caption="Lookaheadは需要予測ではなく、設定済み需要を何日先まで確認するかです。購入支出は入荷日に計上します。">
      <div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>Process</th><th>batch</th><th>保存期限</th><th>Prep Lookahead</th></tr></thead><tbody>{settings.processes.map((process) => <tr key={process.id}><td>{process.name}</td><td>{process.batchSize} {process.outputs[0]?.unit}</td><td>{process.outputs[0]?.shelfLifeDays ?? 0}日</td><td><input type="number" min="0" value={process.prepLookaheadDays ?? 0} onChange={(event) => onChange({ ...settings, processes: settings.processes.map((item) => item.id === process.id ? { ...item, prepLookaheadDays: numeric(event.target.value) } : item) })}/> 日</td></tr>)}</tbody></table></div>
      <div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>Resource</th><th>package</th><th>Lead Time</th><th>発注Lookahead</th></tr></thead><tbody>{settings.resources.map((resource) => <tr key={resource.id}><td>{resource.name}</td><td>{resource.purchaseQuantity} {resource.purchaseUnit} / {formatYen(resource.purchasePrice)}</td><td><input type="number" min="0" value={resource.procurementLeadTimeDays ?? 0} onChange={(event) => onChange({ ...settings, resources: settings.resources.map((item) => item.id === resource.id ? { ...item, procurementLeadTimeDays: numeric(event.target.value) } : item) })}/> 日</td><td><input type="number" min="0" value={resource.procurementLookaheadDays ?? 0} onChange={(event) => onChange({ ...settings, resources: settings.resources.map((item) => item.id === resource.id ? { ...item, procurementLookaheadDays: numeric(event.target.value) } : item) })}/> 日</td></tr>)}</tbody></table></div>
    </Panel>

    <Panel title="Manual Purchase Orders" caption="発注日・入荷日を持つ未入荷注文。Lead Time 0の不足購入は同日入荷として既存FIFO Engineが処理します。" actions={<div className="page-action-row"><select value={orderResourceId} onChange={(event) => setOrderResourceId(event.target.value)}>{settings.resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name}</option>)}</select><Button onClick={addPurchaseOrder}>＋ 発注</Button></div>}>
      <div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>発注日</th><th>入荷日</th><th>Resource</th><th>package</th><th>支出</th><th/></tr></thead><tbody>{planning.purchaseOrders.map((order) => <tr key={order.id}><td><input type="date" value={order.orderedDate} onChange={(event) => updatePlanning({ purchaseOrders: planning.purchaseOrders.map((item) => item.id === order.id ? { ...item, orderedDate: event.target.value } : item) })}/></td><td><input type="date" value={order.deliveryDate} onChange={(event) => updatePlanning({ purchaseOrders: planning.purchaseOrders.map((item) => item.id === order.id ? { ...item, deliveryDate: event.target.value } : item) })}/></td><td>{settings.resources.find((resource) => resource.id === order.resourceId)?.name ?? order.resourceId}</td><td>{order.packageCount}</td><td>{formatYen(order.cost)}</td><td><Button variant="danger" onClick={() => updatePlanning({ purchaseOrders: planning.purchaseOrders.filter((item) => item.id !== order.id) })}>削除</Button></td></tr>)}</tbody></table></div>
    </Panel>

    {result && <>
      <div className="editor-summary planning-summary"><div><span>期間売上</span><strong>{formatYen(result.revenue)}</strong></div><div><span>期間営業利益</span><strong className={result.operatingProfit >= 0 ? 'positive' : 'negative'}>{formatYen(result.operatingProfit)}</strong></div><div><span>購入支出</span><strong>{formatYen(result.purchaseExpenditure)}</strong></div><div><span>廃棄原価</span><strong>{formatYen(result.wasteCost)}</strong></div><div><span>欠品失注</span><strong>{result.stockoutLostMeals}食 / {formatYen(result.stockoutLostRevenue)}</strong></div><div><span>期末在庫価額</span><strong>{formatYen(result.endingInventoryValue)}</strong></div></div>
      {result.warnings.length > 0 && <div className="alert warning"><b>運営計画の確認候補</b><br/>{result.warnings.slice(0, 8).join(' / ')}</div>}
      <Panel title="日別結果" caption="月曜の期末状態が火曜の期首状態になります。"><div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>日付</th><th>需要 / 実現</th><th>売上</th><th>使用原価</th><th>人件費</th><th>利益</th><th>購入支出</th><th>廃棄</th><th>期末在庫</th><th>待ち</th></tr></thead><tbody>{result.dailyResults.map((day) => <tr key={day.date}><td>{day.date}<small>{day.operating ? ' 営業' : ' 休業'}</small></td><td>{day.demandMeals} / {day.realizedMeals}{day.lostMeals > 0 && <small className="negative"> −{day.lostMeals}</small>}</td><td>{formatYen(day.revenue)}</td><td>{formatYen(day.usageCost)}</td><td>{formatYen(day.laborCost)}</td><td>{formatYen(day.operatingProfit)}</td><td>{formatYen(day.purchaseExpenditure)}</td><td>{formatYen(day.wasteCost)}</td><td>{formatYen(day.endingInventoryValue)}</td><td>{formatNumber(day.averageWaitMinutes, 1)}分</td></tr>)}</tbody></table></div></Panel>
      <Panel title="Inventory Timeline" caption="期首 + 入荷 + 生産 + 副産物 − 使用 − 廃棄 = 期末"><SelectField label="Resource / Output" value={selectedResourceId} onChange={(event) => setSelectedResourceId(event.target.value)}>{result.inventoryTimeline.filter((row, index, rows) => rows.findIndex((item) => item.sourceId === row.sourceId) === index).map((row) => <option key={row.sourceId} value={row.sourceId}>{row.name}</option>)}</SelectField><div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>日付</th><th>期首</th><th>入荷</th><th>生産</th><th>副産物</th><th>使用</th><th>廃棄</th><th>期末</th><th>未入荷</th></tr></thead><tbody>{selectedTimeline.map((row) => <tr key={`${row.date}-${row.sourceId}`}><td>{row.date}</td><td>{formatNumber(row.openingQuantity, 2)}</td><td>{formatNumber(row.deliveredQuantity, 2)}</td><td>{formatNumber(row.producedQuantity, 2)}</td><td>{formatNumber(row.byProductQuantity, 2)}</td><td>{formatNumber(row.consumedQuantity, 2)}</td><td>{formatNumber(row.wastedQuantity, 2)}</td><td>{formatNumber(row.endingQuantity, 2)} {row.unit}</td><td>{formatNumber(row.pendingQuantity, 2)}</td></tr>)}</tbody></table></div></Panel>
      <Panel title="Prep Timeline" caption="Process別のバッチ・生産・active labor"><div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>日付</th><th>Process</th><th>batch</th><th>生産</th><th>使用</th><th>残量</th><th>active labor</th></tr></thead><tbody>{result.prepTimeline.map((row) => <tr key={`${row.date}-${row.processId}`}><td>{row.date}</td><td>{row.processName}</td><td>{row.batches}</td><td>{formatNumber(row.producedQuantity, 2)}</td><td>{formatNumber(row.consumedQuantity, 2)}</td><td>{formatNumber(row.endingQuantity, 2)}</td><td>{formatNumber(row.activeLaborMinutes, 1)}分</td></tr>)}</tbody></table></div></Panel>
      <Panel title="Procurement Timeline" caption="購入支出は入荷日に簡易現金収支へ反映します。"><div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>発注日</th><th>入荷日</th><th>Resource</th><th>package</th><th>支出</th><th>状態</th></tr></thead><tbody>{result.purchaseOrders.map((order) => <tr key={order.id}><td>{order.orderedDate}</td><td>{order.deliveryDate}</td><td>{settings.resources.find((resource) => resource.id === order.resourceId)?.name ?? order.resourceId}</td><td>{order.packageCount}</td><td>{formatYen(order.cost)}</td><td>{order.deliveryDate < result.endDateExclusive ? '期間内入荷' : 'Pending'}</td></tr>)}</tbody></table></div></Panel>
    </>}

    {monteCarlo && <Panel title={`${monteCarlo.horizonDays}日 Monte Carlo`} caption="run/day seedを分離し、同一Plan・baseSeed・horizonなら再現できます。"><div className="editor-summary"><div><span>平均期間利益</span><strong>{formatYen(monteCarlo.statistics.operatingProfit.mean)}</strong></div><div><span>p10期間利益</span><strong>{formatYen(monteCarlo.statistics.operatingProfit.p10)}</strong></div><div><span>p90期間利益</span><strong>{formatYen(monteCarlo.statistics.operatingProfit.p90)}</strong></div><div><span>赤字期間率</span><strong>{formatPercent(monteCarlo.lossPeriodRate)}</strong></div><div><span>目標利益達成率</span><strong>{formatPercent(monteCarlo.targetProfitProbability)}</strong></div><div><span>平均欠品日数</span><strong>{formatNumber(monteCarlo.statistics.stockoutDays.mean, 1)}日</strong></div></div></Panel>}
  </>
}
