import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { formatNumber } from '../../lib/utils';

/**
 * Request-volume chart, loaded lazily.
 *
 * Recharts pulls in d3 and is by far the heaviest dependency in the dashboard.
 * Keeping it in its own module means it is fetched only when there is data
 * worth drawing — the login screen and the channel list never pay for it.
 */

export interface RequestsChartProps {
  data: Array<{ label: string; requests: number }>;
}

export default function RequestsChart({ data }: RequestsChartProps) {
  return (
    <div className="h-72 w-full px-2 pb-4 pt-5" dir="ltr">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 16, left: -12, bottom: 0 }}>
          <defs>
            <linearGradient id="requestsFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.22} />
              <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="label" axisLine={false} tickLine={false} tickMargin={10} />
          <YAxis allowDecimals={false} axisLine={false} tickLine={false} tickMargin={8} />
          <Tooltip
            cursor={{ stroke: 'var(--border)' }}
            contentStyle={{
              background: 'var(--popover)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              color: 'var(--popover-foreground)',
              fontSize: 12,
            }}
            formatter={(value) => [formatNumber(Number(value)), 'الطلبات']}
            labelStyle={{ color: 'var(--muted-foreground)', marginBottom: 4 }}
          />
          <Area type="monotone" dataKey="requests" stroke="var(--chart-1)" strokeWidth={1.5} fill="url(#requestsFill)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
