import { RefreshCw, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/cn.js';
import { describeError } from '../../lib/translate.js';
import { Button } from '../button.js';

export interface ErrorStateProps {
  /** Anything that was thrown. Only the translated message and the reference code are shown. */
  error: unknown;
  onRetry?: () => void;
  className?: string;
}

/**
 * A request failed. Plain language, a way to try again and a reference code to quote to support:
 * never a stack, a status line or any technical detail.
 */
export function ErrorState({ error, onRetry, className }: ErrorStateProps) {
  const { t } = useTranslation();
  const { message, requestId } = describeError(t, error);
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center gap-3 rounded-lg border bg-card px-6 py-10 text-center',
        className,
      )}
    >
      <span className="grid size-12 place-content-center rounded-full bg-danger-soft text-danger-soft-foreground">
        <TriangleAlert className="size-6" aria-hidden="true" />
      </span>
      <h2 className="font-display text-lg font-semibold">{t('state.error.title')}</h2>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      {requestId ? (
        <p className="tabular text-xs text-muted-foreground">
          {t('state.error.reference', { id: requestId })}
        </p>
      ) : null}
      {onRetry ? (
        <Button variant="outline" onClick={onRetry}>
          <RefreshCw aria-hidden="true" />
          {t('action.retry')}
        </Button>
      ) : null}
    </div>
  );
}
