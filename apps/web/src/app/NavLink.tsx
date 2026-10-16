import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { cn } from '../shared/lib/cn.js';

import type { NavItem } from './nav/nav-config.js';

/** One navigation entry. The active one is marked for assistive technology and for the eye. */
export function NavLink({
  item,
  layout,
  hideLabel = false,
  onNavigate,
}: {
  item: NavItem;
  /** `side`: icon beside the label (sidebar, sheet). `stacked`: icon above it (bottom bar). */
  layout: 'side' | 'stacked';
  hideLabel?: boolean;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation('shell');
  const Icon = item.icon;
  const label = t(item.labelKey);
  return (
    <Link
      to={item.to}
      activeOptions={{ exact: item.to === '/' }}
      onClick={onNavigate}
      title={hideLabel ? label : undefined}
      className={cn(
        'group touch-target-md flex items-center rounded-md text-sm font-medium transition-colors',
        'text-sidebar-foreground hover:bg-accent hover:text-accent-foreground',
        'data-[status=active]:bg-primary-soft data-[status=active]:text-primary-ink',
        layout === 'side' && 'gap-3 px-3',
        layout === 'stacked' && 'min-w-0 flex-1 flex-col justify-center gap-0.5 px-1 py-1 text-xs',
        hideLabel && 'justify-center px-0',
      )}
    >
      <Icon className="size-5 shrink-0" aria-hidden="true" />
      <span className={cn(hideLabel && 'sr-only', layout === 'stacked' && 'max-w-full truncate')}>
        {label}
      </span>
    </Link>
  );
}
