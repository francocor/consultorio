import { Lock, ShieldCheck, WifiOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/cn.js';
import { formatDate } from '../../lib/format.js';
import { Alert, AlertDescription, AlertTitle } from '../alert.js';

/** The device has no connection. Pure display: the shell decides when to show it. */
export function OfflineBanner({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-3 border-b border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning-soft-foreground',
        className,
      )}
    >
      <WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p>{t('state.offline.banner')}</p>
    </div>
  );
}

/** The organization is read only: reads work, writes are refused (402). */
export function ReadOnlyBanner({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-3 border-b border-info/30 bg-info-soft px-4 py-3 text-sm text-info-soft-foreground',
        className,
      )}
    >
      <Lock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div>
        <p className="font-medium">{t('state.readOnly.title')}</p>
        <p>{t('state.readOnly.description')}</p>
      </div>
    </div>
  );
}

/** A role that must have a second factor but does not yet, after the grace period. */
export function TwoFactorRequiredState({ action }: { action?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <section className="mx-auto flex max-w-xl flex-col items-center gap-3 rounded-lg border bg-card px-6 py-10 text-center">
      <span className="grid size-12 place-content-center rounded-full bg-primary-soft text-primary-ink">
        <ShieldCheck className="size-6" aria-hidden="true" />
      </span>
      <h2 className="font-display text-lg font-semibold">{t('state.twoFactor.title')}</h2>
      <p className="max-w-md text-sm text-muted-foreground">{t('state.twoFactor.description')}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </section>
  );
}

/** Still inside the 7-day grace period: reminds the person without blocking anything. */
export function TwoFactorGraceBanner({ endsAt, action }: { endsAt: string; action?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Alert tone="warning">
      <AlertTitle>{t('state.twoFactor.title')}</AlertTitle>
      <AlertDescription>
        {t('state.twoFactor.grace', { date: formatDate(endsAt) })}
        {action ? <span className="ml-2">{action}</span> : null}
      </AlertDescription>
    </Alert>
  );
}
