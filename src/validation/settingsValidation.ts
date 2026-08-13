import { parseLocalDate, scheduleHours, timeToMinutes } from '../calculations/calendar'
import { areUnitsCompatible } from '../calculations/units'
import type { AppSettings, SourceRef, ValidationIssue } from '../models/types'

const issue = (
  severity: ValidationIssue['severity'],
  code: string,
  message: string,
  path?: string,
): ValidationIssue => ({ severity, code, message, path })

export const validateSettings = (settings: AppSettings): ValidationIssue[] => {
  const issues: ValidationIssue[] = []
  const resources = new Map(settings.resources.map((resource) => [resource.id, resource]))
  const outputs = new Map(settings.processes.flatMap((process) => process.outputs.map((output) => [output.id, output] as const)))
  const outputOwners = new Map(settings.processes.flatMap((process) => process.outputs.map((output) => [output.id, process.id] as const)))

  const validateSource = (source: SourceRef, path: string) => {
    const targetUnit = source.sourceType === 'resource'
      ? resources.get(source.sourceId)?.purchaseUnit
      : outputs.get(source.sourceId)?.unit
    if (!targetUnit) {
      issues.push(issue('error', 'missing-source', `${source.sourceType === 'resource' ? '原材料' : '仕込品'}「${source.sourceId}」が見つかりません。`, path))
      return
    }
    if (!areUnitsCompatible(source.unit, targetUnit)) {
      issues.push(issue('error', 'unit-mismatch', `単位が一致しません: ${source.unit} は ${targetUnit} と換算できません。`, path))
    }
  }

  for (const [index, resource] of settings.resources.entries()) {
    const path = `resources.${index}`
    if (resource.yieldRate <= 0 || resource.yieldRate > 1) issues.push(issue('error', 'invalid-yield-rate', `${resource.name}の歩留まりは0%超100%以下にしてください。`, path))
    if (resource.purchaseQuantity <= 0) issues.push(issue('error', 'invalid-purchase-package-quantity', `${resource.name}の購入パッケージ量は0より大きくしてください。`, path))
    if (resource.purchasePrice < 0) issues.push(issue('error', 'negative-purchase-package-price', `${resource.name}の購入パッケージ価格は0円以上にしてください。`, path))
    if (resource.minimumPurchaseLot <= 0) issues.push(issue('error', 'invalid-minimum-purchase-packages', `${resource.name}の最低購入パッケージ数は1以上にしてください。`, path))
    if (resource.shelfLifeDays <= 0) issues.push(issue('warning', 'missing-shelf-life', `${resource.name}の保存期限が未設定です。`, path))
  }

  for (const [index, process] of settings.processes.entries()) {
    const path = `processes.${index}`
    if (process.batchSize <= 0) issues.push(issue('error', 'invalid-batch-size', `${process.name}のバッチサイズは0より大きくしてください。`, path))
    if (process.laborCostTreatment !== 'withinScheduledShift' && process.laborCostTreatment !== 'additionalLabor') {
      issues.push(issue('error', 'invalid-labor-cost-treatment', `${process.name}の仕込み人件費区分が正しくありません。`, path))
    }
    if (!settings.labor.some((role) => role.id === process.laborRole)) issues.push(issue('error', 'missing-labor-role', `${process.name}の担当役割が見つかりません。`, path))
    process.inputs.forEach((source, sourceIndex) => validateSource(source, `${path}.inputs.${sourceIndex}`))
    for (const [outputIndex, output] of process.outputs.entries()) {
      const outputPath = `${path}.outputs.${outputIndex}`
      if (output.quantity <= 0) issues.push(issue('error', 'invalid-output-quantity', `${output.name}のOutput数量は0より大きくしてください。`, outputPath))
      if (output.costAllocation < 0 || output.costAllocation > 1) issues.push(issue('error', 'invalid-cost-allocation', `${output.name}の原価配賦率は0〜100%にしてください。`, outputPath))
      if (output.shelfLifeDays <= 0) issues.push(issue('warning', 'zero-shelf-life', `${output.name}の保存期限が0日です。`, outputPath))
    }
    const allocationTotal = process.outputs.reduce((total, output) => total + output.costAllocation, 0)
    if (process.outputs.length > 0 && Math.abs(allocationTotal - 1) > 0.0001) {
      issues.push(issue('warning', 'cost-allocation-total', `${process.name}の原価配賦率合計は${(allocationTotal * 100).toFixed(1)}%です。`, path))
    }
    if (process.outputs[0] && Math.abs(process.outputs[0].quantity - process.batchSize) > 0.0001) {
      issues.push(issue('warning', 'primary-output-batch-mismatch', `${process.name}の主Output数量とbatchSizeが一致していません。在庫生産ではbatchSizeを使用します。`, path))
    }
  }

  for (const [index, menu] of settings.menuItems.entries()) {
    if (menu.sellingPrice < 0) issues.push(issue('error', 'negative-selling-price', `${menu.name}の販売価格は0円以上にしてください。`, `menuItems.${index}`))
    menu.consumption.forEach((source, sourceIndex) => validateSource(source, `menuItems.${index}.consumption.${sourceIndex}`))
  }
  for (const [index, topping] of settings.toppings.entries()) {
    if (topping.sellingPrice < 0) issues.push(issue('error', 'negative-selling-price', `${topping.name}の販売価格は0円以上にしてください。`, `toppings.${index}`))
    topping.consumption.forEach((source, sourceIndex) => validateSource(source, `toppings.${index}.consumption.${sourceIndex}`))
  }

  for (const [index, lot] of settings.inventory.openingLots.entries()) {
    const path = `inventory.openingLots.${index}`
    if (lot.quantity < 0) issues.push(issue('error', 'negative-inventory', `期首在庫「${lot.id}」の数量は0以上にしてください。`, path))
    const targetUnit = lot.sourceType === 'resource'
      ? resources.get(lot.sourceId)?.purchaseUnit
      : outputs.get(lot.sourceId)?.unit
    if (!targetUnit) issues.push(issue('error', 'missing-inventory-source', `期首在庫の参照先「${lot.sourceId}」が見つかりません。`, path))
    else if (!areUnitsCompatible(lot.unit, targetUnit)) issues.push(issue('error', 'inventory-unit-mismatch', `期首在庫の単位${lot.unit}は${targetUnit}と換算できません。`, path))
    if (!lot.acquiredDate || !parseLocalDate(lot.acquiredDate)) issues.push(issue('warning', 'opening-inventory-missing-date', `期首在庫「${lot.id}」の取得日がありません。`, path))
  }
  if (settings.fryingOil.inventoryResourceId) {
    const oilResource = resources.get(settings.fryingOil.inventoryResourceId)
    if (!oilResource) issues.push(issue('error', 'missing-frying-oil-resource', '揚げ油の在庫Resourceが見つかりません。', 'fryingOil.inventoryResourceId'))
    else if (!areUnitsCompatible(oilResource.purchaseUnit, 'L')) issues.push(issue('error', 'frying-oil-unit-mismatch', `揚げ油Resourceの単位${oilResource.purchaseUnit}はLと換算できません。`, 'fryingOil.inventoryResourceId'))
  }

  const menuRatio = settings.menuItems.filter((menu) => menu.enabled).reduce((total, menu) => total + menu.expectedSalesRatio, 0)
  if (Math.abs(menuRatio - 100) > 0.01) issues.push(issue('warning', 'menu-ratio-total', `有効メニューの販売構成比合計は${menuRatio.toFixed(1)}%です。`, 'menuItems'))

  if (!parseLocalDate(settings.business.simulationStartDate)) {
    issues.push(issue('error', 'invalid-start-date', 'シミュレーション開始日が正しくありません。', 'business.simulationStartDate'))
  }
  for (const schedule of settings.business.weekdays) {
    const opening = timeToMinutes(schedule.openingTime)
    const closing = timeToMinutes(schedule.closingTime)
    if (schedule.enabled && (opening === null || closing === null || scheduleHours(schedule) <= 0)) {
      issues.push(issue('error', 'invalid-business-hours', `${['月', '火', '水', '木', '金', '土', '日'][schedule.day] ?? schedule.day}曜日の閉店時刻は開店時刻より後にしてください。`, `business.weekdays.${schedule.day}`))
    }
  }

  const processGraph = new Map<string, string[]>()
  for (const process of settings.processes) {
    processGraph.set(process.id, process.inputs
      .filter((source) => source.sourceType === 'output')
      .map((source) => outputOwners.get(source.sourceId))
      .filter((owner): owner is string => !!owner))
  }
  const state = new Map<string, 'visiting' | 'visited'>()
  const stack: string[] = []
  const reportedCycles = new Set<string>()
  const visit = (processId: string) => {
    if (state.get(processId) === 'visited') return
    if (state.get(processId) === 'visiting') {
      const start = stack.indexOf(processId)
      const cycleIds = [...stack.slice(start), processId]
      const signature = [...new Set(cycleIds)].sort().join('|')
      if (!reportedCycles.has(signature)) {
        reportedCycles.add(signature)
        const names = cycleIds.map((id) => settings.processes.find((process) => process.id === id)?.name ?? id)
        issues.push(issue('error', 'process-cycle', `工程が循環参照しています: ${names.join(' → ')}`, `processes.${processId}`))
      }
      return
    }
    state.set(processId, 'visiting')
    stack.push(processId)
    for (const dependency of processGraph.get(processId) ?? []) visit(dependency)
    stack.pop()
    state.set(processId, 'visited')
  }
  for (const process of settings.processes) visit(process.id)

  for (const [index, actualPeriod] of settings.actualPeriods.entries()) {
    const path = `actualPeriods.${index}`
    const start = parseLocalDate(actualPeriod.startDate)
    const end = parseLocalDate(actualPeriod.endDate)
    if (!start || !end || end < start) issues.push(issue('error', 'invalid-actual-period', `${actualPeriod.name}の実績期間が正しくありません。`, path))
    const nonNegativeValues: Array<[string, number | undefined]> = [
      ['売上', actualPeriod.actuals.revenue], ['販売食数', actualPeriod.actuals.meals], ['使用原価', actualPeriod.actuals.usageCost],
      ['購入支出', actualPeriod.actuals.purchaseExpenditure], ['期首在庫価額', actualPeriod.actuals.openingInventoryValue], ['期末在庫価額', actualPeriod.actuals.endingInventoryValue],
      ['廃棄原価', actualPeriod.actuals.wasteCost], ['人件費', actualPeriod.actuals.laborCost], ['実労働時間', actualPeriod.actuals.laborHours],
      ['水道料金', actualPeriod.actuals.utilities.water.cost], ['水使用量', actualPeriod.actuals.utilities.water.quantity],
      ['ガス料金', actualPeriod.actuals.utilities.gas.cost], ['ガス使用量', actualPeriod.actuals.utilities.gas.quantity],
      ['電気料金', actualPeriod.actuals.utilities.electricity.cost], ['電力使用量', actualPeriod.actuals.utilities.electricity.quantity],
      ['その他費用', actualPeriod.actuals.otherCost], ['営業日数', actualPeriod.actuals.operatingDays], ['総営業時間', actualPeriod.actuals.operatingHours],
    ]
    for (const [label, value] of nonNegativeValues) {
      if (value !== undefined && value < 0) issues.push(issue('error', 'negative-actual-value', `${actualPeriod.name}の${label}は0以上にしてください。`, path))
    }
    for (const [recordIndex, record] of actualPeriod.actuals.resourceRecords.entries()) {
      const recordPath = `${path}.actuals.resourceRecords.${recordIndex}`
      if ([record.purchasedQuantity, record.purchaseExpenditure, record.usedQuantity, record.wasteQuantity, record.wasteCost].some((value) => value !== undefined && value < 0)) {
        issues.push(issue('error', 'negative-actual-value', `${actualPeriod.name}のResource実績は0以上にしてください。`, recordPath))
      }
      const resource = resources.get(record.resourceId)
      if (!resource) issues.push(issue('error', 'missing-actual-resource', `実績Resource「${record.resourceId}」が見つかりません。`, recordPath))
      else {
        if (!areUnitsCompatible(record.purchaseUnit, resource.purchaseUnit)) issues.push(issue('error', 'actual-resource-unit-mismatch', `${resource.name}の実績購入単位${record.purchaseUnit}は${resource.purchaseUnit}と換算できません。`, recordPath))
        if (record.usageUnit && !areUnitsCompatible(record.usageUnit, resource.purchaseUnit)) issues.push(issue('error', 'actual-resource-unit-mismatch', `${resource.name}の実績使用単位${record.usageUnit}は${resource.purchaseUnit}と換算できません。`, recordPath))
        if (record.wasteUnit && !areUnitsCompatible(record.wasteUnit, resource.purchaseUnit)) issues.push(issue('error', 'actual-resource-unit-mismatch', `${resource.name}の実績廃棄単位${record.wasteUnit}は${resource.purchaseUnit}と換算できません。`, recordPath))
      }
    }
    for (const [saleIndex, sale] of actualPeriod.actuals.menuSales.entries()) {
      const salePath = `${path}.actuals.menuSales.${saleIndex}`
      if (!settings.menuItems.some((menu) => menu.id === sale.menuItemId)) issues.push(issue('error', 'missing-actual-menu', `実績メニュー「${sale.menuItemId}」が見つかりません。`, salePath))
      if (sale.quantity < 0) issues.push(issue('error', 'negative-actual-value', `${actualPeriod.name}のメニュー別販売食数は0以上にしてください。`, salePath))
    }
  }
  if (new Set(settings.actualPeriods.map((period) => period.id)).size !== settings.actualPeriods.length) {
    issues.push(issue('error', 'duplicate-actual-id', '実績期間のIDが重複しています。', 'actualPeriods'))
  }

  for (const [index, scenario] of settings.scenarios.entries()) {
    const path = `scenarios.${index}`
    const multipliers = [
      scenario.overrides.averageSellingPriceMultiplier,
      scenario.overrides.laborWageMultiplier,
      ...Object.values(scenario.overrides.resourcePurchasePriceMultipliers ?? {}),
      ...Object.values(scenario.overrides.utilityUnitPriceMultipliers ?? {}),
    ]
    if (multipliers.some((value) => value !== undefined && value < 0)) issues.push(issue('error', 'negative-scenario-multiplier', `${scenario.name}の変化倍率は0以上にしてください。`, path))
    if ((scenario.overrides.business?.mealsPerDay ?? 0) < 0 || (scenario.overrides.business?.hoursPerDay ?? 0) < 0) {
      issues.push(issue('error', 'negative-scenario-business-value', `${scenario.name}の食数・営業時間は0以上にしてください。`, path))
    }
    const days = scenario.overrides.business?.operatingDaysPerWeek
    if (days !== undefined && (days < 0 || days > 7)) issues.push(issue('error', 'invalid-scenario-operating-days', `${scenario.name}の週営業日数は0〜7日にしてください。`, path))
    for (const resourceId of Object.keys(scenario.overrides.resourcePurchasePriceMultipliers ?? {})) {
      if (!resources.has(resourceId)) issues.push(issue('error', 'missing-scenario-resource', `${scenario.name}の対象Resource「${resourceId}」が見つかりません。`, path))
    }
  }
  if (settings.scenarios.length > 5) issues.push(issue('warning', 'too-many-scenarios', '比較表示は先頭5件のScenarioまでです。', 'scenarios'))

  if (settings.resources.some((resource) => resource.isReferencePrice)
    || settings.utilities.water.isReferencePrice
    || settings.utilities.gas.isReferencePrice
    || settings.utilities.electricity.isReferencePrice
    || settings.fryingOil.isReferencePrice) {
    issues.push(issue('warning', 'reference-prices', '初期参考価格が残っています。実際の仕入・請求価格へ更新してください。'))
  }

  return issues
}
