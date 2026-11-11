import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../shared/lib/cn.js';

const LINK =
  'touch-target-md inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground';
const CURRENT = 'bg-card text-foreground shadow-sm';

/**
 * The three reports as three screens of their own, so each one loads only what it shows (the
 * money and cash screens bring their own code when opened). The cash report is offered only to
 * who may read it: the server refuses everybody else, the link is a courtesy.
 */
export function ReportNav({ canSeeCash }: { canSeeCash: boolean }) {
  const { t } = useTranslation('reports');
  const items = [
    { to: '/reports', label: t('tabs.operational') },
    { to: '/reports/financial', label: t('tabs.financial') },
    ...(canSeeCash ? [{ to: '/reports/cash', label: t('tabs.cash') }] : []),
  ];
  return (
    <nav
      aria-label={t('tabs.label')}
      className="inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-muted p-1"
    >
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          activeOptions={{ exact: true }}
          className={LINK}
          activeProps={{ 'aria-current': 'page', className: cn(LINK, CURRENT) }}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
