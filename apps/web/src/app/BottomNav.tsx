import { Ellipsis } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../shared/lib/cn.js';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '../shared/ui/sheet.js';

import { splitForMobile, type NavItem } from './nav/nav-config.js';
import { NavLink } from './NavLink.js';

/**
 * The phone's navigation: at most five entries. With more, four plus "More", which opens a sheet
 * with the rest. Safe-area padding keeps it clear of the home indicator.
 */
export function BottomNav({ items, className }: { items: readonly NavItem[]; className?: string }) {
  const { t } = useTranslation('shell');
  const [open, setOpen] = useState(false);
  const { primary, more } = splitForMobile(items);

  return (
    <nav
      aria-label={t('nav.bottom')}
      className={cn(
        'fixed inset-x-0 bottom-0 z-40 flex items-stretch border-t bg-sidebar px-1 pb-[env(safe-area-inset-bottom)]',
        className,
      )}
    >
      {primary.map((item) => (
        <NavLink key={item.id} item={item} layout="stacked" />
      ))}
      {more.length > 0 ? (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <button
              type="button"
              className="touch-target flex min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1 text-xs font-medium text-sidebar-foreground hover:bg-accent"
            >
              <Ellipsis className="size-5" aria-hidden="true" />
              <span>{t('nav.more')}</span>
            </button>
          </SheetTrigger>
          <SheetContent side="bottom">
            <SheetTitle>{t('nav.more.title')}</SheetTitle>
            <SheetDescription className="sr-only">{t('nav.more.description')}</SheetDescription>
            <div className="grid gap-1">
              {more.map((item) => (
                <NavLink
                  key={item.id}
                  item={item}
                  layout="side"
                  onNavigate={() => {
                    setOpen(false);
                  }}
                />
              ))}
            </div>
          </SheetContent>
        </Sheet>
      ) : null}
    </nav>
  );
}
