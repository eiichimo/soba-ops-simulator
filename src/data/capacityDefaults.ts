import type { AppSettings, CapacitySettings, KitchenWorkflow } from '../models/types'
import { timeToMinutes } from '../calculations/calendar'
import { createDefaultStochasticDemand, createSampleStochasticDemand } from './demandDefaults'

type CapacitySeedSettings = Pick<AppSettings, 'business' | 'labor' | 'menuItems'>

const timeAfter = (startTime: string, hours: number, maximumTime: string) => {
  const start = timeToMinutes(startTime) ?? 0
  const maximum = timeToMinutes(maximumTime) ?? 23 * 60 + 59
  const end = Math.min(maximum, start + Math.round(hours * 60))
  return `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`
}

export const createDefaultCapacitySettings = (settings: CapacitySeedSettings): CapacitySettings => {
  const role = settings.labor[0]
  const equipmentId = 'default-service-station'
  const operationId = 'default-service-operation'
  const demandProfile = {
    id: 'default-demand',
    name: '標準需要',
    timeSlots: [{ id: 'default-demand-slot', startTime: settings.business.openingTime, endTime: settings.business.closingTime, meals: settings.business.mealsPerDay }],
  }
  return {
    demandMode: 'deterministic',
    equipment: [{
      id: equipmentId,
      name: '汎用調理台（移行初期値）',
      category: 'other',
      capacity: 4,
      capacityUnit: '食',
      concurrentJobs: 1,
      enabled: true,
      isReferenceCapacity: true,
    }],
    operations: [{
      id: operationId,
      name: '標準提供工程（移行初期値）',
      durationMinutes: 1,
      activeLaborMinutes: role ? 1 : 0,
      equipmentRequirements: [{ equipmentId, occupationMinutes: 1, units: 1 }],
      laborRequirements: role ? [{ laborRoleIds: [role.id], headcount: 1 }] : [],
      batchCapacity: 4,
      enabled: true,
      isReferenceCapacity: true,
    }],
    workflows: settings.menuItems.map((menu) => ({
      id: `workflow-${menu.id}`,
      name: `${menu.name} 標準Workflow`,
      menuItemId: menu.id,
      nodes: [{ id: `node-${menu.id}-service`, operationId, dependencies: [] }],
    })),
    staffShifts: settings.labor.map((laborRole) => ({
      id: `shift-${laborRole.id}`,
      name: `${laborRole.name} 標準Shift`,
      laborRoleId: laborRole.id,
      startTime: settings.business.openingTime,
      endTime: timeAfter(settings.business.openingTime, laborRole.hoursPerDay, settings.business.closingTime),
      headcount: laborRole.headcount,
    })),
    demandProfile,
    targetWaitMinutes: 10,
    fulfillmentPolicy: 'completeAfterClosing',
    bucketMinutes: 30,
    stochasticDemand: createDefaultStochasticDemand(settings.business, demandProfile),
  }
}

const sequentialWorkflow = (menuItemId: string, operationIds: string[]): KitchenWorkflow => ({
  id: `workflow-${menuItemId}`,
  name: `${menuItemId} Workflow`,
  menuItemId,
  nodes: operationIds.map((operationId, index) => ({
    id: `${menuItemId}-${operationId}`,
    operationId,
    dependencies: index === 0 ? [] : [`${menuItemId}-${operationIds[index - 1]}`],
  })),
})

export const createSampleCapacitySettings = (): CapacitySettings => {
  const zaru = sequentialWorkflow('zaru', ['boil-soba', 'rinse-soba', 'plate-soba', 'serve-order'])
  const tororo = sequentialWorkflow('tororo-soba', ['boil-soba', 'rinse-soba', 'plate-soba', 'serve-order'])
  const hotMenuIds = ['kake', 'tsukimi', 'tanuki', 'kitsune']
  const workflows = [zaru, tororo, ...hotMenuIds.map((menuId) => sequentialWorkflow(menuId, ['boil-soba', 'plate-soba', 'serve-order']))]
  workflows.push({
    id: 'workflow-shrimp-tempura-soba',
    name: '海老天そば Workflow',
    menuItemId: 'shrimp-tempura-soba',
    nodes: [
      { id: 'shrimp-boil', operationId: 'boil-soba', dependencies: [] },
      { id: 'shrimp-fry', operationId: 'fry-tempura', dependencies: [] },
      { id: 'shrimp-plate', operationId: 'plate-soba', dependencies: ['shrimp-boil', 'shrimp-fry'] },
      { id: 'shrimp-serve', operationId: 'serve-order', dependencies: ['shrimp-plate'] },
    ],
  })
  const demandProfile = {
    id: 'sample-demand',
    name: '初期参考需要',
    timeSlots: [
      { id: 'demand-11', startTime: '11:00', endTime: '12:00', meals: 15 },
      { id: 'demand-12', startTime: '12:00', endTime: '13:00', meals: 45 },
      { id: 'demand-13', startTime: '13:00', endTime: '14:00', meals: 20 },
      { id: 'demand-14', startTime: '14:00', endTime: '17:00', meals: 10 },
      { id: 'demand-17', startTime: '17:00', endTime: '20:00', meals: 10 },
    ],
  }
  return {
    demandMode: 'deterministic',
    equipment: [
      { id: 'soba-boiler', name: 'そば釜', category: 'sobaBoiler', capacity: 6, capacityUnit: '食', concurrentJobs: 1, enabled: true, isReferenceCapacity: true },
      { id: 'rinse-station', name: '麺洗浄槽', category: 'washing', capacity: 3, capacityUnit: '食', concurrentJobs: 1, enabled: true, isReferenceCapacity: true },
      { id: 'plating-station', name: '盛付台', category: 'plating', capacity: 1, capacityUnit: '食', concurrentJobs: 2, enabled: true, isReferenceCapacity: true },
      { id: 'fryer', name: 'フライヤー', category: 'fryer', capacity: 8, capacityUnit: '本', concurrentJobs: 1, enabled: true, isReferenceCapacity: true },
    ],
    operations: [
      {
        id: 'boil-soba', name: '蕎麦茹で', durationMinutes: 2.5, activeLaborMinutes: 0.5,
        equipmentRequirements: [{ equipmentId: 'soba-boiler', occupationMinutes: 2.5, units: 1 }],
        laborRequirements: [{ laborRoleIds: ['cook'], headcount: 1 }], batchCapacity: 6, enabled: true, isReferenceCapacity: true,
      },
      {
        id: 'rinse-soba', name: '水洗い・締め', durationMinutes: 0.75, activeLaborMinutes: 0.75,
        equipmentRequirements: [{ equipmentId: 'rinse-station', occupationMinutes: 0.75, units: 1 }],
        laborRequirements: [{ laborRoleIds: ['cook'], headcount: 1 }], batchCapacity: 3, enabled: true, isReferenceCapacity: true,
      },
      {
        id: 'fry-tempura', name: '海老天揚げ', durationMinutes: 3.5, activeLaborMinutes: 0.5,
        equipmentRequirements: [{ equipmentId: 'fryer', occupationMinutes: 3.5, units: 1 }],
        laborRequirements: [{ laborRoleIds: ['cook'], headcount: 1 }], batchCapacity: 8, enabled: true, isReferenceCapacity: true,
      },
      {
        id: 'plate-soba', name: '盛付', durationMinutes: 0.65, activeLaborMinutes: 0.65,
        equipmentRequirements: [{ equipmentId: 'plating-station', occupationMinutes: 0.65, units: 1 }],
        laborRequirements: [{ laborRoleIds: ['cook'], headcount: 1 }], batchCapacity: 1, enabled: true, isReferenceCapacity: true,
      },
      {
        id: 'serve-order', name: '提供', durationMinutes: 0.25, activeLaborMinutes: 0.25,
        equipmentRequirements: [], laborRequirements: [{ laborRoleIds: ['hall'], headcount: 1 }], batchCapacity: 1, enabled: true, isReferenceCapacity: true,
      },
    ],
    workflows,
    staffShifts: [
      { id: 'shift-cook', name: '調理 標準Shift', laborRoleId: 'cook', startTime: '11:00', endTime: '20:00', headcount: 2 },
      { id: 'shift-hall', name: 'ホール 標準Shift', laborRoleId: 'hall', startTime: '11:00', endTime: '20:00', headcount: 1 },
    ],
    demandProfile,
    targetWaitMinutes: 10,
    fulfillmentPolicy: 'completeAfterClosing',
    bucketMinutes: 30,
    stochasticDemand: createSampleStochasticDemand({
      storeName: '', mealsPerDay: 100, openingTime: '11:00', closingTime: '20:00', hoursPerDay: 9,
      operatingDaysPerMonth: 22, simulationStartDate: '', weekdays: [],
    }, demandProfile),
  }
}
