import { useMemo, useState } from 'react'
import { simulate } from '../calculations/engine'
import type { AppSettings, OpeningInventoryLot, PeriodKey, Resource } from '../models/types'
import { formatNumber, formatYen } from '../utils/format'
import { PeriodSwitch } from './Dashboard'
import { Badge, Icon, NumberField, PageTitle, Panel, TextField } from './ui'

type Props = { settings: AppSettings; onChange: (settings: AppSettings) => void }

const numberValue = (value: string) => Number.isFinite(Number(value)) ? Number(value) : 0

export const InventoryEditor = ({ settings, onChange }: Props) => {
  const [period, setPeriod] = useState<PeriodKey>('month')
  const result = useMemo(() => simulate(settings, period), [settings, period])
  const [selectedKey, setSelectedKey] = useState<string>('')
  const selected = result.inventory.items.find((item) => `${item.sourceType}:${item.sourceId}` === selectedKey)
    ?? result.inventory.items.find((item) => item.purchasedQuantity + item.producedQuantity + item.byProductQuantity + item.consumedQuantity + item.wastedQuantity > 0)

  const updateOpeningLot = (resource: Resource, patch: Partial<OpeningInventoryLot>) => {
    const current = settings.inventory.openingLots.find((lot) => lot.sourceType === 'resource' && lot.sourceId === resource.id)
    const openingLots = current
      ? settings.inventory.openingLots.map((lot) => lot.id === current.id ? { ...lot, ...patch } : lot)
      : [...settings.inventory.openingLots, {
        id: `opening-${resource.id}`,
        sourceType: 'resource' as const,
        sourceId: resource.id,
        quantity: 0,
        unit: resource.purchaseUnit,
        acquiredDate: settings.business.simulationStartDate,
        ...patch,
      }]
    onChange({ ...settings, inventory: { ...settings.inventory, openingLots } })
  }

  return <>
    <PageTitle
      eyebrow="INVENTORY & PURCHASING"
      title="在庫・仕入"
      description="購入パッケージ、期首在庫、FIFO消費、期限切れ、内製品の持越しを日次で追跡します。"
      actions={<PeriodSwitch period={period} onChange={setPeriod} />}
    />

    <div className="inventory-kpi-grid">
      <div><span>使用原価</span><strong>{formatYen(result.inventory.usageCost)}</strong><small>販売へ払い出した在庫価額</small></div>
      <div><span>購入支出</span><strong>{formatYen(result.inventory.purchaseExpenditure)}</strong><small>{result.inventory.purchaseCount}回の仕入</small></div>
      <div><span>期首在庫価額</span><strong>{formatYen(result.inventory.openingInventoryValue)}</strong><small>開始日時点</small></div>
      <div><span>期末在庫価額</span><strong>{formatYen(result.inventory.endingInventoryValue)}</strong><small>期間終了時点</small></div>
      <div><span>廃棄原価</span><strong>{formatYen(result.inventory.wasteCost)}</strong><small>期限切れ・工程ロス</small></div>
      <div className="cash"><span>簡易現金収支</span><strong>{formatYen(result.inventory.simpleCashFlow)}</strong><small>正式なCF計算ではありません</small></div>
    </div>

    <Panel title="期首在庫" caption="シミュレーション開始前から保有するResource Lotです。取得日からFIFOと保存期限を判定します。">
      <div className="opening-inventory-grid">
        {settings.resources.map((resource) => {
          const opening = settings.inventory.openingLots.find((lot) => lot.sourceType === 'resource' && lot.sourceId === resource.id)
          return <article key={resource.id}>
            <header><strong>{resource.name}</strong><Badge>{resource.storageType === 'frozen' ? '冷凍' : resource.storageType === 'refrigerated' ? '冷蔵' : '常温'}</Badge></header>
            <div className="form-grid form-grid-3 compact-grid">
              <NumberField label="数量" suffix={resource.purchaseUnit} min={0} value={opening?.quantity ?? 0} onChange={(event) => updateOpeningLot(resource, { quantity: numberValue(event.target.value), unit: resource.purchaseUnit })}/>
              <TextField label="取得日" type="date" value={opening?.acquiredDate ?? settings.business.simulationStartDate} onChange={(event) => updateOpeningLot(resource, { acquiredDate: event.target.value })}/>
              <TextField label="期限（任意）" type="date" value={opening?.expiryDate ?? ''} onChange={(event) => updateOpeningLot(resource, { expiryDate: event.target.value || undefined })}/>
            </div>
          </article>
        })}
      </div>
    </Panel>

    <Panel title="期間末在庫" caption="購入・生産・副産物・使用・廃棄をResource / Outputごとに集計します。">
      <div className="resource-table-wrap"><table className="resource-table inventory-table">
        <thead><tr><th>在庫品</th><th>期末在庫</th><th>在庫価額</th><th>最古Lot</th><th>最短期限</th><th>購入</th><th>生産 / 副産物</th><th>使用</th><th>廃棄</th></tr></thead>
        <tbody>{result.inventory.items.map((item) => <tr key={`${item.sourceType}:${item.sourceId}`} className={selected?.sourceId === item.sourceId && selected.sourceType === item.sourceType ? 'selected' : ''} onClick={() => setSelectedKey(`${item.sourceType}:${item.sourceId}`)}>
          <td><strong>{item.name}</strong><small className="inline-note">{item.sourceType === 'output' ? '仕込品' : 'Resource'}</small></td>
          <td>{formatNumber(item.endingQuantity, 3)} {item.unit}</td>
          <td>{formatYen(item.endingValue)}</td>
          <td>{item.oldestAcquiredDate ?? '—'}</td>
          <td>{item.nearestExpiryDate ?? '—'}</td>
          <td>{formatNumber(item.purchasedQuantity, 3)} {item.unit}</td>
          <td>{formatNumber(item.producedQuantity, 3)} / {formatNumber(item.byProductQuantity, 3)}</td>
          <td>{formatNumber(item.consumedQuantity, 3)} {item.unit}</td>
          <td>{formatNumber(item.wastedQuantity, 3)} {item.unit}</td>
        </tr>)}</tbody>
      </table></div>
    </Panel>

    <div className="dashboard-grid lower-grid inventory-lower-grid">
      <Panel title="仕入履歴" caption="不足時に購入パッケージ単位で自動発注した想定履歴です。">
        <div className="purchase-history">
          {result.inventory.purchases.length === 0 && <p>期間中の購入はありません。</p>}
          {result.inventory.purchases.map((purchase) => <div key={purchase.id}>
            <span>{purchase.date}</span><strong>{purchase.resourceName}</strong><b>{formatNumber(purchase.purchasedQuantity, 3)} {purchase.unit} · {purchase.packages} package</b><em>{formatYen(purchase.expenditure)}</em>
          </div>)}
        </div>
        <div className="subsection-title"><span>廃棄履歴</span><small>理由別</small></div>
        <div className="purchase-history waste-history">
          {result.inventory.wastes.length === 0 && <p>期間中の廃棄はありません。</p>}
          {result.inventory.wastes.map((waste) => <div key={waste.id}><span>{waste.date}</span><strong>{waste.name}</strong><b>{waste.quantity ? `${formatNumber(waste.quantity, 3)} ${waste.unit ?? ''}` : waste.reason}</b><em>{formatYen(waste.cost)}</em></div>)}
        </div>
      </Panel>
      <Panel title="日次在庫推移" caption={selected ? `${selected.name} · ${selected.unit}` : '在庫品を選択してください'}>
        {selected ? <div className="resource-table-wrap"><table className="resource-table movement-table">
          <thead><tr><th>日付</th><th>期首</th><th>購入</th><th>生産</th><th>副産物</th><th>使用</th><th>廃棄</th><th>期末</th></tr></thead>
          <tbody>{selected.dailyMovements.map((movement) => <tr key={movement.date}><td>{movement.date}</td><td>{formatNumber(movement.openingQuantity, 2)}</td><td>{formatNumber(movement.purchasedQuantity, 2)}</td><td>{formatNumber(movement.producedQuantity, 2)}</td><td>{formatNumber(movement.byProductQuantity, 2)}</td><td>{formatNumber(movement.consumedQuantity, 2)}</td><td>{formatNumber(movement.wastedQuantity, 2)}</td><td><strong>{formatNumber(movement.endingQuantity, 2)}</strong></td></tr>)}</tbody>
        </table></div> : <div className="empty-state"><Icon name="box"/>在庫推移はありません。</div>}
      </Panel>
    </div>

    <div className="calculation-note"><Icon name="info" size={17}/><span>営業利益は販売へ払い出した使用原価を基準にし、購入支出は購入日に全額を簡易現金収支へ反映します。そのため期末在庫が残る期間では両者が一致しません。</span></div>
  </>
}
