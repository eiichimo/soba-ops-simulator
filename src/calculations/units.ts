import type { Unit } from '../models/types'

type UnitDimension = 'mass' | 'volume' | 'discrete' | 'energy' | 'gasVolume'

const unitDefinitions: Record<Unit, { dimension: UnitDimension; factor: number }> = {
  g: { dimension: 'mass', factor: 1 },
  kg: { dimension: 'mass', factor: 1_000 },
  ml: { dimension: 'volume', factor: 1 },
  L: { dimension: 'volume', factor: 1_000 },
  個: { dimension: 'discrete', factor: 1 },
  枚: { dimension: 'discrete', factor: 1 },
  本: { dimension: 'discrete', factor: 1 },
  食: { dimension: 'discrete', factor: 1 },
  kWh: { dimension: 'energy', factor: 1 },
  'm³': { dimension: 'gasVolume', factor: 1 },
}

export const areUnitsCompatible = (from: Unit, to: Unit) => {
  if (from === to) return true
  const fromDefinition = unitDefinitions[from]
  const toDefinition = unitDefinitions[to]
  return fromDefinition.dimension === toDefinition.dimension
    && (fromDefinition.dimension === 'mass' || fromDefinition.dimension === 'volume')
}

export const convertQuantity = (quantity: number, from: Unit, to: Unit) => {
  if (from === to) return quantity
  if (!areUnitsCompatible(from, to)) {
    throw new Error(`単位を変換できません: ${from} → ${to}`)
  }
  return quantity * unitDefinitions[from].factor / unitDefinitions[to].factor
}

export const tryConvertQuantity = (quantity: number, from: Unit, to: Unit) => {
  try {
    return convertQuantity(quantity, from, to)
  } catch {
    return null
  }
}
