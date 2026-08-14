import { getScheduleForDate, parseLocalDate, scheduleHours, timeToMinutes } from '../calculations/calendar'
import { calculateOptimizationCandidateCount, expandOptimizationVariableValues, OPTIMIZATION_WARNING_CANDIDATES } from '../calculations/optimizationEngine'
import { areUnitsCompatible } from '../calculations/units'
import type { AppSettings, SourceRef, ValidationIssue } from '../models/types'

const optimizationVariableTypes = new Set(['staffShiftHeadcount', 'equipmentCapacity', 'seatingUnitCount', 'openingTime', 'closingTime', 'kitchenOperationDuration', 'weekdayStaffHeadcount', 'weekdayOpeningTime', 'weekdayClosingTime', 'processPrepLookaheadDays', 'resourceProcurementLookaheadDays'])
const optimizationObjectives = new Set(['maximizeMeanOperatingProfit', 'maximizeP10OperatingProfit', 'minimizeAverageWait', 'minimizeLaborCost', 'maximizeRealizedSales', 'maximizeMeanPeriodProfit', 'maximizeP10PeriodProfit', 'minimizePeriodWaste', 'minimizeStockoutLoss'])
const optimizationConstraintMetrics = new Set(['laborCost', 'meanOperatingProfit', 'p10OperatingProfit', 'averageKitchenWait', 'p90KitchenWait', 'abandonmentRate', 'realizedSales', 'serviceLevel', 'staffCount', 'totalSeats', 'afterClosingMinutes', 'periodWasteCost', 'stockoutLostRevenue', 'purchaseExpenditure', 'endingInventoryValue'])

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
    if ((resource.procurementLeadTimeDays ?? 0) < 0) issues.push(issue('error', 'negative-procurement-lead-time', `${resource.name}の発注Lead Timeは0日以上にしてください。`, path))
    if ((resource.procurementLookaheadDays ?? 0) < 0) issues.push(issue('error', 'negative-procurement-lookahead', `${resource.name}の発注Lookaheadは0日以上にしてください。`, path))
    if ((resource.procurementLeadTimeDays ?? 0) > (resource.procurementLookaheadDays ?? 0)) issues.push(issue('warning', 'lead-time-exceeds-lookahead', `${resource.name}のLead Timeが発注Lookaheadを超えています。欠品リスクを確認してください。`, path))
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
    if ((process.prepLookaheadDays ?? 0) < 0) issues.push(issue('error', 'negative-prep-lookahead', `${process.name}の仕込みLookaheadは0日以上にしてください。`, path))
    if (process.outputs[0] && (process.prepLookaheadDays ?? 0) >= process.outputs[0].shelfLifeDays && process.outputs[0].shelfLifeDays > 0) {
      issues.push(issue('warning', 'prep-lookahead-exceeds-shelf-life', `${process.name}の仕込みLookaheadが保存期限以上です。自動計画では保存期限内へ制限されます。`, path))
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

  const equipment = new Map(settings.capacity.equipment.map((item) => [item.id, item]))
  const kitchenOperations = new Map(settings.capacity.operations.map((operation) => [operation.id, operation]))
  const laborRoles = new Set(settings.labor.map((role) => role.id))
  const capacityStartDate = parseLocalDate(settings.business.simulationStartDate)
  let capacitySchedule = capacityStartDate ? getScheduleForDate(settings, capacityStartDate) : undefined
  if (capacityStartDate && !capacitySchedule?.enabled) {
    for (let offset = 1; offset < 7; offset += 1) {
      const date = new Date(capacityStartDate.getFullYear(), capacityStartDate.getMonth(), capacityStartDate.getDate() + offset)
      const candidate = getScheduleForDate(settings, date)
      if (candidate?.enabled) { capacitySchedule = candidate; break }
    }
  }
  const businessOpening = timeToMinutes(capacitySchedule?.openingTime ?? settings.business.openingTime)
  const businessClosing = timeToMinutes(capacitySchedule?.closingTime ?? settings.business.closingTime)
  if (settings.capacity.targetWaitMinutes < 0) issues.push(issue('error', 'invalid-target-wait', '許容待ち時間は0分以上にしてください。', 'capacity.targetWaitMinutes'))
  if (settings.capacity.bucketMinutes <= 0) issues.push(issue('error', 'invalid-capacity-bucket', 'Peak集計幅は0分より大きくしてください。', 'capacity.bucketMinutes'))

  for (const [index, item] of settings.capacity.equipment.entries()) {
    const path = `capacity.equipment.${index}`
    if (item.capacity <= 0) issues.push(issue('error', 'invalid-equipment-capacity', `${item.name}の同時処理容量は0より大きくしてください。`, path))
    if (item.concurrentJobs <= 0) issues.push(issue('error', 'invalid-equipment-concurrency', `${item.name}の同時Job数は1以上にしてください。`, path))
    if (item.upgradeCostPerCapacityUnit !== undefined && item.upgradeCostPerCapacityUnit < 0) issues.push(issue('error', 'negative-equipment-upgrade-cost', `${item.name}の容量1単位あたり投資は0円以上にしてください。`, path))
  }

  for (const [index, operation] of settings.capacity.operations.entries()) {
    const path = `capacity.operations.${index}`
    if (operation.durationMinutes <= 0) issues.push(issue('error', 'invalid-kitchen-duration', `${operation.name}の所要時間は0より大きくしてください。`, path))
    if (operation.activeLaborMinutes < 0 || operation.activeLaborMinutes > operation.durationMinutes) {
      issues.push(issue('error', 'invalid-active-labor-minutes', `${operation.name}の人員占有時間は0以上かつ所要時間以下にしてください。`, path))
    }
    if (operation.batchCapacity <= 0) issues.push(issue('error', 'invalid-kitchen-batch-capacity', `${operation.name}のバッチ容量は0より大きくしてください。`, path))
    for (const [requirementIndex, requirement] of operation.equipmentRequirements.entries()) {
      const requirementPath = `${path}.equipmentRequirements.${requirementIndex}`
      if (!equipment.has(requirement.equipmentId)) issues.push(issue('error', 'missing-kitchen-equipment', `${operation.name}が参照する設備「${requirement.equipmentId}」が見つかりません。`, requirementPath))
      if (requirement.occupationMinutes <= 0 || requirement.units <= 0) issues.push(issue('error', 'invalid-equipment-requirement', `${operation.name}の設備占有時間・必要台数は0より大きくしてください。`, requirementPath))
    }
    for (const [requirementIndex, requirement] of operation.laborRequirements.entries()) {
      const requirementPath = `${path}.laborRequirements.${requirementIndex}`
      if (requirement.headcount < 0) issues.push(issue('error', 'negative-kitchen-headcount', `${operation.name}の必要人数は0以上にしてください。`, requirementPath))
      if (requirement.laborRoleIds.length === 0 || requirement.laborRoleIds.some((roleId) => !laborRoles.has(roleId))) {
        issues.push(issue('error', 'missing-kitchen-labor-role', `${operation.name}が参照する担当Roleが見つかりません。`, requirementPath))
      } else if (!requirement.laborRoleIds.some((roleId) => settings.capacity.staffShifts.some((shift) => shift.laborRoleId === roleId && shift.headcount > 0))) {
        issues.push(issue('warning', 'missing-kitchen-staff-shift', `${operation.name}を担当できるStaffShiftがありません。`, requirementPath))
      }
    }
  }

  for (const [index, shift] of settings.capacity.staffShifts.entries()) {
    const path = `capacity.staffShifts.${index}`
    const start = timeToMinutes(shift.startTime)
    const end = timeToMinutes(shift.endTime)
    if (!laborRoles.has(shift.laborRoleId)) issues.push(issue('error', 'missing-shift-labor-role', `${shift.name}の担当Roleが見つかりません。`, path))
    if (shift.headcount < 0) issues.push(issue('error', 'negative-shift-headcount', `${shift.name}の人数は0以上にしてください。`, path))
    if (start === null || end === null || end <= start) issues.push(issue('error', 'invalid-staff-shift-time', `${shift.name}の終了時刻は開始時刻より後にしてください。`, path))
    else if (businessOpening !== null && businessClosing !== null && (start < businessOpening || end > businessClosing)) {
      issues.push(issue('error', 'staff-shift-outside-business-hours', `${shift.name}は営業時間内に設定してください。`, path))
    }
  }

  for (const [workflowIndex, workflow] of settings.capacity.workflows.entries()) {
    const path = `capacity.workflows.${workflowIndex}`
    const nodes = new Map(workflow.nodes.map((node) => [node.id, node]))
    if (!settings.menuItems.some((menu) => menu.id === workflow.menuItemId)) issues.push(issue('error', 'missing-workflow-menu', `${workflow.name}の対象メニューが見つかりません。`, path))
    for (const [nodeIndex, node] of workflow.nodes.entries()) {
      const nodePath = `${path}.nodes.${nodeIndex}`
      if (!kitchenOperations.has(node.operationId)) issues.push(issue('error', 'missing-workflow-operation', `${workflow.name}が参照する厨房工程「${node.operationId}」が見つかりません。`, nodePath))
      if (node.dependencies.some((dependency) => !nodes.has(dependency))) issues.push(issue('error', 'missing-workflow-dependency', `${workflow.name}に存在しない前工程参照があります。`, nodePath))
    }
    const nodeState = new Map<string, 'visiting' | 'visited'>()
    let hasCycle = false
    const visitNode = (nodeId: string) => {
      if (nodeState.get(nodeId) === 'visiting') { hasCycle = true; return }
      if (nodeState.get(nodeId) === 'visited') return
      nodeState.set(nodeId, 'visiting')
      for (const dependency of nodes.get(nodeId)?.dependencies ?? []) visitNode(dependency)
      nodeState.set(nodeId, 'visited')
    }
    workflow.nodes.forEach((node) => visitNode(node.id))
    if (hasCycle) issues.push(issue('error', 'kitchen-workflow-cycle', `${workflow.name}の厨房Workflowが循環参照しています。`, path))
  }

  for (const [index, menu] of settings.menuItems.entries()) {
    if (menu.enabled && (!menu.kitchenWorkflowId || !settings.capacity.workflows.some((workflow) => workflow.id === menu.kitchenWorkflowId))) {
      issues.push(issue('error', 'missing-menu-workflow', `${menu.name}の厨房Workflowが見つかりません。`, `menuItems.${index}.kitchenWorkflowId`))
    }
  }

  const demandTotal = settings.capacity.demandProfile.timeSlots.reduce((total, slot) => total + Math.max(0, slot.meals), 0)
  if (Math.abs(demandTotal - settings.business.mealsPerDay) > 0.01) {
    issues.push(issue('warning', 'demand-profile-total-mismatch', `時間帯別需要は合計${demandTotal}食で、1日販売食数${settings.business.mealsPerDay}食と一致しません。`, 'capacity.demandProfile'))
  }
  for (const [index, slot] of settings.capacity.demandProfile.timeSlots.entries()) {
    const start = timeToMinutes(slot.startTime)
    const end = timeToMinutes(slot.endTime)
    if (slot.meals < 0 || start === null || end === null || end <= start) issues.push(issue('error', 'invalid-demand-slot', '需要時間帯と食数を正しく設定してください。', `capacity.demandProfile.timeSlots.${index}`))
  }

  const stochastic = settings.capacity.stochasticDemand
  for (const [index, slot] of stochastic.arrivalProfile.slots.entries()) {
    const path = `capacity.stochasticDemand.arrivalProfile.slots.${index}`
    const start = timeToMinutes(slot.startTime)
    const end = timeToMinutes(slot.endTime)
    if (start === null || end === null || end <= start) issues.push(issue('error', 'invalid-arrival-range', '来店時間帯の終了時刻は開始時刻より後にしてください。', path))
    else if (businessOpening !== null && businessClosing !== null && (start < businessOpening || end > businessClosing)) {
      issues.push(issue('warning', 'arrival-outside-business-hours', '来店Profileに営業時間外の時間帯があります。営業時間内だけが生成対象です。', path))
    }
    if (slot.expectedGuests < 0) issues.push(issue('error', 'negative-expected-guests', '平均来店人数は0以上にしてください。', path))
    if (slot.expectedGuests === 0) issues.push(issue('warning', 'zero-expected-guests', '平均来店人数が0人の時間帯があります。', path))
  }
  const partyProbabilityTotal = stochastic.partySizeDistribution.reduce((sum, item) => sum + item.probability, 0)
  for (const [index, item] of stochastic.partySizeDistribution.entries()) {
    const path = `capacity.stochasticDemand.partySizeDistribution.${index}`
    if (item.size <= 0) issues.push(issue('error', 'invalid-party-size', 'Party人数は1人以上にしてください。', path))
    if (item.probability < 0) issues.push(issue('error', 'negative-party-probability', 'Party人数確率は0%以上にしてください。', path))
  }
  if (Math.abs(partyProbabilityTotal - 100) > 0.01) issues.push(issue('warning', 'party-probability-total', `Party人数確率の合計は${partyProbabilityTotal.toFixed(1)}%です。`, 'capacity.stochasticDemand.partySizeDistribution'))

  for (const [index, unit] of stochastic.seatingUnits.entries()) {
    const path = `capacity.stochasticDemand.seatingUnits.${index}`
    if (unit.capacity <= 0) issues.push(issue('error', 'invalid-seating-capacity', `${unit.name}の収容人数は0より大きくしてください。`, path))
    if (unit.count < 0) issues.push(issue('error', 'negative-seating-count', `${unit.name}の席・卓数は0以上にしてください。`, path))
  }
  const validateDuration = (label: string, duration: typeof stochastic.orderDelay, allowZero: boolean, path: string) => {
    if ((allowZero ? duration.meanMinutes < 0 : duration.meanMinutes <= 0)
      || (allowZero ? duration.minMinutes < 0 : duration.minMinutes <= 0)
      || (allowZero ? duration.maxMinutes < 0 : duration.maxMinutes <= 0)
      || duration.maxMinutes < duration.minMinutes) {
      issues.push(issue('error', allowZero ? 'invalid-order-delay' : 'invalid-dwell-time', `${label}の時間範囲が正しくありません。`, path))
    }
  }
  validateDuration('注文遅延', stochastic.orderDelay, true, 'capacity.stochasticDemand.orderDelay')
  validateDuration('滞在時間', stochastic.dwellTime, false, 'capacity.stochasticDemand.dwellTime')
  if (stochastic.maxSeatingWaitMinutes < 0) issues.push(issue('error', 'invalid-max-seating-wait', '最大席待ち時間は0分以上にしてください。', 'capacity.stochasticDemand.maxSeatingWaitMinutes'))
  if (stochastic.monteCarlo.runs <= 0) issues.push(issue('error', 'invalid-monte-carlo-runs', 'Monte Carlo run数は1以上にしてください。', 'capacity.stochasticDemand.monteCarlo.runs'))
  if (stochastic.monteCarlo.maximumRuns <= 0 || stochastic.monteCarlo.maximumRuns > 1_000 || stochastic.monteCarlo.runs > stochastic.monteCarlo.maximumRuns) {
    issues.push(issue('error', 'monte-carlo-runs-exceeded', 'Monte Carlo run数は設定上限かつ1,000以下にしてください。', 'capacity.stochasticDemand.monteCarlo'))
  }
  const totalSeats = stochastic.seatingUnits.filter((unit) => unit.enabled).reduce((sum, unit) => sum + unit.capacity * unit.count, 0)
  const expectedGuests = stochastic.arrivalProfile.slots.reduce((sum, slot) => sum + Math.max(0, slot.expectedGuests), 0)
  if (totalSeats === 0) issues.push(issue('warning', 'no-seating', '有効な客席が0席です。すべての来店Partyが離脱します。', 'capacity.stochasticDemand.seatingUnits'))
  else if (expectedGuests > totalSeats * 10) issues.push(issue('warning', 'extremely-low-seating', '平均来店人数に対して客席が極端に少ない可能性があります。', 'capacity.stochasticDemand.seatingUnits'))

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
    if (scenario.overrides.kitchenOpeningTime !== undefined || scenario.overrides.kitchenClosingTime !== undefined) {
      const opening = timeToMinutes(scenario.overrides.kitchenOpeningTime ?? settings.business.openingTime)
      const closing = timeToMinutes(scenario.overrides.kitchenClosingTime ?? settings.business.closingTime)
      if (opening === null || closing === null || closing <= opening) issues.push(issue('error', 'invalid-scenario-business-hours', `${scenario.name}の開閉店時刻が正しくありません。`, path))
    }
    for (const resourceId of Object.keys(scenario.overrides.resourcePurchasePriceMultipliers ?? {})) {
      if (!resources.has(resourceId)) issues.push(issue('error', 'missing-scenario-resource', `${scenario.name}の対象Resource「${resourceId}」が見つかりません。`, path))
    }
    for (const [shiftId, headcount] of Object.entries(scenario.overrides.staffShiftHeadcountOverrides ?? {})) {
      if (!settings.capacity.staffShifts.some((shift) => shift.id === shiftId)) issues.push(issue('error', 'missing-scenario-shift', `${scenario.name}のStaffShift「${shiftId}」が見つかりません。`, path))
      if (headcount < 0) issues.push(issue('error', 'negative-scenario-shift-headcount', `${scenario.name}のStaffShift人数は0以上にしてください。`, path))
    }
    for (const [equipmentId, capacity] of Object.entries(scenario.overrides.equipmentCapacityOverrides ?? {})) {
      if (!equipment.has(equipmentId)) issues.push(issue('error', 'missing-scenario-equipment', `${scenario.name}の設備「${equipmentId}」が見つかりません。`, path))
      if (capacity <= 0) issues.push(issue('error', 'invalid-scenario-equipment-capacity', `${scenario.name}の設備容量は0より大きくしてください。`, path))
    }
    for (const [operationId, duration] of Object.entries(scenario.overrides.kitchenOperationDurationOverrides ?? {})) {
      if (!kitchenOperations.has(operationId)) issues.push(issue('error', 'missing-scenario-kitchen-operation', `${scenario.name}の厨房工程「${operationId}」が見つかりません。`, path))
      if (duration <= 0) issues.push(issue('error', 'invalid-scenario-kitchen-duration', `${scenario.name}の工程時間は0より大きくしてください。`, path))
    }
    for (const [seatingUnitId, count] of Object.entries(scenario.overrides.seatingUnitCountOverrides ?? {})) {
      if (!stochastic.seatingUnits.some((unit) => unit.id === seatingUnitId)) issues.push(issue('error', 'missing-scenario-seating-unit', `${scenario.name}の客席「${seatingUnitId}」が見つかりません。`, path))
      if (count < 0) issues.push(issue('error', 'negative-scenario-seating-count', `${scenario.name}の客席数は0以上にしてください。`, path))
    }
  }
  if (settings.scenarios.length > 5) issues.push(issue('warning', 'too-many-scenarios', '比較表示は先頭5件のScenarioまでです。', 'scenarios'))

  for (const [studyIndex, study] of settings.optimizationStudies.entries()) {
    const studyPath = `optimizationStudies.${studyIndex}`
    if (!optimizationObjectives.has(study.objective) || (study.evaluationMode !== 'deterministic' && study.evaluationMode !== 'monteCarlo')) {
      issues.push(issue('error', 'invalid-optimization-study-mode', `${study.name}のObjectiveまたは評価方式が正しくありません。`, studyPath))
    }
    if (study.variables.length === 0) issues.push(issue('error', 'optimization-no-variables', `${study.name}には探索Variableがありません。`, `${studyPath}.variables`))
    if (study.maxCandidates <= 0 || study.hardCandidateLimit <= 0 || study.hardCandidateLimit > 50_000) {
      issues.push(issue('error', 'invalid-optimization-limit', `${study.name}の候補上限は1〜50,000件にしてください。`, studyPath))
    }
    if (study.evaluationMode === 'monteCarlo' && study.monteCarloRuns <= 0) {
      issues.push(issue('error', 'invalid-optimization-runs', `${study.name}のMonte Carlo run数は1以上にしてください。`, `${studyPath}.monteCarloRuns`))
    }
    if ((study.objective === 'maximizeP10OperatingProfit' || study.objective === 'maximizeP10PeriodProfit') && study.evaluationMode !== 'monteCarlo') {
      issues.push(issue('error', 'optimization-objective-requires-monte-carlo', `${study.name}のp10利益ObjectiveにはMonte Carlo評価が必要です。`, `${studyPath}.objective`))
    }
    if (study.evaluationMode === 'monteCarlo' && study.monteCarloRuns > 0 && study.monteCarloRuns < 30) {
      issues.push(issue('warning', 'low-optimization-runs', `${study.name}のMonte Carlo run数が少ないため、上位候補を追加検証してください。`, `${studyPath}.monteCarloRuns`))
    }

    for (const [variableIndex, variable] of study.variables.entries()) {
      const variablePath = `${studyPath}.variables.${variableIndex}`
      if (!optimizationVariableTypes.has(variable.type)) issues.push(issue('error', 'invalid-optimization-variable-type', `${variable.name}のVariable種類が正しくありません。`, variablePath))
      if (variable.values.length === 0 && variable.min !== undefined && variable.max !== undefined && variable.min > variable.max) {
        issues.push(issue('error', 'optimization-min-greater-than-max', `${variable.name}のminはmax以下にしてください。`, variablePath))
      }
      if (variable.values.length === 0 && variable.step !== undefined && variable.step <= 0) {
        issues.push(issue('error', 'invalid-optimization-step', `${variable.name}のstepは0より大きくしてください。`, variablePath))
      }
      const values = expandOptimizationVariableValues(variable)
      if (values.length === 0) issues.push(issue('error', 'optimization-variable-empty', `${variable.name}に候補値がありません。`, variablePath))
      const targetExists = variable.type === 'staffShiftHeadcount'
        ? settings.capacity.staffShifts.some((shift) => shift.id === variable.targetId)
        : variable.type === 'weekdayStaffHeadcount'
          ? settings.capacity.staffShifts.some((shift) => shift.id === variable.targetId) && variable.day !== undefined && variable.day >= 0 && variable.day <= 6
        : variable.type === 'equipmentCapacity'
          ? settings.capacity.equipment.some((item) => item.id === variable.targetId)
          : variable.type === 'seatingUnitCount'
            ? stochastic.seatingUnits.some((unit) => unit.id === variable.targetId)
            : variable.type === 'kitchenOperationDuration'
              ? settings.capacity.operations.some((operation) => operation.id === variable.targetId)
              : variable.type === 'processPrepLookaheadDays'
                ? settings.processes.some((process) => process.id === variable.targetId)
                : variable.type === 'resourceProcurementLookaheadDays'
                  ? settings.resources.some((resource) => resource.id === variable.targetId)
              : true
      if (!targetExists) issues.push(issue('error', 'missing-optimization-target', `${variable.name}の探索対象が見つかりません。`, variablePath))
      for (const value of values) {
        if ((variable.type === 'staffShiftHeadcount' || variable.type === 'weekdayStaffHeadcount' || variable.type === 'seatingUnitCount' || variable.type === 'processPrepLookaheadDays' || variable.type === 'resourceProcurementLookaheadDays') && (typeof value !== 'number' || value < 0)) {
          issues.push(issue('error', 'negative-optimization-candidate', `${variable.name}の候補人数・卓数は0以上にしてください。`, variablePath))
          break
        }
        if ((variable.type === 'equipmentCapacity' || variable.type === 'kitchenOperationDuration') && (typeof value !== 'number' || value <= 0)) {
          issues.push(issue('error', 'invalid-optimization-candidate', `${variable.name}の容量・時間候補は0より大きくしてください。`, variablePath))
          break
        }
        if ((variable.type === 'openingTime' || variable.type === 'closingTime' || variable.type === 'weekdayOpeningTime' || variable.type === 'weekdayClosingTime') && (typeof value !== 'string' || timeToMinutes(value) === null)) {
          issues.push(issue('error', 'invalid-optimization-time', `${variable.name}の時刻候補が正しくありません。`, variablePath))
          break
        }
      }
      if (variable.type === 'equipmentCapacity' && !settings.capacity.equipment.find((item) => item.id === variable.targetId)?.upgradeCostPerCapacityUnit
        && Object.keys(variable.adjustmentCosts ?? {}).length === 0) {
        issues.push(issue('warning', 'missing-equipment-adjustment-cost', `${variable.name}の設備変更コストが未設定です。利益とは別に投資条件を確認してください。`, variablePath))
      }
      if (Object.values(variable.adjustmentCosts ?? {}).some((cost) => !Number.isFinite(cost) || cost < 0)) {
        issues.push(issue('error', 'invalid-optimization-adjustment-cost', `${variable.name}の候補変更コストは0円以上にしてください。`, variablePath))
      }
    }

    if (new Set(study.variables.map((variable) => variable.id)).size !== study.variables.length) {
      issues.push(issue('error', 'duplicate-optimization-variable-id', `${study.name}のVariable IDが重複しています。`, `${studyPath}.variables`))
    }
    const openingVariable = [...study.variables].reverse().find((variable) => variable.type === 'openingTime')
    const closingVariable = [...study.variables].reverse().find((variable) => variable.type === 'closingTime')
    const openingCandidates = openingVariable ? expandOptimizationVariableValues(openingVariable) : [settings.business.openingTime]
    const closingCandidates = closingVariable ? expandOptimizationVariableValues(closingVariable) : [settings.business.closingTime]
    if (openingCandidates.some((opening) => closingCandidates.some((closing) => (
      typeof opening !== 'string' || typeof closing !== 'string'
      || timeToMinutes(opening) === null || timeToMinutes(closing) === null
      || (timeToMinutes(closing) ?? 0) <= (timeToMinutes(opening) ?? 0)
    )))) {
      issues.push(issue('error', 'invalid-optimization-business-hours', `${study.name}に閉店時刻が開店時刻以下となる候補があります。`, `${studyPath}.variables`))
    }

    for (const [constraintIndex, constraint] of study.constraints.entries()) {
      const constraintPath = `${studyPath}.constraints.${constraintIndex}`
      if (!optimizationConstraintMetrics.has(constraint.metric) || !Number.isFinite(constraint.value) || (constraint.operator !== '<=' && constraint.operator !== '>=')) {
        issues.push(issue('error', 'invalid-optimization-constraint', `${study.name}に不正なConstraintがあります。`, constraintPath))
      }
    }
    if (new Set(study.constraints.map((constraint) => constraint.id)).size !== study.constraints.length) {
      issues.push(issue('error', 'duplicate-optimization-constraint-id', `${study.name}のConstraint IDが重複しています。`, `${studyPath}.constraints`))
    }
    const candidateCount = calculateOptimizationCandidateCount(study.variables)
    if (candidateCount > study.hardCandidateLimit || candidateCount > 50_000) {
      issues.push(issue('error', 'optimization-hard-limit-exceeded', `${study.name}の総候補数${candidateCount.toLocaleString('ja-JP')}件がhard limitを超えています。`, studyPath))
    } else if (candidateCount > study.maxCandidates) {
      issues.push(issue('error', 'optimization-study-limit-exceeded', `${study.name}の総候補数${candidateCount.toLocaleString('ja-JP')}件がStudy上限を超えています。`, studyPath))
    } else if (candidateCount >= OPTIMIZATION_WARNING_CANDIDATES) {
      issues.push(issue('warning', 'many-optimization-candidates', `${study.name}は${candidateCount.toLocaleString('ja-JP')}候補を評価します。探索範囲を確認してください。`, studyPath))
    }
    if (study.isReferenceStudy) issues.push(issue('warning', 'reference-optimization-study', `${study.name}は初期参考Studyです。実店舗の制約・候補範囲へ更新してください。`, studyPath))
  }
  if (new Set(settings.optimizationStudies.map((study) => study.id)).size !== settings.optimizationStudies.length) {
    issues.push(issue('error', 'duplicate-optimization-study-id', 'Optimization StudyのIDが重複しています。', 'optimizationStudies'))
  }

  const planning = settings.planning
  if (!Number.isInteger(planning.horizonDays) || planning.horizonDays <= 0 || planning.horizonDays > planning.hardMaximumDays || planning.hardMaximumDays > 366) {
    issues.push(issue('error', 'invalid-planning-horizon', 'Planning Horizonは1〜366日にしてください。', 'planning.horizonDays'))
  }
  if (!Number.isInteger(planning.monteCarloRuns) || planning.monteCarloRuns <= 0 || planning.monteCarloRuns > 1_000) {
    issues.push(issue('error', 'invalid-planning-monte-carlo-runs', '複数日Monte Carlo run数は1〜1,000にしてください。', 'planning.monteCarloRuns'))
  }
  if ((planning.maxPrepActiveLaborMinutesPerDay ?? 0) < 0) {
    issues.push(issue('error', 'invalid-planning-prep-capacity', '1日の仕込みactive上限は0分以上にしてください。', 'planning.maxPrepActiveLaborMinutesPerDay'))
  }
  if (planning.horizonDays >= 30 && planning.monteCarloRuns > 1) {
    issues.push(issue('warning', 'long-multiday-calculation', '30日Monte Carlo / Optimizationは計算量が大きいため、候補数とrun数を確認してください。', 'planning'))
  }
  for (const [index, template] of planning.weekdayTemplates.entries()) {
    const path = `planning.weekdayTemplates.${index}`
    if (!Number.isInteger(template.day) || template.day < 0 || template.day > 6) issues.push(issue('error', 'invalid-daily-override', '曜日Templateの曜日が正しくありません。', path))
    if (template.enabled !== false && template.openingTime && template.closingTime && scheduleHours({ openingTime: template.openingTime, closingTime: template.closingTime }) <= 0) {
      issues.push(issue('error', 'invalid-daily-override', '曜日Templateの営業時間が正しくありません。', path))
    }
    if (Object.keys(template.staffHeadcountOverrides ?? {}).some((shiftId) => !settings.capacity.staffShifts.some((shift) => shift.id === shiftId))) {
      issues.push(issue('error', 'invalid-daily-override', '曜日Templateが存在しないStaffShiftを参照しています。', path))
    }
  }
  if (new Set(planning.dailyOperatingPlans.map((plan) => plan.date)).size !== planning.dailyOperatingPlans.length) {
    issues.push(issue('error', 'invalid-daily-override', '同じ日付のOverrideが重複しています。', 'planning.dailyOperatingPlans'))
  }
  for (const [index, plan] of planning.dailyOperatingPlans.entries()) {
    const path = `planning.dailyOperatingPlans.${index}`
    if (!parseLocalDate(plan.date)) issues.push(issue('error', 'invalid-daily-override', `日付Override「${plan.date}」の日付が正しくありません。`, path))
    if (plan.enabled !== false && plan.openingTime && plan.closingTime && scheduleHours({ openingTime: plan.openingTime, closingTime: plan.closingTime }) <= 0) {
      issues.push(issue('error', 'invalid-daily-override', `${plan.date}の営業時間が正しくありません。`, path))
    }
    if ((plan.mealsPerDay ?? 0) < 0 || Object.values(plan.staffHeadcountOverrides ?? {}).some((value) => value < 0) || Object.values(plan.manualPrepBatches ?? {}).some((value) => value < 0)) {
      issues.push(issue('error', 'invalid-daily-override', `${plan.date}の食数・人員・仕込み量は0以上にしてください。`, path))
    }
    if (Object.keys(plan.staffHeadcountOverrides ?? {}).some((shiftId) => !settings.capacity.staffShifts.some((shift) => shift.id === shiftId))
      || Object.keys(plan.manualPrepBatches ?? {}).some((processId) => !settings.processes.some((process) => process.id === processId))) {
      issues.push(issue('error', 'invalid-daily-override', `${plan.date}が存在しないStaffShiftまたはProcessを参照しています。`, path))
    }
  }
  const startDate = parseLocalDate(settings.business.simulationStartDate)
  const horizonEnd = startDate ? new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + planning.horizonDays) : undefined
  for (const [index, order] of planning.purchaseOrders.entries()) {
    const path = `planning.purchaseOrders.${index}`
    const ordered = parseLocalDate(order.orderedDate)
    const delivery = parseLocalDate(order.deliveryDate)
    if (!resources.has(order.resourceId)) issues.push(issue('error', 'missing-purchase-order-resource', `発注のResource「${order.resourceId}」が見つかりません。`, path))
    if (!ordered || !delivery || delivery < ordered) issues.push(issue('error', 'invalid-purchase-order-date', `発注「${order.id}」の発注日・入荷日が正しくありません。`, path))
    if (order.packageCount <= 0 || order.quantity <= 0 || order.cost < 0) issues.push(issue('error', 'invalid-purchase-order-quantity', `発注「${order.id}」のpackage数・数量・支出が正しくありません。`, path))
    if (delivery && horizonEnd && delivery >= horizonEnd) issues.push(issue('warning', 'purchase-order-after-horizon', `発注「${order.id}」はPlanning Horizon終了後に入荷します。`, path))
  }

  if (settings.resources.some((resource) => resource.isReferencePrice)
    || settings.utilities.water.isReferencePrice
    || settings.utilities.gas.isReferencePrice
    || settings.utilities.electricity.isReferencePrice
    || settings.fryingOil.isReferencePrice) {
    issues.push(issue('warning', 'reference-prices', '初期参考価格が残っています。実際の仕入・請求価格へ更新してください。'))
  }
  if (settings.capacity.equipment.some((item) => item.isReferenceCapacity)
    || settings.capacity.operations.some((operation) => operation.isReferenceCapacity)) {
    issues.push(issue('warning', 'reference-capacity', '厨房能力に初期参考値が残っています。実際の設備・作業時間へ更新してください。'))
  }
  if (stochastic.isReferenceDemand) {
    issues.push(issue('warning', 'reference-demand-seating', '来店・客席条件に初期参考値が残っています。実際の来店傾向・席構成へ更新してください。'))
  }

  return issues
}
