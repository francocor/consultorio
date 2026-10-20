import type { Permission } from '@consultorio/contracts';
import { Link } from '@tanstack/react-router';
import type { ComponentType, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ForbiddenState } from '../shared/ui/states/forbidden-state.js';

import { useBoot } from './boot.js';
import { NotFoundPage } from './NotFoundPage.js';
import { hasAnyPermission, useMe } from './session.js';

/**
 * Shows its children only to a user who holds at least one of the permissions. Otherwise it shows
 * the "no access" state INSTEAD of the screen: the children are never mounted, so nothing is
 * fetched for them. The API repeats the check on every route; this is the clear explanation.
 */
export function RequirePermission({
  anyOf,
  children,
}: {
  anyOf: readonly Permission[];
  children: ReactNode;
}) {
  const { t } = useTranslation(['shell', 'common']);
  const me = useMe();
  if (!hasAnyPermission(me.permissions, anyOf)) {
    return (
      <ForbiddenState
        action={
          <Link
            to="/"
            className="inline-flex touch-target-md items-center rounded-md border border-input bg-card px-4 text-sm font-medium hover:bg-accent"
          >
            {t('common:state.forbidden.action')}
          </Link>
        }
      />
    );
  }
  return <>{children}</>;
}

/**
 * A screen behind a permission: the screen itself is mounted only for a user who holds one of them,
 * the "no access" state otherwise. Routes (the shell's and the ones features contribute) use this.
 */
export const guardedScreen = (anyOf: readonly Permission[], Screen: ComponentType) =>
  function GuardedScreen() {
    return (
      <RequirePermission anyOf={anyOf}>
        <Screen />
      </RequirePermission>
    );
  };

/**
 * A screen that exists only on the multi-tenant platform (the platform subscription): in a
 * single-tenant deployment the address is the "not found" page of any unknown one, and the screen is
 * never mounted, so nothing is fetched for it. The API has no such routes there either.
 */
export const multiModeScreen = (Screen: ComponentType) =>
  function MultiModeScreen() {
    const boot = useBoot();
    if (boot?.deploymentMode === 'single') return <NotFoundPage />;
    return <Screen />;
  };
