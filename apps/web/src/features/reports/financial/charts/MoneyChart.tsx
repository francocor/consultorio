import { Bar, BarChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis } from 'recharts';

export interface MoneyDatum {
  label: string;
  charged: number;
  collected: number;
}

export interface MoneyLabels {
  charged: string;
  collected: string;
}

/**
 * The look of each series. Colour is never the only difference: charged is solid and collected is
 * striped, and the legend draws the same patterns beside the words.
 */
const STYLES = {
  charged: { pattern: 'solid', color: 'var(--primary)' },
  collected: { pattern: 'stripes', color: 'var(--success)' },
} as const;

type SeriesKey = keyof typeof STYLES;
const KEYS: readonly SeriesKey[] = ['charged', 'collected'];

function Patterns({ prefix }: { prefix: string }) {
  return (
    <>
      <pattern id={`${prefix}-solid`} width="8" height="8" patternUnits="userSpaceOnUse">
        <rect width="8" height="8" fill={STYLES.charged.color} />
      </pattern>
      <pattern
        id={`${prefix}-stripes`}
        width="8"
        height="8"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <rect width="8" height="8" fill="var(--card)" />
        <rect width="4" height="8" fill={STYLES.collected.color} />
      </pattern>
    </>
  );
}

function Legend({ labels }: { labels: MoneyLabels }) {
  return (
    <>
      <svg width="0" height="0" aria-hidden="true" focusable="false" className="absolute">
        <defs>
          <Patterns prefix="money-legend" />
        </defs>
      </svg>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {KEYS.map((key) => (
          <li key={key} className="flex items-center gap-1.5">
            <svg width="16" height="16" aria-hidden="true" focusable="false">
              <rect
                width="16"
                height="16"
                rx="3"
                fill={`url(#money-legend-${STYLES[key].pattern})`}
                stroke={STYLES[key].color}
              />
            </svg>
            <span>{labels[key]}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** A compact amount for the axis: `$ 1,2 M`, `$ 350 mil`. The exact amounts are in the table. */
function axisAmount(pesos: number): string {
  if (Math.abs(pesos) >= 1_000_000)
    return `$ ${(pesos / 1_000_000).toFixed(1).replace('.', ',')} M`;
  if (Math.abs(pesos) >= 1_000) return `$ ${String(Math.round(pesos / 1_000))} mil`;
  return `$ ${String(pesos)}`;
}

/** Charged and collected per period as grouped bars, in pesos. Loaded on demand with Recharts. */
export default function MoneyChart({
  data,
  label,
  labels,
}: {
  data: readonly MoneyDatum[];
  label: string;
  labels: MoneyLabels;
}) {
  return (
    <div className="w-full min-w-0">
      <div role="img" aria-label={label} className="h-[260px] w-full min-w-0">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <BarChart
            data={[...data]}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
            accessibilityLayer={false}
          >
            <defs>
              <Patterns prefix="money-chart" />
            </defs>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis
              dataKey="label"
              tickLine={false}
              tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
              minTickGap={12}
            />
            <YAxis
              width={56}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value: number) => axisAmount(value)}
              tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            />
            {KEYS.map((key) => (
              <Bar
                key={key}
                dataKey={key}
                name={labels[key]}
                fill={`url(#money-chart-${STYLES[key].pattern})`}
                stroke={STYLES[key].color}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <Legend labels={labels} />
    </div>
  );
}
