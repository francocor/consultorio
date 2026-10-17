import type { PatientDto } from '@consultorio/contracts';
import { useTranslation } from 'react-i18next';

import { documentText } from './PatientRow.js';
import { RepresentativesSection } from './RepresentativesSection.js';
import { Section, Fact } from './Section.js';

/** The personal data of the patient and, for a minor, the adults in charge. */
export function DataTab({ patient, canWrite }: { patient: PatientDto; canWrite: boolean }) {
  const { t } = useTranslation('patients');
  const none = <span className="font-normal text-muted-foreground">{t('data.empty')}</span>;
  const document = documentText(patient.document);

  return (
    <div className="grid gap-4">
      <Section title={t('data.title')} description={t(`data.origin.${patient.origin}`)}>
        <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          <Fact label={t('data.document')}>
            {document ? (
              <span className="tabular">{document}</span>
            ) : (
              <span className="font-normal text-muted-foreground">{t('data.noDocument')}</span>
            )}
          </Fact>
          <Fact label={t('data.sex')}>{patient.sex ? t(`form.sex.${patient.sex}`) : none}</Fact>
          <Fact label={t('data.phone')}>
            {patient.phone ? <span className="tabular">{patient.phone}</span> : none}
          </Fact>
          <Fact label={t('data.email')}>{patient.email ?? none}</Fact>
          <Fact label={t('data.address')}>{patient.address ?? none}</Fact>
          <Fact label={t('data.emergency')}>
            {patient.emergencyContact
              ? `${patient.emergencyContact.name} · ${patient.emergencyContact.phone}`
              : none}
          </Fact>
          <Fact label={t('data.notes')} className="sm:col-span-2">
            {patient.adminNotes ?? none}
          </Fact>
        </dl>
      </Section>
      <RepresentativesSection patientId={patient.id} canWrite={canWrite} />
    </div>
  );
}
