export type Labels = Readonly<Record<string, string>>;

export interface Metrics {
  /** Sets a gauge to an absolute value. */
  gauge(name: string, value: number, labels?: Labels): void;
  /** Adds to a counter (1 by default). */
  increment(name: string, labels?: Labels, by?: number): void;
  /** Current value of a series, zero when it was never recorded. */
  get(name: string, labels?: Labels): number;
  /** Text exposition, one `name{labels} value` line per series, sorted. */
  render(): string;
}

function seriesKey(name: string, labels: Labels = {}): string {
  const pairs = Object.entries(labels)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([key, value]) => `${key}="${value}"`);
  return pairs.length === 0 ? name : `${name}{${pairs.join(',')}}`;
}

/**
 * Minimal in-process metrics registry. The API exposes it later on an internal endpoint and the
 * alerting rules read it (seal lag, chain breaks, queue depth). Label values must be ids or
 * short codes, never personal data.
 */
export function createMetrics(): Metrics {
  const series = new Map<string, number>();

  return {
    gauge(name, value, labels) {
      series.set(seriesKey(name, labels), value);
    },
    increment(name, labels, by = 1) {
      const key = seriesKey(name, labels);
      series.set(key, (series.get(key) ?? 0) + by);
    },
    get(name, labels) {
      return series.get(seriesKey(name, labels)) ?? 0;
    },
    render() {
      const lines = [...series.entries()]
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([key, value]) => `${key} ${String(value)}`);
      return `${lines.join('\n')}\n`;
    },
  };
}
