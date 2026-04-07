'use client'

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from 'recharts'
import type { DailyTokenUsage, AgentTokenUsage } from '@/lib/usage'
import { formatTokens } from '@/lib/usage'

const CHART_COLORS = {
  input: 'hsl(221, 83%, 53%)',
  output: 'hsl(142, 71%, 45%)',
  total: 'hsl(262, 83%, 58%)',
}

interface TokenUsageAreaChartProps {
  data: DailyTokenUsage[]
}

export function TokenUsageAreaChart({ data }: TokenUsageAreaChartProps) {
  if (data.length === 0) {
    return (
      <div className="border rounded-lg p-6 flex items-center justify-center" style={{ height: 220 }}>
        <p className="text-xs text-muted-foreground">No data to display yet.</p>
      </div>
    )
  }

  return (
    <div className="border rounded-lg p-4 space-y-2">
      <p className="text-xs font-medium text-muted-foreground">Token Usage Over Time</p>
      <ResponsiveContainer width="100%" height={180}>
        <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="fillInput" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={CHART_COLORS.input} stopOpacity={0.3} />
              <stop offset="95%" stopColor={CHART_COLORS.input} stopOpacity={0} />
            </linearGradient>
            <linearGradient id="fillOutput" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={CHART_COLORS.output} stopOpacity={0.3} />
              <stop offset="95%" stopColor={CHART_COLORS.output} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-border/50" />
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
            tickFormatter={(v: string) => {
              const d = new Date(v)
              return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
            }}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tickMargin={4}
            tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
            tickFormatter={(v: number) => formatTokens(v)}
            width={40}
          />
          <Tooltip
            contentStyle={{
              background: 'hsl(var(--popover))',
              border: '1px solid hsl(var(--border))',
              borderRadius: 6,
              fontSize: 12,
            }}
            labelFormatter={(label) => {
              const d = new Date(label)
              return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
            }}
            formatter={(value, name) => [
              formatTokens(Number(value)),
              name === 'input_tokens' ? 'Token Out (→model)' : 'Token In (←model)',
            ]}
          />
          <Legend
            iconType="circle"
            iconSize={8}
            wrapperStyle={{ fontSize: 11 }}
            formatter={(name: string) =>
              name === 'input_tokens' ? 'Token Out (→model)' : 'Token In (←model)'
            }
          />
          <Area
            type="monotone"
            dataKey="input_tokens"
            stroke={CHART_COLORS.input}
            fill="url(#fillInput)"
            strokeWidth={1.5}
            dot={false}
          />
          <Area
            type="monotone"
            dataKey="output_tokens"
            stroke={CHART_COLORS.output}
            fill="url(#fillOutput)"
            strokeWidth={1.5}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

interface AgentUsageBarChartProps {
  data: AgentTokenUsage[]
}

export function AgentUsageBarChart({ data }: AgentUsageBarChartProps) {
  if (data.length === 0) {
    return (
      <div className="border rounded-lg p-6 flex items-center justify-center" style={{ height: 220 }}>
        <p className="text-xs text-muted-foreground">No data to display yet.</p>
      </div>
    )
  }

  const displayData = data.slice(0, 10)
  const chartHeight = Math.max(180, displayData.length * 32)

  return (
    <div className="border rounded-lg p-4 space-y-2">
      <p className="text-xs font-medium text-muted-foreground">Tokens by Agent</p>
      <ResponsiveContainer width="100%" height={chartHeight}>
        <BarChart
          data={displayData}
          layout="vertical"
          margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
        >
          <CartesianGrid horizontal={false} strokeDasharray="3 3" className="stroke-border/50" />
          <XAxis
            type="number"
            tickLine={false}
            axisLine={false}
            tickMargin={4}
            tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
            tickFormatter={(v: number) => formatTokens(v)}
          />
          <YAxis
            type="category"
            dataKey="agent_name"
            tickLine={false}
            axisLine={false}
            tickMargin={4}
            width={80}
            tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
          />
          <Tooltip
            contentStyle={{
              background: 'hsl(var(--popover))',
              border: '1px solid hsl(var(--border))',
              borderRadius: 6,
              fontSize: 12,
            }}
            formatter={(value) => [formatTokens(Number(value)), 'Total Tokens']}
          />
          <Bar
            dataKey="total_tokens"
            fill={CHART_COLORS.total}
            radius={[0, 4, 4, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
