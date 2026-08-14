import { useMemo, useState } from 'react'
import {
  applyCalibrationCandidate,
  buildCalibrationCandidates,
  buildCalibrationWarnings,
  calculateBacktestAccuracy,
  calibrationCandidateToScenario,
  compareCalibrationScenarioBacktests,
  revertCalibration,
  runBacktests,
} from '../calculations/calibrationEngine'
import {
  applyPreparedImport,
  createActualPeriodFromDataset,
  createImportDataset,
  createMappingProfile,
  findDuplicateImports,
  prepareImport,
  requiredImportFields,
  suggestColumnMappings,
  suggestEntityMappings,
  undoImport,
} from '../calculations/importEngine'
import type {
  AppSettings,
  CalibrationCandidate,
  ImportDataset,
  ImportMappingProfile,
  ImportMergeMode,
  ImportSemanticField,
  ImportSourceType,
} from '../models/types'
import { formatNumber, formatPercent, formatYen } from '../utils/format'
import { ActualsEditor } from './ActualsEditor'
import { Badge, Button, EmptyState, NumberField, PageTitle, Panel, SelectField, TextField, Toggle } from './ui'

type Props = { settings: AppSettings; onChange: (settings: AppSettings) => void }
type AccuracyTab = 'actuals' | 'import' | 'calibration' | 'backtest'

const sourceLabels: Record<ImportSourceType, string> = {
  sales: '売上', purchases: '仕入', utilities: '水道光熱', labor: '人件費', waste: '廃棄', inventory: '棚卸', generic: '汎用',
}
const fieldLabels: Record<ImportSemanticField, string> = {
  date: '日付', startDate: '開始日', endDate: '終了日', entityName: '名称／種別', quantity: '数量／時間', unit: '単位', amount: '金額', reason: '理由', inventoryValue: '在庫価額',
}
const optionalFields = (source: ImportSourceType): ImportSemanticField[] => source === 'waste' ? ['amount'] : source === 'inventory' ? ['inventoryValue'] : []

const entityValues = (dataset: ImportDataset, profile: ImportMappingProfile) => {
  const column = profile.mappings.entityName
  return column ? [...new Set(dataset.rows.map((row) => row[column]?.trim()).filter(Boolean))] : []
}

const candidateLabel = (settings: AppSettings, candidate: CalibrationCandidate) => {
  if (candidate.targetType === 'utilityUnitPrice') return candidate.targetId === 'water' ? '水道単価' : candidate.targetId === 'gas' ? 'ガス単価' : '電気単価'
  if (candidate.targetType === 'resourceUnitPrice') return `${settings.resources.find((item) => item.id === candidate.targetId)?.name ?? candidate.targetId} 購入単価`
  if (candidate.targetType === 'laborHourlyWage') return `${settings.labor.find((item) => item.id === candidate.targetId)?.name ?? candidate.targetId} 時給`
  if (candidate.targetType === 'demandMeals') return '1日販売食数（確認候補）'
  return `${settings.menuItems.find((item) => item.id === candidate.targetId)?.name ?? candidate.targetId} 実販売単価`
}

const ImportWorkspace = ({ settings, onChange }: Props) => {
  const [sourceType, setSourceType] = useState<ImportSourceType>('sales')
  const [dataset, setDataset] = useState<ImportDataset>()
  const [draft, setDraft] = useState<ImportMappingProfile>()
  const [profileName, setProfileName] = useState('新しいMapping')
  const [actualPeriodId, setActualPeriodId] = useState(settings.actualPeriods[0]?.id ?? '')
  const [mergeMode, setMergeMode] = useState<ImportMergeMode>('add')
  const [allocateUtilities, setAllocateUtilities] = useState(false)
  const [message, setMessage] = useState<{ tone: 'success' | 'error' | 'warning'; text: string }>()
  const [lastSummary, setLastSummary] = useState<{ imported: number; skipped: number; errors: number }>()
  const selectedPeriod = settings.actualPeriods.find((period) => period.id === actualPeriodId)
  const prepared = useMemo(() => dataset && draft && selectedPeriod ? prepareImport(settings, dataset, draft, selectedPeriod, { allocatePartialUtilities: allocateUtilities }) : undefined, [settings, dataset, draft, selectedPeriod, allocateUtilities])
  const duplicates = useMemo(() => dataset && actualPeriodId ? findDuplicateImports(settings, dataset, actualPeriodId) : [], [settings, dataset, actualPeriodId])
  const suggestedPeriod = useMemo(() => dataset && draft ? createActualPeriodFromDataset(dataset, draft) : null, [dataset, draft])

  const loadFile = async (file?: File) => {
    if (!file) return
    try {
      const next = createImportDataset(file.name, sourceType, await file.text(), file.name)
      const mappings = suggestColumnMappings(next.columns)
      const entityMappings = suggestEntityMappings(settings, next, mappings.entityName)
      setDataset(next)
      setDraft({ id: 'draft', name: profileName, sourceType, mappings, entityMappings, updatedAt: new Date().toISOString() })
      setMessage(undefined)
      setLastSummary(undefined)
    } catch (error) {
      setDataset(undefined)
      setDraft(undefined)
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'CSVを読み込めませんでした。' })
    }
  }

  const changeSource = (next: ImportSourceType) => {
    setSourceType(next)
    setDataset(undefined)
    setDraft(undefined)
    setLastSummary(undefined)
  }

  const updateMapping = (field: ImportSemanticField, column: string) => {
    if (!draft || !dataset) return
    const mappings = { ...draft.mappings, [field]: column || undefined }
    const exact = suggestEntityMappings(settings, dataset, mappings.entityName)
    setDraft({ ...draft, mappings, entityMappings: {
      menuItems: { ...exact.menuItems, ...draft.entityMappings.menuItems },
      resources: { ...exact.resources, ...draft.entityMappings.resources },
      laborRoles: { ...exact.laborRoles, ...draft.entityMappings.laborRoles },
      wasteReasons: { ...draft.entityMappings.wasteReasons },
    } })
  }

  const updateEntity = (external: string, id: string) => {
    if (!draft) return
    const group = sourceType === 'sales' ? 'menuItems' : sourceType === 'labor' ? 'laborRoles' : 'resources'
    setDraft({ ...draft, entityMappings: { ...draft.entityMappings, [group]: { ...draft.entityMappings[group], [external]: id } } })
  }

  const updateWasteReason = (external: string, reason: string) => {
    if (!draft) return
    setDraft({ ...draft, entityMappings: { ...draft.entityMappings, wasteReasons: { ...draft.entityMappings.wasteReasons, [external]: reason as ImportMappingProfile['entityMappings']['wasteReasons'][string] } } })
  }

  const saveProfile = () => {
    if (!dataset || !draft || !profileName.trim()) return
    const profile = createMappingProfile(dataset, profileName.trim(), draft.mappings, draft.entityMappings)
    onChange({ ...settings, importMappingProfiles: [...settings.importMappingProfiles, profile] })
    setDraft(profile)
    setMessage({ tone: 'success', text: `${profile.name}を保存しました。列順が変わってもheader名で再利用します。` })
  }

  const selectProfile = (id: string) => {
    const profile = settings.importMappingProfiles.find((item) => item.id === id)
    if (profile) setDraft(structuredClone(profile))
  }

  const importRows = () => {
    if (!dataset || !draft || !selectedPeriod || !prepared) return
    if (duplicates.length > 0 && !window.confirm('同じfileまたはrowを含むImport候補があります。続行しますか？')) return
    try {
      const result = applyPreparedImport(settings, dataset, draft, selectedPeriod.id, mergeMode, { allocatePartialUtilities: allocateUtilities })
      onChange(result.settings)
      setLastSummary({ imported: result.record.importedRows, skipped: result.record.skippedRows, errors: result.record.errorRows })
      setMessage({ tone: 'success', text: `${sourceLabels[sourceType]}実績をActualPeriodへ反映しました。Simulation設定は変更していません。` })
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Importできませんでした。' })
    }
  }

  const createPeriod = () => {
    if (!dataset || !draft) return
    const period = createActualPeriodFromDataset(dataset, draft)
    if (!period) return setMessage({ tone: 'error', text: 'CSV日付からActualPeriodを作成できません。' })
    onChange({ ...settings, actualPeriods: [...settings.actualPeriods, period] })
    setActualPeriodId(period.id)
  }

  return <>
    <div className="calculation-note"><Badge tone="positive">browser only</Badge><span>CSVはブラウザ内で処理し、外部APIへ送信しません。CSV原文と全rowはlocalStorageへ保存しません。</span></div>
    <Panel title="1. CSV / Source" caption="UTF-8・BOM付きUTF-8、quoted comma・quoted newlineに対応。上限50,000行です。">
      <div className="form-grid form-grid-3">
        <SelectField label="sourceType" value={sourceType} onChange={(event) => changeSource(event.target.value as ImportSourceType)}>{Object.entries(sourceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</SelectField>
        <label className="field"><span className="field-label">CSV file</span><input type="file" accept=".csv,text/csv" onChange={(event) => loadFile(event.target.files?.[0])}/></label>
        <SelectField label="保存済みMapping" value={draft?.id ?? ''} onChange={(event) => selectProfile(event.target.value)}><option value="">選択なし</option>{settings.importMappingProfiles.filter((item) => item.sourceType === sourceType).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</SelectField>
      </div>
      {dataset && <div className="editor-summary"><div><span>ファイル</span><strong>{dataset.originalFileName}</strong></div><div><span>行数</span><strong>{dataset.rows.length.toLocaleString('ja-JP')}</strong></div><div><span>列数</span><strong>{dataset.columns.length}</strong></div></div>}
    </Panel>

    {dataset && draft && <>
      <Panel title="2. Preview" caption="先頭10行だけをDOM表示します。"><div className="resource-table-wrap"><table className="resource-table"><thead><tr>{dataset.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{dataset.rows.slice(0, 10).map((row, index) => <tr key={`${dataset.rowHashes[index]}-${index}`}>{dataset.columns.map((column) => <td key={column}>{row[column] || <span className="muted">空欄</span>}</td>)}</tr>)}</tbody></table></div></Panel>
      <Panel title="3. Column Mapping" caption="SobaOps項目からCSV header名へMappingします。" actions={<div className="page-action-row"><TextField label="Profile名" value={profileName} onChange={(event) => setProfileName(event.target.value)}/><Button onClick={saveProfile}>Mapping保存</Button></div>}>
        <div className="form-grid form-grid-4">{[...requiredImportFields(sourceType), ...optionalFields(sourceType)].map((field) => <SelectField key={field} label={`${fieldLabels[field]}${requiredImportFields(sourceType).includes(field) ? ' *' : ''}`} value={draft.mappings[field] ?? ''} onChange={(event) => updateMapping(field, event.target.value)}><option value="">未Mapping</option>{dataset.columns.map((column) => <option key={column} value={column}>{column}</option>)}</SelectField>)}</div>
        {draft.id !== 'draft' && <div className="page-action-row"><TextField label="保存Profile名" value={draft.name} onChange={(event) => { const name = event.target.value; setDraft({ ...draft, name }); onChange({ ...settings, importMappingProfiles: settings.importMappingProfiles.map((item) => item.id === draft.id ? { ...item, name, updatedAt: new Date().toISOString() } : item) }) }}/><Button variant="danger" onClick={() => { onChange({ ...settings, importMappingProfiles: settings.importMappingProfiles.filter((item) => item.id !== draft.id) }); setDraft({ ...draft, id: 'draft' }) }}>Profile削除</Button></div>}
      </Panel>

      {entityValues(dataset, draft).length > 0 && sourceType !== 'utilities' && <Panel title="4. Entity Mapping" caption="完全一致候補だけ初期選択します。曖昧な名称は手動で選択してください。"><div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>CSV名称</th><th>SobaOps Entity</th></tr></thead><tbody>{entityValues(dataset, draft).map((external) => {
        const group = sourceType === 'sales' ? draft.entityMappings.menuItems : sourceType === 'labor' ? draft.entityMappings.laborRoles : draft.entityMappings.resources
        const entities = sourceType === 'sales' ? settings.menuItems : sourceType === 'labor' ? settings.labor : settings.resources
        return <tr key={external}><td>{external}</td><td><select value={group[external] ?? ''} onChange={(event) => updateEntity(external, event.target.value)}><option value="">未Mapping</option>{entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.name}</option>)}</select></td></tr>
      })}</tbody></table></div></Panel>}

      {sourceType === 'waste' && draft.mappings.reason && <Panel title="4b. Waste Reason Mapping" caption="外部の廃棄理由を既存分類へ対応付けます。"><div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>CSV理由</th><th>SobaOps分類</th></tr></thead><tbody>{[...new Set(dataset.rows.map((row) => row[draft.mappings.reason!]?.trim()).filter(Boolean))].map((external) => <tr key={external}><td>{external}</td><td><select value={draft.entityMappings.wasteReasons[external] ?? ''} onChange={(event) => updateWasteReason(external, event.target.value)}><option value="">未Mapping</option><option value="trimLoss">下処理ロス</option><option value="cookingLoss">調理ロス</option><option value="spoilage">期限切れ</option><option value="unsold">売れ残り</option><option value="mistake">ミス</option></select></td></tr>)}</tbody></table></div></Panel>}

      <Panel title="5. Validation / ActualPeriod" caption="Error行を除く正常行だけImportできます。期間外行・明示按分しない部分請求はSkipします。">
        <div className="form-grid form-grid-4"><SelectField label="ActualPeriod" value={actualPeriodId} onChange={(event) => setActualPeriodId(event.target.value)}><option value="">未選択</option>{settings.actualPeriods.map((period) => <option key={period.id} value={period.id}>{period.name}</option>)}</SelectField><SelectField label="重複項目" value={mergeMode} onChange={(event) => setMergeMode(event.target.value as ImportMergeMode)}><option value="add">追加</option><option value="replace">置換</option></SelectField>{sourceType === 'utilities' && <div className="field toggle-field"><span className="field-label">部分請求</span><Toggle label="日数按分する" checked={allocateUtilities} onChange={setAllocateUtilities}/></div>}<Button onClick={createPeriod} disabled={!suggestedPeriod}>{suggestedPeriod ? `${suggestedPeriod.startDate}〜${suggestedPeriod.endDate}を作成` : 'CSV日付を確認できません'}</Button></div>
        {prepared && <div className="editor-summary"><div><span>正常行</span><strong>{prepared.validRowIndexes.length}</strong></div><div><span>Skip</span><strong>{prepared.skippedRowIndexes.length}</strong></div><div><span>Error行</span><strong>{prepared.errorRowIndexes.length}</strong></div><div><span>重複候補</span><strong>{duplicates.length}</strong></div></div>}
        {prepared && prepared.issues.length > 0 && <div className="import-issues">{prepared.issues.slice(0, 30).map((issue, index) => <div className={`alert ${issue.severity}`} key={`${issue.code}-${issue.rowNumber}-${index}`}><b>{issue.severity === 'error' ? 'Error' : 'Warning'}{issue.rowNumber ? ` · row ${issue.rowNumber}` : ''}</b> {issue.message}</div>)}</div>}
        {duplicates.length > 0 && <div className="alert warning">同じfileまたはrowのImport候補があります。追加すると二重計上になる可能性があります。</div>}
        <div className="page-action-row"><Button variant="primary" onClick={importRows} disabled={!selectedPeriod || !prepared || prepared.validRowIndexes.length === 0}>正常行をImport</Button><Button onClick={() => { setDataset(undefined); setDraft(undefined); setLastSummary(undefined); setMessage(undefined) }}>キャンセル</Button><span>追加／置換を選択してください。</span></div>
      </Panel>
    </>}

    {message && <div className={`alert ${message.tone}`}>{message.text}</div>}
    {lastSummary && <div className="editor-summary"><div><span>Import成功</span><strong>{lastSummary.imported}行</strong></div><div><span>Skip</span><strong>{lastSummary.skipped}行</strong></div><div><span>Error</span><strong>{lastSummary.errors}行</strong></div></div>}
    <Panel title="Import Log / Undo" caption="Import後に手入力・別Importがある場合は、安全のため古いsnapshotへのUndoを拒否します。">
      {settings.importRecords.length === 0 ? <EmptyState>Import履歴はありません。</EmptyState> : <div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>日時</th><th>file / source</th><th>ActualPeriod</th><th>成功 / Skip / Error</th><th>状態</th><th/></tr></thead><tbody>{[...settings.importRecords].reverse().map((record) => <tr key={record.id}><td>{new Date(record.importedAt).toLocaleString('ja-JP')}</td><td>{record.originalFileName ?? 'CSV'} / {sourceLabels[record.sourceType]}</td><td>{settings.actualPeriods.find((period) => period.id === record.actualPeriodId)?.name ?? record.actualPeriodId}</td><td>{record.importedRows} / {record.skippedRows} / {record.errorRows}</td><td>{record.undoneAt ? 'Undo済み' : record.mergeMode === 'add' ? '追加' : '置換'}</td><td>{!record.undoneAt && <Button variant="danger" onClick={() => { try { onChange(undoImport(settings, record.id)); setMessage({ tone: 'success', text: 'Importを取り消しました。' }) } catch (error) { setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Undoできませんでした。' }) } }}>Undo</Button>}</td></tr>)}</tbody></table></div>}
    </Panel>
  </>
}

const CalibrationWorkspace = ({ settings, onChange }: Props) => {
  const [periodIds, setPeriodIds] = useState(settings.actualPeriods.map((period) => period.id))
  const [message, setMessage] = useState<string>()
  const candidates = useMemo(() => buildCalibrationCandidates(settings, periodIds), [settings, periodIds])
  const warnings = useMemo(() => buildCalibrationWarnings(settings, candidates), [settings, candidates])
  const confidenceCount = (confidence: CalibrationCandidate['confidence']) => candidates.filter((candidate) => candidate.confidence === confidence).length
  const togglePeriod = (id: string, checked: boolean) => setPeriodIds(checked ? [...periodIds, id] : periodIds.filter((item) => item !== id))
  return <>
    <Panel title="Calibration対象期間" caption="外れ値を自動除外しません。候補に使う期間を明示的に選択します。">
      <div className="period-check-grid">{settings.actualPeriods.map((period) => <Toggle key={period.id} label={period.name} checked={periodIds.includes(period.id)} onChange={(checked) => togglePeriod(period.id, checked)}/>)}</div>
      <div className="form-grid form-grid-2"><NumberField label="最低期間数" min={1} value={settings.calibrationSettings.minimumPeriods} onChange={(event) => onChange({ ...settings, calibrationSettings: { ...settings.calibrationSettings, minimumPeriods: Number(event.target.value) } })}/><NumberField label="差異Warning閾値" suffix="%" min={0} value={settings.calibrationSettings.varianceWarningThreshold * 100} onChange={(event) => onChange({ ...settings, calibrationSettings: { ...settings.calibrationSettings, varianceWarningThreshold: Number(event.target.value) / 100 } })}/></div>
    </Panel>
    <div className="editor-summary"><div><span>校正候補</span><strong>{candidates.length}</strong></div><div><span>高信頼</span><strong>{confidenceCount('high')}</strong></div><div><span>中信頼</span><strong>{confidenceCount('medium')}</strong></div><div><span>低信頼</span><strong>{confidenceCount('low')}</strong></div></div>
    {warnings.length > 0 && <div className="alert warning">{warnings.map((warning) => warning.message).join(' / ')}</div>}
    {message && <div className="alert success">{message}</div>}
    <Panel title="Calibration Candidates" caption="Scenario保存を推奨します。Baseへは確認後に1件ずつ明示適用してください。">
      {candidates.length === 0 ? <EmptyState>料金＋使用量、購入量＋支出、Role別時間＋人件費など、候補算出に必要な実績がありません。</EmptyState> : <div className="calibration-candidate-grid">{candidates.map((candidate) => <article className="menu-card" key={candidate.id}><div className="menu-card-body"><div className="page-action-row"><Badge>{candidate.category}</Badge><Badge tone={candidate.confidence === 'high' ? 'positive' : candidate.confidence === 'medium' ? 'neutral' : 'warning'}>{candidate.confidence}</Badge>{candidate.informationalOnly && <Badge tone="reference">情報のみ</Badge>}</div><h3>{candidateLabel(settings, candidate)}</h3><div className="before-after"><span>Before <b>{formatNumber(candidate.currentValue, 3)}</b></span><span>After <b>{formatNumber(candidate.suggestedValue, 3)}</b></span></div><p>{candidate.evidence.description}</p>{candidate.evidence.totalAmount !== undefined && <small>総額 {formatYen(candidate.evidence.totalAmount)} / 総量 {formatNumber(candidate.evidence.totalQuantity ?? 0, 3)} {candidate.evidence.unit}</small>}<div className="page-action-row">{!candidate.informationalOnly && <><Button onClick={() => { const scenario = calibrationCandidateToScenario(candidate); onChange({ ...settings, scenarios: [...settings.scenarios, scenario] }); setMessage(`${scenario.name}をScenario保存しました。`) }}>Scenario保存</Button><Button variant="danger" onClick={() => { if (!window.confirm(`${candidateLabel(settings, candidate)}をBaseへ適用しますか？`)) return; onChange(applyCalibrationCandidate(settings, candidate)); setMessage('Baseへ適用し、Calibration Historyへ記録しました。') }}>Baseへ適用</Button></>}</div></div></article>)}</div>}
    </Panel>
    <Panel title="Calibration History / Revert" caption="適用後に同じ設定が変更されている場合、安全のためRevertを拒否します。">
      {settings.calibrationHistory.length === 0 ? <EmptyState>Baseへ適用した履歴はありません。</EmptyState> : <div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>日時</th><th>項目</th><th>Before</th><th>After</th><th>状態</th><th/></tr></thead><tbody>{[...settings.calibrationHistory].reverse().map((entry) => <tr key={entry.id}><td>{new Date(entry.appliedAt).toLocaleString('ja-JP')}</td><td>{entry.field}</td><td>{formatNumber(entry.previousValue, 3)}</td><td>{formatNumber(entry.newValue, 3)}</td><td>{entry.revertedAt ? 'Revert済み' : '適用中'}</td><td>{!entry.revertedAt && <Button variant="danger" onClick={() => { try { onChange(revertCalibration(settings, entry.id)); setMessage('直前値へRevertしました。') } catch (error) { setMessage(error instanceof Error ? error.message : 'Revertできませんでした。') } }}>Revert</Button>}</td></tr>)}</tbody></table></div>}
    </Panel>
  </>
}

const BacktestWorkspace = ({ settings }: Pick<Props, 'settings'>) => {
  const [scenarioId, setScenarioId] = useState('')
  const baseResults = useMemo(() => runBacktests(settings), [settings])
  const baseAccuracy = useMemo(() => calculateBacktestAccuracy(baseResults), [baseResults])
  const scenario = settings.scenarios.find((item) => item.id === scenarioId)
  const comparison = useMemo(() => scenario ? compareCalibrationScenarioBacktests(settings, scenario) : undefined, [settings, scenario])
  const calibratedAccuracy = comparison?.calibratedAccuracy
  return <>
    <div className="calculation-note"><Badge tone="reference">current model</Badge><span>Backtestは保存時点の過去予測ではなく、現在のSimulation Settingsで過去期間を再計算した結果です。同じ期間で校正・評価しても将来精度を保証しません。</span></div>
    <Panel title="Base / Calibrated Scenario" caption="ActualPeriodが複数日の場合はPhase 8 Multi-day Engineで連続再計算します。"><SelectField label="比較Scenario" value={scenarioId} onChange={(event) => setScenarioId(event.target.value)}><option value="">Baseのみ</option>{settings.scenarios.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</SelectField></Panel>
    <Panel title="Model Accuracy" caption="MAEは実数誤差、MAPEはActual=0を除外します。小さいActualで極端になるため両方を併記します。">
      {baseResults.length === 0 ? <EmptyState>Backtest対象のActualPeriodがありません。</EmptyState> : <div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>指標</th><th>Base MAE</th><th>Base MAPE</th>{calibratedAccuracy && <><th>Calibrated MAE</th><th>改善</th></>}</tr></thead><tbody>{baseAccuracy.map((metric) => { const calibrated = calibratedAccuracy?.find((item) => item.key === metric.key); const improvement = metric.mae !== null && calibrated?.mae !== null && calibrated?.mae !== undefined ? metric.mae - calibrated.mae : null; return <tr key={metric.key}><td>{metric.label}</td><td>{metric.mae === null ? '算出不可' : formatYen(metric.mae)}</td><td>{metric.mape === null ? '算出不可' : formatPercent(metric.mape)} <small>n={metric.mapeSampleCount}</small></td>{calibratedAccuracy && <><td>{calibrated?.mae === null || calibrated?.mae === undefined ? '算出不可' : formatYen(calibrated.mae)}</td><td className={improvement !== null && improvement >= 0 ? 'positive' : 'negative'}>{improvement === null ? '算出不可' : formatYen(improvement)}</td></>}</tr>})}</tbody></table></div>}
    </Panel>
    <Panel title="Accuracy Trend" caption="月ごとの売上・利益誤差を確認します。未入力Actualは算出不可のままです。"><div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>ActualPeriod</th><th>売上 予測 / 実績 / 誤差</th><th>営業利益 予測 / 実績 / 誤差</th></tr></thead><tbody>{baseResults.map((result) => { const revenue = result.metrics.find((metric) => metric.key === 'revenue')!; const profit = result.metrics.find((metric) => metric.key === 'operatingProfit')!; return <tr key={result.actualPeriodId}><td>{result.actualPeriodName}<small>{result.startDate}〜{result.endDate}</small></td><td>{formatYen(revenue.predicted)} / {revenue.actual === null ? '未入力' : formatYen(revenue.actual)} / {revenue.error === null ? '算出不可' : formatYen(revenue.error)}</td><td>{formatYen(profit.predicted)} / {profit.actual === null ? '未入力' : formatYen(profit.actual)} / {profit.error === null ? '算出不可' : formatYen(profit.error)}</td></tr>})}</tbody></table></div></Panel>
  </>
}

export const ModelAccuracyEditor = ({ settings, onChange }: Props) => {
  const [tab, setTab] = useState<AccuracyTab>('actuals')
  return <>
    <PageTitle eyebrow="ACTUALS / IMPORT / CALIBRATION / BACKTEST" title="実績・校正" description="Actualは観測値、Simulation Settingsはモデルです。Importや候補生成だけではBase設定を変更しません。"/>
    <div className="period-switch accuracy-tabs">{([['actuals', '実績・Variance'], ['import', 'CSV Import'], ['calibration', 'Calibration'], ['backtest', 'Backtest']] as const).map(([id, label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}</div>
    {tab === 'actuals' && <ActualsEditor settings={settings} onChange={onChange}/>} 
    {tab === 'import' && <ImportWorkspace settings={settings} onChange={onChange}/>} 
    {tab === 'calibration' && <CalibrationWorkspace settings={settings} onChange={onChange}/>} 
    {tab === 'backtest' && <BacktestWorkspace settings={settings}/>} 
  </>
}
