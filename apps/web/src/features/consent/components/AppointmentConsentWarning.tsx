import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import type { SlotProps } from '../../../app/registry.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { consentApi, consentKeys } from '../api/consent-api.js';

/**
 * A warning inside the appointment drawer when the type of the appointment requires a consent and
 * the patient holds no valid one (informed-consent, "Revocation": the system warns when a procedure
 * requires a valid consent that is revoked). It names no template: the appointment is linked to a
 * patient, and a title would be clinical metadata. Nothing is shown when nothing is required, when
 * the consent is valid, or while the answer is not known; a failed check says nothing rather than
 * blocking the appointment.
 */
export function AppointmentConsentWarning({ appointment }: SlotProps['appointment-drawer']) {
  const { t } = useTranslation('consent');
  const api = useApi();
  const status = useQuery({
    queryKey: consentKeys.appointment(appointment.id),
    queryFn: () => consentApi(api).appointmentStatus(appointment.id),
    retry: false,
  });

  if (status.data?.state !== 'missing' && status.data?.state !== 'revoked') return null;
  return (
    <Alert tone="warning">
      <AlertDescription>
        {status.data.state === 'revoked' ? t('warning.revoked') : t('warning.missing')}
      </AlertDescription>
    </Alert>
  );
}
