import { lazy, Suspense, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Skeleton } from '../../../shared/ui/skeleton.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../shared/ui/tabs.js';
import type { SeriesDatum, SeriesLabels } from '../charts/SeriesChart.js';
import type { StatusDatum } from '../charts/StatusChart.js';

// Recharts is large: it is loaded only when somebody opens a chart, never with the entry chunk.
const StatusChart = lazy(() => import('../charts/StatusChart.js'));
const SeriesChart = lazy(() => import('../charts/SeriesChart.js'));

function ChartFallback({ height }: { height: number }) {
  return <Skeleton className="w-full" style={{ height }} />;
}

export function LazyStatusChart(props: { data: readonly StatusDatum[]; label: string }) {
  return (
    <Suspense fallback={<ChartFallback height={300} />}>
      <StatusChart {...props} />
    </Suspense>
  );
}

export function LazySeriesChart(props: {
  data: readonly SeriesDatum[];
  label: string;
  labels: SeriesLabels;
}) {
  return (
    <Suspense fallback={<ChartFallback height={260} />}>
      <SeriesChart {...props} />
    </Suspense>
  );
}

/**
 * A chart and the same data as a table (reports, "Charts with accessible table alternative"). The
 * chart is the first view; the table is one tab away and is what a screen reader should use. Only
 * the view on show is mounted, so the chart code is not even fetched for someone who reads tables.
 */
export function ChartWithTable({
  title,
  chart,
  table,
}: {
  /** The name of the data, for the label of the switch. */
  title: string;
  chart: ReactNode;
  table: ReactNode;
}) {
  const { t } = useTranslation('reports');
  return (
    <Tabs defaultValue="chart">
      <TabsList aria-label={t('view.label', { title })}>
        <TabsTrigger value="chart">{t('view.chart')}</TabsTrigger>
        <TabsTrigger value="table">{t('view.table')}</TabsTrigger>
      </TabsList>
      <TabsContent value="chart">{chart}</TabsContent>
      <TabsContent value="table">{table}</TabsContent>
    </Tabs>
  );
}
