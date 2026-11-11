import type { PrescriptionCapabilityDto } from '@consultorio/contracts';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { hasAnyPermission, useMe } from '../../../app/session.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';

/**
 * Why a professional cannot issue right now, in words they can act on (e-prescription,
 * "Prescriber eligibility", "Authorized provider connection"):
 *
 * - the provider is not connected (the deployment serves none, or the organization has not switched
 *   it on): whoever manages the settings gets a link to them, anybody else is told to ask;
 * - the matricula has not been verified by the platform: the rest of their clinical work is not
 *   affected.
 *
 * It draws nothing when everything is in place.
 */
export function CapabilityNotice({
  capability,
  id,
}: {
  capability: PrescriptionCapabilityDto;
  /** So the button that cannot be used can point at the explanation. */
  id?: string;
}) {
  const { t } = useTranslation('prescriptions');
  const me = useMe();
  const manages = hasAnyPermission(me.permissions, ['tenant.settings.manage']);

  if (!capability.providerAvailable || !capability.enabled) {
    return (
      <Alert tone="warning" id={id}>
        <AlertDescription>
          <span className="block font-medium">{t('notConnected.title')}</span>
          <span className="block">
            {capability.providerAvailable ? t('notConnected.switchedOff') : t('notConnected.none')}
          </span>
          {manages && capability.providerAvailable ? (
            <Link
              to="/settings/prescriptions"
              className="mt-1 inline-block font-medium text-primary-ink underline-offset-4 hover:underline"
            >
              {t('notConnected.settings')}
            </Link>
          ) : (
            <span className="mt-1 block">{t('notConnected.ask')}</span>
          )}
        </AlertDescription>
      </Alert>
    );
  }
  if (capability.matriculaStatus !== 'verified') {
    return (
      <Alert tone="warning" id={id}>
        <AlertDescription>
          <span className="block font-medium">{t('matricula.title')}</span>
          <span className="block">
            {capability.matriculaStatus === 'missing'
              ? t('matricula.missing')
              : t('matricula.unverified')}
          </span>
        </AlertDescription>
      </Alert>
    );
  }
  return null;
}
