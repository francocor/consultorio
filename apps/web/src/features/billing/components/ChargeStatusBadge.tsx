import type { ChargeStatus } from '@consultorio/contracts';
import { CheckCircle2, CircleDashed, CircleSlash, Clock, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge, type BadgeTone } from '../../../shared/ui/badge.js';

const STATUSES: Record<ChargeStatus, { icon: LucideIcon; tone: BadgeTone }> = {
  pending: { icon: Clock, tone: 'warning' },
  partially_paid: { icon: CircleDashed, tone: 'info' },
  paid: { icon: CheckCircle2, tone: 'success' },
  voided: { icon: CircleSlash, tone: 'neutral' },
};

/** The state of a charge as an icon AND a word, so it reads without color. */
export function ChargeStatusBadge({ status }: { status: ChargeStatus }) {
  const { t } = useTranslation('billing');
  const { icon: Icon, tone } = STATUSES[status];
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" />
      {t(`status.${status}`)}
    </Badge>
  );
}
