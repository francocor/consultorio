import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';

export interface StatusDatum {
  label: string;
  count: number;
}

/**
 * Appointments per status as horizontal bars: the status is the label of the row and the number is
 * written at the end of the bar, so nothing depends on colour. Loaded on demand (Recharts is large),
 * and every chart of the dashboard has the same data in a table beside it.
 */
export default function StatusChart({
  data,
  label,
}: {
  data: readonly StatusDatum[];
  label: string;
}) {
  return (
    <div role="img" aria-label={label} className="h-[300px] w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <BarChart
          data={[...data]}
          layout="vertical"
          margin={{ top: 4, right: 32, bottom: 4, left: 0 }}
          accessibilityLayer={false}
        >
          <CartesianGrid horizontal={false} stroke="var(--border)" />
          <XAxis type="number" allowDecimals={false} hide />
          <YAxis
            type="category"
            dataKey="label"
            width={118}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 12, fill: 'var(--foreground)' }}
          />
          <Bar
            dataKey="count"
            fill="var(--primary)"
            radius={[0, 4, 4, 0]}
            isAnimationActive={false}
          >
            <LabelList
              dataKey="count"
              position="right"
              style={{ fontSize: 12, fill: 'var(--foreground)' }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
