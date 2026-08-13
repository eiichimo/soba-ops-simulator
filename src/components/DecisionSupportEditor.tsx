import { useId, useMemo, useState } from 'react'
import {
  compareScenarios,
  findBreakEvenMealsPerDay,
  removeScenario,
  runSensitivityAnalysis,
} from '../calculations/decisionSupport'
import { simulate } from '../calculations/engine'
import type { AppSettings, PeriodKey, Scenario, ScenarioOverrides, SensitivityPoint, SensitivityTarget } from '../models/types'
import { formatNumber, formatPercent, formatYen } from '../utils/format'
import { PeriodSwitch } from './Dashboard'
import { Badge, Button, NumberField, PageTitle, Panel, SelectField, TextField } from './ui'

type Props = { settings: AppSettings; onChange: (settings: AppSettings) => void }

const targetNames: Record<SensitivityTarget, string> = {
  mealsPerDay: '1日販売食数',
  averageSellingPrice: '平均販売価格',
  laborWage: '人件費（時給）',
  resourcePrice: 'Resource購入価格',
  waterPrice: '水道単価',
  gasPrice: 'ガス単価',
  electricityPrice: '電気単価',
  operatingHours: '1日営業時間',
  operatingDays: '週営業日数',
}

let idSequence = 0
const uniqueId = () => `scenario-${Date.now()}-${idSequence += 1}`
const numberValue = (value: string) => Number.isFinite(Number(value)) ? Number(value) : 0
const percentMultiplier = (value: string) => Math.max(0, 1 + numberValue(value) / 100)
const percentValue = (multiplier?: number) => Math.round(((multiplier ?? 1) - 1) * 1000) / 10

const SensitivityChart = ({ points }: { points: SensitivityPoint[] }) => {
  const gradientId = useId().replaceAll(':', '')
  const width = 760
  const height = 260
  const pad = { top: 24, right: 28, bottom: 44, left: 78 }
  const innerWidth = width - pad.left - pad.right
  const innerHeight = height - pad.top - pad.bottom
  const values = points.map((point) => point.result.operatingProfit)
  const minimum = Math.min(0, ...values)
  const maximum = Math.max(1, ...values)
  const range = Math.max(1, maximum - minimum)
  const x = (index: number) => pad.left + (points.length <= 1 ? 0 : index / (points.length - 1)) * innerWidth
  const y = (value: number) => pad.top + innerHeight - (value - minimum) / range * innerHeight
  const line = points.map((point, index) => `${index ? 'L' : 'M'} ${x(index)} ${y(point.result.operatingProfit)}`).join(' ')
  const area = `${line} L ${x(points.length - 1)} ${pad.top + innerHeight} L ${x(0)} ${pad.top + innerHeight} Z`
  return <div className="chart-wrap sensitivity-chart-wrap"><svg className="volume-chart" role="img" aria-label="感度変化率と営業利益" viewBox={`0 0 ${width} ${height}`}>
    <defs><linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#355f50" stopOpacity="0.24"/><stop offset="1" stopColor="#355f50" stopOpacity="0"/></linearGradient></defs>
    {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
      const gridY = pad.top + innerHeight * ratio
      return <line key={ratio} className="grid-line" x1={pad.left} x2={pad.left + innerWidth} y1={gridY} y2={gridY}/>
    })}
    <line className="zero-line" x1={pad.left} x2={pad.left + innerWidth} y1={y(0)} y2={y(0)}/>
    <path d={area} fill={`url(#${gradientId})`}/><path className="sensitivity-line" d={line}/>
    {points.map((point, index) => <g key={point.rate}><circle className="sensitivity-dot" cx={x(index)} cy={y(point.result.operatingProfit)} r="5"/><text className="axis-label" x={x(index)} y={height - 14} textAnchor="middle">{point.label}</text><text className="axis-label sensitivity-value-label" x={x(index)} y={Math.max(14, y(point.result.operatingProfit) - 10)} textAnchor="middle">{formatYen(point.result.operatingProfit)}</text></g>)}
  </svg></div>
}

export const DecisionSupportEditor = ({ settings, onChange }: Props) => {
  const [period, setPeriod] = useState<PeriodKey>('month')
  const [target, setTarget] = useState<SensitivityTarget>('mealsPerDay')
  const [resourceId, setResourceId] = useState(settings.resources[0]?.id ?? '')
  const sensitivity = useMemo(() => runSensitivityAnalysis(settings, period, target, undefined, resourceId), [settings, period, target, resourceId])
  const base = useMemo(() => simulate(settings, period), [settings, period])
  const breakEven = useMemo(() => findBreakEvenMealsPerDay(settings, period), [settings, period])
  const scenarios = useMemo(() => compareScenarios(settings, period), [settings, period])

  const addScenario = () => {
    if (settings.scenarios.length >= 5) return
    const scenario: Scenario = { id: uniqueId(), name: `Scenario ${String.fromCharCode(65 + settings.scenarios.length)}`, overrides: {} }
    onChange({ ...settings, scenarios: [...settings.scenarios, scenario] })
  }

  const updateScenario = (id: string, patch: Partial<Scenario>) => onChange({
    ...settings,
    scenarios: settings.scenarios.map((scenario) => scenario.id === id ? { ...scenario, ...patch } : scenario),
  })

  const updateOverrides = (scenario: Scenario, patch: Partial<ScenarioOverrides>) => updateScenario(scenario.id, {
    overrides: { ...scenario.overrides, ...patch },
  })

  const baselinePoint = sensitivity.find((point) => point.rate === 0) ?? sensitivity[0]
  const adversePoint = sensitivity.find((point) => point.rate === 0.2)

  return <>
    <PageTitle eyebrow="SENSITIVITY & SCENARIO" title="感度分析・Scenario" description="条件の差分だけを適用し、既存Simulation Engineで在庫・バッチ・廃棄を含めて再計算します。" actions={<PeriodSwitch period={period} onChange={setPeriod}/>}/>

    <div className="decision-summary">
      <article><span>販売食数の損益分岐</span><strong>{breakEven === null ? '500食超 / 日' : `${breakEven}食 / 日`}</strong><small>0〜500食を順番に再計算</small></article>
      <article><span>基準営業利益</span><strong>{formatYen(base.operatingProfit)}</strong><small>{base.operatingDays}営業日 · {formatNumber(base.meals, 0)}食</small></article>
      <article><span>基準利益率</span><strong>{formatPercent(base.operatingMargin)}</strong><small>簡易現金収支 {formatYen(base.inventory.simpleCashFlow)}</small></article>
    </div>

    <Panel title="Sensitivity Analysis" caption="初期変化率 -20% / -10% / 基準 / +10% / +20% を一括計算します。">
      <div className="sensitivity-controls">
        <SelectField label="分析対象" value={target} onChange={(event) => setTarget(event.target.value as SensitivityTarget)}>{(Object.keys(targetNames) as SensitivityTarget[]).map((key) => <option key={key} value={key}>{targetNames[key]}</option>)}</SelectField>
        {target === 'resourcePrice' && <SelectField label="対象Resource" value={resourceId} onChange={(event) => setResourceId(event.target.value)}>{settings.resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name}</option>)}</SelectField>}
      </div>
      <SensitivityChart points={sensitivity}/>
      <div className="resource-table-wrap"><table className="resource-table sensitivity-table">
        <thead><tr><th>変化率</th><th>対象値</th><th>売上</th><th>使用原価</th><th>人件費</th><th>営業利益</th><th>利益率</th><th>簡易現金収支</th></tr></thead>
        <tbody>{sensitivity.map((point) => <tr key={point.rate} className={point.rate === 0 ? 'baseline' : ''}><td><strong>{point.label}</strong></td><td>{formatNumber(point.parameterValue, 2)}</td><td>{formatYen(point.result.revenue)}</td><td>{formatYen(point.result.inventory.usageCost)}</td><td>{formatYen(point.result.labor.accountingLaborCost)}</td><td><strong>{formatYen(point.result.operatingProfit)}</strong></td><td>{formatPercent(point.result.operatingMargin)}</td><td>{formatYen(point.result.inventory.simpleCashFlow)}</td></tr>)}</tbody>
      </table></div>
    </Panel>

    <Panel title="意思決定サマリー" caption="計算結果を観測文として表示し、推奨を断定しません。">
      <ul className="decision-observations">
        <li>1日販売数が{breakEven === null ? '500食以下の探索範囲では黒字化しません' : `${breakEven}食を下回ると、この期間設定では赤字になります`}。</li>
        {adversePoint && baselinePoint && <li>{targetNames[target]}が+20%の場合、営業利益は基準比 {formatYen(adversePoint.result.operatingProfit - baselinePoint.result.operatingProfit)}、利益率は{formatPercent(adversePoint.result.operatingMargin)}です。</li>}
        {scenarios.map(({ scenario, result }) => <li key={scenario.id}>{scenario.name}の営業利益はBase比 {formatYen(result.operatingProfit - base.operatingProfit)}です。</li>)}
      </ul>
    </Panel>

    <PageTitle eyebrow="SCENARIOS" title="Scenario比較" description="Base Settingsは変更せず、保存されたOverrideを最大5件まで並べます。" actions={<Button variant="primary" disabled={settings.scenarios.length >= 5} onClick={addScenario}>＋ Scenario追加</Button>}/>
    {settings.scenarios.length === 0 && <div className="empty-state">Scenarioはまだありません。比較案を追加してください。</div>}
    <div className="scenario-editor-grid">
      {settings.scenarios.slice(0, 5).map((scenario) => {
        const business = scenario.overrides.business ?? {}
        const resourceEntry = Object.entries(scenario.overrides.resourcePurchasePriceMultipliers ?? {})[0]
        const selectedResourceId = resourceEntry?.[0] ?? settings.resources[0]?.id ?? ''
        const selectedResourceMultiplier = resourceEntry?.[1] ?? 1
        const shiftEntry = Object.entries(scenario.overrides.staffShiftHeadcountOverrides ?? {})[0]
        const selectedShiftId = shiftEntry?.[0] ?? settings.capacity.staffShifts[0]?.id ?? ''
        const selectedShiftHeadcount = shiftEntry?.[1] ?? settings.capacity.staffShifts.find((shift) => shift.id === selectedShiftId)?.headcount ?? 0
        const equipmentEntry = Object.entries(scenario.overrides.equipmentCapacityOverrides ?? {})[0]
        const selectedEquipmentId = equipmentEntry?.[0] ?? settings.capacity.equipment[0]?.id ?? ''
        const selectedEquipmentCapacity = equipmentEntry?.[1] ?? settings.capacity.equipment.find((equipment) => equipment.id === selectedEquipmentId)?.capacity ?? 0
        const operationEntry = Object.entries(scenario.overrides.kitchenOperationDurationOverrides ?? {})[0]
        const selectedOperationId = operationEntry?.[0] ?? settings.capacity.operations[0]?.id ?? ''
        const selectedOperationDuration = operationEntry?.[1] ?? settings.capacity.operations.find((operation) => operation.id === selectedOperationId)?.durationMinutes ?? 0
        const seatingEntry = Object.entries(scenario.overrides.seatingUnitCountOverrides ?? {})[0]
        const selectedSeatingId = seatingEntry?.[0] ?? settings.capacity.stochasticDemand.seatingUnits[0]?.id ?? ''
        const selectedSeatingCount = seatingEntry?.[1] ?? settings.capacity.stochasticDemand.seatingUnits.find((unit) => unit.id === selectedSeatingId)?.count ?? 0
        return <Panel key={scenario.id} className="scenario-editor-card" title={scenario.name} actions={<Button variant="danger" onClick={() => {
          if (window.confirm(`${scenario.name}を削除しますか？`)) onChange(removeScenario(settings, scenario.id))
        }}>削除</Button>}>
          <div className="form-grid form-grid-2">
            <TextField label="Scenario名" value={scenario.name} onChange={(event) => updateScenario(scenario.id, { name: event.target.value })}/>
            <NumberField label="1日販売食数" suffix="食" min={0} value={business.mealsPerDay ?? settings.business.mealsPerDay} onChange={(event) => updateOverrides(scenario, { business: { ...business, mealsPerDay: numberValue(event.target.value) } })}/>
            <NumberField label="1日営業時間" suffix="時間" min={0} max={24} value={business.hoursPerDay ?? settings.business.hoursPerDay} onChange={(event) => updateOverrides(scenario, { business: { ...business, hoursPerDay: numberValue(event.target.value) } })}/>
            <NumberField label="週営業日数" suffix="日" min={0} max={7} value={business.operatingDaysPerWeek ?? settings.business.weekdays.filter((day) => day.enabled).length} onChange={(event) => updateOverrides(scenario, { business: { ...business, operatingDaysPerWeek: numberValue(event.target.value) } })}/>
            <NumberField label="平均販売価格変化" suffix="%" value={percentValue(scenario.overrides.averageSellingPriceMultiplier)} onChange={(event) => updateOverrides(scenario, { averageSellingPriceMultiplier: percentMultiplier(event.target.value) })}/>
            <NumberField label="時給変化" suffix="%" value={percentValue(scenario.overrides.laborWageMultiplier)} onChange={(event) => updateOverrides(scenario, { laborWageMultiplier: percentMultiplier(event.target.value) })}/>
            <SelectField label="価格変更Resource" value={selectedResourceId} onChange={(event) => updateOverrides(scenario, { resourcePurchasePriceMultipliers: { [event.target.value]: selectedResourceMultiplier } })}>{settings.resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name}</option>)}</SelectField>
            <NumberField label="Resource価格変化" suffix="%" value={percentValue(selectedResourceMultiplier)} onChange={(event) => updateOverrides(scenario, { resourcePurchasePriceMultipliers: { [selectedResourceId]: percentMultiplier(event.target.value) } })}/>
            <SelectField label="変更StaffShift" value={selectedShiftId} onChange={(event) => updateOverrides(scenario, { staffShiftHeadcountOverrides: { [event.target.value]: settings.capacity.staffShifts.find((shift) => shift.id === event.target.value)?.headcount ?? 0 } })}>{settings.capacity.staffShifts.map((shift) => <option key={shift.id} value={shift.id}>{shift.name}</option>)}</SelectField>
            <NumberField label="Shift人数" suffix="人" min={0} value={selectedShiftHeadcount} onChange={(event) => updateOverrides(scenario, { staffShiftHeadcountOverrides: { [selectedShiftId]: numberValue(event.target.value) } })}/>
            <SelectField label="変更Equipment" value={selectedEquipmentId} onChange={(event) => updateOverrides(scenario, { equipmentCapacityOverrides: { [event.target.value]: settings.capacity.equipment.find((equipment) => equipment.id === event.target.value)?.capacity ?? 1 } })}>{settings.capacity.equipment.map((equipment) => <option key={equipment.id} value={equipment.id}>{equipment.name}</option>)}</SelectField>
            <NumberField label="設備容量" suffix="単位" min={0.01} value={selectedEquipmentCapacity} onChange={(event) => updateOverrides(scenario, { equipmentCapacityOverrides: { [selectedEquipmentId]: numberValue(event.target.value) } })}/>
            <SelectField label="変更厨房工程" value={selectedOperationId} onChange={(event) => updateOverrides(scenario, { kitchenOperationDurationOverrides: { [event.target.value]: settings.capacity.operations.find((operation) => operation.id === event.target.value)?.durationMinutes ?? 1 } })}>{settings.capacity.operations.map((operation) => <option key={operation.id} value={operation.id}>{operation.name}</option>)}</SelectField>
            <NumberField label="工程所要時間" suffix="分" min={0.01} value={selectedOperationDuration} onChange={(event) => updateOverrides(scenario, { kitchenOperationDurationOverrides: { [selectedOperationId]: numberValue(event.target.value) } })}/>
            <SelectField label="変更客席" value={selectedSeatingId} onChange={(event) => updateOverrides(scenario, { seatingUnitCountOverrides: { [event.target.value]: settings.capacity.stochasticDemand.seatingUnits.find((unit) => unit.id === event.target.value)?.count ?? 0 } })}>{settings.capacity.stochasticDemand.seatingUnits.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</SelectField>
            <NumberField label="席・卓数" suffix="台" min={0} value={selectedSeatingCount} onChange={(event) => updateOverrides(scenario, { seatingUnitCountOverrides: { [selectedSeatingId]: numberValue(event.target.value) } })}/>
          </div>
        </Panel>
      })}
    </div>

    {scenarios.length > 0 && <Panel title="Baseとの差" caption="購入支出と使用原価は別指標として比較します。">
      <div className="resource-table-wrap"><table className="resource-table scenario-comparison-table">
        <thead><tr><th>指標</th><th>Base</th>{scenarios.map(({ scenario }) => <th key={scenario.id}>{scenario.name}<small>Base差</small></th>)}</tr></thead>
        <tbody>{([
          ['売上', (result: typeof base) => result.revenue, 'yen'],
          ['使用原価', (result: typeof base) => result.inventory.usageCost, 'yen'],
          ['購入支出', (result: typeof base) => result.inventory.purchaseExpenditure, 'yen'],
          ['人件費', (result: typeof base) => result.labor.accountingLaborCost, 'yen'],
          ['廃棄', (result: typeof base) => result.inventory.wasteCost, 'yen'],
          ['営業利益', (result: typeof base) => result.operatingProfit, 'yen'],
          ['利益率', (result: typeof base) => result.operatingMargin, 'percent'],
          ['簡易現金収支', (result: typeof base) => result.inventory.simpleCashFlow, 'yen'],
          ['1食平均原価', (result: typeof base) => result.averageCostPerMeal, 'yen'],
          ['1営業時間あたり利益', (result: typeof base) => result.profitPerOperatingHour, 'yen'],
        ] as const).map(([label, select, format]) => {
          const baseValue = select(base)
          return <tr key={label}><td><strong>{label}</strong></td><td>{format === 'percent' ? formatPercent(baseValue) : formatYen(baseValue)}</td>{scenarios.map(({ scenario, result }) => {
            const value = select(result)
            const difference = value - baseValue
            return <td key={scenario.id}><strong>{format === 'percent' ? formatPercent(value) : formatYen(value)}</strong><small className={difference >= 0 ? 'positive' : 'negative'}>{difference >= 0 ? '+' : ''}{format === 'percent' ? formatPercent(difference) : formatYen(difference)}</small></td>
          })}</tr>
        })}</tbody>
      </table></div>
    </Panel>}
    <div className="calculation-note"><Badge>非破壊Override</Badge><span>Scenario編集はBase Settingsへ書き戻さず、比較時だけ差分を適用します。</span></div>
  </>
}
