import type { MeResponse } from '@consultorio/contracts';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { ReadOnlyBanner, TwoFactorGraceBanner } from '../shared/ui/states/banners.js';

import { useAppStatus } from './providers.js';

/**
 * The global states of the signed-in shell, each driven by a real signal: a 402 or the
 * organization status in `/auth/me` (read only), and the second-factor grace period. The offline
 * banner lives at the root, because it must show on any screen, signed in or not.
 */
export function StatusBanners({ me }: { me: MeResponse }) {
  const { t } = useTranslation('shell');
  const status = useAppStatus();
  const readOnly = status.readOnly || me.tenantStatus === 'read_only';
  const { enrolled, required, graceEndsAt } = me.twoFactor;
  const showGrace = required && !enrolled && graceEndsAt !== null && me.scope === 'full';

  return (
    <>
      {readOnly ? <ReadOnlyBanner /> : null}
      {showGrace ? (
        <div className="px-4 pt-4 md:px-8">
          <TwoFactorGraceBanner
            endsAt={graceEndsAt}
            action={
              <Link to="/account/security" className="font-medium underline">
                {t('banner.enrollment.action')}
              </Link>
            }
          />
        </div>
      ) : null}
    </>
  );
}
