import { createVolumeSeries, simulate } from '../calculations/engine'
import type { AppSettings, PeriodKey, SimulationResult } from '../models/types'
import { formatCompactYen, formatNumber, formatPercent, formatYen } from '../utils/format'
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
    ['仕込み人件費', result.costs.prepLabor],
    ['営業人件費', result.costs.operatingLabor],
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
  </div>
}

export const Dashboard = ({ settings, period, onPeriodChange }: { settings: AppSettings; period: PeriodKey; onPeriodChange: (period: PeriodKey) => void }) => {
  const result = simulate(settings, period)
  const day = simulate(settings, 'day')
  const breakEven = createVolumeSeries(settings).find((item) => item.profit >= 0)?.meals
  const ratioValid = Math.abs(result.menuRatioTotal - 100) < 0.01
  const variableFood = result.costs.directIngredients + result.costs.prepMaterials + result.costs.fryingOil + result.costs.waste

  return <>
    <PageTitle
      eyebrow="OVERVIEW"
      title="今日の商いを、数字で整える。"
      description={`${settings.business.storeName} · ${formatNumber(settings.business.mealsPerDay, 0)}食/日の想定`}
      actions={<PeriodSwitch period={period} onChange={onPeriodChange} />}
    />

    {!ratioValid && <div className="alert warning"><Icon name="info" size={18}/><span>有効なメニュー構成比の合計が {formatNumber(result.menuRatioTotal)}% です。100%に合わせると販売食数と集計が一致します。</span></div>}

    <div className="kpi-grid">
      <KpiCard label="売上" value={formatCompactYen(result.revenue)} note={`メニュー ${formatCompactYen(result.menuRevenue)} + 追加 ${formatCompactYen(result.toppingRevenue)}`} />
      <KpiCard label="総コスト" value={formatCompactYen(result.totalCost)} note={`売上比 ${formatPercent(result.revenue ? result.totalCost / result.revenue : 0)}`} />
      <KpiCard label="営業利益" value={formatCompactYen(result.operatingProfit)} note={`${formatNumber(result.operatingDays, 0)}営業日 · ${formatNumber(result.meals, 0)}食`} tone="accent" />
      <KpiCard label="営業利益率" value={formatPercent(result.operatingMargin)} note={`原価率 ${formatPercent(result.foodCostRate)}`} tone="dark" />
      <KpiCard label="1食平均原価" value={formatYen(result.averageCostPerMeal)} note={`限界原価 ${formatYen(result.marginalCostPerMeal)}`} />
      <KpiCard label="1時間あたり利益" value={formatYen(result.profitPerOperatingHour)} note={`1営業日 ${formatYen(result.profitPerOperatingDay)}`} />
    </div>

    <div className="dashboard-grid">
      <Panel className="chart-panel" title="販売食数と採算ライン" caption="日次の営業利益と、固定費を含む1食平均原価">
        <VolumeChart settings={settings} />
      </Panel>

      <Panel className="insight-panel" title="運営インサイト" caption="現在の設定から見える着眼点">
        <div className="insight-hero"><span><Icon name="trend" size={22}/></span><div><small>概算の黒字化ライン</small><strong>{breakEven ? `${breakEven}食 / 日` : '200食超 / 日'}</strong></div></div>
        <p>現在は1日 <b>{formatNumber(settings.business.mealsPerDay, 0)}食</b> の想定で、営業利益は <b className={day.operatingProfit >= 0 ? 'positive' : 'negative'}>{formatYen(day.operatingProfit)}</b> です。</p>
        <dl className="mini-stats">
          <div><dt>食材・油・廃棄</dt><dd>{formatYen(variableFood / Math.max(1, result.meals))}<small>/ 食</small></dd></div>
          <div><dt>月固定費</dt><dd>{formatCompactYen(result.costs.fixedMonthly / Math.max(result.calendarMonths, 1 / settings.business.operatingDaysPerMonth))}</dd></div>
          <div><dt>営業時間</dt><dd>{formatNumber(settings.business.hoursPerDay)}<small>時間 / 日</small></dd></div>
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
    <div className="calculation-note"><Badge tone="reference">初期参考値</Badge><span>水道・ガス・電気・油・食材価格は概算です。実際の請求書・仕入明細に合わせて各設定画面で変更してください。</span></div>
  </>
}
