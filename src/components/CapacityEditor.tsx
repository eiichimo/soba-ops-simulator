import { useId, useMemo } from 'react'
import { simulateCapacity } from '../calculations/capacityEngine'
import { applyScenarioOverrides } from '../calculations/decisionSupport'
import type { AppSettings, CapacitySettings, Equipment, KitchenOperation, KitchenWorkflow, StaffShift } from '../models/types'
import { formatNumber, formatPercent, formatYen } from '../utils/format'
import { validateSettings } from '../validation/settingsValidation'
import { Badge, Button, NumberField, PageTitle, Panel, SelectField, TextField, Toggle } from './ui'

type Props = { settings: AppSettings; onChange: (settings: AppSettings) => void }

const uniqueId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
const valueNumber = (value: string) => Number.isFinite(Number(value)) ? Number(value) : 0

const QueueChart = ({ settings }: { settings: AppSettings }) => {
  const result = useMemo(() => simulateCapacity(settings), [settings])
  const gradientId = useId().replaceAll(':', '')
  const width = 900
  const height = 270
  const pad = { top: 24, right: 28, bottom: 44, left: 58 }
  const maxMinute = Math.max(result.closingMinute, result.finalCompletionMinute, ...result.queueTimeline.map((point) => point.minute))
  const rangeMinutes = Math.max(1, maxMinute - result.openingMinute)
  const maxQueue = Math.max(1, result.maxQueueLength)
  const x = (minute: number) => pad.left + (minute - result.openingMinute) / rangeMinutes * (width - pad.left - pad.right)
  const y = (queue: number) => pad.top + (height - pad.top - pad.bottom) * (1 - queue / maxQueue)
  const points = result.queueTimeline.length ? result.queueTimeline : [{ minute: result.openingMinute, queueLength: 0, time: result.openingTime }]
  const line = points.map((point, index) => `${index ? 'L' : 'M'} ${x(point.minute)} ${y(point.queueLength)}`).join(' ')
  const baseline = height - pad.bottom
  const area = `${line} L ${x(points.at(-1)?.minute ?? result.openingMinute)} ${baseline} L ${x(points[0].minute)} ${baseline} Z`
  return <div className="chart-wrap capacity-chart"><svg role="img" aria-label="時間別Queue Length" viewBox={`0 0 ${width} ${height}`}>
    <defs><linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#b66b35" stopOpacity="0.32"/><stop offset="1" stopColor="#b66b35" stopOpacity="0.02"/></linearGradient></defs>
    {[0, 0.25, 0.5, 0.75, 1].map((ratio) => <line key={ratio} className="grid-line" x1={pad.left} x2={width - pad.right} y1={pad.top + ratio * (baseline - pad.top)} y2={pad.top + ratio * (baseline - pad.top)}/>)}
    <line className="capacity-closing-line" x1={x(result.closingMinute)} x2={x(result.closingMinute)} y1={pad.top} y2={baseline}/>
    <path d={area} fill={`url(#${gradientId})`}/><path className="capacity-queue-line" d={line}/>
    <text className="axis-label" x={pad.left} y={height - 14}>{result.openingTime}</text>
    <text className="axis-label" x={x(result.closingMinute)} y={height - 14} textAnchor="middle">閉店 {result.closingTime}</text>
    <text className="axis-label" x={width - pad.right} y={height - 14} textAnchor="end">{result.finalCompletionTime}</text>
    <text className="axis-label" x={pad.left - 8} y={y(maxQueue)} textAnchor="end">{maxQueue}</text>
    <text className="axis-label" x={pad.left - 8} y={baseline} textAnchor="end">0</text>
  </svg></div>
}

const CapacityDashboard = ({ settings }: { settings: AppSettings }) => {
  const result = useMemo(() => simulateCapacity(settings), [settings])
  const equipmentBottleneck = result.equipmentUtilization.find((item) => item.id === result.bottleneckEquipmentId)
  const laborBottleneck = result.laborUtilization.find((item) => item.id === result.bottleneckLaborRoleId)
  return <>
    <div className="capacity-kpi-grid">
      <article><span>注文 / 完了</span><strong>{result.totalOrders} / {result.completedOrders}食</strong><small>営業時間内 {result.completedWithinBusinessHours}食</small></article>
      <article><span>平均待ち時間</span><strong>{formatNumber(result.averageWaitMinutes, 1)}分</strong><small>中央値 {formatNumber(result.medianWaitMinutes, 1)}分</small></article>
      <article><span>90%待ち時間</span><strong>{formatNumber(result.p90WaitMinutes, 1)}分</strong><small>最大 {formatNumber(result.maxWaitMinutes, 1)}分</small></article>
      <article><span>許容時間以内</span><strong>{formatPercent(result.withinTargetRate)}</strong><small>{result.targetExceededCount}件が{settings.capacity.targetWaitMinutes}分超</small></article>
      <article><span>最大Queue</span><strong>{result.maxQueueLength}食</strong><small>{result.maxQueueTime}</small></article>
      <article><span>最終提供</span><strong>{result.finalCompletionTime}</strong><small>閉店時未完了 {result.unfinishedAtClosing}食</small></article>
      <article><span>設備ボトルネック候補</span><strong>{equipmentBottleneck?.name ?? 'なし'}</strong><small>{formatPercent(equipmentBottleneck?.utilization ?? 0)}</small></article>
      <article><span>人員ボトルネック候補</span><strong>{laborBottleneck?.name ?? 'なし'}</strong><small>{formatPercent(laborBottleneck?.utilization ?? 0)}</small></article>
    </div>
    <Panel title="Queue Length" caption="到着済み・未提供の注文数です。閉店線より右は閉店後処理を表します。"><QueueChart settings={settings}/></Panel>
    <div className="capacity-economics-grid">
      <Panel title="需要ベース" caption={`${result.economic.demandMeals}食をすべて販売できる仮定`}><strong>{formatYen(result.economic.demandRevenue)}</strong><small>Shift補正後営業利益 {formatYen(result.economic.demandOperatingProfit)}</small></Panel>
      <Panel title="能力制約後" caption={`${result.economic.fulfilledMeals}食を日単位で経済Engineへ再入力`}><strong>{formatYen(result.economic.feasibleRevenue)}</strong><small>能力制約後営業利益 {formatYen(result.economic.capacityAdjustedOperatingProfit)}</small></Panel>
      <Panel title="Capacity Shift人件費" caption="StaffShiftの時間帯・人数・既存Role時給"><strong>{formatYen(result.economic.staffShiftCost)}</strong><small>既存日次Shiftとの差 {formatYen(result.economic.staffShiftCost - result.economic.legacyShiftCost)}</small></Panel>
    </div>
    {(result.warnings.length > 0) && <div className="capacity-warning-list">{result.warnings.map((warning) => <div key={warning}><Badge tone="warning">候補</Badge><span>{warning}</span></div>)}</div>}
    <Panel title="時間帯別Peak Window" caption={`${settings.capacity.bucketMinutes}分単位。待機数はBucket終端時点です。`}>
      <div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>開始</th><th>到着</th><th>完了</th><th>終端待機</th><th>平均待ち</th><th>最大Queue</th></tr></thead><tbody>{result.timeBuckets.map((bucket) => <tr key={bucket.startMinute}><td>{bucket.startTime}</td><td>{bucket.arrivals}</td><td>{bucket.completions}</td><td>{bucket.waitingOrders}</td><td>{formatNumber(bucket.averageWaitMinutes, 1)}分</td><td>{bucket.maxQueueLength}</td></tr>)}</tbody></table></div>
    </Panel>
    <div className="capacity-util-grid">
      <Panel title="設備利用率" caption="実稼働時間 ÷ 営業時間内利用可能時間"><div className="util-list">{result.equipmentUtilization.map((item) => <div key={item.id}><span>{item.name}</span><progress max="1" value={Math.min(1, item.utilization)}/><strong>{formatPercent(item.utilization)}</strong></div>)}</div></Panel>
      <Panel title="人員利用率" caption="active作業割当時間 ÷ Shift時間"><div className="util-list">{result.laborUtilization.map((item) => <div key={item.id}><span>{item.name}</span><progress max="1" value={Math.min(1, item.utilization)}/><strong>{formatPercent(item.utilization)}</strong></div>)}</div></Panel>
    </div>
  </>
}

export const CapacityEditor = ({ settings, onChange }: Props) => {
  const setCapacity = (capacity: CapacitySettings) => onChange({ ...settings, capacity })
  const updateEquipment = (id: string, patch: Partial<Equipment>) => setCapacity({ ...settings.capacity, equipment: settings.capacity.equipment.map((item) => item.id === id ? { ...item, ...patch, isReferenceCapacity: false } : item) })
  const updateOperation = (id: string, patch: Partial<KitchenOperation>) => setCapacity({ ...settings.capacity, operations: settings.capacity.operations.map((item) => item.id === id ? { ...item, ...patch, isReferenceCapacity: false } : item) })
  const updateShift = (id: string, patch: Partial<StaffShift>) => setCapacity({ ...settings.capacity, staffShifts: settings.capacity.staffShifts.map((item) => item.id === id ? { ...item, ...patch } : item) })
  const updateWorkflow = (id: string, patch: Partial<KitchenWorkflow>) => setCapacity({ ...settings.capacity, workflows: settings.capacity.workflows.map((item) => item.id === id ? { ...item, ...patch } : item) })
  const capacityIssues = validateSettings(settings).filter((item) => item.path?.startsWith('capacity') || item.code.includes('workflow') || item.code === 'reference-capacity')
  const scenarioResults = settings.scenarios.slice(0, 5).map((scenario) => ({ scenario, result: simulateCapacity(applyScenarioOverrides(settings, scenario)) }))
  const baseResult = simulateCapacity(settings)

  return <>
    <PageTitle eyebrow="CAPACITY / QUEUE / STAFFING" title="厨房能力" description="需要と処理能力を分離し、決定論的な1日イベントシミュレーションで待ち行列・設備・人員占有を追跡します。"/>
    {capacityIssues.length > 0 && <div className="capacity-warning-list">{capacityIssues.map((item, index) => <div key={`${item.code}-${index}`}><Badge tone={item.severity === 'error' ? 'warning' : 'reference'}>{item.severity === 'error' ? 'Error' : 'Warning'}</Badge><span>{item.message}</span></div>)}</div>}
    <CapacityDashboard settings={settings}/>

    <PageTitle eyebrow="DEMAND & POLICY" title="需要・提供方針" description="時間帯内の注文は均等間隔で発生し、既存Menu Mixへ端数を含めて決定論的に配分します。"/>
    <Panel title="提供方針と集計"><div className="form-grid form-grid-3">
      <NumberField label="許容待ち時間" suffix="分" min={0} value={settings.capacity.targetWaitMinutes} onChange={(event) => setCapacity({ ...settings.capacity, targetWaitMinutes: valueNumber(event.target.value) })}/>
      <NumberField label="Peak集計幅" suffix="分" min={1} value={settings.capacity.bucketMinutes} onChange={(event) => setCapacity({ ...settings.capacity, bucketMinutes: Math.max(1, valueNumber(event.target.value)) })}/>
      <SelectField label="閉店時処理" value={settings.capacity.fulfillmentPolicy} onChange={(event) => setCapacity({ ...settings.capacity, fulfillmentPolicy: event.target.value as CapacitySettings['fulfillmentPolicy'] })}><option value="completeAfterClosing">受付済みは閉店後も提供</option><option value="dropAtClosing">閉店時に未完了を失注</option></SelectField>
    </div></Panel>
    <Panel title="時間帯別注文数" caption={`合計 ${settings.capacity.demandProfile.timeSlots.reduce((total, slot) => total + slot.meals, 0)}食 / mealsPerDay ${settings.business.mealsPerDay}食`} actions={<Button onClick={() => setCapacity({ ...settings.capacity, demandProfile: { ...settings.capacity.demandProfile, timeSlots: [...settings.capacity.demandProfile.timeSlots, { id: uniqueId('demand'), startTime: settings.business.openingTime, endTime: settings.business.closingTime, meals: 0 }] } })}>＋ 時間帯</Button>}>
      <div className="editor-list">{settings.capacity.demandProfile.timeSlots.map((slot) => <div className="editor-row capacity-demand-row" key={slot.id}><label>開始<input type="time" value={slot.startTime} onChange={(event) => setCapacity({ ...settings.capacity, demandProfile: { ...settings.capacity.demandProfile, timeSlots: settings.capacity.demandProfile.timeSlots.map((item) => item.id === slot.id ? { ...item, startTime: event.target.value } : item) } })}/></label><label>終了<input type="time" value={slot.endTime} onChange={(event) => setCapacity({ ...settings.capacity, demandProfile: { ...settings.capacity.demandProfile, timeSlots: settings.capacity.demandProfile.timeSlots.map((item) => item.id === slot.id ? { ...item, endTime: event.target.value } : item) } })}/></label><NumberField label="注文数" suffix="食" min={0} value={slot.meals} onChange={(event) => setCapacity({ ...settings.capacity, demandProfile: { ...settings.capacity.demandProfile, timeSlots: settings.capacity.demandProfile.timeSlots.map((item) => item.id === slot.id ? { ...item, meals: valueNumber(event.target.value) } : item) } })}/><Button variant="danger" onClick={() => setCapacity({ ...settings.capacity, demandProfile: { ...settings.capacity.demandProfile, timeSlots: settings.capacity.demandProfile.timeSlots.filter((item) => item.id !== slot.id) } })}>削除</Button></div>)}</div>
    </Panel>

    <PageTitle eyebrow="EQUIPMENT & STAFF" title="設備・StaffShift" description="Equipmentの容量／同時Jobと、既存LaborRoleの勤務時間帯を厨房占有へ接続します。"/>
    <Panel title="Equipment" actions={<Button onClick={() => setCapacity({ ...settings.capacity, equipment: [...settings.capacity.equipment, { id: uniqueId('equipment'), name: '新しい設備', category: 'other', capacity: 1, capacityUnit: '食', concurrentJobs: 1, enabled: true }] })}>＋ 設備</Button>}>
      <div className="capacity-card-grid">{settings.capacity.equipment.map((item) => <article className="editor-card" key={item.id}><div className="form-grid form-grid-2"><TextField label="設備名" value={item.name} onChange={(event) => updateEquipment(item.id, { name: event.target.value })}/><SelectField label="種類" value={item.category} onChange={(event) => updateEquipment(item.id, { category: event.target.value as Equipment['category'] })}><option value="sobaBoiler">そば釜</option><option value="fryer">フライヤー</option><option value="burner">コンロ</option><option value="dishwasher">食洗機</option><option value="plating">盛付台</option><option value="washing">洗浄</option><option value="other">その他</option></SelectField><NumberField label="同時処理容量" suffix={item.capacityUnit} min={0.01} value={item.capacity} onChange={(event) => updateEquipment(item.id, { capacity: valueNumber(event.target.value) })}/><NumberField label="同時Job数" suffix="Job" min={1} value={item.concurrentJobs} onChange={(event) => updateEquipment(item.id, { concurrentJobs: valueNumber(event.target.value) })}/></div><div className="card-actions"><Toggle checked={item.enabled} label="有効" onChange={(enabled) => updateEquipment(item.id, { enabled })}/><Button variant="danger" onClick={() => setCapacity({ ...settings.capacity, equipment: settings.capacity.equipment.filter((target) => target.id !== item.id) })}>削除</Button></div></article>)}</div>
    </Panel>
    <Panel title="StaffShift" actions={<Button onClick={() => setCapacity({ ...settings.capacity, staffShifts: [...settings.capacity.staffShifts, { id: uniqueId('shift'), name: '新しいShift', laborRoleId: settings.labor[0]?.id ?? '', startTime: settings.business.openingTime, endTime: settings.business.closingTime, headcount: 1 }] })}>＋ Shift</Button>}>
      <div className="editor-list">{settings.capacity.staffShifts.map((shift) => <div className="editor-row capacity-shift-row" key={shift.id}><TextField label="Shift名" value={shift.name} onChange={(event) => updateShift(shift.id, { name: event.target.value })}/><SelectField label="Role" value={shift.laborRoleId} onChange={(event) => updateShift(shift.id, { laborRoleId: event.target.value })}>{settings.labor.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</SelectField><label>開始<input type="time" value={shift.startTime} onChange={(event) => updateShift(shift.id, { startTime: event.target.value })}/></label><label>終了<input type="time" value={shift.endTime} onChange={(event) => updateShift(shift.id, { endTime: event.target.value })}/></label><NumberField label="人数" suffix="人" min={0} value={shift.headcount} onChange={(event) => updateShift(shift.id, { headcount: valueNumber(event.target.value) })}/><Button variant="danger" onClick={() => setCapacity({ ...settings.capacity, staffShifts: settings.capacity.staffShifts.filter((item) => item.id !== shift.id) })}>削除</Button></div>)}</div>
    </Panel>

    <PageTitle eyebrow="KITCHEN WORKFLOW" title="営業中工程・Workflow" description="Process（仕込み／在庫生成）とは別に、1注文の設備占有・active人員・DAG依存を設定します。"/>
    <Panel title="KitchenOperation" actions={<Button onClick={() => setCapacity({ ...settings.capacity, operations: [...settings.capacity.operations, { id: uniqueId('operation'), name: '新しい営業工程', durationMinutes: 1, activeLaborMinutes: 1, equipmentRequirements: [], laborRequirements: [], batchCapacity: 1, enabled: true }] })}>＋ 工程</Button>}>
      <div className="capacity-card-grid">{settings.capacity.operations.map((operation) => {
        const equipmentRequirement = operation.equipmentRequirements[0]
        const laborRequirement = operation.laborRequirements[0]
        return <article className="editor-card" key={operation.id}><div className="form-grid form-grid-2"><TextField label="工程名" value={operation.name} onChange={(event) => updateOperation(operation.id, { name: event.target.value })}/><NumberField label="総所要時間" suffix="分" min={0.01} value={operation.durationMinutes} onChange={(event) => updateOperation(operation.id, { durationMinutes: valueNumber(event.target.value) })}/><NumberField label="active人員時間" suffix="分" min={0} value={operation.activeLaborMinutes} onChange={(event) => updateOperation(operation.id, { activeLaborMinutes: valueNumber(event.target.value) })}/><NumberField label="工程バッチ容量" suffix="食" min={1} value={operation.batchCapacity} onChange={(event) => updateOperation(operation.id, { batchCapacity: valueNumber(event.target.value) })}/><SelectField label="使用設備" value={equipmentRequirement?.equipmentId ?? ''} onChange={(event) => updateOperation(operation.id, { equipmentRequirements: event.target.value ? [{ equipmentId: event.target.value, occupationMinutes: equipmentRequirement?.occupationMinutes ?? operation.durationMinutes, units: 1 }] : [] })}><option value="">設備なし</option>{settings.capacity.equipment.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</SelectField><NumberField label="設備占有時間" suffix="分" min={0.01} disabled={!equipmentRequirement} value={equipmentRequirement?.occupationMinutes ?? 0} onChange={(event) => equipmentRequirement && updateOperation(operation.id, { equipmentRequirements: [{ ...equipmentRequirement, occupationMinutes: valueNumber(event.target.value) }] })}/><SelectField label="必要Role" value={laborRequirement?.laborRoleIds[0] ?? ''} onChange={(event) => updateOperation(operation.id, { laborRequirements: event.target.value ? [{ laborRoleIds: [event.target.value], headcount: laborRequirement?.headcount ?? 1 }] : [] })}><option value="">人員なし</option>{settings.labor.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</SelectField><NumberField label="必要人数" suffix="人" min={0} disabled={!laborRequirement} value={laborRequirement?.headcount ?? 0} onChange={(event) => laborRequirement && updateOperation(operation.id, { laborRequirements: [{ ...laborRequirement, headcount: valueNumber(event.target.value) }] })}/></div><div className="card-actions"><Toggle checked={operation.enabled} label="有効" onChange={(enabled) => updateOperation(operation.id, { enabled })}/><Button variant="danger" onClick={() => setCapacity({ ...settings.capacity, operations: settings.capacity.operations.filter((item) => item.id !== operation.id) })}>削除</Button></div></article>
      })}</div>
    </Panel>
    <Panel title="MenuItem KitchenWorkflow" caption="前工程は同一Workflow内のNodeから選択します。複数の前工程はカンマ区切りで内部保持します。">
      <div className="workflow-list">{settings.capacity.workflows.map((workflow) => <article className="editor-card" key={workflow.id}><header><strong>{settings.menuItems.find((menu) => menu.id === workflow.menuItemId)?.name ?? workflow.name}</strong><Button onClick={() => updateWorkflow(workflow.id, { nodes: [...workflow.nodes, { id: uniqueId('node'), operationId: settings.capacity.operations[0]?.id ?? '', dependencies: workflow.nodes.at(-1) ? [workflow.nodes.at(-1)!.id] : [] }] })}>＋ Node</Button></header>{workflow.nodes.map((node, index) => <div className="workflow-node-row" key={node.id}><span>{index + 1}</span><SelectField label="工程" value={node.operationId} onChange={(event) => updateWorkflow(workflow.id, { nodes: workflow.nodes.map((item) => item.id === node.id ? { ...item, operationId: event.target.value } : item) })}>{settings.capacity.operations.map((operation) => <option key={operation.id} value={operation.id}>{operation.name}</option>)}</SelectField><SelectField label="前工程" multiple value={node.dependencies} onChange={(event) => updateWorkflow(workflow.id, { nodes: workflow.nodes.map((item) => item.id === node.id ? { ...item, dependencies: Array.from(event.target.selectedOptions, (option) => option.value) } : item) })}>{workflow.nodes.filter((candidate) => candidate.id !== node.id).map((candidate) => <option key={candidate.id} value={candidate.id}>{settings.capacity.operations.find((operation) => operation.id === candidate.operationId)?.name ?? candidate.id}</option>)}</SelectField><Button variant="danger" onClick={() => updateWorkflow(workflow.id, { nodes: workflow.nodes.filter((item) => item.id !== node.id).map((item) => ({ ...item, dependencies: item.dependencies.filter((dependency) => dependency !== node.id) })) })}>削除</Button></div>)}</article>)}</div>
    </Panel>

    {scenarioResults.length > 0 && <Panel title="Capacity Scenario / ROI" caption="既存ScenarioのStaffShift人数・Equipment容量・工程時間Overrideを同じCapacity Engineで比較します。">
      <div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>Scenario</th><th>完了食数</th><th>平均待ち</th><th>追加人件費</th><th>追加提供</th><th>追加売上</th><th>営業利益差</th></tr></thead><tbody>{scenarioResults.map(({ scenario, result }) => <tr key={scenario.id}><td><strong>{scenario.name}</strong></td><td>{result.completedOrders}食</td><td>{formatNumber(result.averageWaitMinutes, 1)}分</td><td>{formatYen(result.economic.staffShiftCost - baseResult.economic.staffShiftCost)}</td><td>{result.completedOrders - baseResult.completedOrders}食</td><td>{formatYen(result.economic.feasibleRevenue - baseResult.economic.feasibleRevenue)}</td><td>{formatYen(result.economic.capacityAdjustedOperatingProfit - baseResult.economic.capacityAdjustedOperatingProfit)}</td></tr>)}</tbody></table></div>
    </Panel>}
    <div className="calculation-note"><Badge>日次近似</Badge><span>能力制約後利益は提供完了食数を既存Economic Engineへ日単位で渡します。分単位Inventory同期と残業割増はPhase 5対象外です。</span></div>
  </>
}
