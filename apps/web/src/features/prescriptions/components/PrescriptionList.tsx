import type { PrescriptionDto } from '@consultorio/contracts';
import { Pill } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '../../../shared/ui/states/empty-state.js';

import { PrescriptionCard } from './PrescriptionCard.js';

/** The prescriptions the person may read, newest first, or a first-use empty state. */
export function PrescriptionList({
  prescriptions,
  professionalId,
  showPatient,
  emptyAction,
}: {
  prescriptions: readonly PrescriptionDto[];
  professionalId: string | null;
  showPatient?: boolean;
  emptyAction?: ReactNode;
}) {
  const { t } = useTranslation('prescriptions');
  if (prescriptions.length === 0) {
    return (
      <EmptyState
        icon={Pill}
        title={t('list.empty.title')}
        description={t('list.empty.description')}
        action={emptyAction}
      />
    );
  }
  return (
    <ul className="grid gap-3" aria-label={t('list.caption')}>
      {prescriptions.map((prescription) => (
        <li key={prescription.id}>
          <PrescriptionCard
            prescription={prescription}
            professionalId={professionalId}
            {...(showPatient === undefined ? {} : { showPatient })}
          />
        </li>
      ))}
    </ul>
  );
}
