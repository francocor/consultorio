import { Outlet } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

/**
 * The frame of the public pages of the platform host (Stage 6, `mount: 'platform'`): the name of the
 * product and nothing else. There is no organization yet, so no brand and no logo of one; no staff
 * navigation and no account menu either, because a visitor here is nobody's staff. The signup
 * decides what goes inside.
 */
export function PlatformShell() {
  const { t } = useTranslation('shell');
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b bg-card px-4 py-3 md:px-8">
        <p className="mx-auto w-full max-w-3xl font-display text-base font-semibold">
          {t('platform.title')}
        </p>
      </header>
      <main id="main" className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 md:px-8">
        <Outlet />
      </main>
    </div>
  );
}
