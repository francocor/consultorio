import { Link } from '@tanstack/react-router';
import { CalendarPlus } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { buttonVariants } from '../../../shared/ui/button.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../shared/ui/card.js';
import { EmptyState } from '../../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { DetailSkeleton } from '../../../shared/ui/states/loading-skeleton.js';

/** What a widget needs to know about the request that feeds it. */
export interface WidgetRequest {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
}

export interface ReportWidgetProps {
  title: string;
  description?: string;
  request: WidgetRequest;
  /** True when the request answered and there is nothing to show for the filters chosen. */
  empty: boolean;
  /** What the widget shows when it is empty; the standard pointer to the agenda by default. */
  emptyState?: ReactNode;
  /** Controls beside the title (for example the choice of group). */
  actions?: ReactNode;
  children: ReactNode;
}

/** The pointer every empty widget gives: the first thing to do is to schedule an appointment. */
export function EmptyReport() {
  const { t } = useTranslation('reports');
  return (
    <EmptyState
      className="py-8"
      title={t('empty.title')}
      description={t('empty.description')}
      action={
        <Link to="/calendar" className={buttonVariants({ variant: 'outline' })}>
          <CalendarPlus aria-hidden="true" />
          {t('empty.action')}
        </Link>
      }
    />
  );
}

/**
 * One piece of the dashboard with its own loading, empty and error states and its own retry, so a
 * failure in one widget leaves the others working (reports, "Empty, loading and error states").
 */
export function ReportWidget({
  title,
  description,
  request,
  empty,
  emptyState,
  actions,
  children,
}: ReportWidgetProps) {
  const headingId = useId();
  let body: ReactNode;
  if (request.isPending) {
    body = <DetailSkeleton />;
  } else if (request.isError) {
    body = (
      <ErrorState
        error={request.error}
        onRetry={() => {
          void request.refetch();
        }}
      />
    );
  } else if (empty) {
    body = emptyState ?? <EmptyReport />;
  } else {
    body = children;
  }
  return (
    <Card aria-labelledby={headingId}>
      <CardHeader className="sm:flex-row sm:items-start sm:justify-between">
        <div className="grid gap-1">
          <CardTitle id={headingId}>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        {actions}
      </CardHeader>
      <CardContent className="min-w-0">{body}</CardContent>
    </Card>
  );
}
