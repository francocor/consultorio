import { Outlet } from '@tanstack/react-router';
import { ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { OrgBrand } from '../../app/OrgBrand.js';

/**
 * The frame of every screen a visitor sees before signing in: the organization's name and logo
 * above one calm card. Nothing here depends on a session.
 */
export function AuthLayout() {
  const { t } = useTranslation('common');
  return (
    <div className="flex min-h-dvh flex-col items-center bg-background px-4 py-8 sm:py-14">
      <div className="mb-6 flex w-full max-w-md justify-center">
        <OrgBrand />
      </div>
      <main id="main" className="w-full max-w-md rounded-xl border bg-card p-6 shadow-sm sm:p-8">
        <Outlet />
      </main>
      <p className="mt-6 flex items-center gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="size-4" aria-hidden="true" />
        {t('app.name')}
      </p>
    </div>
  );
}
