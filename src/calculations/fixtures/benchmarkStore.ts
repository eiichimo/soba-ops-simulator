import type { AppSettings } from '../../models/types'
import { createDefaultStochasticDemand } from '../../data/demandDefaults'
import { createDefaultPlanningSettings } from '../../data/planningDefaults'
import { createDefaultCalibrationSettings } from '../../data/calibrationDefaults'

export const createBenchmarkStore = (simulationStartDate = '2026-01-05'): AppSettings => {
  const business = {
    storeName: '検算用基準店舗', mealsPerDay: 100, openingTime: '09:00', closingTime: '17:00', hoursPerDay: 8,
    operatingDaysPerMonth: 20, simulationStartDate,
    weekdays: Array.from({ length: 7 }, (_, day) => ({ day, enabled: day < 5, openingTime: '09:00', closingTime: '17:00' })),
  }
  const demandProfile = { id: 'benchmark-demand', name: '検算需要', timeSlots: [{ id: 'benchmark-slot', startTime: '09:00', endTime: '17:00', meals: 100 }] }
  return ({
  schemaVersion: 9,
  business,
  resources: [{
    id: 'benchmark-noodle',
    name: '検算用麺',
    category: 'noodle',
    purchaseQuantity: 10,
    purchaseUnit: 'kg',
    purchasePrice: 10_000,
    yieldRate: 1,
    usableQuantity: 10,
    storageType: 'refrigerated',
    shelfLifeDays: 365,
    minimumPurchaseLot: 1,
    isReferencePrice: false,
  }],
  processes: [],
  menuItems: [{
    id: 'benchmark-menu',
    name: '検算そば',
    sellingPrice: 1_000,
    consumption: [{ sourceType: 'resource', sourceId: 'benchmark-noodle', quantity: 150, unit: 'g' }],
    expectedSalesRatio: 100,
    enabled: true,
    kitchenWorkflowId: 'workflow-benchmark-menu',
  }],
  toppings: [],
  labor: [{
    id: 'benchmark-staff',
    name: 'スタッフ',
    hourlyWage: 1_500,
    headcount: 1,
    hoursPerDay: 8,
    marginalCostRate: 0.2,
  }],
  utilities: {
    water: {
      unitPrice: 0.5,
      fixedChargePerMonth: 0,
      uses: [{ id: 'benchmark-water', name: '調理・洗浄水', behavior: 'perMeal', quantity: 2 }],
      isReferencePrice: false,
    },
    gas: {
      unitPrice: 180,
      fixedChargePerMonth: 0,
      uses: [{ id: 'benchmark-gas', name: '厨房ガス', behavior: 'perDay', quantity: 2 }],
      isReferencePrice: false,
    },
    electricity: {
      unitPrice: 30,
      fixedChargePerMonth: 0,
      uses: [{ id: 'benchmark-electricity', name: '店内電力', behavior: 'perHour', quantity: 0.5 }],
      isReferencePrice: false,
    },
  },
  fryingOil: {
    unitPricePerL: 0,
    initialFillL: 0,
    dailyTopUpL: 0,
    absorptionLPerMeal: 0,
    replacementIntervalDays: 1,
    discardLAtReplacement: 0,
    isReferencePrice: false,
  },
  otherCosts: [],
  makeBuyComparison: {
    name: '未設定',
    homemadeOutputId: '',
    purchasedResourceId: 'benchmark-noodle',
    blendProcessId: '',
    dailyUsage: 0,
    unit: 'kg',
  },
  inventory: {
    carryOverEnabled: true,
    entries: [],
    openingLots: [],
  },
  actualPeriods: [],
  scenarios: [],
  optimizationStudies: [],
  planning: createDefaultPlanningSettings(business),
  importMappingProfiles: [],
  importRecords: [],
  calibrationHistory: [],
  calibrationSettings: createDefaultCalibrationSettings(),
  capacity: {
    demandMode: 'deterministic',
    equipment: [{ id: 'benchmark-station', name: '検算設備', category: 'other', capacity: 1, capacityUnit: '食', concurrentJobs: 1, enabled: true, isReferenceCapacity: false }],
    operations: [{
      id: 'benchmark-service', name: '検算提供', durationMinutes: 1, activeLaborMinutes: 1,
      equipmentRequirements: [{ equipmentId: 'benchmark-station', occupationMinutes: 1, units: 1 }],
      laborRequirements: [{ laborRoleIds: ['benchmark-staff'], headcount: 1 }], batchCapacity: 1, enabled: true, isReferenceCapacity: false,
    }],
    workflows: [{ id: 'workflow-benchmark-menu', name: '検算Workflow', menuItemId: 'benchmark-menu', nodes: [{ id: 'benchmark-service-node', operationId: 'benchmark-service', dependencies: [] }] }],
    staffShifts: [{ id: 'benchmark-shift', name: '検算Shift', laborRoleId: 'benchmark-staff', startTime: '09:00', endTime: '17:00', headcount: 1 }],
    demandProfile,
    targetWaitMinutes: 10,
    fulfillmentPolicy: 'completeAfterClosing',
    bucketMinutes: 30,
    stochasticDemand: { ...createDefaultStochasticDemand(business, demandProfile), isReferenceDemand: false },
  },
  })
}
