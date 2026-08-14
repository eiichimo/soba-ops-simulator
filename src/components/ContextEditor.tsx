import { useMemo, useState } from 'react'
import { buildContextWarnings, contextKeysForDate } from '../calculations/contextEngine'
import { buildDemandObservations, rollingContextForecastBacktest } from '../calculations/forecastEngine'
import { parseLocalDate } from '../calculations/calendar'
import { contextFeaturesForPreset } from '../data/contextDefaults'
import type {
  AppSettings,
  ContextFeature,
  ContextModelPreset,
  ContextTagCategory,
  DayContext,
  HolidayType,
  SpecialBusinessDay,
  WeatherCategory,
} from '../models/types'
import { formatNumber, formatPercent } from '../utils/format'
import { Badge, Button, EmptyState, NumberField, Panel, SelectField, TextField, Toggle } from './ui'

type Props = { settings: AppSettings; onChange: (settings: AppSettings) => void }

const features: Array<{ id: ContextFeature; label: string }> = [
  { id: 'holiday', label: 'Holiday' }, { id: 'dayBeforeHoliday', label: '祝前日' }, { id: 'dayAfterHoliday', label: '祝日翌日' },
  { id: 'longWeekend', label: 'Long Weekend' }, { id: 'monthStart', label: '月初' }, { id: 'monthEnd', label: '月末' },
  { id: 'weather', label: 'Weather Category' }, { id: 'temperature', label: 'Temperature Bucket' }, { id: 'precipitation', label: 'Precipitation Bucket' },
  { id: 'event', label: 'Event / Custom Tag' }, { id: 'store', label: '特殊営業' },
]

const emptyContext = (date: string): DayContext => ({
  date,
  source: 'manual',
  holidayType: 'none',
  events: [],
  specialBusinessDay: 'normal',
})

const contextLabel = (settings: AppSettings, context: DayContext) => {
  const entries: string[] = []
  if (context.holidayType !== 'none') entries.push(context.holidayType)
  if (context.dayBeforeHoliday) entries.push('祝前日')
  if (context.dayAfterHoliday) entries.push('祝日翌日')
  if (context.longWeekend) entries.push('連休')
  if (context.weatherCategory) entries.push(context.weatherCategory)
  entries.push(...context.events.map((event) => settings.contextTags.find((tag) => tag.id === event.tagId)?.name ?? event.tagId))
  if (context.specialBusinessDay !== 'normal') entries.push(context.specialBusinessDay)
  return entries.join(' / ') || 'Contextなし'
}

export const ContextEditor = ({ settings, onChange }: Props) => {
  const [draft, setDraft] = useState<DayContext>(emptyContext(settings.business.simulationStartDate))
  const [eventTagId, setEventTagId] = useState('')
  const [tagName, setTagName] = useState('')
  const [tagCategory, setTagCategory] = useState<ContextTagCategory>('event')
  const [selectedEffect, setSelectedEffect] = useState('')
  const observations = useMemo(() => buildDemandObservations(settings), [settings])
  const comparison = useMemo(() => rollingContextForecastBacktest(settings, observations), [settings, observations])
  const presetComparisons = useMemo(() => (['baseOnly', 'calendar', 'weather', 'calendarWeather', 'custom'] as ContextModelPreset[]).map((preset) => {
    const contextSettings = { ...settings.contextForecastSettings, preset, enabledContexts: preset === 'custom' ? settings.contextForecastSettings.enabledContexts : contextFeaturesForPreset(preset) }
    return { preset, result: rollingContextForecastBacktest(settings, observations, settings.forecastSettings.method, contextSettings) }
  }), [settings, observations])
  const warnings = useMemo(() => buildContextWarnings(settings, observations, comparison.effects, comparison.base.mae, comparison.context.mae), [settings, observations, comparison])
  const effectDetail = comparison.effects.find((effect) => effect.contextKey === selectedEffect)
  const detailRows = effectDetail ? comparison.base.details.filter((detail) => {
    const context = settings.dayContexts.find((item) => item.date === detail.date)
    return contextKeysForDate(context, settings.contextTags, detail.date, settings.contextForecastSettings).some((item) => item.key === effectDetail.contextKey)
  }) : []

  const saveContext = () => {
    if (!parseLocalDate(draft.date)) return
    const next = { ...draft, events: eventTagId ? [...new Map([...draft.events, { tagId: eventTagId }].map((item) => [item.tagId, item])).values()] : draft.events }
    const exists = settings.dayContexts.some((item) => item.date === next.date)
    onChange({ ...settings, dayContexts: exists ? settings.dayContexts.map((item) => item.date === next.date ? next : item) : [...settings.dayContexts, next].sort((left, right) => left.date.localeCompare(right.date)) })
    setDraft(emptyContext(next.date))
    setEventTagId('')
  }

  const addTag = () => {
    if (!tagName.trim()) return
    const tag = { id: `context-tag-${Date.now()}`, name: tagName.trim(), category: tagCategory }
    onChange({ ...settings, contextTags: [...settings.contextTags, tag] })
    setTagName('')
    setEventTagId(tag.id)
  }

  const updatePreset = (preset: ContextModelPreset) => onChange({
    ...settings,
    contextForecastSettings: {
      ...settings.contextForecastSettings,
      preset,
      enabledContexts: preset === 'custom' ? settings.contextForecastSettings.enabledContexts : contextFeaturesForPreset(preset),
    },
  })

  const toggleFeature = (feature: ContextFeature, checked: boolean) => onChange({
    ...settings,
    contextForecastSettings: {
      ...settings.contextForecastSettings,
      preset: 'custom',
      enabledContexts: checked ? [...new Set([...settings.contextForecastSettings.enabledContexts, feature])] : settings.contextForecastSettings.enabledContexts.filter((item) => item !== feature),
    },
  })

  return <>
    <div className="calculation-note"><Badge tone="reference">correlation ≠ causation</Badge><span>Contextは需要倍率を決めません。各日のBase Forecast residualから傾向を測り、Rolling Backtest上の改善・悪化を確認します。</span></div>
    <Panel title="Day Context Editor" caption="過去・未来のどちらにも登録できます。未来Weatherは仮定条件であり、外部APIから取得しません。">
      <div className="form-grid form-grid-4">
        <TextField type="date" label="日付" value={draft.date} onChange={(event) => setDraft({ ...draft, date: event.target.value })}/>
        <SelectField label="Holiday" value={draft.holidayType} onChange={(event) => setDraft({ ...draft, holidayType: event.target.value as HolidayType })}><option value="none">none</option><option value="holiday">holiday</option><option value="substituteHoliday">substituteHoliday</option><option value="customHoliday">customHoliday</option></SelectField>
        <SelectField label="Weather" value={draft.weatherCategory ?? ''} onChange={(event) => setDraft({ ...draft, weatherCategory: event.target.value ? event.target.value as WeatherCategory : undefined })}><option value="">未入力</option><option value="unknown">unknown</option><option value="clear">clear</option><option value="cloudy">cloudy</option><option value="rain">rain</option><option value="snow">snow</option><option value="other">other</option></SelectField>
        <SelectField label="特殊営業" value={draft.specialBusinessDay} onChange={(event) => setDraft({ ...draft, specialBusinessDay: event.target.value as SpecialBusinessDay })}><option value="normal">normal</option><option value="shortened">shortened</option><option value="extended">extended</option><option value="temporaryClosure">temporaryClosure</option><option value="specialOperation">specialOperation</option></SelectField>
        <NumberField label="代表気温" suffix="℃" value={draft.temperatureC ?? ''} onChange={(event) => setDraft({ ...draft, temperatureC: event.target.value === '' ? undefined : Number(event.target.value) })}/>
        <NumberField label="降水量" suffix="mm" min={0} value={draft.precipitationMm ?? ''} onChange={(event) => setDraft({ ...draft, precipitationMm: event.target.value === '' ? undefined : Number(event.target.value) })}/>
        <SelectField label="Event Tag" value={eventTagId} onChange={(event) => setEventTagId(event.target.value)}><option value="">なし</option>{settings.contextTags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</SelectField>
        <TextField label="メモ" value={draft.notes ?? ''} onChange={(event) => setDraft({ ...draft, notes: event.target.value || undefined })}/>
      </div>
      <div className="period-check-grid"><Toggle label="祝前日" checked={draft.dayBeforeHoliday ?? false} onChange={(checked) => setDraft({ ...draft, dayBeforeHoliday: checked })}/><Toggle label="祝日翌日" checked={draft.dayAfterHoliday ?? false} onChange={(checked) => setDraft({ ...draft, dayAfterHoliday: checked })}/><Toggle label="Long Weekend" checked={draft.longWeekend ?? false} onChange={(checked) => setDraft({ ...draft, longWeekend: checked })}/><Toggle label="Promotion" checked={draft.promotion ?? false} onChange={(checked) => setDraft({ ...draft, promotion: checked })}/><Toggle label="Equipment Trouble" checked={draft.equipmentTrouble ?? false} onChange={(checked) => setDraft({ ...draft, equipmentTrouble: checked })}/><Toggle label="通常外運営" checked={draft.unusualOperation ?? false} onChange={(checked) => setDraft({ ...draft, unusualOperation: checked })}/><Toggle label="Effect推定から除外" checked={draft.excludedFromEffect ?? false} onChange={(checked) => setDraft({ ...draft, excludedFromEffect: checked })}/></div>
      <div className="page-action-row"><Button variant="primary" onClick={saveContext}>DayContextを保存</Button><span>同一日付は上書きしますがActualは変更しません。</span></div>
    </Panel>

    <Panel title="Context Tags" caption="Event importanceは記録できますが、補正倍率には使いません。">
      <div className="form-grid form-grid-3"><TextField label="Tag名" value={tagName} onChange={(event) => setTagName(event.target.value)}/><SelectField label="Category" value={tagCategory} onChange={(event) => setTagCategory(event.target.value as ContextTagCategory)}><option value="event">event</option><option value="custom">custom</option><option value="store">store</option></SelectField><Button onClick={addTag}>Tag追加</Button></div>
      <div className="page-action-row">{settings.contextTags.map((tag) => <Badge key={tag.id}>{tag.name} · {tag.category}</Badge>)}</div>
    </Panel>

    <Panel title="Context履歴" caption="Context occurrence除外はActual/Forecast Observation除外とは独立です。">
      {settings.dayContexts.length === 0 ? <EmptyState>DayContextはまだありません。手入力または実績・校正画面のdayContext CSVから登録できます。</EmptyState> : <div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>日付</th><th>Source</th><th>Context</th><th>代表気温 / 降水</th><th>Effect</th><th/></tr></thead><tbody>{settings.dayContexts.map((context) => <tr key={context.date}><td>{context.date}</td><td>{context.source}</td><td>{contextLabel(settings, context)}<small>{context.notes}</small></td><td>{context.temperatureC ?? '—'}℃ / {context.precipitationMm ?? '—'}mm</td><td>{context.excludedFromEffect ? '除外' : '使用'}</td><td><div className="page-action-row"><Button onClick={() => { setDraft(structuredClone(context)); setEventTagId(context.events[0]?.tagId ?? '') }}>編集</Button><Button variant="danger" onClick={() => onChange({ ...settings, dayContexts: settings.dayContexts.filter((item) => item.date !== context.date) })}>削除</Button></div></td></tr>)}</tbody></table></div>}
    </Panel>

    <Panel title="Context Forecast Settings" caption="全Contextを自動採用しません。選択したFeatureだけを加法補正します。">
      <div className="form-grid form-grid-3"><SelectField label="Preset" value={settings.contextForecastSettings.preset} onChange={(event) => updatePreset(event.target.value as ContextModelPreset)}><option value="baseOnly">Base only</option><option value="calendar">Calendar</option><option value="weather">Weather</option><option value="calendarWeather">Calendar + Weather</option><option value="custom">Custom</option></SelectField><NumberField label="最低Context件数" min={1} value={settings.contextForecastSettings.minimumContextObservations} onChange={(event) => onChange({ ...settings, contextForecastSettings: { ...settings.contextForecastSettings, minimumContextObservations: Number(event.target.value) } })}/><NumberField label="最大補正（任意）" suffix="人" min={0} disabled={!settings.contextForecastSettings.adjustmentCapEnabled} value={settings.contextForecastSettings.maximumAbsoluteAdjustment ?? 30} onChange={(event) => onChange({ ...settings, contextForecastSettings: { ...settings.contextForecastSettings, maximumAbsoluteAdjustment: Number(event.target.value) } })}/></div>
      <div className="period-check-grid">{features.map((feature) => <Toggle key={feature.id} label={feature.label} checked={settings.contextForecastSettings.enabledContexts.includes(feature.id)} onChange={(checked) => toggleFeature(feature.id, checked)}/>)}</div>
      <div className="period-check-grid"><Toggle label="censoredをContext推定へ含める" checked={settings.contextForecastSettings.includeCensored} onChange={(checked) => onChange({ ...settings, contextForecastSettings: { ...settings.contextForecastSettings, includeCensored: checked } })}/><Toggle label="limited dayを含める" checked={settings.contextForecastSettings.includeLimitedDays} onChange={(checked) => onChange({ ...settings, contextForecastSettings: { ...settings.contextForecastSettings, includeLimitedDays: checked } })}/><Toggle label="補正Capを有効化" checked={settings.contextForecastSettings.adjustmentCapEnabled} onChange={(checked) => onChange({ ...settings, contextForecastSettings: { ...settings.contextForecastSettings, adjustmentCapEnabled: checked } })}/></div>
    </Panel>

    {warnings.length > 0 && <div className="import-issues">{warnings.map((warning, index) => <div className="alert warning" key={`${warning.code}-${index}`}>{warning.message}</div>)}</div>}

    <Panel title="Base vs Context Rolling Backtest" caption="正値はContext追加で誤差が縮小、負値は悪化です。因果関係ではなくBacktest上の観測結果です。">
      <div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>Model</th><th>MAE</th><th>RMSE</th><th>Bias</th><th>WAPE</th><th>Coverage</th></tr></thead><tbody><tr><td>Base</td><td>{formatNumber(comparison.base.mae ?? 0, 2)}</td><td>{formatNumber(comparison.base.rmse ?? 0, 2)}</td><td>{formatNumber(comparison.base.bias ?? 0, 2)}</td><td>{comparison.base.wape === null ? '—' : formatPercent(comparison.base.wape)}</td><td>{comparison.base.intervalCoverage === null ? '—' : formatPercent(comparison.base.intervalCoverage)}</td></tr><tr><td>Context</td><td>{formatNumber(comparison.context.mae ?? 0, 2)}</td><td>{formatNumber(comparison.context.rmse ?? 0, 2)}</td><td>{formatNumber(comparison.context.bias ?? 0, 2)}</td><td>{comparison.context.wape === null ? '—' : formatPercent(comparison.context.wape)}</td><td>{comparison.context.intervalCoverage === null ? '—' : formatPercent(comparison.context.intervalCoverage)}</td></tr><tr><td>改善</td><td>{formatNumber(comparison.improvement.mae ?? 0, 2)}</td><td>{formatNumber(comparison.improvement.rmse ?? 0, 2)}</td><td>{formatNumber(comparison.improvement.bias ?? 0, 2)}</td><td>{comparison.improvement.wape === null ? '—' : formatPercent(comparison.improvement.wape)}</td><td>—</td></tr></tbody></table></div>
      <h3>Preset比較</h3><div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>Context Set</th><th>MAE</th><th>Baseとの差</th><th>件数</th></tr></thead><tbody>{presetComparisons.map(({ preset, result }) => <tr key={preset}><td>{preset}</td><td>{result.context.mae === null ? '—' : formatNumber(result.context.mae, 2)}</td><td>{result.improvement.mae === null ? '—' : formatNumber(result.improvement.mae, 2)}</td><td>{result.context.count}</td></tr>)}</tbody></table></div>
    </Panel>

    <Panel title="Context Effect" caption="各日のBase Forecast residual（Actual − Base）をContext別に平均します。同じ曜日差はBase Forecast側で先に扱います。">
      {comparison.effects.length === 0 ? <EmptyState>選択Contextに対応する履歴がありません。</EmptyState> : <div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>Context</th><th>件数</th><th>平均Residual</th><th>標準偏差</th><th>範囲</th><th>曜日</th><th/></tr></thead><tbody>{comparison.effects.map((effect) => <tr key={effect.contextKey}><td>{effect.label}</td><td>{effect.observationCount}{!effect.sufficientData && <small>履歴不足</small>}</td><td className={effect.meanResidual >= 0 ? 'positive' : 'negative'}>{effect.meanResidual >= 0 ? '+' : ''}{formatNumber(effect.meanResidual, 1)}人</td><td>{formatNumber(effect.standardDeviation, 1)}</td><td>{formatNumber(effect.minimumResidual, 1)}〜{formatNumber(effect.maximumResidual, 1)}</td><td>{effect.weekdays.length}種</td><td><Button onClick={() => setSelectedEffect(effect.contextKey)}>根拠</Button></td></tr>)}</tbody></table></div>}
      {effectDetail && <div className="resource-table-wrap"><h3>{effectDetail.label}の根拠日</h3><table className="resource-table"><thead><tr><th>日付</th><th>Actual</th><th>Base Forecast</th><th>Residual</th></tr></thead><tbody>{detailRows.map((row) => <tr key={row.date}><td>{row.date}</td><td>{formatNumber(row.actual, 1)}</td><td>{formatNumber(row.forecast, 1)}</td><td>{formatNumber(row.residual, 1)}</td></tr>)}</tbody></table></div>}
    </Panel>
  </>
}
