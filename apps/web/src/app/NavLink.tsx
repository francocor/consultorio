import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { cn } from '../shared/lib/cn.js';

import type { NavItem } from './nav/nav-config.js';
import { useNavBadge } from './nav/use-nav-badge.js';

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
  const { t } = useTranslation(['shell', 'scheduling']);
  const badge = useNavBadge(item.id);
  const Icon = item.icon;
  const label = t(item.labelKey, { ns: 'shell' });
  return (
    <Link
      to={item.to}
      activeOptions={{ exact: item.to === '/' }}
      onClick={onNavigate}
      title={hideLabel ? label : undefined}
      aria-label={
        badge > 0 ? `${label}, ${t('scheduling:nav.worklistBadge', { count: badge })}` : undefined
      }
      className={cn(
        'group touch-target-md relative flex items-center rounded-md text-sm font-medium transition-colors',
        'text-sidebar-foreground hover:bg-accent hover:text-accent-foreground',
        'data-[status=active]:bg-primary-soft data-[status=active]:font-semibold data-[status=active]:text-foreground',
        layout === 'side' && 'gap-3 px-3',
        layout === 'stacked' && 'min-w-0 flex-1 flex-col justify-center gap-0.5 px-1 py-1 text-xs',
        hideLabel && 'justify-center px-0',
      )}
    >
      <Icon
        className="size-5 shrink-0 group-data-[status=active]:text-primary-ink"
        aria-hidden="true"
      />
      <span className={cn(hideLabel && 'sr-only', layout === 'stacked' && 'max-w-full truncate')}>
        {label}
      </span>
      {badge > 0 ? (
        <span
          aria-hidden="true"
          className={cn(
            'tabular ml-auto inline-grid min-w-5 place-content-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground',
            layout === 'stacked' && 'absolute right-2 top-0.5 ml-0',
            hideLabel && 'absolute right-1 top-1 ml-0',
          )}
        >
          {badge > 99 ? '99+' : badge}
        </span>
      ) : null}
    </Link>
  );
}
