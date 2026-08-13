import { createVolumeSeries, simulate } from '../calculations/engine'
import type { AppSettings, PeriodKey, SimulationResult } from '../models/types'
import { formatCompactYen, formatNumber, formatPercent, formatYen } from '../utils/format'
import { validateSettings } from '../validation/settingsValidation'
import { Badge, Icon, PageTitle, Panel } from './ui'
import { VolumeChart } from './VolumeChart'

const periodNames: Record<PeriodKey, string> = {
  day: '1日',
  month: '30日',
  quarter: '3か月',
  halfYear: '6か月',
  year: '1年',
}

const KpiCard = ({ label, value, note, tone = 'default' }: { label: string; value: string; note: string; tone?: 'default' | 'accent' | 'dark' }) => (
  <article className={`kpi-card kpi-${tone}`}>
    <p>{label}</p>
    <strong>{value}</strong>
    <span>{note}</span>
  </article>
)

const CostRow = ({ label, value, total, color }: { label: string; value: number; total: number; color: string }) => {
  const percentage = total > 0 ? value / total * 100 : 0
  return <div className="cost-row">
    <span className="cost-dot-label"><i style={{ background: color }} />{label}</span>
    <span>{formatYen(value)}</span>
    <div className="cost-bar"><i style={{ width: `${Math.min(100, percentage)}%`, background: color }} /></div>
    <small>{formatNumber(percentage)}%</small>
  </div>
}

export const PeriodSwitch = ({ period, onChange }: { period: PeriodKey; onChange: (period: PeriodKey) => void }) => (
  <div className="period-switch" role="group" aria-label="集計期間">
    {(Object.keys(periodNames) as PeriodKey[]).map((key) => <button key={key} className={period === key ? 'active' : ''} onClick={() => onChange(key)}>{periodNames[key]}</button>)}
  </div>
)

export const ResultsTable = ({ result }: { result: SimulationResult }) => {
  const rows = [
    ['原材料費', result.costs.directIngredients],
    ['仕込み材料費', result.costs.prepMaterials],
    ['追加仕込み人件費', result.costs.prepLabor],
    ['シフト人件費', result.costs.operatingLabor],
    ['水道費', result.costs.water],
    ['ガス費', result.costs.gas],
    ['電気代', result.costs.electricity],
    ['揚げ油費', result.costs.fryingOil],
    ['廃棄費', result.costs.waste],
    ['その他費用', result.costs.other],
    ['月固定費配賦', result.costs.fixedMonthly],
  ] as const
  return <div className="result-table">
    {rows.map(([label, value]) => <div key={label}><span>{label}</span><strong>{formatYen(value)}</strong></div>)}
    <div className="result-total"><span>総コスト</span><strong>{formatYen(result.totalCost)}</strong></div>
    <div><span>粗利益</span><strong>{formatYen(result.grossProfit)}</strong></div>
    <div className="result-profit"><span>営業利益</span><strong>{formatYen(result.operatingProfit)}</strong></div>
    <div className="result-allocation"><span>購入支出（費用へ非加算）</span><strong>{formatYen(result.inventory.purchaseExpenditure)}</strong></div>
    <div className="result-allocation"><span>仕込み作業配賦額（非加算）</span><strong>{formatYen(result.labor.prepLaborAllocation)}</strong></div>
    <div className="result-allocation"><span>限界人件費（意思決定）</span><strong>{formatYen(result.labor.marginalPrepLaborCost)}</strong></div>
  </div>
}

const CalculationDetails = ({ result }: { result: SimulationResult }) => <details className="calculation-details">
  <summary><span><Icon name="recipe" size={18}/>計算詳細・検算内訳</span><small>Resource → Process → Consumption の根拠を表示</small></summary>
  <div className="calculation-details-body">
    <div className="detail-summary-grid">
      <div><span>販売食数</span><strong>{formatNumber(result.details.meals, 1)}食</strong></div>
      <div><span>営業日数</span><strong>{result.operatingDays}日</strong></div>
      <div><span>総営業時間</span><strong>{formatNumber(result.totalOperatingHours, 1)}時間</strong></div>
      <div><span>暦日数</span><strong>{result.calendarDays}日</strong></div>
    </div>
    <div className="detail-columns">
      <section><h3>メニュー別販売・売上</h3><div className="detail-table">{result.details.menus.map((menu) => <div key={menu.id}><span>{menu.name}</span><b>{formatNumber(menu.servings, 1)}食</b><strong>{formatYen(menu.revenue)}</strong></div>)}</div></section>
      <section><h3>Resource別使用量・使用原価</h3><div className="detail-table">{result.details.resources.map((resource) => <div key={resource.id}><span>{resource.name}</span><b>{formatNumber(resource.quantity, 3)} {resource.unit}</b><strong>{formatYen(resource.usageCost)}</strong></div>)}</div></section>
    </div>
    <section><h3>Process別バッチ・作業</h3><div className="detail-table process-detail-table">{result.details.processes.map((process) => <div key={process.id}><span>{process.name}</span><b>{formatNumber(process.batches, 1)} batch</b><b>材料 {formatYen(process.materialCost)}</b><b>{formatNumber(process.activeLaborMinutes / 60, 2)}時間</b><strong>配賦 {formatYen(process.laborAllocation)} / 追加 {formatYen(process.additionalLaborCost)}</strong></div>)}</div></section>
    <section><h3>水道光熱・揚げ油使用量</h3><div className="detail-utility-grid">
      <div><span>水道</span><b>{formatNumber(result.details.utilities.water.quantity, 2)} L</b><strong>{formatYen(result.details.utilities.water.usageCost)}</strong></div>
      <div><span>ガス</span><b>{formatNumber(result.details.utilities.gas.quantity, 3)} m³</b><strong>{formatYen(result.details.utilities.gas.usageCost)}</strong></div>
      <div><span>電力</span><b>{formatNumber(result.details.utilities.electricity.quantity, 2)} kWh</b><strong>{formatYen(result.details.utilities.electricity.usageCost)}</strong></div>
      <div><span>揚げ油</span><b>{formatNumber(result.details.fryingOilLiters, 2)} L</b><strong>{formatYen(result.details.fryingOilCost)}</strong></div>
    </div></section>
    <section><h3>Resource / Output別 在庫フロー</h3><div className="resource-table-wrap"><table className="resource-table inventory-detail-table">
      <thead><tr><th>在庫品</th><th>期首</th><th>購入</th><th>内製</th><th>副産物</th><th>使用</th><th>廃棄</th><th>期末</th><th>使用原価</th><th>購入支出</th></tr></thead>
      <tbody>{result.inventory.items.filter((item) => item.openingQuantity + item.purchasedQuantity + item.producedQuantity + item.byProductQuantity + item.consumedQuantity + item.wastedQuantity + item.endingQuantity > 0).map((item) => <tr key={`${item.sourceType}:${item.sourceId}`}>
        <td><strong>{item.name}</strong></td><td>{formatNumber(item.openingQuantity, 2)}</td><td>{formatNumber(item.purchasedQuantity, 2)}</td><td>{formatNumber(item.producedQuantity, 2)}</td><td>{formatNumber(item.byProductQuantity, 2)}</td><td>{formatNumber(item.consumedQuantity, 2)}</td><td>{formatNumber(item.wastedQuantity, 2)}</td><td>{formatNumber(item.endingQuantity, 2)} {item.unit}</td><td>{formatYen(item.usageCost)}</td><td>{formatYen(item.purchaseExpenditure)}</td>
      </tr>)}</tbody>
    </table></div></section>
  </div>
</details>

export const Dashboard = ({ settings, period, onPeriodChange }: { settings: AppSettings; period: PeriodKey; onPeriodChange: (period: PeriodKey) => void }) => {
  const result = simulate(settings, period)
  const day = simulate(settings, 'day')
  const breakEven = createVolumeSeries(settings).find((item) => item.profit >= 0)?.meals
  const runtimeWarnings = [
    ...(result.inventory.wasteCost > Math.max(1_000, result.inventory.usageCost * 0.25) ? [{ severity: 'warning' as const, code: 'high-inventory-waste', message: `期間中の廃棄原価が${formatYen(result.inventory.wasteCost)}です。保存期限・仕込みバッチ・購入packageを確認してください。`, path: undefined }] : []),
    ...(result.inventory.endingInventoryValue > Math.max(result.revenue, result.inventory.purchaseExpenditure * 2, 100_000) ? [{ severity: 'warning' as const, code: 'large-ending-inventory', message: `期末在庫価額が${formatYen(result.inventory.endingInventoryValue)}です。過剰在庫の可能性があります。`, path: undefined }] : []),
  ]
  const validationIssues = [...validateSettings(settings), ...runtimeWarnings]
  const validationErrors = validationIssues.filter((validationIssue) => validationIssue.severity === 'error')
  const calculationErrors = validationErrors.filter((validationIssue) => !validationIssue.code.includes('actual') && !validationIssue.code.includes('scenario'))
  const validationWarnings = validationIssues.filter((validationIssue) => validationIssue.severity === 'warning')
  const variableFood = result.costs.directIngredients + result.costs.prepMaterials + result.costs.fryingOil + result.costs.waste

  return <>
    <PageTitle
      eyebrow="OVERVIEW"
      title="今日の商いを、数字で整える。"
      description={`${settings.business.storeName} · ${formatNumber(settings.business.mealsPerDay, 0)}食/日の想定`}
      actions={<PeriodSwitch period={period} onChange={onPeriodChange} />}
    />

    {validationIssues.length > 0 && <details className={`validation-summary ${validationErrors.length ? 'has-errors' : ''}`} open={validationErrors.length > 0}>
      <summary><Icon name="info" size={18}/><span>{validationErrors.length > 0 ? calculationErrors.length > 0 ? `計算設定に${calculationErrors.length}件のErrorがあります。結果が不完全な可能性があります。` : `実績またはScenarioに${validationErrors.length}件のErrorがあります。該当比較を確認してください。` : `${validationWarnings.length}件のWarningがあります。`}</span><small>Error {validationErrors.length} / Warning {validationWarnings.length}</small></summary>
      <div>{validationIssues.map((validationIssue, index) => <p className={validationIssue.severity} key={`${validationIssue.code}-${validationIssue.path}-${index}`}><Badge tone={validationIssue.severity === 'error' ? 'warning' : 'reference'}>{validationIssue.severity.toUpperCase()}</Badge><span>{validationIssue.message}</span></p>)}</div>
    </details>}

    <div className="kpi-grid">
      <KpiCard label="売上" value={formatCompactYen(result.revenue)} note={`メニュー ${formatCompactYen(result.menuRevenue)} + 追加 ${formatCompactYen(result.toppingRevenue)}`} />
      <KpiCard label="総コスト" value={formatCompactYen(result.totalCost)} note={`売上比 ${formatPercent(result.revenue ? result.totalCost / result.revenue : 0)}`} />
      <KpiCard label="営業利益" value={formatCompactYen(result.operatingProfit)} note={`${formatNumber(result.operatingDays, 0)}営業日 · ${formatNumber(result.meals, 0)}食${calculationErrors.length ? ' · 要確認' : ''}`} tone="accent" />
      <KpiCard label="営業利益率" value={formatPercent(result.operatingMargin)} note={`原価率 ${formatPercent(result.foodCostRate)}`} tone="dark" />
      <KpiCard label="1食平均原価" value={formatYen(result.averageCostPerMeal)} note={`限界原価 ${formatYen(result.marginalCostPerMeal)}`} />
      <KpiCard label="1時間あたり利益" value={formatYen(result.profitPerOperatingHour)} note={`1営業日 ${formatYen(result.profitPerOperatingDay)}`} />
    </div>

    <div className="inventory-kpi-grid dashboard-inventory-kpis">
      <div><span>使用原価</span><strong>{formatYen(result.inventory.usageCost)}</strong><small>販売へ払い出した在庫価額</small></div>
      <div><span>購入支出</span><strong>{formatYen(result.inventory.purchaseExpenditure)}</strong><small>{result.inventory.purchaseCount}回購入</small></div>
      <div><span>期首在庫価額</span><strong>{formatYen(result.inventory.openingInventoryValue)}</strong><small>開始日時点</small></div>
      <div><span>期末在庫価額</span><strong>{formatYen(result.inventory.endingInventoryValue)}</strong><small>次期間へ持越し</small></div>
      <div><span>廃棄原価</span><strong>{formatYen(result.inventory.wasteCost)}</strong><small>spoilage・工程ロス</small></div>
      <div className="cash"><span>簡易現金収支</span><strong>{formatYen(result.inventory.simpleCashFlow)}</strong><small>正式なCFではありません</small></div>
    </div>

    <div className="cash-flow-note"><Icon name="info" size={18}/><p><strong>利益と現金の差</strong><span>営業利益は使用した在庫価額を費用とし、簡易現金収支は購入日にpackage代金を全額支出します。期末在庫が残ると両者に差が生じます。</span></p><b>{formatYen(result.inventory.simpleCashFlow - result.operatingProfit)}</b></div>

    <div className="dashboard-grid">
      <Panel className="chart-panel" title="販売食数と採算ライン" caption="日次の営業利益と、固定費を含む1食平均原価">
        <VolumeChart settings={settings} />
      </Panel>

      <Panel className="insight-panel" title="運営インサイト" caption="現在の設定から見える着眼点">
        <div className="insight-hero"><span><Icon name="trend" size={22}/></span><div><small>概算の黒字化ライン</small><strong>{breakEven ? `${breakEven}食 / 日` : '200食超 / 日'}</strong></div></div>
        <p>現在は1日 <b>{formatNumber(settings.business.mealsPerDay, 0)}食</b> の想定で、営業利益は <b className={day.operatingProfit >= 0 ? 'positive' : 'negative'}>{formatYen(day.operatingProfit)}</b> です。</p>
        <dl className="mini-stats">
          <div><dt>食材・油・廃棄</dt><dd>{formatYen(variableFood / Math.max(1, result.meals))}<small>/ 食</small></dd></div>
          <div><dt>固定費 / 暦月相当</dt><dd>{formatCompactYen(result.costs.fixedMonthly / Math.max(result.calendarMonths, 1 / 31))}</dd></div>
          <div><dt>期間総営業時間</dt><dd>{formatNumber(result.totalOperatingHours)}<small>時間</small></dd></div>
        </dl>
      </Panel>
    </div>

    <div className="dashboard-grid lower-grid">
      <Panel title="コスト構成" caption={`${periodNames[period]} · ${formatYen(result.totalCost)}`}>
        <div className="cost-list">
          <CostRow label="食材・仕込み" value={result.costs.directIngredients + result.costs.prepMaterials} total={result.totalCost} color="#bc493a" />
          <CostRow label="人件費" value={result.costs.prepLabor + result.costs.operatingLabor} total={result.totalCost} color="#355f50" />
          <CostRow label="水道光熱・油" value={result.costs.water + result.costs.gas + result.costs.electricity + result.costs.fryingOil} total={result.totalCost} color="#d2a84a" />
          <CostRow label="固定・その他" value={result.costs.fixedMonthly + result.costs.other + result.costs.waste} total={result.totalCost} color="#7f7468" />
        </div>
      </Panel>
      <Panel title="集計明細" caption="計算途中では丸めず、表示時のみ円単位にしています">
        <ResultsTable result={result} />
      </Panel>
    </div>
    <CalculationDetails result={result} />
    <div className="calculation-note"><Badge tone="reference">初期参考値</Badge><span>水道・ガス・電気・油・食材価格は概算です。実際の請求書・仕入明細に合わせて各設定画面で変更してください。</span></div>
  </>
}
