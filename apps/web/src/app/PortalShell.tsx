import { Outlet } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { OrgBrand } from './OrgBrand.js';

/**
 * The shell of the patient portal (Stage 5, `mount: 'portal'`): the organization's name and logo,
 * the name of the portal, and nothing else. No staff navigation and no account menu: a person in
 * the portal is not staff, and the staff `AppShell` never wraps a portal screen. The portal feature
 * decides what goes inside (the sign-in, the subject picker, the sections).
 */
export function PortalShell() {
  const { t } = useTranslation('shell');
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b bg-card px-4 py-3 md:px-8">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4">
          <OrgBrand />
          <p className="shrink-0 text-sm text-muted-foreground">{t('portal.title')}</p>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 md:px-8">
        <Outlet />
      </main>
    </div>
  );
}
