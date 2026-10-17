import { Link, Outlet } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { RequirePermission } from '../../app/guards.js';
import { useMe } from '../../app/session.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { cn } from '../../shared/lib/cn.js';
import { PageHeader } from '../../shared/ui/page-header.js';

import { SETTINGS_TABS, settingsTabsFor } from './settings-tabs.js';

/** The frame of Settings: the title and the sections this person may open. */
export function SettingsPage() {
  const { t } = useTranslation('settings');
  usePageTitle(t('title'));
  const me = useMe();
  const tabs = settingsTabsFor(me.permissions);

  return (
    <RequirePermission anyOf={SETTINGS_TABS.map((tab) => tab.permission)}>
      <PageHeader title={t('title')} description={t('description')} className="mb-4" />
      <nav aria-label={t('nav')} className="mb-6 overflow-x-auto border-b">
        <ul className="flex min-w-max gap-1">
          {tabs.map((tab) => (
            <li key={tab.id}>
              <Link
                to={tab.to}
                className={cn(
                  'touch-target-md -mb-px inline-flex items-center border-b-2 border-transparent px-4 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground',
                  'data-[status=active]:border-primary data-[status=active]:text-foreground',
                )}
              >
                {t(`tab.${tab.id}`)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <Outlet />
    </RequirePermission>
  );
}
