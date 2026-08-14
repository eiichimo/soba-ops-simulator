import { describe, expect, it } from 'vitest'
import { createSampleSettings } from '../data/sampleData'
import type { ActualPeriod, ImportDataset, ImportMappingProfile, ImportSourceType } from '../models/types'
import {
  applyPreparedImport,
  createActualPeriodFromDataset,
  createImportDataset,
  createMappingProfile,
  datasetHash,
  findDuplicateImports,
  mergeActualContribution,
  parseCsv,
  parseImportAmount,
  parseImportDate,
  prepareImport,
  suggestEntityMappings,
  undoImport,
} from './importEngine'

const period = (): ActualPeriod => ({
  id: 'actual-aug', name: '2026年8月', startDate: '2026-08-01', endDate: '2026-08-31',
  actuals: { menuSales: [], resourceRecords: [], laborRecords: [], wasteRecords: [], inventoryRecords: [], utilities: { water: {}, gas: {}, electricity: {} } },
})

const settingsWithPeriod = () => {
  const settings = createSampleSettings()
  settings.actualPeriods = [period()]
  return settings
}

const dataset = (sourceType: ImportSourceType, csv: string): ImportDataset => createImportDataset('test', sourceType, csv, 'test.csv', '2026-09-01T00:00:00.000Z')

const profile = (sourceType: ImportSourceType, mappings: ImportMappingProfile['mappings'], entityMappings?: Partial<ImportMappingProfile['entityMappings']>): ImportMappingProfile => ({
  id: 'profile', name: 'test', sourceType, mappings,
  entityMappings: { menuItems: {}, resources: {}, laborRoles: {}, wasteReasons: {}, ...entityMappings },
  updatedAt: '2026-09-01T00:00:00.000Z',
})

describe('CSV parser', () => {
  it('基本CSVをheader名付きrowへ変換する', () => {
    const result = parseCsv('date,menu,quantity\n2026-08-01,ざるそば,2')
    expect(result.columns).toEqual(['date', 'menu', 'quantity'])
    expect(result.rows[0]).toEqual({ date: '2026-08-01', menu: 'ざるそば', quantity: '2' })
  })

  it('quoted commaを1セルとして読む', () => expect(parseCsv('name,amount\n"そば,大盛",1200').rows[0].name).toBe('そば,大盛'))
  it('quoted newlineをセル内に保持する', () => expect(parseCsv('name,note\nそば,"昼\n限定"').rows[0].note).toBe('昼\n限定'))
  it('empty cellを空文字で保持する', () => expect(parseCsv('a,b,c\n1,,3').rows[0].b).toBe(''))
  it('UTF-8 BOMをheaderから除く', () => expect(parseCsv('\uFEFFdate,value\n2026-08-01,1').columns[0]).toBe('date'))
  it('row limit超過を拒否する', () => expect(() => parseCsv('a\n1\n2', 1)).toThrow(/1行以下/))
  it('閉じていない引用符をparse failureにする', () => expect(() => parseCsv('a\n"broken')).toThrow(/引用符/))
  it('日付と金額の許可形式を読む', () => {
    expect(parseImportDate('2026/8/14')).toBe('2026-08-14')
    expect(parseImportDate('2026年8月14日')).toBe('2026-08-14')
    expect(parseImportAmount('￥1,200')).toBe(1_200)
  })
})

describe('column / entity mapping', () => {
  it('完全一致・trim・大文字小文字無視でMenu候補を作る', () => {
    const settings = settingsWithPeriod()
    const menu = settings.menuItems[0]
    menu.name = 'ZARU'
    const data = dataset('sales', `日付,商品,数量,売上\n2026-08-01, zaru ,1,800`)
    expect(suggestEntityMappings(settings, data, '商品').menuItems['zaru']).toBe(menu.id)
  })

  it('未知Entityは自動Mappingしない', () => {
    const data = dataset('sales', '日付,商品,数量,売上\n2026-08-01,未知商品,1,800')
    expect(suggestEntityMappings(settingsWithPeriod(), data, '商品').menuItems).toEqual({})
  })

  it('Mapping Profileは列順でなくheader名を再利用する', () => {
    const first = dataset('sales', '日付,商品,数量,売上\n2026-08-01,ざる,1,800')
    const saved = createMappingProfile(first, 'POS', { date: '日付', entityName: '商品', quantity: '数量', amount: '売上' }, { menuItems: {}, resources: {}, laborRoles: {}, wasteReasons: {} }, '2026-09-01T00:00:00.000Z')
    const reordered = dataset('sales', '売上,数量,商品,日付\n800,1,ざる,2026-08-01')
    expect(saved.mappings.date).toBe('日付')
    expect(reordered.columns.includes(saved.mappings.amount!)).toBe(true)
  })

  it('必須Column未MappingをErrorにする', () => {
    const data = dataset('sales', '日付,商品\n2026-08-01,ざる')
    const prepared = prepareImport(settingsWithPeriod(), data, profile('sales', { date: '日付', entityName: '商品' }), period())
    expect(prepared.issues).toContainEqual(expect.objectContaining({ severity: 'error', code: 'required-column-unmapped' }))
  })
})

describe('Actual CSV aggregation', () => {
  it('Salesの売上・食数・Menu別実績を集計する', () => {
    const settings = settingsWithPeriod()
    const menu = settings.menuItems[0]
    const data = dataset('sales', `date,menu,qty,amount\n2026-08-01,外部ざる,2,"1,600"\n2026-08-02,外部ざる,1,800`)
    const prepared = prepareImport(settings, data, profile('sales', { date: 'date', entityName: 'menu', quantity: 'qty', amount: 'amount' }, { menuItems: { 外部ざる: menu.id } }), period())
    expect(prepared.validRowIndexes).toHaveLength(2)
    expect(prepared.contribution.revenue).toBe(2_400)
    expect(prepared.contribution.meals).toBe(3)
    expect(prepared.contribution.menuSales[0]).toMatchObject({ menuItemId: menu.id, quantity: 3, revenue: 2_400 })
  })

  it('Salesの期間外行をWarning付きSkipにする', () => {
    const settings = settingsWithPeriod(); const menu = settings.menuItems[0]
    const data = dataset('sales', 'date,menu,qty,amount\n2026-09-01,外部,1,800')
    const prepared = prepareImport(settings, data, profile('sales', { date: 'date', entityName: 'menu', quantity: 'qty', amount: 'amount' }, { menuItems: { 外部: menu.id } }), period())
    expect(prepared.skippedRowIndexes).toEqual([0])
    expect(prepared.issues).toContainEqual(expect.objectContaining({ code: 'outside-actual-period' }))
  })

  it('明示0は0として取り込み、空欄はErrorにする', () => {
    const settings = settingsWithPeriod(); const menu = settings.menuItems[0]
    const zero = dataset('sales', 'date,menu,qty,amount\n2026-08-01,外部,0,0')
    const mapped = profile('sales', { date: 'date', entityName: 'menu', quantity: 'qty', amount: 'amount' }, { menuItems: { 外部: menu.id } })
    expect(prepareImport(settings, zero, mapped, period()).contribution.revenue).toBe(0)
    const empty = dataset('sales', 'date,menu,qty,amount\n2026-08-01,外部,,')
    expect(prepareImport(settings, empty, mapped, period()).errorRowIndexes).toEqual([0])
  })

  it('不正日付・数量・未知EntityをRow Errorにする', () => {
    const data = dataset('sales', 'date,menu,qty,amount\nbad,missing,x,abc')
    const prepared = prepareImport(settingsWithPeriod(), data, profile('sales', { date: 'date', entityName: 'menu', quantity: 'qty', amount: 'amount' }), period())
    expect(prepared.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['invalid-date', 'invalid-quantity', 'invalid-amount', 'unknown-entity']))
  })

  it('Purchasesは単位換算した購入量と支出を集計しUsageへ入れない', () => {
    const settings = settingsWithPeriod(); const resource = settings.resources[0]
    resource.purchaseUnit = 'kg'
    const data = dataset('purchases', 'date,item,qty,unit,amount\n2026-08-01,仕入麺,1500,g,1200')
    const prepared = prepareImport(settings, data, profile('purchases', { date: 'date', entityName: 'item', quantity: 'qty', unit: 'unit', amount: 'amount' }, { resources: { 仕入麺: resource.id } }), period())
    expect(prepared.contribution.purchaseExpenditure).toBe(1_200)
    expect(prepared.contribution.resourceRecords[0]).toMatchObject({ purchasedQuantity: 1.5, purchaseExpenditure: 1_200 })
    expect(prepared.contribution.resourceRecords[0].usedQuantity).toBeUndefined()
  })

  it('Purchasesの不正単位をErrorにする', () => {
    const settings = settingsWithPeriod(); const resource = settings.resources[0]
    const data = dataset('purchases', 'date,item,qty,unit,amount\n2026-08-01,品,1,L,100')
    const prepared = prepareImport(settings, data, profile('purchases', { date: 'date', entityName: 'item', quantity: 'qty', unit: 'unit', amount: 'amount' }, { resources: { 品: resource.id } }), period())
    expect(prepared.issues).toContainEqual(expect.objectContaining({ code: 'invalid-unit' }))
  })

  it('Utilitiesの使用量・料金を集計する', () => {
    const data = dataset('utilities', 'start,end,type,usage,unit,amount\n2026-08-01,2026-08-31,電気,1400,kWh,42000\n2026-08-01,2026-08-31,水道,200000,ml,100')
    const prepared = prepareImport(settingsWithPeriod(), data, profile('utilities', { startDate: 'start', endDate: 'end', entityName: 'type', quantity: 'usage', unit: 'unit', amount: 'amount' }), period())
    expect(prepared.contribution.utilities.electricity).toEqual({ quantity: 1_400, cost: 42_000 })
    expect(prepared.contribution.utilities.water).toEqual({ quantity: 200, cost: 100 })
  })

  it('部分請求期間は明示按分なしではSkipする', () => {
    const data = dataset('utilities', 'start,end,type,usage,unit,amount\n2026-07-15,2026-08-14,ガス,31,m³,6200')
    const mapped = profile('utilities', { startDate: 'start', endDate: 'end', entityName: 'type', quantity: 'usage', unit: 'unit', amount: 'amount' })
    const prepared = prepareImport(settingsWithPeriod(), data, mapped, period())
    expect(prepared.skippedRowIndexes).toEqual([0])
    expect(prepared.issues).toContainEqual(expect.objectContaining({ code: 'partial-utility-period' }))
  })

  it('部分請求期間を明示選択時だけ日数按分する', () => {
    const data = dataset('utilities', 'start,end,type,usage,unit,amount\n2026-07-15,2026-08-14,ガス,31,m³,6200')
    const mapped = profile('utilities', { startDate: 'start', endDate: 'end', entityName: 'type', quantity: 'usage', unit: 'unit', amount: 'amount' })
    const prepared = prepareImport(settingsWithPeriod(), data, mapped, period(), { allocatePartialUtilities: true })
    expect(prepared.contribution.utilities.gas.quantity).toBeCloseTo(14)
    expect(prepared.contribution.utilities.gas.cost).toBeCloseTo(2_800)
  })

  it('LaborのRole別hours・costと全体値を集計する', () => {
    const settings = settingsWithPeriod(); const role = settings.labor[0]
    const data = dataset('labor', 'date,role,hours,cost\n2026-08-01,厨房,8,12000')
    const prepared = prepareImport(settings, data, profile('labor', { date: 'date', entityName: 'role', quantity: 'hours', amount: 'cost' }, { laborRoles: { 厨房: role.id } }), period())
    expect(prepared.contribution).toMatchObject({ laborHours: 8, laborCost: 12_000 })
    expect(prepared.contribution.laborRecords?.[0]).toEqual({ laborRoleId: role.id, hours: 8, cost: 12_000 })
  })

  it('Wasteの理由・数量・原価を保持する', () => {
    const settings = settingsWithPeriod(); const resource = settings.resources[0]
    const data = dataset('waste', 'date,item,qty,unit,reason,cost\n2026-08-01,麺廃棄,1,kg,期限切れ,500')
    const prepared = prepareImport(settings, data, profile('waste', { date: 'date', entityName: 'item', quantity: 'qty', unit: 'unit', reason: 'reason', amount: 'cost' }, { resources: { 麺廃棄: resource.id }, wasteReasons: { 期限切れ: 'spoilage' } }), period())
    expect(prepared.contribution.wasteRecords?.[0]).toMatchObject({ reason: 'spoilage', cost: 500 })
    expect(prepared.contribution.wasteCost).toBe(500)
  })

  it('Inventory Countと期末価額を保持する', () => {
    const settings = settingsWithPeriod(); const resource = settings.resources[0]
    const data = dataset('inventory', 'date,item,qty,unit,value\n2026-08-31,麺,2,kg,2000')
    const prepared = prepareImport(settings, data, profile('inventory', { date: 'date', entityName: 'item', quantity: 'qty', unit: 'unit', inventoryValue: 'value' }, { resources: { 麺: resource.id } }), period())
    expect(prepared.contribution.inventoryRecords?.[0]).toMatchObject({ resourceId: resource.id, quantity: 2_000, inventoryValue: 2_000 })
    expect(prepared.contribution.endingInventoryValue).toBe(2_000)
  })
})

describe('Import record / duplicate / undo', () => {
  const salesFixture = () => {
    const settings = settingsWithPeriod(); const menu = settings.menuItems[0]
    const data = dataset('sales', 'date,menu,qty,amount\n2026-08-01,外部,2,1600')
    const mapped = profile('sales', { date: 'date', entityName: 'menu', quantity: 'qty', amount: 'amount' }, { menuItems: { 外部: menu.id } })
    return { settings, data, mapped }
  }

  it('Import metadataとActual sourceを保存する', () => {
    const { settings, data, mapped } = salesFixture()
    const applied = applyPreparedImport(settings, data, mapped, 'actual-aug', 'add', {}, '2026-09-01T00:00:00.000Z')
    expect(applied.record).toMatchObject({ importedRows: 1, errorRows: 0, mergeMode: 'add' })
    expect(applied.settings.actualPeriods[0].sourceMetadata?.[0]).toMatchObject({ source: 'imported', importRecordId: applied.record.id })
  })

  it('同じdataset hashまたはrow hashをDuplicate候補にする', () => {
    const { settings, data, mapped } = salesFixture()
    const applied = applyPreparedImport(settings, data, mapped, 'actual-aug', 'add')
    expect(datasetHash(data)).toBe(applied.record.datasetHash)
    expect(findDuplicateImports(applied.settings, data, 'actual-aug')).toHaveLength(1)
  })

  it('Import単位で直前ActualへUndoする', () => {
    const { settings, data, mapped } = salesFixture()
    const applied = applyPreparedImport(settings, data, mapped, 'actual-aug', 'add')
    const reverted = undoImport(applied.settings, applied.record.id, '2026-09-02T00:00:00.000Z')
    expect(reverted.actualPeriods[0].actuals.revenue).toBeUndefined()
    expect(reverted.importRecords[0].undoneAt).toBeTruthy()
  })

  it('Import後に手入力変更があればUndoを拒否する', () => {
    const { settings, data, mapped } = salesFixture()
    const applied = applyPreparedImport(settings, data, mapped, 'actual-aug', 'add')
    applied.settings.actualPeriods[0].actuals.revenue = 999
    expect(() => undoImport(applied.settings, applied.record.id)).toThrow(/安全にUndo/)
  })

  it('addとreplaceを明示的に分ける', () => {
    const base = period().actuals
    base.revenue = 100
    const contribution = period().actuals
    contribution.revenue = 50
    expect(mergeActualContribution(base, contribution, 'sales', 'add').revenue).toBe(150)
    expect(mergeActualContribution(base, contribution, 'sales', 'replace').revenue).toBe(50)
  })

  it('CSV日付からActualPeriod候補を作成する', () => {
    const data = dataset('sales', 'date,menu,qty,amount\n2026-08-03,a,1,1\n2026-08-20,a,1,1')
    const created = createActualPeriodFromDataset(data, profile('sales', { date: 'date' }))
    expect(created).toMatchObject({ startDate: '2026-08-03', endDate: '2026-08-20' })
    const utility = dataset('utilities', 'start,end,type,usage,unit,amount\n2026-07-15,2026-08-14,電気,1,kWh,1')
    expect(createActualPeriodFromDataset(utility, profile('utilities', { startDate: 'start', endDate: 'end' }))).toMatchObject({ startDate: '2026-07-15', endDate: '2026-08-14' })
  })
})
