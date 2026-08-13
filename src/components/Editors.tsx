import { useMemo, useRef, useState } from 'react'
import { calculateAverageDailyOilLiters, calculateProcessOutputCost, calculateUtilityQuantity, compareMakeBuy, getResourceUnitCost, simulate, sumCosts } from '../calculations/engine'
import { timeToMinutes } from '../calculations/calendar'
import type {
  AppSettings,
  CostBehavior,
  LaborCostMode,
  LaborRole,
  MenuItem,
  Process,
  Resource,
  ResourceCategory,
  SourceRef,
  Topping,
  Unit,
  UtilityConfig,
} from '../models/types'
import { validateSettings } from '../validation/settingsValidation'
import { formatCompactYen, formatNumber, formatPercent, formatUnitPrice, formatYen } from '../utils/format'
import { Badge, Button, EmptyState, Icon, NumberField, PageTitle, Panel, SelectField, TextField, Toggle } from './ui'

type EditorProps = { settings: AppSettings; onChange: (settings: AppSettings) => void }
const numberValue = (value: string) => Number.isFinite(Number(value)) ? Number(value) : 0
const uniqueId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
const closingTimeForHours = (openingTime: string, hours: number) => {
  const opening = timeToMinutes(openingTime) ?? 0
  const closing = Math.min(23 * 60 + 59, opening + Math.round(hours * 60))
  return `${String(Math.floor(closing / 60)).padStart(2, '0')}:${String(closing % 60).padStart(2, '0')}`
}

const categoryNames: Record<ResourceCategory, string> = {
  noodle: '麺類', produce: '野菜', seasoning: '調味料', seafood: '魚介', topping: '薬味・具材', prepared: '既製品',
  water: '水道', gas: 'ガス', electricity: '電気', oil: '油', other: 'その他',
}
const storageNames = { ambient: '常温', refrigerated: '冷蔵', frozen: '冷凍' }
const unitOptions: Unit[] = ['g', 'kg', 'ml', 'L', '個', '枚', '本', '食', 'kWh', 'm³']
const behaviorNames: Record<CostBehavior, string> = { perDay: '営業日固定', perHour: '営業時間比例', perMeal: '食数比例', perMonth: '月固定', perUse: '使用回数比例', alwaysOn: '常時（24時間）' }

export const OperationsEditor = ({ settings, onChange }: EditorProps) => {
  const updateBusiness = <K extends keyof AppSettings['business']>(key: K, value: AppSettings['business'][K]) => onChange({
    ...settings,
    business: { ...settings.business, [key]: value },
  })
  const day = simulate(settings, 'day')
  const month = simulate(settings, 'month')

  return <>
    <PageTitle eyebrow="OPERATIONS" title="営業条件" description="食数・時間・営業日を変えると、全画面の結果がすぐに再計算されます。" />
    <div className="editor-summary">
      <div><span>日次売上</span><strong>{formatYen(day.revenue)}</strong></div>
      <div><span>日次営業利益</span><strong className={day.operatingProfit >= 0 ? 'positive' : 'negative'}>{formatYen(day.operatingProfit)}</strong></div>
      <div><span>月間営業利益</span><strong className={month.operatingProfit >= 0 ? 'positive' : 'negative'}>{formatCompactYen(month.operatingProfit)}</strong></div>
    </div>
    <Panel title="基本営業条件" caption="開始日から暦日を進め、曜日別の営業設定に一致する日だけを集計します。">
      <div className="form-grid form-grid-3">
        <TextField label="店舗名" value={settings.business.storeName} onChange={(event) => updateBusiness('storeName', event.target.value)} />
        <NumberField label="1日の想定販売数" suffix="食" min={0} value={settings.business.mealsPerDay} onChange={(event) => updateBusiness('mealsPerDay', numberValue(event.target.value))} />
        <TextField label="シミュレーション開始日" type="date" value={settings.business.simulationStartDate} onChange={(event) => updateBusiness('simulationStartDate', event.target.value)} />
        <NumberField label="標準営業時間" suffix="時間" min={0} max={24} value={settings.business.hoursPerDay} onChange={(event) => updateBusiness('hoursPerDay', numberValue(event.target.value))} hint="シフト時間を曜日別営業時間へ比例させる基準" />
        <NumberField label="開始日から30日間の営業日数" suffix="日" value={month.operatingDays} readOnly hint="曜日別営業カレンダーから自動計算" />
      </div>
    </Panel>
    <Panel title="曜日別営業カレンダー" caption="営業日数・総営業時間・時間比例費用・人件費を、この曜日設定から計算します。">
      <div className="weekday-grid">
        {settings.business.weekdays.map((schedule, index) => <div className={schedule.enabled ? 'weekday-card enabled' : 'weekday-card'} key={schedule.day}>
          <Toggle label={['月', '火', '水', '木', '金', '土', '日'][schedule.day]} checked={schedule.enabled} onChange={(enabled) => {
            const weekdays = settings.business.weekdays.map((item, itemIndex) => itemIndex === index ? { ...item, enabled } : item)
            updateBusiness('weekdays', weekdays)
          }} />
          <div className="weekday-times">
            <input aria-label={`${['月', '火', '水', '木', '金', '土', '日'][schedule.day]}曜開店`} type="time" value={schedule.openingTime} disabled={!schedule.enabled} onChange={(event) => updateBusiness('weekdays', settings.business.weekdays.map((item, itemIndex) => itemIndex === index ? { ...item, openingTime: event.target.value } : item))}/>
            <span>–</span>
            <input aria-label={`${['月', '火', '水', '木', '金', '土', '日'][schedule.day]}曜閉店`} type="time" value={schedule.closingTime} disabled={!schedule.enabled} onChange={(event) => updateBusiness('weekdays', settings.business.weekdays.map((item, itemIndex) => itemIndex === index ? { ...item, closingTime: event.target.value } : item))}/>
          </div>
        </div>)}
      </div>
    </Panel>
  </>
}

const SourceEditor = ({ settings, sources, onChange, allowOutputs = true }: { settings: AppSettings; sources: SourceRef[]; onChange: (sources: SourceRef[]) => void; allowOutputs?: boolean }) => {
  const allSources = [
    ...settings.resources.map((resource) => ({ type: 'resource' as const, id: resource.id, name: resource.name, unit: resource.purchaseUnit })),
    ...(allowOutputs ? settings.processes.flatMap((process) => process.outputs.map((output) => ({ type: 'output' as const, id: output.id, name: output.name, unit: output.unit }))) : []),
  ]
  return <div className="source-editor">
    {sources.map((source, index) => <div className="source-row" key={`${source.sourceType}-${source.sourceId}-${index}`}>
      <select value={`${source.sourceType}:${source.sourceId}`} onChange={(event) => {
        const [sourceType, sourceId] = event.target.value.split(':') as [SourceRef['sourceType'], string]
        const selected = allSources.find((item) => item.type === sourceType && item.id === sourceId)
        onChange(sources.map((item, itemIndex) => itemIndex === index ? { ...item, sourceType, sourceId, unit: selected?.unit ?? item.unit } : item))
      }}>
        {allSources.map((item) => <option key={`${item.type}:${item.id}`} value={`${item.type}:${item.id}`}>{item.type === 'output' ? '仕込品 · ' : ''}{item.name}</option>)}
      </select>
      <span className="input-shell compact"><input type="number" step="any" min="0" value={source.quantity} onChange={(event) => onChange(sources.map((item, itemIndex) => itemIndex === index ? { ...item, quantity: numberValue(event.target.value) } : item))}/><select aria-label="消費単位" value={source.unit} onChange={(event) => onChange(sources.map((item, itemIndex) => itemIndex === index ? { ...item, unit: event.target.value as Unit } : item))}>{unitOptions.map((unit) => <option key={unit}>{unit}</option>)}</select></span>
      <button className="icon-button danger" title="削除" onClick={() => onChange(sources.filter((_, itemIndex) => itemIndex !== index))}>×</button>
    </div>)}
    <button className="text-button" disabled={allSources.length === 0} onClick={() => {
      const first = allSources[0]
      if (first) onChange([...sources, { sourceType: first.type, sourceId: first.id, quantity: 1, unit: first.unit }])
    }}>＋ 使用材料を追加</button>
  </div>
}

export const MenuEditor = ({ settings, onChange }: EditorProps) => {
  const updateMenu = (index: number, patch: Partial<MenuItem>) => onChange({ ...settings, menuItems: settings.menuItems.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) })
  const updateTopping = (index: number, patch: Partial<Topping>) => onChange({ ...settings, toppings: settings.toppings.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) })
  const ratio = settings.menuItems.filter((item) => item.enabled).reduce((sum, item) => sum + item.expectedSalesRatio, 0)

  return <>
    <PageTitle eyebrow="MENU MIX" title="メニューと販売構成" description="販売価格・構成比・1食あたり消費量を編集します。有効メニューの構成比は100%が基準です。" actions={<Badge tone={Math.abs(ratio - 100) < 0.01 ? 'positive' : 'warning'}>構成比 {formatNumber(ratio)}%</Badge>} />
    <Panel title="主力メニュー" caption="仕込品も原材料と同じように1食の消費対象として参照できます。" actions={<Button onClick={() => onChange({ ...settings, menuItems: [...settings.menuItems, { id: uniqueId('menu'), name: '新しいメニュー', sellingPrice: 800, consumption: [], expectedSalesRatio: 0, enabled: true }] })}>＋ メニュー追加</Button>}>
      <div className="menu-list">
        {settings.menuItems.map((menu, index) => <details className="menu-card" key={menu.id} open={index < 3}>
          <summary>
            <span className="menu-status"><span className={menu.enabled ? 'status-dot enabled' : 'status-dot'} />{menu.name}</span>
            <span className="menu-summary"><b>{formatYen(menu.sellingPrice)}</b><em>{formatNumber(menu.expectedSalesRatio)}%</em><Icon name="chevron" size={17}/></span>
          </summary>
          <div className="menu-card-body">
            <div className="form-grid form-grid-4 compact-grid">
              <TextField label="メニュー名" value={menu.name} onChange={(event) => updateMenu(index, { name: event.target.value })} />
              <NumberField label="販売価格" suffix="円" min={0} value={menu.sellingPrice} onChange={(event) => updateMenu(index, { sellingPrice: numberValue(event.target.value) })} />
              <NumberField label="販売構成比" suffix="%" min={0} value={menu.expectedSalesRatio} onChange={(event) => updateMenu(index, { expectedSalesRatio: numberValue(event.target.value) })} />
              <div className="field toggle-field"><span className="field-label">販売設定</span><Toggle label={menu.enabled ? '販売中' : '停止中'} checked={menu.enabled} onChange={(enabled) => updateMenu(index, { enabled })}/></div>
            </div>
            <div className="subsection-title"><span>1食あたりの消費</span><small>Resource / Output</small></div>
            <SourceEditor settings={settings} sources={menu.consumption} onChange={(consumption) => updateMenu(index, { consumption })}/>
            <div className="card-footer-actions"><Button variant="danger" onClick={() => onChange({ ...settings, menuItems: settings.menuItems.filter((_, itemIndex) => itemIndex !== index) })}>このメニューを削除</Button></div>
          </div>
        </details>)}
      </div>
    </Panel>
    <Panel title="追加トッピング" caption="注文率は全販売食数に対する追加注文の割合です。" actions={<Button onClick={() => onChange({ ...settings, toppings: [...settings.toppings, { id: uniqueId('topping'), name: '新しいトッピング', sellingPrice: 100, consumption: [], orderRate: 0, enabled: true }] })}>＋ トッピング追加</Button>}>
      <div className="compact-card-grid">
        {settings.toppings.map((topping, index) => <article className="compact-editor-card" key={topping.id}>
          <header><input value={topping.name} aria-label="トッピング名" onChange={(event) => updateTopping(index, { name: event.target.value })}/><Toggle label="" checked={topping.enabled} onChange={(enabled) => updateTopping(index, { enabled })}/></header>
          <div className="form-grid form-grid-2 compact-grid">
            <NumberField label="販売価格" suffix="円" value={topping.sellingPrice} onChange={(event) => updateTopping(index, { sellingPrice: numberValue(event.target.value) })}/>
            <NumberField label="注文率" suffix="%" value={topping.orderRate} onChange={(event) => updateTopping(index, { orderRate: numberValue(event.target.value) })}/>
          </div>
          <SourceEditor settings={settings} sources={topping.consumption} onChange={(consumption) => updateTopping(index, { consumption })}/>
          <button className="text-button danger-text" onClick={() => onChange({ ...settings, toppings: settings.toppings.filter((_, itemIndex) => itemIndex !== index) })}>削除</button>
        </article>)}
      </div>
    </Panel>
  </>
}

export const ResourcesEditor = ({ settings, onChange }: EditorProps) => {
  const [filter, setFilter] = useState<ResourceCategory | 'all'>('all')
  const updateResource = (id: string, patch: Partial<Resource>) => onChange({
    ...settings,
    resources: settings.resources.map((resource) => resource.id === id ? {
      ...resource,
      ...patch,
      usableQuantity: patch.purchaseQuantity !== undefined || patch.yieldRate !== undefined
        ? (patch.purchaseQuantity ?? resource.purchaseQuantity) * (patch.yieldRate ?? resource.yieldRate)
        : resource.usableQuantity,
    } : resource),
  })
  const visible = filter === 'all' ? settings.resources : settings.resources.filter((item) => item.category === filter)

  return <>
    <PageTitle eyebrow="RESOURCES" title="原材料・既製品" description="購入パッケージ量・価格、歩留まり、最低購入パッケージ数を管理します。表示単価は利用可能量を基準にしています。" actions={<Button variant="primary" onClick={() => onChange({ ...settings, resources: [...settings.resources, {
      id: uniqueId('resource'), name: '新しい原材料', category: 'other', purchaseQuantity: 1, purchaseUnit: '個', purchasePrice: 0, yieldRate: 1, usableQuantity: 1,
      storageType: 'refrigerated', shelfLifeDays: 7, minimumPurchaseLot: 1, isReferencePrice: false,
    }] })}>＋ 原材料を追加</Button>} />
    <div className="filter-row">
      <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>すべて <span>{settings.resources.length}</span></button>
      {(Object.keys(categoryNames) as ResourceCategory[]).filter((key) => settings.resources.some((item) => item.category === key)).map((key) => <button key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{categoryNames[key]} <span>{settings.resources.filter((item) => item.category === key).length}</span></button>)}
    </div>
    <Panel className="table-panel">
      <div className="resource-table-wrap"><table className="resource-table">
        <thead><tr><th>原材料</th><th>分類</th><th>購入package</th><th>package価格</th><th>歩留まり</th><th>使用単価</th><th>保存</th><th>最低購入数</th><th /></tr></thead>
        <tbody>{visible.map((resource) => <tr key={resource.id}>
          <td><input className="table-name-input" value={resource.name} onChange={(event) => updateResource(resource.id, { name: event.target.value })}/>{resource.isReferencePrice && <small className="reference-note">初期参考値</small>}</td>
          <td><select value={resource.category} onChange={(event) => updateResource(resource.id, { category: event.target.value as ResourceCategory })}>{Object.entries(categoryNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></td>
          <td><div className="table-input-group"><input type="number" step="any" value={resource.purchaseQuantity} onChange={(event) => updateResource(resource.id, { purchaseQuantity: numberValue(event.target.value) })}/><select value={resource.purchaseUnit} onChange={(event) => updateResource(resource.id, { purchaseUnit: event.target.value as Unit })}>{unitOptions.map((unit) => <option key={unit}>{unit}</option>)}</select></div></td>
          <td><div className="table-input-group"><input type="number" step="any" value={resource.purchasePrice} onChange={(event) => updateResource(resource.id, { purchasePrice: numberValue(event.target.value), isReferencePrice: false })}/><span>円</span></div></td>
          <td><div className="table-input-group"><input type="number" step="1" min="1" max="100" value={resource.yieldRate * 100} onChange={(event) => updateResource(resource.id, { yieldRate: numberValue(event.target.value) / 100 })}/><span>%</span></div></td>
          <td><strong>{formatUnitPrice(getResourceUnitCost(settings, resource.id))}</strong><small> / {resource.purchaseUnit}</small></td>
          <td><select value={resource.storageType} onChange={(event) => updateResource(resource.id, { storageType: event.target.value as Resource['storageType'] })}>{Object.entries(storageNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><span className="table-input-group shelf-life"><input aria-label="保存日数" type="number" min="0" value={resource.shelfLifeDays} onChange={(event) => updateResource(resource.id, { shelfLifeDays: numberValue(event.target.value) })}/><span>日</span></span></td>
          <td><div className="table-input-group narrow"><input type="number" step="1" min="1" value={resource.minimumPurchaseLot} onChange={(event) => updateResource(resource.id, { minimumPurchaseLot: numberValue(event.target.value) })}/><span>個</span></div></td>
          <td><button className="icon-button danger" title="削除" onClick={() => onChange({ ...settings, resources: settings.resources.filter((item) => item.id !== resource.id) })}>×</button></td>
        </tr>)}</tbody>
      </table></div>
    </Panel>
    <div className="calculation-note"><Icon name="info" size={17}/><span>使用単価 = package価格 ÷（package量 × 歩留まり）。在庫不足時はpackage単位かつ最低購入数以上で仕入れ、購入日に支出を記録します。</span></div>
  </>
}

export const ProcessesEditor = ({ settings, onChange }: EditorProps) => {
  const updateProcess = (id: string, patch: Partial<Process>) => onChange({ ...settings, processes: settings.processes.map((process) => process.id === id ? { ...process, ...patch } : process) })
  const roleName = (roleId: string) => settings.labor.find((role) => role.id === roleId)?.name ?? '未設定'
  const processErrors = validateSettings(settings).filter((validationIssue) => validationIssue.severity === 'error' && validationIssue.path?.startsWith('processes'))

  return <>
    <PageTitle eyebrow="PROCESS / RECIPE" title="仕込み・レシピ" description="原料や中間生成物を入力し、複数のOutputへ変換します。加熱時間と実作業時間は別々に管理します。" actions={<Button variant="primary" onClick={() => {
      const processId = uniqueId('process')
      onChange({ ...settings, processes: [...settings.processes, {
        id: processId,
        name: '新しい仕込み工程',
        inputs: [],
        outputs: [{ id: uniqueId('output'), name: '新しい仕込品', quantity: 1, unit: 'L', costAllocation: 1, storageType: 'refrigerated', shelfLifeDays: 3 }],
        batchSize: 1,
        processDurationMinutes: 0,
        activeLaborMinutes: 0,
        laborRole: settings.labor[0]?.id ?? '',
        laborCostTreatment: 'withinScheduledShift',
        gasUsageM3: 0,
        electricUsageKWh: 0,
        waterUsageL: 0,
        wasteRate: 0,
        wasteReason: 'cookingLoss',
      }] })
    }}>＋ 工程を追加</Button>} />
    {processErrors.length > 0 && <div className="alert error"><Icon name="info" size={18}/><span><b>計算できない工程設定が{processErrors.length}件あります。</b><br/>{processErrors.slice(0, 3).map((validationIssue) => validationIssue.message).join(' / ')}</span></div>}
    <div className="flow-legend"><span><i className="flow-input"/>Resource / Output</span><Icon name="chevron" size={16}/><span><i className="flow-process"/>Process</span><Icon name="chevron" size={16}/><span><i className="flow-output"/>Inventory Output</span></div>
    <div className="process-list">
      {settings.processes.map((process, index) => {
        const primary = process.outputs[0]
        const costPerUnit = primary ? sumCosts(calculateProcessOutputCost(settings, primary.id, 1, false)) : 0
        return <details className="process-card" key={process.id} open={index < 2}>
          <summary>
            <div className="process-index">{String(index + 1).padStart(2, '0')}</div>
            <div><strong>{process.name}</strong><span>{process.inputs.length} inputs → {process.outputs.length} outputs · {roleName(process.laborRole)}</span></div>
            <div className="process-summary"><span>{formatUnitPrice(costPerUnit)}<small> / {primary?.unit ?? 'unit'}</small></span><Badge>{process.batchSize}{primary?.unit ?? ''} / batch</Badge><Icon name="chevron" size={18}/></div>
          </summary>
          <div className="process-body">
            <div className="form-grid form-grid-4 compact-grid">
              <TextField label="工程名" value={process.name} onChange={(event) => updateProcess(process.id, { name: event.target.value })}/>
              <NumberField label="基準バッチサイズ" suffix={primary?.unit ?? ''} min={0} value={process.batchSize} onChange={(event) => { const batchSize = numberValue(event.target.value); updateProcess(process.id, { batchSize, outputs: process.outputs.map((item, itemIndex) => itemIndex === 0 ? { ...item, quantity: batchSize } : item) }) }}/>
              <NumberField label="工程所要時間" suffix="分" min={0} value={process.processDurationMinutes} onChange={(event) => updateProcess(process.id, { processDurationMinutes: numberValue(event.target.value) })}/>
              <NumberField label="実作業時間" suffix="分" min={0} value={process.activeLaborMinutes} onChange={(event) => updateProcess(process.id, { activeLaborMinutes: numberValue(event.target.value) })}/>
              <SelectField label="担当役割" value={process.laborRole} onChange={(event) => updateProcess(process.id, { laborRole: event.target.value })}>{settings.labor.map((role) => <option key={role.id} value={role.id}>{role.name} · {formatYen(role.hourlyWage)}/時</option>)}</SelectField>
              <SelectField label="仕込み人件費の扱い" value={process.laborCostTreatment} onChange={(event) => updateProcess(process.id, { laborCostTreatment: event.target.value as Process['laborCostTreatment'] })}>
                <option value="withinScheduledShift">勤務時間内（配賦のみ）</option>
                <option value="additionalLabor">追加勤務（総人件費へ加算）</option>
              </SelectField>
              <NumberField label="廃棄・ロス率" suffix="%" min={0} max={100} value={process.wasteRate * 100} onChange={(event) => updateProcess(process.id, { wasteRate: numberValue(event.target.value) / 100 })}/>
              <SelectField label="廃棄理由" value={process.wasteReason} onChange={(event) => updateProcess(process.id, { wasteReason: event.target.value as Process['wasteReason'] })}>
                <option value="trimLoss">下処理ロス</option><option value="cookingLoss">調理ロス</option><option value="spoilage">期限切れ</option><option value="unsold">売れ残り</option><option value="mistake">作業ミス</option>
              </SelectField>
            </div>
            <div className="process-flow-grid">
              <div><div className="subsection-title"><span>INPUT</span><small>1バッチあたり</small></div><SourceEditor settings={settings} sources={process.inputs} onChange={(inputs) => updateProcess(process.id, { inputs })}/></div>
              <div className="flow-arrow"><Icon name="chevron" size={22}/></div>
              <div><div className="subsection-title"><span>OUTPUT</span><small>在庫へ受入</small></div><div className="output-list">
                {process.outputs.map((output, outputIndex) => <div className="output-editor" key={output.id}>
                  <input value={output.name} aria-label="出力名" onChange={(event) => updateProcess(process.id, { outputs: process.outputs.map((item, itemIndex) => itemIndex === outputIndex ? { ...item, name: event.target.value } : item) })}/>
                  <span className="input-shell compact"><input type="number" step="any" min="0" value={output.quantity} onChange={(event) => { const quantity = numberValue(event.target.value); updateProcess(process.id, { batchSize: outputIndex === 0 ? quantity : process.batchSize, outputs: process.outputs.map((item, itemIndex) => itemIndex === outputIndex ? { ...item, quantity } : item) }) }}/><select value={output.unit} onChange={(event) => updateProcess(process.id, { outputs: process.outputs.map((item, itemIndex) => itemIndex === outputIndex ? { ...item, unit: event.target.value as Unit } : item) })}>{unitOptions.map((unit) => <option key={unit}>{unit}</option>)}</select></span>
                  <span className="input-shell compact allocation"><input title="原価配賦率" type="number" min="0" max="100" value={output.costAllocation * 100} onChange={(event) => updateProcess(process.id, { outputs: process.outputs.map((item, itemIndex) => itemIndex === outputIndex ? { ...item, costAllocation: numberValue(event.target.value) / 100 } : item) })}/><span>% 配賦</span></span>
                  <button className="icon-button danger" title="Outputを削除" onClick={() => updateProcess(process.id, { outputs: process.outputs.filter((_, itemIndex) => itemIndex !== outputIndex) })}>×</button>
                </div>)}
                <button className="text-button" onClick={() => updateProcess(process.id, { outputs: [...process.outputs, { id: uniqueId('output'), name: '副産物', quantity: 1, unit: primary?.unit ?? 'g', costAllocation: 0, storageType: 'refrigerated', shelfLifeDays: 2 }] })}>＋ Output / 副産物を追加</button>
              </div></div>
            </div>
            <div className="utility-inline"><span>工程内の水道光熱</span>
              <label>水 <input type="number" step="any" min="0" value={process.waterUsageL} onChange={(event) => updateProcess(process.id, { waterUsageL: numberValue(event.target.value) })}/> L</label>
              <label>ガス <input type="number" step="any" min="0" value={process.gasUsageM3} onChange={(event) => updateProcess(process.id, { gasUsageM3: numberValue(event.target.value) })}/> m³</label>
              <label>電気 <input type="number" step="any" min="0" value={process.electricUsageKWh} onChange={(event) => updateProcess(process.id, { electricUsageKWh: numberValue(event.target.value) })}/> kWh</label>
            </div>
            <div className="card-footer-actions"><Button variant="danger" onClick={() => onChange({ ...settings, processes: settings.processes.filter((item) => item.id !== process.id) })}>この工程を削除</Button></div>
          </div>
        </details>
      })}
    </div>
  </>
}

export const LaborEditor = ({ settings, onChange }: EditorProps) => {
  const updateRole = (id: string, patch: Partial<LaborRole>) => onChange({ ...settings, labor: settings.labor.map((role) => role.id === id ? { ...role, ...patch } : role) })
  const day = simulate(settings, 'day')
  const month = simulate(settings, 'month')

  return <>
    <PageTitle eyebrow="LABOR" title="人件費" description="営業シフトの会計上人件費と、仕込み工程の実作業時間から算出する人件費を分けて確認します。" actions={<Button variant="primary" onClick={() => onChange({ ...settings, labor: [...settings.labor, { id: uniqueId('labor'), name: '新しい役割', hourlyWage: 1_100, headcount: 1, hoursPerDay: 6, marginalCostRate: 0 }] })}>＋ 役割を追加</Button>} />
    <div className="editor-summary labor-summary">
      <div><span>シフト人件費 / 選択日</span><strong>{formatYen(day.labor.shiftLaborCost)}</strong></div>
      <div><span>仕込み作業配賦額</span><strong>{formatYen(day.labor.prepLaborAllocation)}</strong></div>
      <div><span>追加仕込み人件費</span><strong>{formatYen(day.labor.additionalPrepLaborCost)}</strong></div>
      <div><span>会計上総人件費 / 30日</span><strong>{formatCompactYen(month.labor.accountingLaborCost)}</strong></div>
    </div>
    <Panel title="スタッフ・役割" caption="限界人件費率は、工程を追加・削除したとき実際に増減すると推定する割合です。">
      <div className="labor-grid">
        {settings.labor.map((role) => <article className="labor-card" key={role.id}>
          <div className="labor-card-head"><span className="avatar">{role.name.slice(0, 1)}</span><input value={role.name} aria-label="役割名" onChange={(event) => updateRole(role.id, { name: event.target.value })}/><button className="icon-button danger" onClick={() => onChange({ ...settings, labor: settings.labor.filter((item) => item.id !== role.id) })}>×</button></div>
          <div className="form-grid form-grid-2 compact-grid">
            <NumberField label="時給" suffix="円" min={0} value={role.hourlyWage} onChange={(event) => updateRole(role.id, { hourlyWage: numberValue(event.target.value) })}/>
            <NumberField label="人数" suffix="人" min={0} value={role.headcount} onChange={(event) => updateRole(role.id, { headcount: numberValue(event.target.value) })}/>
            <NumberField label="勤務時間 / 日" suffix="時間" min={0} value={role.hoursPerDay} onChange={(event) => updateRole(role.id, { hoursPerDay: numberValue(event.target.value) })}/>
            <NumberField label="限界人件費率" suffix="%" min={0} max={100} value={role.marginalCostRate * 100} onChange={(event) => updateRole(role.id, { marginalCostRate: numberValue(event.target.value) / 100 })}/>
          </div>
          <footer><span>会計上 / 日</span><strong>{formatYen(role.hourlyWage * role.headcount * role.hoursPerDay)}</strong></footer>
        </article>)}
      </div>
    </Panel>
    <div className="calculation-note"><Icon name="info" size={17}/><span>勤務時間内の仕込みは作業配賦額として確認できますが、会計上総人件費へは再加算しません。追加勤務だけを加算し、限界人件費は配賦額 × 役割の限界人件費率で計算します。</span></div>
  </>
}

const UtilitySection = ({ title, unit, config, dailyQuantity, onChange }: { title: string; unit: string; config: UtilityConfig; dailyQuantity: number; onChange: (config: UtilityConfig) => void }) => (
  <Panel title={title} caption={`標準営業日の使用量 ${formatNumber(dailyQuantity, 2)} ${unit} · ${formatYen(dailyQuantity * config.unitPrice)}`} actions={config.isReferencePrice ? <Badge tone="reference">初期参考値</Badge> : undefined}>
    <div className="form-grid form-grid-3 utility-prices">
      <NumberField label={`従量単価 / ${unit}`} suffix="円" min={0} value={config.unitPrice} onChange={(event) => onChange({ ...config, unitPrice: numberValue(event.target.value), isReferencePrice: false })}/>
      <NumberField label="月基本料金" suffix="円" min={0} value={config.fixedChargePerMonth} onChange={(event) => onChange({ ...config, fixedChargePerMonth: numberValue(event.target.value), isReferencePrice: false })}/>
    </div>
    <div className="utility-use-list">
      {config.uses.map((use, index) => <div className="utility-use-row" key={use.id}>
        <input className="utility-name" value={use.name} aria-label="用途名" onChange={(event) => onChange({ ...config, uses: config.uses.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) })}/>
        <select value={use.behavior} onChange={(event) => onChange({ ...config, uses: config.uses.map((item, itemIndex) => itemIndex === index ? { ...item, behavior: event.target.value as CostBehavior } : item) })}>{(['perDay', 'perHour', 'perMeal', 'perUse', 'alwaysOn'] as CostBehavior[]).map((behavior) => <option key={behavior} value={behavior}>{behaviorNames[behavior]}</option>)}</select>
        <span className="input-shell compact"><input type="number" step="any" min="0" value={use.quantity} onChange={(event) => onChange({ ...config, uses: config.uses.map((item, itemIndex) => itemIndex === index ? { ...item, quantity: numberValue(event.target.value) } : item) })}/><span>{unit}</span></span>
        {use.behavior === 'perUse' && <span className="input-shell compact"><input aria-label="1食あたり使用回数" type="number" step="any" min="0" value={use.usesPerMeal ?? 0} onChange={(event) => onChange({ ...config, uses: config.uses.map((item, itemIndex) => itemIndex === index ? { ...item, usesPerMeal: numberValue(event.target.value) } : item) })}/><span>回/食</span></span>}
        <button className="icon-button danger" onClick={() => onChange({ ...config, uses: config.uses.filter((_, itemIndex) => itemIndex !== index) })}>×</button>
      </div>)}
      <button className="text-button" onClick={() => onChange({ ...config, uses: [...config.uses, { id: uniqueId('utility'), name: '新しい用途', behavior: 'perDay', quantity: 0 }] })}>＋ 用途を追加</button>
    </div>
  </Panel>
)

export const UtilitiesEditor = ({ settings, onChange }: EditorProps) => {
  const meals = settings.business.mealsPerDay
  const hours = settings.business.hoursPerDay
  const updateUtility = (key: keyof AppSettings['utilities'], config: UtilityConfig) => onChange({ ...settings, utilities: { ...settings.utilities, [key]: config } })
  const oilLiters = calculateAverageDailyOilLiters(settings)

  return <>
    <PageTitle eyebrow="UTILITIES & EQUIPMENT" title="水道・ガス・電気・揚げ油" description="営業日固定・営業時間比例・食数比例など、費用の性質を分けて設定します。" />
    <div className="utility-kpis">
      <div><i className="water"/><span>水道 / 標準営業日</span><strong>{formatYen(calculateUtilityQuantity(settings.utilities.water, meals, hours) * settings.utilities.water.unitPrice)}</strong></div>
      <div><i className="gas"/><span>ガス / 標準営業日</span><strong>{formatYen(calculateUtilityQuantity(settings.utilities.gas, meals, hours) * settings.utilities.gas.unitPrice)}</strong></div>
      <div><i className="electric"/><span>電気 / 標準営業日</span><strong>{formatYen(calculateUtilityQuantity(settings.utilities.electricity, meals, hours) * settings.utilities.electricity.unitPrice)}</strong></div>
      <div><i className="oil"/><span>揚げ油 / 標準営業日</span><strong>{formatYen(oilLiters * settings.fryingOil.unitPricePerL)}</strong></div>
    </div>
    <UtilitySection title="水道" unit="L" config={settings.utilities.water} dailyQuantity={calculateUtilityQuantity(settings.utilities.water, meals, hours)} onChange={(config) => updateUtility('water', config)}/>
    <UtilitySection title="ガス" unit="m³" config={settings.utilities.gas} dailyQuantity={calculateUtilityQuantity(settings.utilities.gas, meals, hours)} onChange={(config) => updateUtility('gas', config)}/>
    <UtilitySection title="電気" unit="kWh" config={settings.utilities.electricity} dailyQuantity={calculateUtilityQuantity(settings.utilities.electricity, meals, hours)} onChange={(config) => updateUtility('electricity', config)}/>
    <Panel title="揚げ油" caption={`平均日次消費量 ${formatNumber(oilLiters, 2)} L。Inventory Resourceを選ぶとpackage購入・FIFO在庫で計算します。`} actions={settings.fryingOil.isReferencePrice ? <Badge tone="reference">初期参考値</Badge> : undefined}>
      <div className="form-grid form-grid-3">
        <SelectField label="在庫Resource" value={settings.fryingOil.inventoryResourceId ?? ''} onChange={(event) => onChange({ ...settings, fryingOil: { ...settings.fryingOil, inventoryResourceId: event.target.value || undefined } })}>
          <option value="">在庫連携なし（従来計算）</option>{settings.resources.filter((resource) => resource.category === 'oil').map((resource) => <option key={resource.id} value={resource.id}>{resource.name} · {resource.purchaseQuantity}{resource.purchaseUnit}</option>)}
        </SelectField>
        <NumberField label="油単価" suffix="円 / L" min={0} value={settings.fryingOil.unitPricePerL} onChange={(event) => onChange({ ...settings, fryingOil: { ...settings.fryingOil, unitPricePerL: numberValue(event.target.value), isReferencePrice: false } })}/>
        <NumberField label="初期投入量" suffix="L" min={0} value={settings.fryingOil.initialFillL} onChange={(event) => onChange({ ...settings, fryingOil: { ...settings.fryingOil, initialFillL: numberValue(event.target.value) } })}/>
        <NumberField label="営業中補充量" suffix="L / 日" min={0} value={settings.fryingOil.dailyTopUpL} onChange={(event) => onChange({ ...settings, fryingOil: { ...settings.fryingOil, dailyTopUpL: numberValue(event.target.value) } })}/>
        <NumberField label="食材への吸油" suffix="L / 食" min={0} value={settings.fryingOil.absorptionLPerMeal} onChange={(event) => onChange({ ...settings, fryingOil: { ...settings.fryingOil, absorptionLPerMeal: numberValue(event.target.value) } })}/>
        <NumberField label="交換周期" suffix="営業日" min={1} value={settings.fryingOil.replacementIntervalDays} onChange={(event) => onChange({ ...settings, fryingOil: { ...settings.fryingOil, replacementIntervalDays: numberValue(event.target.value) } })}/>
        <NumberField label="交換時廃棄量" suffix="L" min={0} value={settings.fryingOil.discardLAtReplacement} onChange={(event) => onChange({ ...settings, fryingOil: { ...settings.fryingOil, discardLAtReplacement: numberValue(event.target.value) } })}/>
      </div>
      <div className="oil-formula"><span>平均日次消費量</span><b>{formatNumber(settings.fryingOil.initialFillL)} ÷ {formatNumber(settings.fryingOil.replacementIntervalDays)} + {formatNumber(settings.fryingOil.dailyTopUpL)} + ({formatNumber(settings.fryingOil.absorptionLPerMeal, 3)} × {formatNumber(meals, 0)}食)</b><strong>= {formatNumber(oilLiters, 2)} L / 日</strong></div>
    </Panel>
    <Panel title="その他費用・月固定費" caption="家賃、設備費、消耗品などを費用の性質ごとに集計します。" actions={<Button onClick={() => onChange({ ...settings, otherCosts: [...settings.otherCosts, { id: uniqueId('cost'), name: '新しい費用', amount: 0, behavior: 'perMonth' }] })}>＋ 費用を追加</Button>}>
      <div className="other-cost-list">
        {settings.otherCosts.map((cost, index) => <div className="other-cost-row" key={cost.id}>
          <input value={cost.name} aria-label="費用名" onChange={(event) => onChange({ ...settings, otherCosts: settings.otherCosts.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) })}/>
          <select value={cost.behavior} onChange={(event) => onChange({ ...settings, otherCosts: settings.otherCosts.map((item, itemIndex) => itemIndex === index ? { ...item, behavior: event.target.value as AppSettings['otherCosts'][number]['behavior'] } : item) })}>{(['perDay', 'perHour', 'perMeal', 'perMonth'] as const).map((behavior) => <option key={behavior} value={behavior}>{behaviorNames[behavior]}</option>)}</select>
          <span className="input-shell compact"><input type="number" step="any" min="0" value={cost.amount} onChange={(event) => onChange({ ...settings, otherCosts: settings.otherCosts.map((item, itemIndex) => itemIndex === index ? { ...item, amount: numberValue(event.target.value) } : item) })}/><span>円</span></span>
          <button className="icon-button danger" onClick={() => onChange({ ...settings, otherCosts: settings.otherCosts.filter((_, itemIndex) => itemIndex !== index) })}>×</button>
        </div>)}
      </div>
    </Panel>
  </>
}

const ComparisonColumn = ({ title, subtitle, unitCost, monthlyCost, tone }: { title: string; subtitle: string; unitCost: number; monthlyCost: number; tone: 'make' | 'blend' | 'buy' }) => (
  <article className={`comparison-column ${tone}`}>
    <header><span>{subtitle}</span><h3>{title}</h3></header>
    <div className="comparison-price"><strong>{formatUnitPrice(unitCost)}</strong><span>/ 単位</span></div>
    <footer><span>月間総費用</span><b>{formatYen(monthlyCost)}</b></footer>
  </article>
)

export const ComparisonEditor = ({ settings, onChange }: EditorProps) => {
  const [laborCostMode, setLaborCostMode] = useState<LaborCostMode>('accounting')
  const result = useMemo(() => compareMakeBuy(settings, laborCostMode), [settings, laborCostMode])
  const [scenarioB, setScenarioB] = useState({ meals: 110, hours: 10, days: 5 })
  const scenarioAResult = simulate(settings, 'month')
  const scenarioBSettings: AppSettings = {
    ...settings,
    business: {
      ...settings.business,
      mealsPerDay: scenarioB.meals,
      hoursPerDay: scenarioB.hours,
      weekdays: settings.business.weekdays.map((schedule, index) => ({
        ...schedule,
        enabled: index < scenarioB.days,
        closingTime: closingTimeForHours(schedule.openingTime, scenarioB.hours),
      })),
    },
  }
  const scenarioBResult = simulate(scenarioBSettings, 'month')
  const blendIndex = settings.processes.findIndex((item) => item.id === settings.makeBuyComparison.blendProcessId)
  const blend = settings.processes[blendIndex]

  return <>
    <PageTitle eyebrow="MAKE OR BUY" title="内製 vs 既製品" description="材料・人件費・水道光熱・廃棄・作業時間を揃え、同じ用途の調達方法を比較します。" actions={<div className="period-switch"><button className={laborCostMode === 'accounting' ? 'active' : ''} onClick={() => setLaborCostMode('accounting')}>会計上比較</button><button className={laborCostMode === 'decision' ? 'active' : ''} onClick={() => setLaborCostMode('decision')}>意思決定比較</button></div>} />
    <div className="comparison-hero">
      <div><p>比較対象</p><h2>{settings.makeBuyComparison.name}</h2><span>月間使用量 {formatNumber(result.monthlyUsage)} {settings.makeBuyComparison.unit}</span></div>
      <div className="roi-display"><span>{laborCostMode === 'accounting' ? '会計上' : '意思決定'} 内製ROI</span><strong>{formatYen(result.savingsPerWorkHour)}</strong><small>削減額 / 作業1時間</small></div>
      <div className="saving-display"><span>内製による月間削減額</span><strong className={result.monthlySavings >= 0 ? 'positive' : 'negative'}>{formatYen(result.monthlySavings)}</strong><small>追加作業 {formatNumber(result.monthlyAdditionalHours)} 時間 / 月</small></div>
    </div>
    <div className="labor-comparison-note"><span>内製作業配賦額 <b>{formatUnitPrice(result.homemadeLaborAllocation)} / 単位</b></span><span>限界人件費 <b>{formatUnitPrice(result.homemadeMarginalLabor)} / 単位</b></span><span>期間廃棄 <b>内製 {formatYen(result.homemadeWasteCost)} / 混合 {formatYen(result.blendedWasteCost)} / 既製 {formatYen(result.purchasedWasteCost)}</b></span><p>{laborCostMode === 'accounting' ? '勤務時間内の作業は総人件費へ再加算せず、追加勤務だけを含めています。' : '作業配賦額へ担当役割の限界人件費率を適用しています。'}</p></div>
    <div className="comparison-grid">
      <ComparisonColumn title="内製" subtitle="MAKE" unitCost={result.homemadeUnitCost} monthlyCost={result.homemadeMonthlyCost} tone="make" />
      <ComparisonColumn title="混合" subtitle="BLEND" unitCost={result.blendedUnitCost} monthlyCost={result.blendedMonthlyCost} tone="blend" />
      <ComparisonColumn title="既製品" subtitle="BUY" unitCost={result.purchasedUnitCost} monthlyCost={result.purchasedMonthlyCost} tone="buy" />
    </div>
    <div className="dashboard-grid comparison-details">
      <Panel title="内製の単位原価内訳" caption="工程のバッチ丸めを外した、比較用の連続単価です。">
        <div className="breakdown-list">
          {([
            ['原材料', result.homemadeBreakdown.prepMaterials], [laborCostMode === 'accounting' ? '追加勤務人件費' : '限界人件費', result.homemadeBreakdown.prepLabor], ['水道', result.homemadeBreakdown.water],
            ['ガス', result.homemadeBreakdown.gas], ['電気', result.homemadeBreakdown.electricity], ['廃棄・ロス', result.homemadeBreakdown.waste],
          ] as const).map(([label, amount]) => <div key={label}><span>{label}</span><i><b style={{ width: `${Math.min(100, result.homemadeUnitCost ? amount / result.homemadeUnitCost * 100 : 0)}%` }}/></i><strong>{formatUnitPrice(amount)}</strong></div>)}
        </div>
      </Panel>
      <Panel title="混合レシピ" caption="特殊機能ではなく、通常工程のInput比率として保存されます。">
        {blend ? <>
          <SourceEditor settings={settings} sources={blend.inputs} onChange={(inputs) => onChange({ ...settings, processes: settings.processes.map((item, index) => index === blendIndex ? { ...item, inputs } : item) })}/>
          <div className="blend-ratio-note"><Icon name="info" size={17}/><span>入力値の比率を変えると、混合単価と店舗全体の原価が即時更新されます。</span></div>
        </> : <EmptyState>比較対象の混合工程が見つかりません。</EmptyState>}
        <NumberField label="想定使用量 / 日" suffix={settings.makeBuyComparison.unit} min={0} value={settings.makeBuyComparison.dailyUsage} onChange={(event) => onChange({ ...settings, makeBuyComparison: { ...settings.makeBuyComparison, dailyUsage: numberValue(event.target.value) } })}/>
      </Panel>
    </div>
    <div className="comparison-callout">
      <div><span>販売量による内製損益分岐</span><strong>{result.breakEvenMealsPerDay ? `${result.breakEvenMealsPerDay}食 / 日 以上` : '500食 / 日でも既製品有利'}</strong></div>
      <p>月間総費用は日次FIFO・保存期限・仕込みバッチ・購入packageによる廃棄を含みます。損益分岐表示は日次バッチの概算探索です。期末在庫価額は内製 {formatYen(result.homemadeEndingInventoryValue)} / 既製 {formatYen(result.purchasedEndingInventoryValue)} です。</p>
    </div>

    <PageTitle eyebrow="SCENARIO" title="営業シナリオ比較" description="現在の店舗設定をAとし、食数・曜日別営業時間・週営業日数を変えたBを同じ30暦日で比較します。" />
    <Panel className="scenario-panel">
      <div className="scenario-headings"><div><Badge>SCENARIO A</Badge><h3>現在の設定</h3><p>{settings.business.mealsPerDay}食 · {formatNumber(scenarioAResult.totalOperatingHours)}時間 / 期間 · {scenarioAResult.operatingDays}営業日</p></div><div><Badge tone="positive">SCENARIO B</Badge><h3>比較案</h3><div className="scenario-inputs"><label><input type="number" value={scenarioB.meals} onChange={(event) => setScenarioB({ ...scenarioB, meals: numberValue(event.target.value) })}/>食</label><label><input type="number" value={scenarioB.hours} onChange={(event) => setScenarioB({ ...scenarioB, hours: numberValue(event.target.value) })}/>時間</label><label>週<input type="number" min="0" max="7" value={scenarioB.days} onChange={(event) => setScenarioB({ ...scenarioB, days: numberValue(event.target.value) })}/>日</label></div></div></div>
      <div className="scenario-table">
        <div className="scenario-row header"><span>比較項目</span><b>A</b><b>B</b><em>差分 B−A</em></div>
        {([
          ['売上', scenarioAResult.revenue, scenarioBResult.revenue],
          ['総コスト', scenarioAResult.totalCost, scenarioBResult.totalCost],
          ['営業利益', scenarioAResult.operatingProfit, scenarioBResult.operatingProfit],
          ['会計上人件費', scenarioAResult.labor.accountingLaborCost, scenarioBResult.labor.accountingLaborCost],
          ['水道光熱費', scenarioAResult.costs.water + scenarioAResult.costs.gas + scenarioAResult.costs.electricity, scenarioBResult.costs.water + scenarioBResult.costs.gas + scenarioBResult.costs.electricity],
          ['1営業時間あたり利益', scenarioAResult.profitPerOperatingHour, scenarioBResult.profitPerOperatingHour],
        ] as const).map(([label, a, b]) => <div className="scenario-row" key={label}><span>{label}</span><b>{formatYen(a)}</b><b>{formatYen(b)}</b><em className={b - a >= 0 ? 'positive' : 'negative'}>{b - a >= 0 ? '+' : ''}{formatYen(b - a)}</em></div>)}
        <div className="scenario-row"><span>営業利益率</span><b>{formatPercent(scenarioAResult.operatingMargin)}</b><b>{formatPercent(scenarioBResult.operatingMargin)}</b><em className={scenarioBResult.operatingMargin - scenarioAResult.operatingMargin >= 0 ? 'positive' : 'negative'}>{formatPercent(scenarioBResult.operatingMargin - scenarioAResult.operatingMargin)}</em></div>
      </div>
    </Panel>
  </>
}

export const DataManager = ({ settings, onExport, onImport, onReset, message }: EditorProps & { onExport: () => void; onImport: (file: File) => void; onReset: () => void; message?: { type: 'success' | 'error'; text: string } }) => {
  const fileInput = useRef<HTMLInputElement>(null)
  return <>
    <PageTitle eyebrow="DATA & BACKUP" title="データ管理" description="設定はこのブラウザに自動保存されます。JSONでバックアップ・移行できます。" />
    {message && <div className={`alert ${message.type}`}><Icon name="info" size={18}/><span>{message.text}</span></div>}
    <div className="data-action-grid">
      <article><span className="data-icon"><Icon name="data" size={26}/></span><h2>Export JSON</h2><p>現在の原材料・工程・メニュー・営業条件を1つのJSONファイルに保存します。</p><Button variant="primary" onClick={onExport}>設定を書き出す</Button></article>
      <article><span className="data-icon import"><Icon name="data" size={26}/></span><h2>Import JSON</h2><p>SobaOpsから書き出した設定を読み込みます。現在の設定は上書きされます。</p><input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) onImport(file); event.target.value = '' }}/><Button onClick={() => fileInput.current?.click()}>ファイルを選択</Button></article>
      <article><span className="data-icon reset"><Icon name="store" size={26}/></span><h2>サンプルへ戻す</h2><p>入力内容を破棄し、初回起動時のサンプル蕎麦店データを復元します。</p><Button variant="danger" onClick={onReset}>初期状態へリセット</Button></article>
    </div>
    <Panel title="保存されているデータ" caption="localStorageへ変更のたびに自動保存されます。">
      <div className="schema-summary">
        <div><span>Schema version</span><strong>v{settings.schemaVersion}</strong></div>
        <div><span>Resources</span><strong>{settings.resources.length}</strong></div>
        <div><span>Processes</span><strong>{settings.processes.length}</strong></div>
        <div><span>Outputs</span><strong>{settings.processes.reduce((sum, process) => sum + process.outputs.length, 0)}</strong></div>
        <div><span>Menu items</span><strong>{settings.menuItems.length}</strong></div>
      </div>
      <details className="json-preview"><summary>JSONプレビュー</summary><pre>{JSON.stringify(settings, null, 2)}</pre></details>
    </Panel>
    <Panel title="データモデル" caption="メニュー材料一覧だけではなく、加工・在庫・消費の流れを中心に設計しています。">
      <div className="model-flow"><div><b>Resource</b><span>原材料・既製品・資源</span></div><Icon name="chevron"/><div><b>Process</b><span>加工・混合・仕込み</span></div><Icon name="chevron"/><div><b>Output</b><span>主生成物・副産物</span></div><Icon name="chevron"/><div><b>Inventory</b><span>保存期限・持ち越し</span></div><Icon name="chevron"/><div><b>Consumption</b><span>メニュー・次工程</span></div></div>
    </Panel>
  </>
}
