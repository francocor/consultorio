import type { PatientSummaryDto } from '@consultorio/contracts';
import { Link } from '@tanstack/react-router';
import { ChevronRight, Phone } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { formatAge, formatDocument } from '../../../shared/lib/format.js';
import { Badge } from '../../../shared/ui/badge.js';
import { SafetyFlag } from '../../../shared/ui/states/safety-flag.js';

export function initialsOf(familyName: string, givenNames: string): string {
  return `${givenNames.slice(0, 1)}${familyName.slice(0, 1)}`.toUpperCase();
}

/** The document the way people write it: `12.345.678`, or the passport as typed. */
export function documentText(document: PatientSummaryDto['document']): string | null {
  if (!document) return null;
  return document.type === 'passport'
    ? formatDocument('passport', document.number)
    : formatDocument('dni', document.number);
}

/** One patient of a list. The whole row is the link to the record (stretched over the card). */
export function PatientRow({ patient }: { patient: PatientSummaryDto }) {
  const { t } = useTranslation('patients');
  const document = documentText(patient.document);
  const age = formatAge(patient.birthDate);
  return (
    <li className="relative flex items-center gap-3 rounded-lg border bg-card p-3 transition-colors focus-within:border-primary hover:bg-accent/40 sm:p-4">
      <span
        aria-hidden="true"
        className="grid size-11 shrink-0 place-content-center rounded-full bg-accent font-display text-sm font-semibold text-accent-foreground"
      >
        {initialsOf(patient.familyName, patient.givenNames)}
      </span>
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={`/patients/${patient.id}`}
            className="font-medium after:absolute after:inset-0 after:content-[''] focus-visible:outline-offset-4"
          >
            {`${patient.familyName}, ${patient.givenNames}`}
          </Link>
          {patient.status === 'inactive' ? <Badge tone="neutral">{t('row.inactive')}</Badge> : null}
          <SafetyFlag flags={patient.hasSafetyFlag ? ['allergy_on_file'] : []} detail="summary" />
        </div>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-muted-foreground">
          <span className="tabular">{document ?? t('row.noDocument')}</span>
          {age ? <span>{age}</span> : null}
          {patient.phone ? (
            <span className="tabular inline-flex items-center gap-1">
              <Phone className="size-3.5" aria-hidden="true" />
              {t('row.phone', { phone: patient.phone })}
            </span>
          ) : null}
        </p>
      </div>
      <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
    </li>
  );
}
