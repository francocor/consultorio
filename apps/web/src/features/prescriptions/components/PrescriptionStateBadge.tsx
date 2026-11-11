import type { PrescriptionDto } from '@consultorio/contracts';
import { useTranslation } from 'react-i18next';

import { StatusBadge, type Status } from '../../../shared/ui/states/status-badge.js';
import { displayState, type DisplayState } from '../domain/states.js';

const STATUS_OF: Record<DisplayState, Status> = {
  issued: 'ok',
  pending: 'pending',
  attention: 'warning',
  refused: 'error',
  cancelled: 'inactive',
  dispensed: 'verified',
  expired: 'inactive',
};

/**
 * Where a prescription stands, as an icon AND a word. A prescription the provider has not confirmed
 * never wears the word "emitida": it is "pendiente de envío" until the provider answers.
 */
export function PrescriptionStateBadge({ prescription }: { prescription: PrescriptionDto }) {
  const { t } = useTranslation('prescriptions');
  const state = displayState(prescription);
  return <StatusBadge status={STATUS_OF[state]}>{t(`state.${state}`)}</StatusBadge>;
}
