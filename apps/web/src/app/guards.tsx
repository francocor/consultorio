import type { Permission } from '@consultorio/contracts';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ForbiddenState } from '../shared/ui/states/forbidden-state.js';

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
