import { Outlet } from '@tanstack/react-router';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../shared/lib/cn.js';
import { readSidebarCollapsed, writeSidebarCollapsed } from '../shared/lib/preferences.js';

import { useBoot } from './boot.js';
import { BottomNav } from './BottomNav.js';
import { FirstRunSlot } from './FirstRunSlot.js';
import { buildNav } from './nav/nav-config.js';
import { NavLink } from './NavLink.js';
import { OrgBrand } from './OrgBrand.js';
import { useServices } from './providers.js';
import { useMe } from './session.js';
import { StatusBanners } from './StatusBanners.js';
import { UserMenu } from './UserMenu.js';

/**
 * One shell for every staff role. The navigation comes from the permissions the API returned: a
 * collapsible sidebar from the tablet size up, a bottom bar on phones. The skip link is the first
 * thing a keyboard user reaches.
 */
export function AppShell() {
  const { t } = useTranslation(['shell', 'common']);
  const me = useMe();
  const { registry } = useServices();
  const boot = useBoot();
  const items = buildNav({
    permissions: me.permissions,
    roles: me.roles,
    contributed: registry.navItems,
    deploymentMode: boot?.deploymentMode,
  });
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);

  function toggle() {
    const next = !collapsed;
    writeSidebarCollapsed(next);
    setCollapsed(next);
  }

  return (
    <div className="min-h-dvh md:flex">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        {t('common:action.skip')}
      </a>

      <aside
        className={cn(
          'sticky top-0 hidden h-dvh shrink-0 flex-col border-r bg-sidebar transition-[width] md:flex',
          collapsed ? 'w-[4.5rem]' : 'w-64',
        )}
      >
        <div className={cn('flex h-14 items-center border-b px-3', collapsed && 'justify-center')}>
          <OrgBrand compact={collapsed} />
        </div>
        <nav aria-label={t('shell:nav.primary')} className="grid flex-1 content-start gap-1 p-3">
          {items.map((item) => (
            <NavLink key={item.id} item={item} layout="side" hideLabel={collapsed} />
          ))}
        </nav>
        <div className="border-t p-3">
          <button
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            className="touch-target-md flex w-full cursor-pointer items-center gap-3 rounded-md px-3 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            {collapsed ? (
              <PanelLeftOpen className="size-5 shrink-0" aria-hidden="true" />
            ) : (
              <PanelLeftClose className="size-5 shrink-0" aria-hidden="true" />
            )}
            <span className={cn(collapsed && 'sr-only')}>
              {collapsed ? t('shell:nav.expand') : t('shell:nav.collapse')}
            </span>
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b bg-background/95 px-4 backdrop-blur md:justify-end md:px-8">
          <OrgBrand className="md:hidden" />
          <UserMenu me={me} />
        </header>
        <StatusBanners me={me} />
        <main
          id="main"
          tabIndex={-1}
          className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 pb-28 outline-none md:px-8 md:pb-10"
        >
          <FirstRunSlot />
          <Outlet />
        </main>
      </div>

      <BottomNav items={items} className="md:hidden" />
    </div>
  );
}
