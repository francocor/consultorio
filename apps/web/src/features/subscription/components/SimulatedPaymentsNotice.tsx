import { FlaskConical } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../shared/lib/cn.js';

/**
 * The payments of this organization go through a simulator: nothing real is charged and the
 * statements are test documents. Shown on every screen that handles the subscription.
 */
export function SimulatedPaymentsNotice({ className }: { className?: string }) {
  const { t } = useTranslation('subscription');
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-3 rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning-soft-foreground',
        className,
      )}
    >
      <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div>
        <p className="font-medium">{t('simulated.title')}</p>
        <p>{t('simulated.description')}</p>
      </div>
    </div>
  );
}
