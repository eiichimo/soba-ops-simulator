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

export interface InventorySettings {
  carryOverEnabled: boolean
  entries: InventoryEntry[]
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

export interface SimulationResult {
  period: PeriodKey
  calendarMonths: number
  operatingDays: number
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
}

export interface MakeBuyResult {
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
}
