import { useId } from 'react'
import type { AppSettings } from '../models/types'
import { createVolumeSeries } from '../calculations/engine'
import { formatCompactYen, formatYen } from '../utils/format'

export const VolumeChart = ({ settings }: { settings: AppSettings }) => {
  const gradientId = useId().replaceAll(':', '')
  const data = createVolumeSeries(settings)
  const width = 760
  const height = 280
  const pad = { top: 24, right: 64, bottom: 42, left: 58 }
  const innerWidth = width - pad.left - pad.right
  const innerHeight = height - pad.top - pad.bottom
  const profitMin = Math.min(0, ...data.map((item) => item.profit))
  const profitMax = Math.max(1, ...data.map((item) => item.profit))
  const costMax = Math.max(1, ...data.map((item) => item.averageCost))
  const x = (index: number) => pad.left + (index / (data.length - 1)) * innerWidth
  const yProfit = (value: number) => pad.top + innerHeight - ((value - profitMin) / (profitMax - profitMin)) * innerHeight
  const yCost = (value: number) => pad.top + innerHeight - (value / costMax) * innerHeight
  const profitLine = data.map((item, index) => `${index ? 'L' : 'M'} ${x(index)} ${yProfit(item.profit)}`).join(' ')
  const costLine = data.map((item, index) => `${index ? 'L' : 'M'} ${x(index)} ${yCost(item.averageCost)}`).join(' ')
  const area = `${profitLine} L ${x(data.length - 1)} ${pad.top + innerHeight} L ${x(0)} ${pad.top + innerHeight} Z`
  const zeroY = yProfit(0)
  const currentIndex = Math.max(0, Math.min(data.length - 1, Math.round(settings.business.mealsPerDay / 10) - 1))

  return <div className="chart-wrap">
    <div className="chart-legend"><span><i className="legend-profit" />営業利益 / 日</span><span><i className="legend-cost" />1食平均原価</span></div>
    <svg className="volume-chart" role="img" aria-label="販売食数による営業利益と平均原価の変化" viewBox={`0 0 ${width} ${height}`}>
      <defs><linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#bc493a" stopOpacity="0.22"/><stop offset="1" stopColor="#bc493a" stopOpacity="0"/></linearGradient></defs>
      {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
        const y = pad.top + innerHeight * ratio
        const value = profitMax - (profitMax - profitMin) * ratio
        return <g key={ratio}><line className="grid-line" x1={pad.left} x2={pad.left + innerWidth} y1={y} y2={y}/><text className="axis-label" x={pad.left - 9} y={y + 4} textAnchor="end">{formatCompactYen(value)}</text></g>
      })}
      <line className="zero-line" x1={pad.left} x2={pad.left + innerWidth} y1={zeroY} y2={zeroY}/>
      <path d={area} fill={`url(#${gradientId})`}/>
      <path className="profit-line" d={profitLine}/>
      <path className="cost-line" d={costLine}/>
      {[0, 4, 9, 14, 19].map((index) => <text key={index} className="axis-label" x={x(index)} y={height - 14} textAnchor="middle">{data[index].meals}食</text>)}
      <text className="axis-label cost-axis" x={width - 5} y={pad.top + 4} textAnchor="end">{formatYen(costMax)}</text>
      <line className="current-marker" x1={x(currentIndex)} x2={x(currentIndex)} y1={pad.top} y2={pad.top + innerHeight}/>
      <circle className="profit-dot" cx={x(currentIndex)} cy={yProfit(data[currentIndex].profit)} r="5"/>
      <circle className="cost-dot" cx={x(currentIndex)} cy={yCost(data[currentIndex].averageCost)} r="5"/>
    </svg>
  </div>
}
