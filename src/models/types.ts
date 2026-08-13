export type Unit = 'g' | 'kg' | 'ml' | 'L' | '個' | '枚' | '本' | '食' | 'kWh' | 'm³'

export type ResourceCategory =
  | 'noodle'
  | 'produce'
  | 'seasoning'
  | 'seafood'
  | 'topping'
  | 'prepared'
  | 'water'
  | 'gas'
  | 'electricity'
  | 'oil'
  | 'other'

export type StorageType = 'ambient' | 'refrigerated' | 'frozen'
export type WasteReason = 'trimLoss' | 'cookingLoss' | 'spoilage' | 'unsold' | 'mistake'
export type CostBehavior = 'perDay' | 'perHour' | 'perMeal' | 'perMonth' | 'perUse' | 'alwaysOn'
export type PeriodKey = 'day' | 'month' | 'quarter' | 'halfYear' | 'year'
export type LaborCostTreatment = 'withinScheduledShift' | 'additionalLabor'
export type LaborCostMode = 'accounting' | 'decision'
export type ValidationSeverity = 'error' | 'warning'
export type InventoryLotSource = 'purchase' | 'processOutput' | 'openingInventory' | 'byProduct' | 'carryOver'
export type VarianceDirection = 'benefit' | 'cost' | 'neutral'
export type VarianceInterpretation = 'favorable' | 'unfavorable' | 'neutral' | 'notAvailable'
export type SensitivityTarget = 'mealsPerDay' | 'averageSellingPrice' | 'laborWage' | 'resourcePrice' | 'waterPrice' | 'gasPrice' | 'electricityPrice' | 'operatingHours' | 'operatingDays'

export interface Resource {
  id: string
  name: string
  category: ResourceCategory
  purchaseQuantity: number
  purchaseUnit: Unit
  purchasePrice: number
  yieldRate: number
  usableQuantity: number
  storageType: StorageType
  shelfLifeDays: number
  minimumPurchaseLot: number
  priceLow?: number
  priceStandard?: number
  priceHigh?: number
  isReferencePrice?: boolean
}

export interface SourceRef {
  sourceType: 'resource' | 'output'
  sourceId: string
  quantity: number
  unit: Unit
}

export interface ProcessOutput {
  id: string
  name: string
  quantity: number
  unit: Unit
  costAllocation: number
  storageType: StorageType
  shelfLifeDays: number
}

export interface Process {
  id: string
  name: string
  inputs: SourceRef[]
  outputs: ProcessOutput[]
  batchSize: number
  processDurationMinutes: number
  activeLaborMinutes: number
  laborRole: string
  laborCostTreatment: LaborCostTreatment
  gasUsageM3: number
  electricUsageKWh: number
  waterUsageL: number
  wasteRate: number
  wasteReason: WasteReason
}

export interface MenuItem {
  id: string
  name: string
  sellingPrice: number
  consumption: SourceRef[]
  expectedSalesRatio: number
  enabled: boolean
}

export interface Topping {
  id: string
  name: string
  sellingPrice: number
  consumption: SourceRef[]
  orderRate: number
  enabled: boolean
}

export interface LaborRole {
  id: string
  name: string
  hourlyWage: number
  headcount: number
  hoursPerDay: number
  marginalCostRate: number
}

export interface LaborCostResult {
  accountingLaborCost: number
  marginalLaborCost: number
}

export interface InventoryEntry {
  id: string
  sourceType: 'resource' | 'output'
  sourceId: string
  unit: Unit
  preparedToday: number
  usedToday: number
  carryOverQuantity: number
  discardedQuantity: number
  discardReason?: WasteReason
  ageDays: number
  shelfLifeDays: number
}

export interface OpeningInventoryLot {
  id: string
  sourceType: 'resource' | 'output'
  sourceId: string
  quantity: number
  unit: Unit
  acquiredDate: string
  expiryDate?: string
  unitCost?: number
}

export interface InventoryCostComponents {
  directIngredients: number
  prepMaterials: number
  prepLabor: number
  water: number
  gas: number
  electricity: number
  fryingOil: number
}

export interface InventoryLot {
  id: string
  sourceType: 'resource' | 'output'
  sourceId: string
  quantity: number
  unit: Unit
  acquiredDate: string
  expiryDate?: string
  unitCost: number
  purchaseCost: number
  source: InventoryLotSource
  costComponents?: InventoryCostComponents
}

export interface InventorySettings {
  carryOverEnabled: boolean
  entries: InventoryEntry[]
  openingLots: OpeningInventoryLot[]
}

export interface UtilityUse {
  id: string
  name: string
  behavior: CostBehavior
  quantity: number
  usesPerMeal?: number
}

export interface UtilityConfig {
  unitPrice: number
  fixedChargePerMonth: number
  uses: UtilityUse[]
  isReferencePrice: boolean
}

export interface FryingOilConfig {
  inventoryResourceId?: string
  unitPricePerL: number
  initialFillL: number
  dailyTopUpL: number
  absorptionLPerMeal: number
  replacementIntervalDays: number
  discardLAtReplacement: number
  isReferencePrice: boolean
}

export interface OtherCost {
  id: string
  name: string
  amount: number
  behavior: Exclude<CostBehavior, 'perUse' | 'alwaysOn'>
}

export interface WeekdaySchedule {
  day: number
  enabled: boolean
  openingTime: string
  closingTime: string
}

export interface BusinessSettings {
  storeName: string
  mealsPerDay: number
  openingTime: string
  closingTime: string
  hoursPerDay: number
  operatingDaysPerMonth: number
  simulationStartDate: string
  weekdays: WeekdaySchedule[]
}

export interface MakeBuyComparison {
  name: string
  homemadeOutputId: string
  purchasedResourceId: string
  blendProcessId: string
  dailyUsage: number
  unit: Unit
}

export interface ActualMenuSales {
  menuItemId: string
  quantity: number
}

export interface ActualResourceRecord {
  resourceId: string
  purchasedQuantity?: number
  purchaseUnit: Unit
  purchaseExpenditure?: number
  usedQuantity?: number
  usageUnit?: Unit
  wasteQuantity?: number
  wasteUnit?: Unit
  wasteCost?: number
}

export interface ActualUtilityRecord {
  cost?: number
  quantity?: number
}

export interface ActualValues {
  revenue?: number
  meals?: number
  menuSales: ActualMenuSales[]
  usageCost?: number
  purchaseExpenditure?: number
  resourceRecords: ActualResourceRecord[]
  openingInventoryValue?: number
  endingInventoryValue?: number
  wasteCost?: number
  laborCost?: number
  laborHours?: number
  utilities: {
    water: ActualUtilityRecord
    gas: ActualUtilityRecord
    electricity: ActualUtilityRecord
  }
  otherCost?: number
  operatingDays?: number
  operatingHours?: number
  operatingProfit?: number
  simpleCashFlow?: number
}

export interface ActualPeriod {
  id: string
  name: string
  startDate: string
  endDate: string
  actuals: ActualValues
  notes?: string
}

export interface ScenarioOverrides {
  business?: {
    mealsPerDay?: number
    hoursPerDay?: number
    operatingDaysPerWeek?: number
  }
  averageSellingPriceMultiplier?: number
  laborWageMultiplier?: number
  resourcePurchasePriceMultipliers?: Record<string, number>
  utilityUnitPriceMultipliers?: Partial<Record<'water' | 'gas' | 'electricity', number>>
}

export interface Scenario {
  id: string
  name: string
  overrides: ScenarioOverrides
  notes?: string
}

export interface AppSettings {
  schemaVersion: number
  business: BusinessSettings
  resources: Resource[]
  processes: Process[]
  menuItems: MenuItem[]
  toppings: Topping[]
  labor: LaborRole[]
  utilities: {
    water: UtilityConfig
    gas: UtilityConfig
    electricity: UtilityConfig
  }
  fryingOil: FryingOilConfig
  otherCosts: OtherCost[]
  makeBuyComparison: MakeBuyComparison
  inventory: InventorySettings
  actualPeriods: ActualPeriod[]
  scenarios: Scenario[]
}

export interface CostBreakdown {
  directIngredients: number
  prepMaterials: number
  prepLabor: number
  operatingLabor: number
  water: number
  gas: number
  electricity: number
  fryingOil: number
  waste: number
  other: number
  fixedMonthly: number
}

export interface LaborBreakdown {
  shiftLaborCost: number
  prepLaborAllocation: number
  additionalPrepLaborCost: number
  accountingLaborCost: number
  marginalPrepLaborCost: number
}

export interface MenuCalculationDetail {
  id: string
  name: string
  servings: number
  revenue: number
}

export interface ResourceCalculationDetail {
  id: string
  name: string
  quantity: number
  unit: Unit
  usageCost: number
}

export interface ProcessCalculationDetail {
  id: string
  name: string
  batches: number
  materialCost: number
  activeLaborMinutes: number
  laborAllocation: number
  additionalLaborCost: number
  marginalLaborCost: number
}

export interface UtilityCalculationDetail {
  quantity: number
  unit: Unit
  usageCost: number
}

export interface CalculationDetails {
  meals: number
  menus: MenuCalculationDetail[]
  resources: ResourceCalculationDetail[]
  processes: ProcessCalculationDetail[]
  utilities: {
    water: UtilityCalculationDetail
    gas: UtilityCalculationDetail
    electricity: UtilityCalculationDetail
  }
  fryingOilLiters: number
  fryingOilCost: number
}

export interface PurchaseRecord {
  id: string
  date: string
  resourceId: string
  resourceName: string
  packages: number
  purchasedQuantity: number
  stockedQuantity: number
  unit: Unit
  expenditure: number
}

export interface InventoryWasteRecord {
  id: string
  date: string
  sourceType: 'resource' | 'output' | 'process'
  sourceId: string
  name: string
  quantity: number
  unit?: Unit
  cost: number
  reason: WasteReason
}

export interface InventoryDailyMovement {
  date: string
  openingQuantity: number
  purchasedQuantity: number
  producedQuantity: number
  byProductQuantity: number
  consumedQuantity: number
  wastedQuantity: number
  endingQuantity: number
}

export interface InventoryItemSummary {
  sourceType: 'resource' | 'output'
  sourceId: string
  name: string
  unit: Unit
  openingQuantity: number
  purchasedQuantity: number
  producedQuantity: number
  byProductQuantity: number
  consumedQuantity: number
  wastedQuantity: number
  endingQuantity: number
  openingValue: number
  endingValue: number
  usageCost: number
  wasteCost: number
  purchaseExpenditure: number
  productionValue: number
  oldestAcquiredDate?: string
  nearestExpiryDate?: string
  endingLots: InventoryLot[]
  dailyMovements: InventoryDailyMovement[]
}

export interface InventorySimulationResult {
  usageCost: number
  purchaseExpenditure: number
  openingInventoryValue: number
  endingInventoryValue: number
  wasteCost: number
  purchaseCount: number
  simpleCashFlow: number
  items: InventoryItemSummary[]
  purchases: PurchaseRecord[]
  wastes: InventoryWasteRecord[]
  endingLots: InventoryLot[]
}

export interface CalendarSummary {
  startDate: string
  endDateExclusive: string
  calendarDays: number
  operatingDays: number
  totalOperatingHours: number
  calendarMonths: number
}

export interface ValidationIssue {
  severity: ValidationSeverity
  code: string
  message: string
  path?: string
}

export interface SimulationResult {
  period: PeriodKey | 'custom'
  startDate: string
  endDateExclusive: string
  calendarDays: number
  calendarMonths: number
  operatingDays: number
  totalOperatingHours: number
  meals: number
  revenue: number
  menuRevenue: number
  toppingRevenue: number
  costs: CostBreakdown
  totalCost: number
  grossProfit: number
  operatingProfit: number
  foodCostRate: number
  operatingMargin: number
  averageCostPerMeal: number
  profitPerOperatingDay: number
  profitPerOperatingHour: number
  marginalCostPerMeal: number
  menuRatioTotal: number
  labor: LaborBreakdown
  details: CalculationDetails
  inventory: InventorySimulationResult
}

export interface MakeBuyResult {
  laborCostMode: LaborCostMode
  homemadeUnitCost: number
  purchasedUnitCost: number
  blendedUnitCost: number
  homemadeBreakdown: Pick<CostBreakdown, 'prepMaterials' | 'prepLabor' | 'water' | 'gas' | 'electricity' | 'waste'>
  monthlyUsage: number
  homemadeMonthlyCost: number
  purchasedMonthlyCost: number
  blendedMonthlyCost: number
  monthlySavings: number
  monthlyAdditionalHours: number
  savingsPerWorkHour: number
  breakEvenMealsPerDay: number | null
  homemadeLaborAllocation: number
  homemadeMarginalLabor: number
  homemadeWasteCost: number
  purchasedWasteCost: number
  blendedWasteCost: number
  homemadeEndingInventoryValue: number
  purchasedEndingInventoryValue: number
}

export interface VarianceResult {
  plan: number
  actual: number | null
  amount: number | null
  rate: number | null
  direction: VarianceDirection
  interpretation: VarianceInterpretation
}

export interface VarianceRow extends VarianceResult {
  key: string
  label: string
  unit: 'yen' | 'count' | 'hours'
}

export interface ResourceVariance {
  resourceId: string
  resourceName: string
  unit: Unit
  plannedUsageQuantity: number
  actualUsageQuantity: number | null
  plannedPurchaseQuantity: number
  actualPurchaseQuantity: number | null
  plannedPurchaseExpenditure: number
  actualPurchaseExpenditure: number | null
  plannedUnitPrice: number | null
  actualUnitPrice: number | null
  unitPriceDifference: number | null
  purchaseQuantityDifference: number | null
  plannedWasteQuantity: number
  actualWasteQuantity: number | null
  wasteQuantityDifference: number | null
}

export interface SensitivityPoint {
  rate: number
  label: string
  parameterValue: number
  result: SimulationResult
}

export interface ScenarioComparison {
  scenario: Scenario
  settings: AppSettings
  result: SimulationResult
}
