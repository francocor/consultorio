import { ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge } from '../badge.js';

export type SafetyFlagKind =
  'allergy_on_file' | 'anticoagulant_on_file' | 'pregnancy' | 'implanted_device';

export interface SafetyFlagProps {
  flags: readonly SafetyFlagKind[];
  /**
   * `kinds`: a health professional sees which conditions are on file.
   * `summary`: everyone else sees one "see professional" chip and nothing about the condition.
   */
  detail: 'kinds' | 'summary';
}

/**
 * The patient safety indicator. It is computed by the system from the anamnesis and cannot be set
 * by hand; this component only displays it, and only reveals the kind of condition to people the
 * clinical rules already trust with it.
 */
export function SafetyFlag({ flags, detail }: SafetyFlagProps) {
  const { t } = useTranslation();
  if (flags.length === 0) return null;
  return (
    <div data-safety-flag className="flex flex-wrap gap-1.5">
      {detail === 'summary' ? (
        <Badge tone="danger">
          <ShieldAlert aria-hidden="true" />
          {t('safety.seeProfessional')}
        </Badge>
      ) : (
        flags.map((flag) => (
          <Badge key={flag} tone="danger">
            <ShieldAlert aria-hidden="true" />
            {t(`safety.${flag}`)}
          </Badge>
        ))
      )}
    </div>
  );
}
