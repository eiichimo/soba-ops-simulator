import { useMemo, useState } from 'react'
import {
  buildDemandObservations,
  buildForecastWarnings,
  compareForecastMethods,
  compareForecastSnapshotActuals,
  createDemandForecast,
  forecastPeriodDistribution,
  forecastToPlanningSettings,
  forecastToScenario,
  selectBestForecastModel,
} from '../calculations/forecastEngine'
import { formatLocalDate, parseLocalDate } from '../calculations/calendar'
import type {
  AppSettings,
  DemandForecast,
  DemandObservation,
  ForecastDemandCase,
  ForecastExclusionReason,
  ForecastMethod,
  ForecastSelectionMetric,
  ForecastSettings,
  ForecastTrainingWindow,
} from '../models/types'
import { formatNumber, formatPercent } from '../utils/format'
import { Badge, Button, EmptyState, NumberField, PageTitle, Panel, SelectField, TextField, Toggle } from './ui'

type Props = { settings: AppSettings; onChange: (settings: AppSettings) => void }
type Tab = 'history' | 'models' | 'future' | 'saved'

const methodLabels: Record<ForecastMethod, string> = {
  naive: 'Naive（直近値）',
  movingAverage: 'Moving Average',
  weightedMovingAverage: 'Weighted Moving Average',
  weekdayAverage: 'Weekday Average',
  weekdayWeightedAverage: 'Weekday Weighted Average',
  weekdayTrend: 'Weekday Trend',
}

const sourceLabels: Record<DemandObservation['source'], string> = {
  guestCount: '実来店人数',
  manual: '明示需要',
  salesCount: '販売数近似',
}

const exclusionLabels: Record<ForecastExclusionReason, string> = {
  temporaryClosure: '臨時休業',
  event: 'イベント',
  equipmentFailure: '設備故障',
  weather: '天候',
  other: 'その他',
}

const addDaysText = (dateText: string, days: number) => {
  const date = parseLocalDate(dateText) ?? new Date()
  return formatLocalDate(new Date(date.getFullYear(), date.getMonth(), date.getDate() + days))
}

const ForecastChart = ({ observations, forecast }: { observations: DemandObservation[]; forecast?: DemandForecast }) => {
  const historical = observations.filter((item) => !item.excluded).map((item) => ({ date: item.date, value: item.value, kind: 'actual' as const }))
  const future = forecast?.forecastPoints.filter((item) => !item.closed).map((item) => ({ date: item.date, value: item.pointForecast, lower: item.lower, upper: item.upper, kind: 'forecast' as const })) ?? []
  const rows = [...historical, ...future]
  if (rows.length < 2) return <EmptyState>グラフ表示には2点以上の履歴または予測が必要です。</EmptyState>
  const width = 900
  const height = 300
  const pad = { left: 62, right: 25, top: 25, bottom: 48 }
  const values = rows.flatMap((row) => row.kind === 'forecast' ? [row.value, row.lower ?? row.value, row.upper ?? row.value] : [row.value])
  const maximum = Math.max(1, ...values)
  const x = (index: number) => pad.left + index / Math.max(1, rows.length - 1) * (width - pad.left - pad.right)
  const y = (value: number) => pad.top + (maximum - value) / maximum * (height - pad.top - pad.bottom)
  const line = (points: Array<{ index: number; value: number }>) => points.map((point) => `${x(point.index)},${y(point.value)}`).join(' ')
  const actualLine = line(rows.flatMap((row, index) => row.kind === 'actual' ? [{ index, value: row.value }] : []))
  const forecastLine = line(rows.flatMap((row, index) => row.kind === 'forecast' ? [{ index, value: row.value }] : []))
  const band = future.length ? [
    ...rows.flatMap((row, index) => row.kind === 'forecast' ? [`${x(index)},${y(row.upper ?? row.value)}`] : []),
    ...rows.flatMap((row, index) => row.kind === 'forecast' ? [{ index, value: row.lower ?? row.value }] : []).reverse().map((point) => `${x(point.index)},${y(point.value)}`),
  ].join(' ') : ''
  return <div className="chart-wrap forecast-chart"><svg role="img" aria-label="履歴需要と将来Forecast" viewBox={`0 0 ${width} ${height}`}>
    {[0, 0.25, 0.5, 0.75, 1].map((ratio) => <g key={ratio}><line className="grid-line" x1={pad.left} x2={width - pad.right} y1={pad.top + ratio * (height - pad.top - pad.bottom)} y2={pad.top + ratio * (height - pad.top - pad.bottom)}/><text className="axis-label" x={pad.left - 9} y={pad.top + ratio * (height - pad.top - pad.bottom) + 4} textAnchor="end">{formatNumber(maximum * (1 - ratio))}</text></g>)}
    {band && <polygon className="forecast-band" points={band} />}
    {actualLine && <polyline className="forecast-actual-line" points={actualLine} />}
    {forecastLine && <polyline className="forecast-point-line" points={forecastLine} />}
    <text className="axis-label" x={pad.left} y={height - 14}>{rows[0].date}</text><text className="axis-label" x={width - pad.right} y={height - 14} textAnchor="end">{rows.at(-1)?.date}</text>
  </svg></div>
}

export const ForecastEditor = ({ settings, onChange }: Props) => {
  const observations = useMemo(() => buildDemandObservations(settings), [settings])
  const modelSummaries = useMemo(() => compareForecastMethods(observations, settings.forecastSettings), [observations, settings.forecastSettings])
  const bestModel = useMemo(() => selectBestForecastModel(modelSummaries, settings.forecastSettings.selectionMetric), [modelSummaries, settings.forecastSettings.selectionMetric])
  const latestDate = observations.at(-1)?.date ?? settings.business.simulationStartDate
  const [tab, setTab] = useState<Tab>('history')
  const [startDate, setStartDate] = useState(addDaysText(latestDate, 1))
  const [forecastName, setForecastName] = useState(`${addDaysText(latestDate, 1)} 需要予測`)
  const [preview, setPreview] = useState<DemandForecast>()
  const [message, setMessage] = useState<string>()

  const updateForecastSettings = (patch: Partial<ForecastSettings>) => {
    setPreview(undefined)
    onChange({ ...settings, forecastSettings: { ...settings.forecastSettings, ...patch } })
  }

  const setExcluded = (observation: DemandObservation, excluded: boolean) => {
    onChange({
      ...settings,
      forecastExclusions: excluded
        ? [...settings.forecastExclusions.filter((item) => item.date !== observation.date), { date: observation.date, reason: observation.exclusionReason ?? 'other' }]
        : settings.forecastExclusions.filter((item) => item.date !== observation.date),
    })
  }

  const updateExclusionReason = (date: string, reason: ForecastExclusionReason) => onChange({
    ...settings,
    forecastExclusions: settings.forecastExclusions.map((item) => item.date === date ? { ...item, reason } : item),
  })

  const generate = () => {
    try {
      const created = createDemandForecast(settings, forecastName.trim() || '需要予測', startDate, settings.forecastSettings.horizonDays, settings.forecastSettings.method)
      setPreview(created)
      setMessage('Forecastを生成しました。保存するまでSnapshotには追加されません。')
    } catch (error) {
      setPreview(undefined)
      setMessage(error instanceof Error ? error.message : 'Forecastを生成できませんでした。')
    }
  }

  const savePreview = () => {
    if (!preview) return
    const saved = structuredClone({ ...preview, id: `${preview.id}-${settings.demandForecasts.length + 1}` })
    onChange({ ...settings, demandForecasts: [...settings.demandForecasts, saved] })
    setPreview(saved)
    setMessage('Forecast Snapshotを保存しました。後からActualが増えても自動更新されません。')
  }

  const saveScenario = (forecast: DemandForecast, demandCase: ForecastDemandCase) => {
    if (settings.scenarios.length >= 5) {
      setMessage('Scenarioは5件です。既存Scenarioを整理してから保存してください。')
      return
    }
    const scenario = forecastToScenario(forecast, demandCase, `${forecast.name} ${demandCase === 'lower' ? '低需要' : demandCase === 'upper' ? '高需要' : demandCase === 'point' ? '中心' : 'bootstrap'}`)
    onChange({ ...settings, scenarios: [...settings.scenarios, scenario] })
    setMessage('ForecastをPlanning Scenarioとして保存しました。Base Demandは変更していません。')
  }

  const applyPlanning = (forecast: DemandForecast) => {
    onChange(forecastToPlanningSettings(settings, forecast, 'point'))
    setMessage('中心ForecastをPlanningの日別Overrideへ明示適用しました。Base DemandProfileは変更していません。')
  }

  const deleteForecast = (forecast: DemandForecast) => {
    const referenced = settings.planning.demandSource.forecastId === forecast.id
      || settings.optimizationStudies.some((study) => study.demandForecastId === forecast.id)
      || settings.scenarios.some((scenario) => scenario.overrides.planningDemandSource?.forecastId === forecast.id)
    if (referenced) {
      setMessage('このForecastはPlanning・Optimization・Scenarioから参照されています。参照を解除してから削除してください。')
      return
    }
    onChange({ ...settings, demandForecasts: settings.demandForecasts.filter((item) => item.id !== forecast.id) })
    setMessage('Forecast Snapshotを削除しました。Base設定には影響しません。')
  }

  const warnings = buildForecastWarnings(settings, observations, preview?.backtestSummary ?? bestModel, preview)
  const distribution = preview && preview.backtestSummary.residuals.length
    ? forecastPeriodDistribution(preview, settings.forecastSettings.bootstrapRuns, settings.capacity.stochasticDemand.seed)
    : null

  return <>
    <PageTitle eyebrow="HISTORICAL DEMAND / FORECAST / VALIDATION" title="需要予測" description="Actualから需要系列を作り、Rolling Backtestで説明可能なモデルを比較します。Forecastは推定値であり、Base需要を自動変更しません。"/>
    <div className="period-switch accuracy-tabs">{([['history', '履歴'], ['models', 'モデル比較'], ['future', '将来予測'], ['saved', '予測履歴']] as const).map(([id, label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}</div>
    {message && <div className="calculation-note"><Badge tone="reference">Forecast</Badge><span>{message}</span></div>}

    {tab === 'history' && <>
      <Panel title="需要Observation" caption="実来店人数 → 明示需要 → 販売食数の順で使用します。censored値は補正せず、販売数のまま保持します。">
        {observations.length ? <div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>日付</th><th>曜日</th><th>Observation</th><th>Source</th><th>Quality</th><th>参考下限</th><th>学習</th><th>除外理由</th></tr></thead><tbody>{observations.map((observation) => <tr key={observation.id}><td>{observation.date}</td><td>{parseLocalDate(observation.date)?.toLocaleDateString('ja-JP', { weekday: 'short' })}</td><td><strong>{formatNumber(observation.value, 1)}人</strong></td><td>{sourceLabels[observation.source]}</td><td><Badge tone={observation.quality === 'good' ? 'positive' : 'warning'}>{observation.quality}</Badge>{observation.censoredReasons.length > 0 && <small>{observation.censoredReasons.join(' / ')}</small>}</td><td>{observation.possibleDemandFloor === undefined ? '—' : `少なくとも${formatNumber(observation.possibleDemandFloor, 1)}相当`}</td><td><Toggle checked={!observation.excluded} onChange={(checked) => setExcluded(observation, !checked)} label={observation.excluded ? '除外' : '使用'}/></td><td>{observation.excluded ? <select value={observation.exclusionReason ?? 'other'} onChange={(event) => updateExclusionReason(observation.date, event.target.value as ForecastExclusionReason)}>{Object.entries(exclusionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> : '—'}</td></tr>)}</tbody></table></div> : <EmptyState>需要履歴がありません。単日Actualへ実来店人数を入力するか、売上CSVをImportしてください。</EmptyState>}
      </Panel>
      <Panel title="Historical Demand" caption="外れ値候補は自動削除しません。学習から除外するかはユーザーが判断します。"><ForecastChart observations={observations}/></Panel>
    </>}

    {tab === 'models' && <>
      <Panel title="Training / Model Settings" caption="営業日のみを対象にし、Forecast対象日より後のActualは使用しません。">
        <div className="form-grid form-grid-4">
          <SelectField label="Training Window" value={settings.forecastSettings.trainingWindow} onChange={(event) => updateForecastSettings({ trainingWindow: event.target.value as ForecastTrainingWindow })}><option value="all">全履歴</option><option value="last4Weeks">直近4週</option><option value="last8Weeks">直近8週</option><option value="last12Weeks">直近12週</option><option value="custom">カスタム</option></SelectField>
          <NumberField label="Window size" suffix="営業日 / 同曜日" min={1} value={settings.forecastSettings.windowSize} onChange={(event) => updateForecastSettings({ windowSize: Math.max(1, Math.trunc(Number(event.target.value))) })}/>
          <NumberField label="最低Observation" min={1} value={settings.forecastSettings.minimumObservations} onChange={(event) => updateForecastSettings({ minimumObservations: Math.max(1, Math.trunc(Number(event.target.value))) })}/>
          <SelectField label="選択指標" value={settings.forecastSettings.selectionMetric} onChange={(event) => updateForecastSettings({ selectionMetric: event.target.value as ForecastSelectionMetric })}><option value="mae">MAE</option><option value="rmse">RMSE</option><option value="wape">WAPE</option></SelectField>
          {settings.forecastSettings.trainingWindow === 'custom' && <><TextField label="Training開始" type="date" value={settings.forecastSettings.trainingStart ?? ''} onChange={(event) => updateForecastSettings({ trainingStart: event.target.value })}/><TextField label="Training終了" type="date" value={settings.forecastSettings.trainingEnd ?? ''} onChange={(event) => updateForecastSettings({ trainingEnd: event.target.value })}/></>}
        </div>
        <div className="page-action-row"><Toggle checked={settings.forecastSettings.includeCensored} onChange={(checked) => updateForecastSettings({ includeCensored: checked })} label="censoredを学習に含める"/><Toggle checked={settings.forecastSettings.includeLimitedDays} onChange={(checked) => updateForecastSettings({ includeLimitedDays: checked })} label="不完全営業日を含める"/></div>
      </Panel>
      <Panel title="Rolling-origin Backtest" caption="MAE・RMSEは食数、Biasはforecast−actual（正なら過大予測）、WAPEは総絶対誤差÷総実績です。">
        <div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>Model</th><th>MAE</th><th>RMSE</th><th>Bias</th><th>WAPE</th><th>Coverage</th><th>件数</th><th/></tr></thead><tbody>{modelSummaries.map((summary) => <tr key={summary.method}><td><strong>{methodLabels[summary.method]}</strong>{bestModel?.method === summary.method && <Badge tone="positive">{settings.forecastSettings.selectionMetric.toUpperCase()}最小</Badge>}</td><td>{summary.mae === null ? '算出不可' : formatNumber(summary.mae, 2)}</td><td>{summary.rmse === null ? '算出不可' : formatNumber(summary.rmse, 2)}</td><td>{summary.bias === null ? '算出不可' : formatNumber(summary.bias, 2)}</td><td>{summary.wape === null ? '算出不可' : formatPercent(summary.wape)}</td><td>{summary.intervalCoverage === null ? '算出不可' : formatPercent(summary.intervalCoverage)}</td><td>{summary.count}</td><td><Button onClick={() => updateForecastSettings({ method: summary.method })}>{settings.forecastSettings.method === summary.method ? '選択中' : '使用'}</Button></td></tr>)}</tbody></table></div>
        {bestModel && <details><summary>Backtest明細（{methodLabels[bestModel.method]}）</summary><div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>Forecast日</th><th>Training終了</th><th>Forecast</th><th>Actual</th><th>Error</th><th>Fallback</th></tr></thead><tbody>{bestModel.details.map((point) => <tr key={point.date}><td>{point.date}</td><td>{point.trainingEndDate}</td><td>{formatNumber(point.forecast, 1)}</td><td>{formatNumber(point.actual, 1)}</td><td>{formatNumber(point.error, 1)}</td><td>{point.fallbackMethod ? methodLabels[point.fallbackMethod] : '—'}</td></tr>)}</tbody></table></div></details>}
      </Panel>
    </>}

    {tab === 'future' && <>
      <Panel title="将来Forecast" caption="Point Forecastと、Rolling Backtest residualの経験分布による幅を生成します。厳密な信頼区間ではありません。" actions={<Button variant="primary" onClick={generate}>Forecast実行</Button>}>
        <div className="form-grid form-grid-4">
          <TextField label="Forecast名" value={forecastName} onChange={(event) => setForecastName(event.target.value)}/>
          <TextField label="開始日" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)}/>
          <NumberField label="Horizon" suffix="暦日" min={1} value={settings.forecastSettings.horizonDays} onChange={(event) => updateForecastSettings({ horizonDays: Math.max(1, Math.trunc(Number(event.target.value))) })}/>
          <SelectField label="Method" value={settings.forecastSettings.method} onChange={(event) => updateForecastSettings({ method: event.target.value as ForecastMethod })}>{Object.entries(methodLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</SelectField>
          <NumberField label="Interval最低Residual" min={1} value={settings.forecastSettings.minimumIntervalResiduals} onChange={(event) => updateForecastSettings({ minimumIntervalResiduals: Math.max(1, Math.trunc(Number(event.target.value))) })}/>
          <SelectField label="Menu Mix" value={settings.forecastSettings.menuMixMethod} onChange={(event) => updateForecastSettings({ menuMixMethod: event.target.value as ForecastSettings['menuMixMethod'] })}><option value="weekday">曜日別構成比</option><option value="recent">直近構成比</option></SelectField>
        </div>
      </Panel>
      {warnings.length > 0 && <div className="capacity-warning-list">{warnings.map((warning) => <div key={warning.code}><Badge tone="warning">確認</Badge><span>{warning.message}</span></div>)}</div>}
      {preview ? <>
        <div className="dashboard-grid"><article className="kpi-card"><span>使用モデル</span><strong>{methodLabels[preview.method]}</strong></article><article className="kpi-card"><span>Backtest MAE</span><strong>{preview.backtestSummary.mae === null ? '算出不可' : `${formatNumber(preview.backtestSummary.mae, 1)}食`}</strong></article><article className="kpi-card"><span>Bias</span><strong>{preview.backtestSummary.bias === null ? '算出不可' : `${formatNumber(preview.backtestSummary.bias, 1)}食`}</strong></article><article className="kpi-card"><span>期間中心予測</span><strong>{formatNumber(preview.forecastPoints.reduce((total, point) => total + point.pointForecast, 0), 0)}食</strong></article>{distribution && <article className="kpi-card"><span>期間Residual bootstrap</span><strong>p10 {formatNumber(distribution.p10)} / p90 {formatNumber(distribution.p90)}</strong></article>}</div>
        <Panel title="Forecast Chart" caption="帯は日別の経験的p10〜p90幅です。日別幅の単純合計を期間の確率区間とは扱いません。"><ForecastChart observations={observations} forecast={preview}/></Panel>
        <Panel title="Future Forecast" actions={<Button variant="primary" onClick={savePreview}>Snapshot保存</Button>}><div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>Date</th><th>Weekday</th><th>Point</th><th>Lower</th><th>Upper</th><th>Method</th><th>履歴数</th><th>Menu Mix</th></tr></thead><tbody>{preview.forecastPoints.map((point) => <tr key={point.date}><td>{point.date}</td><td>{parseLocalDate(point.date)?.toLocaleDateString('ja-JP', { weekday: 'short' })}</td><td>{point.closed ? '営業なし' : formatNumber(point.pointForecast, 1)}</td><td>{point.lower === undefined ? '算出不可' : formatNumber(point.lower, 1)}</td><td>{point.upper === undefined ? '算出不可' : formatNumber(point.upper, 1)}</td><td>{point.fallbackMethod ? `${methodLabels[point.method]} → ${methodLabels[point.fallbackMethod]}` : methodLabels[point.method]}</td><td>{point.observationCount}</td><td>{point.menuMixFallback ? 'Base fallback' : point.menuMix.map((mix) => `${settings.menuItems.find((menu) => menu.id === mix.menuItemId)?.name ?? mix.menuItemId} ${formatPercent(mix.ratio)}`).join(' / ')}</td></tr>)}</tbody></table></div></Panel>
      </> : <EmptyState>Forecast実行後に将来日別予測と経験的予測幅を確認できます。</EmptyState>}
    </>}

    {tab === 'saved' && <Panel title="Forecast History" caption="Snapshotは作成時点の値を保持します。後日Actualが増えても書き換えません。">
      {settings.demandForecasts.length ? <div className="editor-list">{settings.demandForecasts.map((forecast) => {
        const comparisons = compareForecastSnapshotActuals(forecast, observations)
        const mae = comparisons.length ? comparisons.reduce((total, row) => total + Math.abs(row.error), 0) / comparisons.length : null
        return <article className="editor-card" key={forecast.id}><div className="editor-card-title"><div><strong>{forecast.name}</strong><small>{forecast.createdAt.slice(0, 16).replace('T', ' ')} · Training {forecast.trainingStart}〜{forecast.trainingEnd}</small></div><Badge tone="reference">{methodLabels[forecast.method]}</Badge></div><div className="form-grid form-grid-4"><div><span>対象期間</span><strong>{forecast.targetStart}〜{forecast.targetEnd}</strong></div><div><span>Backtest MAE</span><strong>{forecast.backtestSummary.mae === null ? '算出不可' : `${formatNumber(forecast.backtestSummary.mae, 1)}食`}</strong></div><div><span>Snapshot事後MAE</span><strong>{mae === null ? 'Actual未登録' : `${formatNumber(mae, 1)}食`}</strong></div><div><span>中心合計</span><strong>{formatNumber(forecast.forecastPoints.reduce((total, point) => total + point.pointForecast, 0))}食</strong></div></div><div className="page-action-row"><Button onClick={() => saveScenario(forecast, 'lower')}>低需要Scenario</Button><Button onClick={() => saveScenario(forecast, 'point')}>中心Scenario</Button><Button onClick={() => saveScenario(forecast, 'upper')}>高需要Scenario</Button><Button onClick={() => saveScenario(forecast, 'bootstrap')}>Bootstrap Scenario</Button><Button variant="primary" onClick={() => applyPlanning(forecast)}>Planningへ使用</Button><Button variant="danger" onClick={() => deleteForecast(forecast)}>削除</Button></div></article>
      })}</div> : <EmptyState>保存済みForecast Snapshotはありません。</EmptyState>}
    </Panel>}
    <div className="calculation-note"><Badge tone="warning">定義</Badge><span>Forecast Error（来客需要の誤差）とSimulation Error（費用・利益再現の誤差）は別です。販売数はstockout・離脱・Capacity制約により潜在需要を下回る場合があります。</span></div>
  </>
}

export default ForecastEditor
