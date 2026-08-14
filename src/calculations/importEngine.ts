import { formatLocalDate, parseLocalDate } from './calendar'
import { tryConvertQuantity } from './units'
import type {
  ActualInventoryRecord,
  ActualLaborRecord,
  ActualMenuSales,
  ActualPeriod,
  ActualResourceRecord,
  ActualValues,
  ActualWasteRecord,
  AppSettings,
  ImportDataset,
  ImportMappingProfile,
  ImportMergeMode,
  ImportRecord,
  ImportSemanticField,
  ImportSourceType,
  ImportValidationIssue,
  Unit,
  WasteReason,
} from '../models/types'

export const CSV_ROW_LIMIT = 50_000

const normalizeText = (value: string) => value.trim().toLocaleLowerCase('ja-JP')

export const hashText = (value: string) => {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

const hashRow = (columns: string[], row: Record<string, string>) => hashText(columns.map((column) => `${column}\u0000${row[column] ?? ''}`).join('\u0001'))

export const parseCsv = (input: string, rowLimit = CSV_ROW_LIMIT): Pick<ImportDataset, 'columns' | 'rows' | 'rowHashes'> => {
  const text = input.replace(/^\uFEFF/, '')
  const parsedRows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let quoteClosed = false

  const pushField = () => {
    row.push(field)
    field = ''
    quoteClosed = false
  }
  const pushRow = () => {
    pushField()
    parsedRows.push(row)
    row = []
    if (parsedRows.length - 1 > rowLimit) throw new Error(`CSVは${rowLimit.toLocaleString('ja-JP')}行以下にしてください。`)
  }

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
          quoteClosed = true
        }
      } else {
        field += character
      }
      continue
    }
    if (character === '"') {
      if (field.length > 0 || quoteClosed) throw new Error('CSVの引用符形式が正しくありません。')
      quoted = true
    } else if (character === ',') {
      pushField()
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1
      pushRow()
    } else {
      if (quoteClosed && character.trim() !== '') throw new Error('CSVの引用符後に不正な文字があります。')
      if (!quoteClosed) field += character
    }
  }
  if (quoted) throw new Error('CSVの引用符が閉じられていません。')
  if (field.length > 0 || row.length > 0 || quoteClosed) pushRow()
  if (parsedRows.length === 0) throw new Error('CSVにheaderがありません。')

  const columns = parsedRows[0].map((column) => column.trim())
  if (columns.length === 0 || columns.some((column) => !column)) throw new Error('CSV headerに空の列名があります。')
  if (new Set(columns).size !== columns.length) throw new Error('CSV headerの列名が重複しています。')
  const dataRows = parsedRows.slice(1).filter((cells) => cells.some((cell) => cell !== ''))
  if (dataRows.length > rowLimit) throw new Error(`CSVは${rowLimit.toLocaleString('ja-JP')}行以下にしてください。`)
  const rows = dataRows.map((cells) => Object.fromEntries(columns.map((column, index) => [column, cells[index] ?? ''])))
  return { columns, rows, rowHashes: rows.map((item) => hashRow(columns, item)) }
}

export const createImportDataset = (
  name: string,
  sourceType: ImportSourceType,
  csv: string,
  originalFileName?: string,
  now = new Date().toISOString(),
): ImportDataset => {
  const parsed = parseCsv(csv)
  return {
    id: `dataset-${hashText(`${name}:${now}:${csv.length}`)}`,
    name,
    sourceType,
    importedAt: now,
    originalFileName,
    ...parsed,
  }
}

export const parseImportDate = (value: string): string | null => {
  const normalized = value.trim()
  let match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(normalized)
  if (!match) match = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(normalized)
  if (!match) return null
  const formatted = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
  return parseLocalDate(formatted) ? formatted : null
}

export const parseImportNumber = (value: string): number | undefined | null => {
  const normalized = value.trim()
  if (normalized === '') return undefined
  const stripped = normalized.replace(/,/g, '')
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(stripped)) return null
  const parsed = Number(stripped)
  return Number.isFinite(parsed) ? parsed : null
}

export const parseImportAmount = (value: string): number | undefined | null => (
  parseImportNumber(value.trim().replace(/^[¥￥]\s*/, '').replace(/\s*円$/, ''))
)

const exactEntity = (external: string, entities: Array<{ id: string; name: string }>) => {
  const normalized = normalizeText(external)
  return entities.find((entity) => normalizeText(entity.name) === normalized)?.id
}

const defaultEntityMappings = (): ImportMappingProfile['entityMappings'] => ({
  menuItems: {}, resources: {}, laborRoles: {}, wasteReasons: {},
})

export const suggestEntityMappings = (
  settings: AppSettings,
  dataset: ImportDataset,
  entityColumn: string | undefined,
): ImportMappingProfile['entityMappings'] => {
  const result = defaultEntityMappings()
  if (!entityColumn) return result
  for (const external of new Set(dataset.rows.map((row) => row[entityColumn]?.trim()).filter(Boolean))) {
    if (dataset.sourceType === 'sales') {
      const id = exactEntity(external, settings.menuItems)
      if (id) result.menuItems[external] = id
    } else if (dataset.sourceType === 'purchases' || dataset.sourceType === 'waste' || dataset.sourceType === 'inventory') {
      const id = exactEntity(external, settings.resources)
      if (id) result.resources[external] = id
    } else if (dataset.sourceType === 'labor') {
      const id = exactEntity(external, settings.labor)
      if (id) result.laborRoles[external] = id
    }
  }
  return result
}

export const requiredImportFields = (sourceType: ImportSourceType): ImportSemanticField[] => {
  if (sourceType === 'sales') return ['date', 'entityName', 'quantity', 'amount']
  if (sourceType === 'purchases') return ['date', 'entityName', 'quantity', 'unit', 'amount']
  if (sourceType === 'utilities') return ['startDate', 'endDate', 'entityName', 'quantity', 'unit', 'amount']
  if (sourceType === 'labor') return ['date', 'entityName', 'quantity', 'amount']
  if (sourceType === 'waste') return ['date', 'entityName', 'quantity', 'unit', 'reason']
  if (sourceType === 'inventory') return ['date', 'entityName', 'quantity', 'unit']
  return []
}

const columnAliases: Record<ImportSemanticField, string[]> = {
  date: ['date', '日付', '営業日', '購入日', '勤務日', '棚卸日'],
  startDate: ['startdate', 'start', '開始日', '請求開始日'],
  endDate: ['enddate', 'end', '終了日', '請求終了日'],
  entityName: ['menu', 'menuname', '商品', '商品名', 'resource', '品目', '原材料', 'role', '役割', 'utilitytype', 'type', '種別'],
  quantity: ['quantity', 'qty', '数量', '使用量', 'hours', '労働時間'],
  unit: ['unit', '単位'],
  amount: ['amount', 'salesamount', 'revenue', 'cost', '金額', '売上額', '料金', '人件費', '購入支出', '廃棄原価'],
  reason: ['reason', '理由', '廃棄理由'],
  inventoryValue: ['inventoryvalue', '在庫価額', '棚卸価額'],
}

export const suggestColumnMappings = (columns: string[]): Partial<Record<ImportSemanticField, string>> => {
  const normalizedColumns = columns.map((column) => ({ column, normalized: normalizeText(column).replace(/[\s_-]/g, '') }))
  return Object.fromEntries((Object.keys(columnAliases) as ImportSemanticField[]).flatMap((field) => {
    const aliases = columnAliases[field].map((alias) => normalizeText(alias).replace(/[\s_-]/g, ''))
    const match = normalizedColumns.find((item) => aliases.includes(item.normalized))
    return match ? [[field, match.column]] : []
  }))
}

const emptyActuals = (): ActualValues => ({
  menuSales: [],
  resourceRecords: [],
  laborRecords: [],
  wasteRecords: [],
  inventoryRecords: [],
  utilities: { water: {}, gas: {}, electricity: {} },
})

const addOptional = (current: number | undefined, amount: number) => (current ?? 0) + amount
const inclusiveDays = (start: string, end: string) => {
  const first = parseLocalDate(start)
  const last = parseLocalDate(end)
  if (!first || !last || last < first) return 0
  return Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1
}

const overlapDays = (startA: string, endA: string, startB: string, endB: string) => {
  const start = [startA, startB].sort()[1]
  const end = [endA, endB].sort()[0]
  return start <= end ? inclusiveDays(start, end) : 0
}

const utilityKey = (value: string): 'water' | 'gas' | 'electricity' | null => {
  const normalized = normalizeText(value)
  if (normalized === 'water' || normalized === '水道') return 'water'
  if (normalized === 'gas' || normalized === 'ガス') return 'gas'
  if (normalized === 'electricity' || normalized === 'electric' || normalized === '電気') return 'electricity'
  return null
}

const wasteReason = (value: string, profile: ImportMappingProfile): WasteReason | null => {
  const mapped = profile.entityMappings.wasteReasons[value.trim()]
  if (mapped) return mapped
  const normalized = value.trim() as WasteReason
  return ['trimLoss', 'cookingLoss', 'spoilage', 'unsold', 'mistake'].includes(normalized) ? normalized : null
}

const mappedEntity = (profile: ImportMappingProfile, sourceType: ImportSourceType, external: string) => {
  const trimmed = external.trim()
  if (sourceType === 'sales') return profile.entityMappings.menuItems[trimmed]
  if (sourceType === 'purchases' || sourceType === 'waste' || sourceType === 'inventory') return profile.entityMappings.resources[trimmed]
  if (sourceType === 'labor') return profile.entityMappings.laborRoles[trimmed]
  return undefined
}

const upsertMenu = (items: ActualMenuSales[], incoming: ActualMenuSales) => {
  const current = items.find((item) => item.menuItemId === incoming.menuItemId)
  if (!current) items.push({ ...incoming })
  else {
    current.quantity += incoming.quantity
    if (incoming.revenue !== undefined) current.revenue = addOptional(current.revenue, incoming.revenue)
  }
}

const upsertResource = (items: ActualResourceRecord[], resourceId: string, unit: Unit, patch: Partial<ActualResourceRecord>) => {
  let current = items.find((item) => item.resourceId === resourceId)
  if (!current) {
    current = { resourceId, purchaseUnit: unit }
    items.push(current)
  }
  if (patch.purchasedQuantity !== undefined) current.purchasedQuantity = addOptional(current.purchasedQuantity, patch.purchasedQuantity)
  if (patch.purchaseExpenditure !== undefined) current.purchaseExpenditure = addOptional(current.purchaseExpenditure, patch.purchaseExpenditure)
  if (patch.wasteQuantity !== undefined) current.wasteQuantity = addOptional(current.wasteQuantity, patch.wasteQuantity)
  if (patch.wasteCost !== undefined) current.wasteCost = addOptional(current.wasteCost, patch.wasteCost)
  if (patch.wasteUnit) current.wasteUnit = patch.wasteUnit
}

const upsertLabor = (items: ActualLaborRecord[], laborRoleId: string, hours: number, cost: number) => {
  const current = items.find((item) => item.laborRoleId === laborRoleId)
  if (!current) items.push({ laborRoleId, hours, cost })
  else {
    current.hours = addOptional(current.hours, hours)
    current.cost = addOptional(current.cost, cost)
  }
}

const fieldValue = (row: Record<string, string>, profile: ImportMappingProfile, field: ImportSemanticField) => {
  const column = profile.mappings[field]
  return column ? row[column] ?? '' : ''
}

export interface PrepareImportOptions {
  allocatePartialUtilities?: boolean
}

export interface PreparedImport {
  contribution: ActualValues
  issues: ImportValidationIssue[]
  validRowIndexes: number[]
  errorRowIndexes: number[]
  skippedRowIndexes: number[]
  targetFields: string[]
}

export const prepareImport = (
  settings: AppSettings,
  dataset: ImportDataset,
  profile: ImportMappingProfile,
  actualPeriod: ActualPeriod,
  options: PrepareImportOptions = {},
): PreparedImport => {
  const issues: ImportValidationIssue[] = []
  const contribution = emptyActuals()
  const validRowIndexes: number[] = []
  const errorRowIndexes: number[] = []
  const skippedRowIndexes: number[] = []
  const required = requiredImportFields(dataset.sourceType)
  for (const field of required) {
    const column = profile.mappings[field]
    if (!column || !dataset.columns.includes(column)) issues.push({ severity: 'error', code: 'required-column-unmapped', message: `必須項目${field}がCSV列へMappingされていません。`, column })
  }
  if (issues.some((item) => item.severity === 'error')) return { contribution, issues, validRowIndexes, errorRowIndexes: dataset.rows.map((_, index) => index), skippedRowIndexes, targetFields: [] }

  dataset.rows.forEach((row, index) => {
    const rowNumber = index + 2
    const rowIssues: ImportValidationIssue[] = []
    const error = (code: string, message: string, column?: string) => rowIssues.push({ severity: 'error', code, message, rowNumber, column })
    const warning = (code: string, message: string, column?: string) => rowIssues.push({ severity: 'warning', code, message, rowNumber, column })
    const entityName = fieldValue(row, profile, 'entityName')
    const entityId = mappedEntity(profile, dataset.sourceType, entityName)
    const parseNumberField = (field: ImportSemanticField, amount = false) => {
      const raw = fieldValue(row, profile, field)
      const parsed = amount ? parseImportAmount(raw) : parseImportNumber(raw)
      if (parsed === undefined) error('empty-required-value', `${field}が空欄です。`, profile.mappings[field])
      else if (parsed === null) error(amount ? 'invalid-amount' : 'invalid-quantity', `${field}「${raw}」を数値として読めません。`, profile.mappings[field])
      return parsed
    }
    const parseDateField = (field: 'date' | 'startDate' | 'endDate') => {
      const raw = fieldValue(row, profile, field)
      const parsed = parseImportDate(raw)
      if (!parsed) error('invalid-date', `${field}「${raw}」を日付として読めません。`, profile.mappings[field])
      return parsed
    }

    if (dataset.sourceType !== 'utilities' && dataset.sourceType !== 'generic' && !entityId) {
      error('unknown-entity', `「${entityName || '空欄'}」のEntity Mappingがありません。`, profile.mappings.entityName)
    }

    if (dataset.sourceType === 'sales') {
      const date = parseDateField('date')
      const quantity = parseNumberField('quantity')
      const amount = parseNumberField('amount', true)
      if (quantity !== undefined && quantity !== null && quantity < 0) warning('negative-quantity', '負の販売数量です。')
      if (amount === 0) warning('zero-amount', '売上額が明示的に0円です。')
      if (date && (date < actualPeriod.startDate || date > actualPeriod.endDate)) warning('outside-actual-period', `${date}はActualPeriod外です。`)
      issues.push(...rowIssues)
      if (rowIssues.some((item) => item.severity === 'error')) return void errorRowIndexes.push(index)
      if (date! < actualPeriod.startDate || date! > actualPeriod.endDate) return void skippedRowIndexes.push(index)
      contribution.revenue = addOptional(contribution.revenue, amount as number)
      contribution.meals = addOptional(contribution.meals, quantity as number)
      upsertMenu(contribution.menuSales, { menuItemId: entityId!, quantity: quantity as number, revenue: amount as number })
    } else if (dataset.sourceType === 'purchases') {
      const date = parseDateField('date')
      const quantity = parseNumberField('quantity')
      const amount = parseNumberField('amount', true)
      const unit = fieldValue(row, profile, 'unit') as Unit
      const resource = settings.resources.find((item) => item.id === entityId)
      const converted = resource && quantity !== undefined && quantity !== null ? tryConvertQuantity(quantity, unit, resource.purchaseUnit) : null
      if (!resource || converted === null) error('invalid-unit', `単位${unit || '（空欄）'}をResource単位へ換算できません。`, profile.mappings.unit)
      if (quantity !== undefined && quantity !== null && quantity < 0) warning('negative-quantity', '負の購入数量です。')
      if (date && (date < actualPeriod.startDate || date > actualPeriod.endDate)) warning('outside-actual-period', `${date}はActualPeriod外です。`)
      issues.push(...rowIssues)
      if (rowIssues.some((item) => item.severity === 'error')) return void errorRowIndexes.push(index)
      if (date! < actualPeriod.startDate || date! > actualPeriod.endDate) return void skippedRowIndexes.push(index)
      contribution.purchaseExpenditure = addOptional(contribution.purchaseExpenditure, amount as number)
      upsertResource(contribution.resourceRecords, entityId!, resource!.purchaseUnit, { purchasedQuantity: converted!, purchaseExpenditure: amount as number })
    } else if (dataset.sourceType === 'utilities') {
      const startDate = parseDateField('startDate')
      const endDate = parseDateField('endDate')
      const quantity = parseNumberField('quantity')
      const amount = parseNumberField('amount', true)
      const utility = utilityKey(entityName)
      if (!utility) error('unknown-entity', `光熱種別「${entityName}」を認識できません。`, profile.mappings.entityName)
      const expectedUnit: Unit | undefined = utility === 'water' ? 'L' : utility === 'gas' ? 'm³' : utility === 'electricity' ? 'kWh' : undefined
      const unit = fieldValue(row, profile, 'unit') as Unit
      const convertedQuantity = expectedUnit && quantity !== undefined && quantity !== null ? tryConvertQuantity(quantity, unit, expectedUnit) : null
      if (expectedUnit && convertedQuantity === null) error('invalid-unit', `単位${unit || '（空欄）'}は${expectedUnit}と互換性がありません。`, profile.mappings.unit)
      if (quantity !== undefined && quantity !== null && quantity < 0) warning('negative-quantity', '負の光熱使用量です。')
      if (amount === 0) warning('zero-amount', '光熱料金が明示的に0円です。')
      if (startDate && endDate && endDate < startDate) error('invalid-date-range', '請求終了日が開始日より前です。')
      const overlap = startDate && endDate ? overlapDays(startDate, endDate, actualPeriod.startDate, actualPeriod.endDate) : 0
      const billingDays = startDate && endDate ? inclusiveDays(startDate, endDate) : 0
      if (billingDays > 0 && overlap === 0) warning('outside-actual-period', '請求期間はActualPeriod外です。')
      else if (billingDays > 0 && overlap < billingDays) warning('partial-utility-period', options.allocatePartialUtilities ? '請求値を重複日数で按分します。' : '請求期間が部分重複しています。明示的な日数按分が必要です。')
      issues.push(...rowIssues)
      if (rowIssues.some((item) => item.severity === 'error')) return void errorRowIndexes.push(index)
      if (overlap === 0 || (overlap < billingDays && !options.allocatePartialUtilities)) return void skippedRowIndexes.push(index)
      const factor = overlap < billingDays ? overlap / billingDays : 1
      const record = contribution.utilities[utility!]
      record.cost = addOptional(record.cost, (amount as number) * factor)
      record.quantity = addOptional(record.quantity, convertedQuantity! * factor)
    } else if (dataset.sourceType === 'labor') {
      const date = parseDateField('date')
      const hours = parseNumberField('quantity')
      const amount = parseNumberField('amount', true)
      if (hours !== undefined && hours !== null && hours < 0) warning('negative-quantity', '負の実労働時間です。')
      if (amount === 0) warning('zero-amount', '人件費が明示的に0円です。')
      if (date && (date < actualPeriod.startDate || date > actualPeriod.endDate)) warning('outside-actual-period', `${date}はActualPeriod外です。`)
      issues.push(...rowIssues)
      if (rowIssues.some((item) => item.severity === 'error')) return void errorRowIndexes.push(index)
      if (date! < actualPeriod.startDate || date! > actualPeriod.endDate) return void skippedRowIndexes.push(index)
      contribution.laborHours = addOptional(contribution.laborHours, hours as number)
      contribution.laborCost = addOptional(contribution.laborCost, amount as number)
      upsertLabor(contribution.laborRecords!, entityId!, hours as number, amount as number)
    } else if (dataset.sourceType === 'waste') {
      const date = parseDateField('date')
      const quantity = parseNumberField('quantity')
      const unit = fieldValue(row, profile, 'unit') as Unit
      const resource = settings.resources.find((item) => item.id === entityId)
      const converted = resource && quantity !== undefined && quantity !== null ? tryConvertQuantity(quantity, unit, resource.purchaseUnit) : null
      const reason = wasteReason(fieldValue(row, profile, 'reason'), profile)
      const amountRaw = fieldValue(row, profile, 'amount')
      const amount = amountRaw.trim() === '' ? undefined : parseImportAmount(amountRaw)
      if (!resource || converted === null) error('invalid-unit', `単位${unit || '（空欄）'}をResource単位へ換算できません。`, profile.mappings.unit)
      if (!reason) error('unknown-waste-reason', '廃棄理由のMappingがありません。', profile.mappings.reason)
      if (amount === null) error('invalid-amount', `廃棄原価「${amountRaw}」を数値として読めません。`, profile.mappings.amount)
      if (quantity !== undefined && quantity !== null && quantity < 0) warning('negative-quantity', '負の廃棄数量です。')
      if (amount === 0) warning('zero-amount', '廃棄原価が明示的に0円です。')
      if (date && (date < actualPeriod.startDate || date > actualPeriod.endDate)) warning('outside-actual-period', `${date}はActualPeriod外です。`)
      issues.push(...rowIssues)
      if (rowIssues.some((item) => item.severity === 'error')) return void errorRowIndexes.push(index)
      if (date! < actualPeriod.startDate || date! > actualPeriod.endDate) return void skippedRowIndexes.push(index)
      const waste: ActualWasteRecord = { resourceId: entityId!, quantity: converted!, unit: resource!.purchaseUnit, reason: reason! }
      if (typeof amount === 'number') {
        waste.cost = amount
        contribution.wasteCost = addOptional(contribution.wasteCost, amount)
      }
      contribution.wasteRecords!.push(waste)
      upsertResource(contribution.resourceRecords, entityId!, resource!.purchaseUnit, { wasteQuantity: converted!, wasteUnit: resource!.purchaseUnit, wasteCost: typeof amount === 'number' ? amount : undefined })
    } else if (dataset.sourceType === 'inventory') {
      const date = parseDateField('date')
      const quantity = parseNumberField('quantity')
      const unit = fieldValue(row, profile, 'unit') as Unit
      const resource = settings.resources.find((item) => item.id === entityId)
      const converted = resource && quantity !== undefined && quantity !== null ? tryConvertQuantity(quantity, unit, resource.purchaseUnit) : null
      const valueRaw = fieldValue(row, profile, 'inventoryValue')
      const inventoryValue = valueRaw.trim() === '' ? undefined : parseImportAmount(valueRaw)
      if (!resource || converted === null) error('invalid-unit', `単位${unit || '（空欄）'}をResource単位へ換算できません。`, profile.mappings.unit)
      if (inventoryValue === null) error('invalid-amount', `在庫価額「${valueRaw}」を数値として読めません。`, profile.mappings.inventoryValue)
      if (quantity !== undefined && quantity !== null && quantity < 0) warning('negative-quantity', '負の棚卸数量です。')
      if (inventoryValue === 0) warning('zero-amount', '在庫価額が明示的に0円です。')
      if (date && (date < actualPeriod.startDate || date > actualPeriod.endDate)) warning('outside-actual-period', `${date}はActualPeriod外です。`)
      issues.push(...rowIssues)
      if (rowIssues.some((item) => item.severity === 'error')) return void errorRowIndexes.push(index)
      if (date! < actualPeriod.startDate || date! > actualPeriod.endDate) return void skippedRowIndexes.push(index)
      const inventory: ActualInventoryRecord = { resourceId: entityId!, date: date!, quantity: converted!, unit: resource!.purchaseUnit }
      if (typeof inventoryValue === 'number') inventory.inventoryValue = inventoryValue
      contribution.inventoryRecords!.push(inventory)
      if (typeof inventoryValue === 'number' && date === actualPeriod.startDate) contribution.openingInventoryValue = addOptional(contribution.openingInventoryValue, inventoryValue)
      if (typeof inventoryValue === 'number' && date === actualPeriod.endDate) contribution.endingInventoryValue = addOptional(contribution.endingInventoryValue, inventoryValue)
    } else {
      issues.push(...rowIssues)
    }
    validRowIndexes.push(index)
  })

  const targetFields = dataset.sourceType === 'sales' ? ['revenue', 'meals', 'menuSales']
    : dataset.sourceType === 'purchases' ? ['purchaseExpenditure', 'resourceRecords.purchase']
      : dataset.sourceType === 'utilities' ? ['utilities']
        : dataset.sourceType === 'labor' ? ['laborCost', 'laborHours', 'laborRecords']
          : dataset.sourceType === 'waste' ? ['wasteCost', 'wasteRecords', 'resourceRecords.waste']
            : dataset.sourceType === 'inventory' ? ['openingInventoryValue', 'endingInventoryValue', 'inventoryRecords']
              : []
  return { contribution, issues, validRowIndexes, errorRowIndexes, skippedRowIndexes, targetFields }
}

const resetSource = (actuals: ActualValues, sourceType: ImportSourceType): ActualValues => {
  const next: ActualValues = structuredClone(actuals)
  if (sourceType === 'sales') {
    delete next.revenue; delete next.meals; next.menuSales = []
  } else if (sourceType === 'purchases') {
    delete next.purchaseExpenditure
    next.resourceRecords = next.resourceRecords.map((record) => {
      const cleaned = { ...record }
      delete cleaned.purchasedQuantity
      delete cleaned.purchaseExpenditure
      return cleaned
    })
  } else if (sourceType === 'utilities') {
    next.utilities = { water: {}, gas: {}, electricity: {} }
  } else if (sourceType === 'labor') {
    delete next.laborCost; delete next.laborHours; next.laborRecords = []
  } else if (sourceType === 'waste') {
    delete next.wasteCost; next.wasteRecords = []
    next.resourceRecords = next.resourceRecords.map((record) => {
      const cleaned = { ...record }
      delete cleaned.wasteQuantity
      delete cleaned.wasteUnit
      delete cleaned.wasteCost
      return cleaned
    })
  } else if (sourceType === 'inventory') {
    delete next.openingInventoryValue; delete next.endingInventoryValue; next.inventoryRecords = []
  }
  return next
}

export const mergeActualContribution = (current: ActualValues, contribution: ActualValues, sourceType: ImportSourceType, mode: ImportMergeMode): ActualValues => {
  const next = mode === 'replace' ? resetSource(current, sourceType) : structuredClone(current)
  const addField = (key: keyof Pick<ActualValues, 'revenue' | 'meals' | 'purchaseExpenditure' | 'wasteCost' | 'laborCost' | 'laborHours' | 'openingInventoryValue' | 'endingInventoryValue'>) => {
    if (contribution[key] !== undefined) next[key] = addOptional(next[key], contribution[key])
  }
  ;(['revenue', 'meals', 'purchaseExpenditure', 'wasteCost', 'laborCost', 'laborHours', 'openingInventoryValue', 'endingInventoryValue'] as const).forEach(addField)
  contribution.menuSales.forEach((item) => upsertMenu(next.menuSales, item))
  contribution.resourceRecords.forEach((record) => upsertResource(next.resourceRecords, record.resourceId, record.purchaseUnit, record))
  ;(['water', 'gas', 'electricity'] as const).forEach((utility) => {
    const incoming = contribution.utilities[utility]
    if (incoming.cost !== undefined) next.utilities[utility].cost = addOptional(next.utilities[utility].cost, incoming.cost)
    if (incoming.quantity !== undefined) next.utilities[utility].quantity = addOptional(next.utilities[utility].quantity, incoming.quantity)
  })
  next.laborRecords = [...(next.laborRecords ?? [])]
  contribution.laborRecords?.forEach((record) => upsertLabor(next.laborRecords!, record.laborRoleId, record.hours ?? 0, record.cost ?? 0))
  next.wasteRecords = [...(next.wasteRecords ?? []), ...(contribution.wasteRecords ?? []).map((record) => ({ ...record }))]
  next.inventoryRecords = [...(next.inventoryRecords ?? []), ...(contribution.inventoryRecords ?? []).map((record) => ({ ...record }))]
  return next
}

export const datasetHash = (dataset: ImportDataset) => hashText(`${dataset.sourceType}\u0000${dataset.columns.join('\u0001')}\u0000${dataset.rowHashes.join('\u0001')}`)

export const findDuplicateImports = (settings: AppSettings, dataset: ImportDataset, actualPeriodId: string) => {
  const hash = datasetHash(dataset)
  return settings.importRecords.filter((record) => !record.undoneAt && record.actualPeriodId === actualPeriodId && (
    record.datasetHash === hash || record.rowHashes.some((rowHash) => dataset.rowHashes.includes(rowHash))
  ))
}

export interface ApplyImportResult {
  settings: AppSettings
  record: ImportRecord
  prepared: PreparedImport
}

export const applyPreparedImport = (
  settings: AppSettings,
  dataset: ImportDataset,
  profile: ImportMappingProfile,
  actualPeriodId: string,
  mergeMode: ImportMergeMode,
  options: PrepareImportOptions = {},
  now = new Date().toISOString(),
): ApplyImportResult => {
  const period = settings.actualPeriods.find((item) => item.id === actualPeriodId)
  if (!period || !parseLocalDate(period.startDate) || !parseLocalDate(period.endDate) || period.endDate < period.startDate) throw new Error('ActualPeriodが正しくありません。')
  const prepared = prepareImport(settings, dataset, profile, period, options)
  if (prepared.validRowIndexes.length === 0) throw new Error('Import可能な正常行がありません。')
  const beforeActual = structuredClone(period.actuals)
  const afterActual = mergeActualContribution(beforeActual, prepared.contribution, dataset.sourceType, mergeMode)
  const id = `import-${hashText(`${dataset.id}:${actualPeriodId}:${now}`)}`
  const record: ImportRecord = {
    id,
    datasetId: dataset.id,
    datasetHash: datasetHash(dataset),
    sourceType: dataset.sourceType,
    originalFileName: dataset.originalFileName,
    actualPeriodId,
    importedAt: now,
    importedRows: prepared.validRowIndexes.length,
    skippedRows: prepared.skippedRowIndexes.length,
    errorRows: prepared.errorRowIndexes.length,
    targetFields: prepared.targetFields,
    mergeMode,
    rowHashes: prepared.validRowIndexes.map((index) => dataset.rowHashes[index]),
    beforeActual: structuredClone(beforeActual),
    afterActual: structuredClone(afterActual),
  }
  return {
    settings: {
      ...settings,
      actualPeriods: settings.actualPeriods.map((item) => item.id === actualPeriodId ? {
        ...item,
        actuals: structuredClone(afterActual),
        sourceMetadata: [...(item.sourceMetadata ?? []), { source: 'imported', fields: prepared.targetFields, importRecordId: id, recordedAt: now }],
      } : item),
      importRecords: [...settings.importRecords, record],
    },
    record,
    prepared,
  }
}

export const undoImport = (settings: AppSettings, importRecordId: string, now = new Date().toISOString()): AppSettings => {
  const record = settings.importRecords.find((item) => item.id === importRecordId)
  if (!record || record.undoneAt) throw new Error('取り消せるImportが見つかりません。')
  const period = settings.actualPeriods.find((item) => item.id === record.actualPeriodId)
  if (!period) throw new Error('Import先ActualPeriodが見つかりません。')
  if (JSON.stringify(period.actuals) !== JSON.stringify(record.afterActual)) throw new Error('Import後に実績が変更されているため、安全にUndoできません。最新変更を確認してください。')
  return {
    ...settings,
    actualPeriods: settings.actualPeriods.map((item) => item.id === period.id ? {
      ...item,
      actuals: structuredClone(record.beforeActual),
      sourceMetadata: (item.sourceMetadata ?? []).filter((metadata) => metadata.importRecordId !== record.id),
    } : item),
    importRecords: settings.importRecords.map((item) => item.id === record.id ? { ...item, undoneAt: now } : item),
  }
}

export const createMappingProfile = (
  dataset: ImportDataset,
  name: string,
  mappings: ImportMappingProfile['mappings'],
  entityMappings: ImportMappingProfile['entityMappings'],
  now = new Date().toISOString(),
): ImportMappingProfile => ({
  id: `mapping-${hashText(`${name}:${dataset.sourceType}:${now}`)}`,
  name,
  sourceType: dataset.sourceType,
  mappings: { ...mappings },
  entityMappings: structuredClone(entityMappings),
  updatedAt: now,
})

export const formatDatasetDateRange = (dataset: ImportDataset, profile: ImportMappingProfile) => {
  const startField = dataset.sourceType === 'utilities' ? 'startDate' : 'date'
  const startDates = dataset.rows
    .map((row) => parseImportDate(fieldValue(row, profile, startField)))
    .filter((value): value is string => !!value)
    .sort()
  if (!startDates.length) return null

  const endDates = dataset.sourceType === 'utilities'
    ? dataset.rows
      .map((row) => parseImportDate(fieldValue(row, profile, 'endDate')))
      .filter((value): value is string => !!value)
      .sort()
    : startDates
  return { startDate: startDates[0], endDate: endDates.at(-1) ?? startDates.at(-1)! }
}

export const createActualPeriodFromDataset = (dataset: ImportDataset, profile: ImportMappingProfile, name?: string): ActualPeriod | null => {
  const range = formatDatasetDateRange(dataset, profile)
  if (!range) return null
  return {
    id: `actual-${hashText(`${dataset.id}:${range.startDate}:${range.endDate}`)}`,
    name: name ?? `${range.startDate}〜${range.endDate} 実績`,
    ...range,
    actuals: emptyActuals(),
  }
}

export const importRecordLabel = (record: ImportRecord) => `${record.originalFileName ?? record.sourceType} · ${formatLocalDate(new Date(record.importedAt))}`
