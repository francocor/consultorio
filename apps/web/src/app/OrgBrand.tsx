import { useTranslation } from 'react-i18next';

import { cn } from '../shared/lib/cn.js';

import { useBoot } from './boot.js';

/** The organization's logo, or its initial on the brand color when it has none. */
export function OrgBrand({
  compact = false,
  className,
}: {
  /** Only the mark, for a collapsed sidebar. The name stays available to assistive technology. */
  compact?: boolean;
  className?: string;
}) {
  const { t } = useTranslation('shell');
  const boot = useBoot();
  const name = boot?.name ?? t('org.fallbackName');
  return (
    <div className={cn('flex min-w-0 items-center gap-3', className)}>
      {boot?.logoUrl ? (
        <img
          src={boot.logoUrl}
          alt={t('org.logoAlt', { name })}
          className="size-9 shrink-0 rounded-md object-contain"
        />
      ) : (
        <span
          aria-hidden="true"
          className="grid size-9 shrink-0 place-content-center rounded-md bg-primary font-display text-base font-semibold text-primary-foreground"
        >
          {name.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className={cn('truncate font-display text-sm font-semibold', compact && 'sr-only')}>
        {name}
      </span>
    </div>
  );
}
