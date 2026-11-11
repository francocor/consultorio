import { Bar, BarChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis } from 'recharts';

export interface SeriesDatum {
  label: string;
  attended: number;
  noShow: number;
  cancelled: number;
}

export interface SeriesLabels {
  attended: string;
  noShow: string;
  cancelled: string;
}

/**
 * The look of each series. Colour is never the only difference: attended is solid, no-show is
 * striped and cancelled is dotted, and the legend draws the same patterns beside the words.
 */
const STYLES = {
  attended: { pattern: 'solid', color: 'var(--success)' },
  noShow: { pattern: 'stripes', color: 'var(--destructive)' },
  cancelled: { pattern: 'dots', color: 'var(--muted-foreground)' },
} as const;

type SeriesKey = keyof typeof STYLES;
const KEYS: readonly SeriesKey[] = ['attended', 'noShow', 'cancelled'];

/** The three fills, under ids of their own so the chart and the legend never share one. */
function Patterns({ prefix }: { prefix: string }) {
  return (
    <>
      <pattern id={`${prefix}-solid`} width="8" height="8" patternUnits="userSpaceOnUse">
        <rect width="8" height="8" fill={STYLES.attended.color} />
      </pattern>
      <pattern
        id={`${prefix}-stripes`}
        width="8"
        height="8"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <rect width="8" height="8" fill="var(--card)" />
        <rect width="4" height="8" fill={STYLES.noShow.color} />
      </pattern>
      <pattern id={`${prefix}-dots`} width="8" height="8" patternUnits="userSpaceOnUse">
        <rect width="8" height="8" fill="var(--card)" />
        <circle cx="4" cy="4" r="2" fill={STYLES.cancelled.color} />
      </pattern>
    </>
  );
}

function Legend({ labels }: { labels: SeriesLabels }) {
  return (
    <>
      <svg width="0" height="0" aria-hidden="true" focusable="false" className="absolute">
        <defs>
          <Patterns prefix="legend" />
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
                fill={`url(#legend-${STYLES[key].pattern})`}
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

/** Appointments per period as stacked bars of attended, no-show and cancelled. Loaded on demand. */
export default function SeriesChart({
  data,
  label,
  labels,
}: {
  data: readonly SeriesDatum[];
  label: string;
  labels: SeriesLabels;
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
              <Patterns prefix="chart" />
            </defs>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis
              dataKey="label"
              tickLine={false}
              tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
              minTickGap={12}
            />
            <YAxis
              allowDecimals={false}
              width={32}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            />
            {KEYS.map((key) => (
              <Bar
                key={key}
                dataKey={key}
                name={labels[key]}
                stackId="attendance"
                fill={`url(#chart-${STYLES[key].pattern})`}
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
