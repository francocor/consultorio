import { ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/cn.js';

export interface ForbiddenStateProps {
  /** A way out, such as a link to the start page. */
  action?: ReactNode;
  className?: string;
}

/**
 * A direct address the role cannot use. It is shown instead of the screen, so nothing is fetched
 * for it; the API refuses the same request on its own, this is only the clear explanation.
 */
export function ForbiddenState({ action, className }: ForbiddenStateProps) {
  const { t } = useTranslation();
  return (
    <section
      className={cn(
        'flex flex-col items-center gap-3 rounded-lg border bg-card px-6 py-12 text-center',
        className,
      )}
    >
      <span className="grid size-12 place-content-center rounded-full bg-warning-soft text-warning-soft-foreground">
        <ShieldAlert className="size-6" aria-hidden="true" />
      </span>
      <h2 className="font-display text-lg font-semibold">{t('state.forbidden.title')}</h2>
      <p className="max-w-md text-sm text-muted-foreground">{t('state.forbidden.description')}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </section>
  );
}
