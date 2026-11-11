import {
  BadgeCheck,
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  Clock,
  TriangleAlert,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge, type BadgeTone } from '../badge.js';

export type Status =
  'active' | 'inactive' | 'pending' | 'unverified' | 'verified' | 'ok' | 'warning' | 'error';

const STATUSES: Record<Status, { icon: LucideIcon; tone: BadgeTone }> = {
  active: { icon: CheckCircle2, tone: 'success' },
  inactive: { icon: CircleSlash, tone: 'neutral' },
  pending: { icon: Clock, tone: 'warning' },
  unverified: { icon: CircleDashed, tone: 'warning' },
  verified: { icon: BadgeCheck, tone: 'success' },
  ok: { icon: CheckCircle2, tone: 'success' },
  warning: { icon: TriangleAlert, tone: 'warning' },
  error: { icon: XCircle, tone: 'danger' },
};

/**
 * A status as an icon AND a word, so it is understood without color. The label defaults to the
 * standard word of the status; pass children for a more specific one.
 */
export function StatusBadge({ status, children }: { status: Status; children?: ReactNode }) {
  const { t } = useTranslation();
  const { icon: Icon, tone } = STATUSES[status];
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" />
      {children ?? t(`status.${status}`)}
    </Badge>
  );
}
