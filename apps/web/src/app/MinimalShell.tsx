import { Outlet } from '@tanstack/react-router';

import { OrgBrand } from './OrgBrand.js';

/**
 * The shell of the patient portal and the public booking pages: the organization's name and logo
 * and nothing else. No staff navigation, no account menu: these visitors are not staff.
 */
export function MinimalShell() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b bg-card px-4 py-3 md:px-8">
        <OrgBrand />
      </header>
      <main id="main" className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 md:px-8">
        <Outlet />
      </main>
    </div>
  );
}
