import type { DocumentDto } from '@consultorio/contracts';
import {
  CheckCircle2,
  EyeOff,
  LoaderCircle,
  ShieldAlert,
  Stethoscope,
  FileText,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge, type BadgeTone } from '../../../shared/ui/badge.js';

const STATUS: Record<DocumentDto['status'], { tone: BadgeTone; icon: typeof CheckCircle2 }> = {
  quarantined: { tone: 'warning', icon: LoaderCircle },
  available: { tone: 'success', icon: CheckCircle2 },
  rejected: { tone: 'danger', icon: ShieldAlert },
  hidden: { tone: 'neutral', icon: EyeOff },
};

/** The state of a file as an icon AND a word: "Analizando" while the scan runs, never color alone. */
export function DocumentStatusBadge({ status }: { status: DocumentDto['status'] }) {
  const { t } = useTranslation('documents');
  const { tone, icon: Icon } = STATUS[status];
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" />
      {t(`status.${status}`)}
    </Badge>
  );
}

/** Clinical documents belong to the health team; administrative ones are shared with reception. */
export function ClassificationBadge({
  classification,
}: {
  classification: DocumentDto['classification'];
}) {
  const { t } = useTranslation('documents');
  const Icon = classification === 'clinical' ? Stethoscope : FileText;
  return (
    <Badge tone={classification === 'clinical' ? 'info' : 'neutral'}>
      <Icon aria-hidden="true" />
      {t(`classification.${classification}`)}
    </Badge>
  );
}
