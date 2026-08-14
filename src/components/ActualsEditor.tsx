import { useMemo, useState } from 'react'
import { formatLocalDate, parseLocalDate } from '../calculations/calendar'
import {
  analyzeRevenueVariance,
  buildCalibrationHints,
  buildResourceVariances,
  buildVarianceRows,
  calculateActualUtilityUnitPrice,
  deriveActualMetrics,
  simulateActualPeriod,
} from '../calculations/decisionSupport'
import type { ActualPeriod, ActualResourceRecord, ActualValues, AppSettings, Unit } from '../models/types'
import { formatNumber, formatPercent, formatYen } from '../utils/format'
import { Badge, Button, EmptyState, NumberField, PageTitle, Panel, TextField } from './ui'

type Props = { settings: AppSettings; onChange: (settings: AppSettings) => void }

let idSequence = 0
const uniqueId = () => `actual-${Date.now()}-${idSequence += 1}`
const optionalNumber = (value: string) => value === '' ? undefined : Number.isFinite(Number(value)) ? Number(value) : undefined
const inputValue = (value?: number) => value ?? ''
const addDays = (dateText: string, days: number) => {
  const date = parseLocalDate(dateText) ?? new Date()
  return formatLocalDate(new Date(date.getFullYear(), date.getMonth(), date.getDate() + days))
}

const emptyActualValues = (): ActualValues => ({
  menuSales: [],
  resourceRecords: [],
  utilities: { water: {}, gas: {}, electricity: {} },
})

const metricValue = (value: number | null, unit: 'yen' | 'count' | 'hours') => {
  if (value === null) return '未入力'
  if (unit === 'yen') return formatYen(value)
  return `${formatNumber(value, 1)}${unit === 'hours' ? '時間' : '食'}`
}

export const ActualsEditor = ({ settings, onChange }: Props) => {
  const [selectedId, setSelectedId] = useState(settings.actualPeriods[0]?.id ?? '')
  const selected = settings.actualPeriods.find((period) => period.id === selectedId) ?? settings.actualPeriods[0]
  const plan = useMemo(() => selected ? simulateActualPeriod(settings, selected) : null, [settings, selected])
  const rows = useMemo(() => plan && selected ? buildVarianceRows(plan, selected) : [], [plan, selected])
  const resourceRows = useMemo(() => plan && selected ? buildResourceVariances(settings, plan, selected) : [], [settings, plan, selected])
  const hints = useMemo(() => buildCalibrationHints(rows), [rows])
  const revenueAnalysis = useMemo(() => plan && selected ? analyzeRevenueVariance(settings, plan, selected) : null, [settings, plan, selected])

  const addPeriod = () => {
    const startDate = settings.business.simulationStartDate
    const period: ActualPeriod = {
      id: uniqueId(),
      name: `${startDate.slice(0, 7)} 実績`,
      startDate,
      endDate: addDays(startDate, 29),
      actuals: emptyActualValues(),
    }
    onChange({ ...settings, actualPeriods: [...settings.actualPeriods, period] })
    setSelectedId(period.id)
  }

  const updatePeriod = (patch: Partial<ActualPeriod>) => {
    if (!selected) return
    onChange({ ...settings, actualPeriods: settings.actualPeriods.map((period) => period.id === selected.id ? { ...period, ...patch } : period) })
  }

  const updateActuals = (patch: Partial<ActualValues>) => {
    if (!selected) return
    updatePeriod({
      actuals: { ...selected.actuals, ...patch },
      sourceMetadata: [
        ...(selected.sourceMetadata ?? []).filter((metadata) => metadata.source !== 'manual'),
        { source: 'manual', fields: Object.keys(patch), recordedAt: new Date().toISOString() },
      ],
    })
  }

  const updateResource = (resourceId: string, unit: Unit, patch: Partial<ActualResourceRecord>) => {
    if (!selected) return
    const existing = selected.actuals.resourceRecords.find((record) => record.resourceId === resourceId)
    const record: ActualResourceRecord = existing
      ? { ...existing, ...patch }
      : { resourceId, purchaseUnit: unit, wasteUnit: unit, ...patch }
    updateActuals({ resourceRecords: existing
      ? selected.actuals.resourceRecords.map((item) => item.resourceId === resourceId ? record : item)
      : [...selected.actuals.resourceRecords, record] })
  }

  const updateMenuSale = (menuItemId: string, quantity?: number) => {
    if (!selected) return
    const others = selected.actuals.menuSales.filter((sale) => sale.menuItemId !== menuItemId)
    updateActuals({ menuSales: quantity === undefined ? others : [...others, { menuItemId, quantity }] })
  }

  const utilityField = (utility: 'water' | 'gas' | 'electricity', patch: { cost?: number; quantity?: number }) => {
    if (!selected) return
    updateActuals({ utilities: { ...selected.actuals.utilities, [utility]: { ...selected.actuals.utilities[utility], ...patch } } })
  }

  if (!selected) return <>
    <PageTitle eyebrow="ACTUALS & VARIANCE" title="実績・予測差異" description="実績はSimulation設定とは独立して保存され、自動的に設定値を変更しません。" actions={<Button variant="primary" onClick={addPeriod}>＋ 実績期間を追加</Button>} />
    <EmptyState>実績期間はまだありません。最初の期間を追加してください。</EmptyState>
  </>

  const actuals = selected.actuals
  const derived = deriveActualMetrics(actuals)
  const utilityPrices = {
    water: calculateActualUtilityUnitPrice(actuals.utilities.water.cost, actuals.utilities.water.quantity),
    gas: calculateActualUtilityUnitPrice(actuals.utilities.gas.cost, actuals.utilities.gas.quantity),
    electricity: calculateActualUtilityUnitPrice(actuals.utilities.electricity.cost, actuals.utilities.electricity.quantity),
  }

  return <>
    <PageTitle
      eyebrow="ACTUALS & VARIANCE"
      title="実績・予測差異"
      description="入力されている実績だけを比較し、未入力値を0円として推計しません。"
      actions={<div className="page-action-row"><select value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>{settings.actualPeriods.map((period) => <option key={period.id} value={period.id}>{period.name}</option>)}</select><Button onClick={addPeriod}>＋ 追加</Button><Button variant="danger" onClick={() => {
        if (!window.confirm(`${selected.name}を削除しますか？`)) return
        const remaining = settings.actualPeriods.filter((period) => period.id !== selected.id)
        onChange({ ...settings, actualPeriods: remaining })
        setSelectedId(remaining[0]?.id ?? '')
      }}>削除</Button></div>}
    />

    <Panel title="実績期間" caption="終了日は含む日付です。同じ暦日範囲を既存Simulation Engineで再計算します。">
      <div className="form-grid form-grid-3">
        <TextField label="実績名" value={selected.name} onChange={(event) => updatePeriod({ name: event.target.value })}/>
        <TextField label="開始日" type="date" value={selected.startDate} onChange={(event) => updatePeriod({ startDate: event.target.value })}/>
        <TextField label="終了日" type="date" value={selected.endDate} onChange={(event) => updatePeriod({ endDate: event.target.value })}/>
      </div>
      <label className="field"><span className="field-label">メモ</span><textarea value={selected.notes ?? ''} onChange={(event) => updatePeriod({ notes: event.target.value })}/></label>
    </Panel>

    <div className="dashboard-grid actual-input-grid">
      <Panel title="売上・営業実績">
        <div className="form-grid form-grid-2">
          <NumberField label="総売上" suffix="円" min={0} value={inputValue(actuals.revenue)} onChange={(event) => updateActuals({ revenue: optionalNumber(event.target.value) })}/>
          <NumberField label="総販売食数" suffix="食" min={0} value={inputValue(actuals.meals)} onChange={(event) => updateActuals({ meals: optionalNumber(event.target.value) })}/>
          <NumberField label="営業日数" suffix="日" min={0} value={inputValue(actuals.operatingDays)} onChange={(event) => updateActuals({ operatingDays: optionalNumber(event.target.value) })}/>
          <NumberField label="総営業時間" suffix="時間" min={0} value={inputValue(actuals.operatingHours)} onChange={(event) => updateActuals({ operatingHours: optionalNumber(event.target.value) })}/>
        </div>
        <details className="actual-menu-sales"><summary>メニュー別販売食数（任意）</summary><div>{settings.menuItems.map((menu) => <label key={menu.id}><span>{menu.name}</span><input type="number" min="0" step="any" value={inputValue(actuals.menuSales.find((sale) => sale.menuItemId === menu.id)?.quantity)} onChange={(event) => updateMenuSale(menu.id, optionalNumber(event.target.value))}/><b>食</b></label>)}</div></details>
      </Panel>
      <Panel title="原価・在庫・仕入">
        <div className="form-grid form-grid-2">
          <NumberField label="使用原価（任意）" suffix="円" min={0} value={inputValue(actuals.usageCost)} onChange={(event) => updateActuals({ usageCost: optionalNumber(event.target.value) })} hint="未入力時は在庫方程式が揃った場合のみ算出"/>
          <NumberField label="総購入支出" suffix="円" min={0} value={inputValue(actuals.purchaseExpenditure)} onChange={(event) => updateActuals({ purchaseExpenditure: optionalNumber(event.target.value) })}/>
          <NumberField label="期首在庫価額" suffix="円" min={0} value={inputValue(actuals.openingInventoryValue)} onChange={(event) => updateActuals({ openingInventoryValue: optionalNumber(event.target.value) })}/>
          <NumberField label="期末在庫価額" suffix="円" min={0} value={inputValue(actuals.endingInventoryValue)} onChange={(event) => updateActuals({ endingInventoryValue: optionalNumber(event.target.value) })}/>
          <NumberField label="廃棄原価" suffix="円" min={0} value={inputValue(actuals.wasteCost)} onChange={(event) => updateActuals({ wasteCost: optionalNumber(event.target.value) })}/>
          <NumberField label="その他費用" suffix="円" min={0} value={inputValue(actuals.otherCost)} onChange={(event) => updateActuals({ otherCost: optionalNumber(event.target.value) })}/>
        </div>
      </Panel>
    </div>

    <div className="dashboard-grid actual-input-grid">
      <Panel title="人件費">
        <div className="form-grid form-grid-2">
          <NumberField label="給与・人件費総額" suffix="円" min={0} value={inputValue(actuals.laborCost)} onChange={(event) => updateActuals({ laborCost: optionalNumber(event.target.value) })}/>
          <NumberField label="実労働時間" suffix="時間" min={0} value={inputValue(actuals.laborHours)} onChange={(event) => updateActuals({ laborHours: optionalNumber(event.target.value) })}/>
        </div>
      </Panel>
      <Panel title="水道光熱実績" caption="料金と使用量が揃うと実績平均単価を算出します。">
        <div className="actual-utility-grid">
          {([
            ['water', '水道', 'L', settings.utilities.water.unitPrice, utilityPrices.water],
            ['gas', 'ガス', 'm³', settings.utilities.gas.unitPrice, utilityPrices.gas],
            ['electricity', '電気', 'kWh', settings.utilities.electricity.unitPrice, utilityPrices.electricity],
          ] as const).map(([key, label, unit, configuredPrice, actualPrice]) => <div key={key}>
            <strong>{label}</strong>
            <NumberField label="料金" suffix="円" min={0} value={inputValue(actuals.utilities[key].cost)} onChange={(event) => utilityField(key, { cost: optionalNumber(event.target.value) })}/>
            <NumberField label="使用量" suffix={unit} min={0} value={inputValue(actuals.utilities[key].quantity)} onChange={(event) => utilityField(key, { quantity: optionalNumber(event.target.value) })}/>
            <small>現在設定 {formatNumber(configuredPrice, 2)}円 / {actualPrice === null ? '実績平均は算出不可' : `設定候補 ${formatNumber(actualPrice, 2)}円（実績平均）`}</small>
          </div>)}
        </div>
      </Panel>
    </div>

    <Panel title="予測 vs 実績" caption={plan ? `${selected.startDate}〜${selected.endDate} · ${plan.calendarDays}暦日` : '期間設定を確認してください'}>
      {plan ? <div className="resource-table-wrap"><table className="resource-table variance-table">
        <thead><tr><th>指標</th><th>予測</th><th>実績</th><th>差額</th><th>差率</th><th>判定</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.key}><td><strong>{row.label}</strong></td><td>{metricValue(row.plan, row.unit)}</td><td>{metricValue(row.actual, row.unit)}</td><td>{row.amount === null ? '算出不可' : `${row.amount > 0 ? '+' : ''}${metricValue(row.amount, row.unit)}`}</td><td>{row.actual === null ? '未入力' : row.rate === null ? '算出不可' : `${row.rate > 0 ? '+' : ''}${formatPercent(row.rate)}`}</td><td><Badge tone={row.interpretation === 'favorable' ? 'positive' : row.interpretation === 'unfavorable' ? 'warning' : 'neutral'}>{row.interpretation === 'favorable' ? '好転' : row.interpretation === 'unfavorable' ? '悪化' : row.interpretation === 'notAvailable' ? '未入力' : '中立'}</Badge></td></tr>)}</tbody>
      </table></div> : <EmptyState>開始日と終了日を確認してください。</EmptyState>}
    </Panel>

    {plan && <Panel title="単位あたり比較" caption="客数差と運営効率差を分けて確認します。">
      <div className="efficiency-grid">
        {([
          ['1食あたり売上', plan.meals > 0 ? plan.revenue / plan.meals : null, actuals.revenue !== undefined && actuals.meals ? actuals.revenue / actuals.meals : null, '円'],
          ['1食あたり使用原価', plan.meals > 0 ? plan.inventory.usageCost / plan.meals : null, derived.usageCost !== undefined && actuals.meals ? derived.usageCost / actuals.meals : null, '円'],
          ['1食あたり人件費', plan.meals > 0 ? plan.labor.accountingLaborCost / plan.meals : null, actuals.laborCost !== undefined && actuals.meals ? actuals.laborCost / actuals.meals : null, '円'],
          ['1食あたり水道光熱費', plan.meals > 0 ? (plan.costs.water + plan.costs.gas + plan.costs.electricity) / plan.meals : null, actuals.meals && actuals.utilities.water.cost !== undefined && actuals.utilities.gas.cost !== undefined && actuals.utilities.electricity.cost !== undefined ? (actuals.utilities.water.cost + actuals.utilities.gas.cost + actuals.utilities.electricity.cost) / actuals.meals : null, '円'],
          ['1時間あたり売上', plan.totalOperatingHours > 0 ? plan.revenue / plan.totalOperatingHours : null, actuals.revenue !== undefined && actuals.operatingHours ? actuals.revenue / actuals.operatingHours : null, '円'],
          ['1時間あたり利益', plan.profitPerOperatingHour, derived.operatingProfit !== undefined && actuals.operatingHours ? derived.operatingProfit / actuals.operatingHours : null, '円'],
        ] as const).map(([label, planned, actual, unit]) => <div key={label}><span>{label}</span><strong>予測 {planned === null ? '算出不可' : `${formatNumber(planned, 1)}${unit}`}</strong><b>実績 {actual === null ? '未入力' : `${formatNumber(actual, 1)}${unit}`}</b></div>)}
      </div>
      {revenueAnalysis && <div className="variance-decomposition"><span>販売数量差 {formatYen(revenueAnalysis.quantityVariance)}</span><span>単価・構成差 {formatYen(revenueAnalysis.priceAndMixVariance)}</span>{revenueAnalysis.menuMixVariance !== null && <span>うちメニュー構成差 {formatYen(revenueAnalysis.menuMixVariance)}</span>}</div>}
    </Panel>}

    <Panel title="Resource別実績" caption="購入と使用は別項目です。購入量しかない場合、実使用量へ転用しません。">
      <div className="resource-table-wrap"><table className="resource-table actual-resource-input-table">
        <thead><tr><th>Resource</th><th>購入量</th><th>購入支出</th><th>使用量（任意）</th><th>廃棄量</th><th>廃棄原価</th></tr></thead>
        <tbody>{settings.resources.map((resource) => {
          const record = actuals.resourceRecords.find((item) => item.resourceId === resource.id)
          return <tr key={resource.id}><td><strong>{resource.name}</strong><small>{resource.purchaseUnit}</small></td>
            <td><input type="number" min="0" step="any" value={inputValue(record?.purchasedQuantity)} onChange={(event) => updateResource(resource.id, resource.purchaseUnit, { purchasedQuantity: optionalNumber(event.target.value) })}/></td>
            <td><input type="number" min="0" step="any" value={inputValue(record?.purchaseExpenditure)} onChange={(event) => updateResource(resource.id, resource.purchaseUnit, { purchaseExpenditure: optionalNumber(event.target.value) })}/></td>
            <td><input type="number" min="0" step="any" value={inputValue(record?.usedQuantity)} onChange={(event) => updateResource(resource.id, resource.purchaseUnit, { usedQuantity: optionalNumber(event.target.value), usageUnit: resource.purchaseUnit })}/></td>
            <td><input type="number" min="0" step="any" value={inputValue(record?.wasteQuantity)} onChange={(event) => updateResource(resource.id, resource.purchaseUnit, { wasteQuantity: optionalNumber(event.target.value), wasteUnit: resource.purchaseUnit })}/></td>
            <td><input type="number" min="0" step="any" value={inputValue(record?.wasteCost)} onChange={(event) => updateResource(resource.id, resource.purchaseUnit, { wasteCost: optionalNumber(event.target.value) })}/></td>
          </tr>
        })}</tbody>
      </table></div>
    </Panel>

    {plan && <Panel title="Resource別Variance" caption="予測使用量と実績購入量は異なる列として表示します。">
      <div className="resource-table-wrap"><table className="resource-table resource-variance-table">
        <thead><tr><th>Resource</th><th>予測使用</th><th>実績使用</th><th>購入量 予測 / 実績 / 差</th><th>購入支出差</th><th>単価 予測 / 実績 / 差</th><th>廃棄差</th></tr></thead>
        <tbody>{resourceRows.filter((row) => row.plannedUsageQuantity + row.plannedPurchaseQuantity > 0 || row.actualPurchaseQuantity !== null || row.actualUsageQuantity !== null).map((row) => <tr key={row.resourceId}><td><strong>{row.resourceName}</strong></td><td>{formatNumber(row.plannedUsageQuantity, 2)} {row.unit}</td><td>{row.actualUsageQuantity === null ? '未入力' : `${formatNumber(row.actualUsageQuantity, 2)} ${row.unit}`}</td><td>{formatNumber(row.plannedPurchaseQuantity, 2)} / {row.actualPurchaseQuantity === null ? '未入力' : formatNumber(row.actualPurchaseQuantity, 2)} / {row.purchaseQuantityDifference === null ? '算出不可' : formatNumber(row.purchaseQuantityDifference, 2)} {row.unit}</td><td>{row.actualPurchaseExpenditure === null ? '未入力' : formatYen(row.actualPurchaseExpenditure - row.plannedPurchaseExpenditure)}</td><td>{row.plannedUnitPrice === null ? '算出不可' : formatNumber(row.plannedUnitPrice, 2)} / {row.actualUnitPrice === null ? '算出不可' : formatNumber(row.actualUnitPrice, 2)} / {row.unitPriceDifference === null ? '算出不可' : formatNumber(row.unitPriceDifference, 2)}円</td><td>{row.wasteQuantityDifference === null ? '未入力' : `${formatNumber(row.wasteQuantityDifference, 2)} ${row.unit}`}</td></tr>)}</tbody>
      </table></div>
    </Panel>}

    {hints.length > 0 && <Panel title="モデル校正の確認候補" caption="差率20%以上の項目について、設定を見直す入口をルールベースで示します。" actions={<Badge tone="warning">±20%以上</Badge>}>
      <div className="calibration-hints">{hints.map((hint) => <article key={hint.key}><strong>{hint.message}</strong><span>確認候補：{hint.candidates.join('・')}</span></article>)}</div>
    </Panel>}
    <div className="calculation-note"><Badge tone="reference">独立データ</Badge><span>Actualを入力してもResource単価、Recipe、Process、MenuItem、営業条件は自動変更されません。</span></div>
  </>
}
