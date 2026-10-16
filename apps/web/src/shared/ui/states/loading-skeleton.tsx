import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/cn.js';
import { Skeleton } from '../skeleton.js';

/** One polite announcement for the whole region; the shapes inside are decorative. */
function LoadingRegion({ children, className }: { children: ReactNode; className?: string }) {
  const { t } = useTranslation();
  return (
    <div role="status" aria-busy="true" className={className}>
      <span className="sr-only">{t('state.loading.label')}</span>
      {children}
    </div>
  );
}

/** Rows of a list or table. */
export function ListSkeleton({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <LoadingRegion className={cn('divide-y rounded-lg border bg-card', className)}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} data-skeleton-row className="flex items-center gap-4 p-4">
          <Skeleton className="size-10 shrink-0 rounded-full" />
          <div className="grid flex-1 gap-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
          <Skeleton className="hidden h-6 w-16 sm:block" />
        </div>
      ))}
    </LoadingRegion>
  );
}

/** A record page: header and a couple of cards. */
export function DetailSkeleton({ className }: { className?: string }) {
  return (
    <LoadingRegion className={cn('grid gap-4', className)}>
      <Skeleton className="h-8 w-1/2" />
      <Skeleton className="h-4 w-1/3" />
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    </LoadingRegion>
  );
}

/** A form: labels and inputs. */
export function FormSkeleton({ fields = 4, className }: { fields?: number; className?: string }) {
  return (
    <LoadingRegion className={cn('grid max-w-xl gap-5', className)}>
      {Array.from({ length: fields }, (_, index) => (
        <div key={index} className="grid gap-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-10 w-full" />
        </div>
      ))}
    </LoadingRegion>
  );
}
