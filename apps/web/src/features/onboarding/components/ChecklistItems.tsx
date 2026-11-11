import type { ChecklistItemDto } from '@consultorio/contracts';
import { Link } from '@tanstack/react-router';
import { CheckCircle2, Circle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../shared/lib/cn.js';
import { CHECKLIST_LINKS } from '../checklist-links.js';

/** "2 de 8 listos" and a bar that says the same thing in a shape. */
export function ChecklistProgress({ items }: { items: readonly ChecklistItemDto[] }) {
  const { t } = useTranslation('onboarding');
  const done = items.filter((item) => item.done).length;
  const percent = items.length === 0 ? 0 : Math.round((done / items.length) * 100);
  return (
    <div className="grid gap-1.5">
      <p className="text-sm font-medium">
        {t('checklist.progress', { done, total: items.length })}
      </p>
      <div aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-secondary">
        <div className="h-full rounded-full bg-primary" style={{ width: `${String(percent)}%` }} />
      </div>
    </div>
  );
}

/**
 * The items of the checklist. Each one links to the screen that completes it, and says whether it
 * is done in words as well as in the icon: color and shape are never the only signal.
 */
export function ChecklistItems({
  items,
  onNavigate,
}: {
  items: readonly ChecklistItemDto[];
  /** Called when a link is followed, so a dialog that hosts the list can close. */
  onNavigate?: () => void;
}) {
  const { t } = useTranslation('onboarding');
  return (
    <ul className="grid gap-1">
      {items.map((item) => {
        const link = CHECKLIST_LINKS[item.id];
        const Icon = item.done ? CheckCircle2 : Circle;
        return (
          <li key={item.id} className="flex items-center gap-3">
            <Icon
              aria-hidden="true"
              className={cn(
                'size-5 shrink-0',
                item.done ? 'text-success' : 'text-muted-foreground',
              )}
            />
            <Link
              to={link.to}
              {...(link.step ? { search: { step: link.step } } : {})}
              {...(onNavigate ? { onClick: onNavigate } : {})}
              className="touch-target-md flex flex-1 items-center rounded-md px-1 text-sm hover:underline"
            >
              {t(`checklist.item.${item.id}`)}
            </Link>
            <span className="shrink-0 text-xs font-medium text-muted-foreground">
              {item.done ? t('checklist.done') : t('checklist.pending')}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
