export type Labels = Readonly<Record<string, string>>;

/** What a metric is, for the lines `# HELP` and `# TYPE` of the text format. */
export interface MetricDescription {
  type: 'gauge' | 'counter';
  help: string;
}

export interface MetricsOptions {
  /** Described metrics (see `metrics-catalog.ts`). A series of a name not in it is rendered bare. */
  catalog?: Readonly<Record<string, MetricDescription>>;
}

export interface Metrics {
  /** Sets a gauge to an absolute value. */
  gauge(name: string, value: number, labels?: Labels): void;
  /** Adds to a counter (1 by default). */
  increment(name: string, labels?: Labels, by?: number): void;
  /**
   * Sets every series of a metric at once and forgets the ones that are not in the list: for a gauge
   * that is measured from a whole (the jobs of every queue), so a queue that emptied does not stay at
   * the depth it last had.
   */
  replace(name: string, series: readonly { labels?: Labels; value: number }[]): void;
  /** Current value of a series, zero when it was never recorded. */
  get(name: string, labels?: Labels): number;
  /** Text exposition (Prometheus text format 0.0.4), sorted, one `name{labels} value` line per series. */
  render(): string;
}

/** A label value in the text format: the backslash, the double quote and the line break are escaped. */
function escapeValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

function seriesKey(name: string, labels: Labels = {}): string {
  const pairs = Object.entries(labels)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([key, value]) => `${key}="${escapeValue(value)}"`);
  return pairs.length === 0 ? name : `${name}{${pairs.join(',')}}`;
}

/** The metric a series key belongs to. */
function nameOf(key: string): string {
  const brace = key.indexOf('{');
  return brace === -1 ? key : key.slice(0, brace);
}

/**
 * Minimal in-process metrics registry. A process exposes it on its own port (`metrics-server.ts`) and
 * the alerting rules read it (seal lag, chain breaks, queue depth). Label values must be ids or short
 * codes, never personal data.
 */
export function createMetrics(options: MetricsOptions = {}): Metrics {
  const catalog = options.catalog ?? {};
  const series = new Map<string, number>();

  return {
    gauge(name, value, labels) {
      series.set(seriesKey(name, labels), value);
    },
    increment(name, labels, by = 1) {
      const key = seriesKey(name, labels);
      series.set(key, (series.get(key) ?? 0) + by);
    },
    replace(name, replacement) {
      for (const key of [...series.keys()]) {
        if (nameOf(key) === name) series.delete(key);
      }
      for (const entry of replacement) series.set(seriesKey(name, entry.labels), entry.value);
    },
    get(name, labels) {
      return series.get(seriesKey(name, labels)) ?? 0;
    },
    render() {
      const lines: string[] = [];
      let introduced: string | null = null;
      const keys = [...series.keys()].sort((left, right) => {
        const leftName = nameOf(left);
        const rightName = nameOf(right);
        if (leftName !== rightName) return leftName < rightName ? -1 : 1;
        return left < right ? -1 : 1;
      });
      for (const key of keys) {
        const name = nameOf(key);
        const description = catalog[name];
        if (description && introduced !== name) {
          lines.push(`# HELP ${name} ${description.help}`, `# TYPE ${name} ${description.type}`);
          introduced = name;
        }
        lines.push(`${key} ${String(series.get(key) ?? 0)}`);
      }
      return `${lines.join('\n')}\n`;
    },
  };
}
