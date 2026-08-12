export const formatYen = (value: number) => `${Math.round(value).toLocaleString('ja-JP')}円`

export const formatCompactYen = (value: number) => {
  const absolute = Math.abs(value)
  if (absolute >= 10_000) return `${(value / 10_000).toLocaleString('ja-JP', { maximumFractionDigits: 1 })}万円`
  return formatYen(value)
}

export const formatUnitPrice = (value: number) => `${value.toLocaleString('ja-JP', { maximumFractionDigits: 2 })}円`

export const formatPercent = (ratio: number) => `${(ratio * 100).toLocaleString('ja-JP', { maximumFractionDigits: 1 })}%`

export const formatNumber = (value: number, maximumFractionDigits = 1) => value.toLocaleString('ja-JP', {
  maximumFractionDigits,
})
