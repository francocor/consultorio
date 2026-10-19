import type { ConsentRequestStatus } from '@consultorio/contracts';
import { CheckCircle2, Clock, Hourglass, Undo2, XCircle, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge, type BadgeTone } from '../../../shared/ui/badge.js';

const STATES: Record<ConsentRequestStatus, { icon: LucideIcon; tone: BadgeTone }> = {
  pending: { icon: Clock, tone: 'warning' },
  signed: { icon: CheckCircle2, tone: 'success' },
  declined: { icon: XCircle, tone: 'neutral' },
  expired: { icon: Hourglass, tone: 'neutral' },
  revoked: { icon: Undo2, tone: 'danger' },
};

/** The state of a consent: an icon and a word, never the color alone. */
export function ConsentStatusBadge({ status }: { status: ConsentRequestStatus }) {
  const { t } = useTranslation('consent');
  const { icon: Icon, tone } = STATES[status];
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" />
      {t(`requestStatus.${status}`)}
    </Badge>
  );
}
