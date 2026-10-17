import type { ClinicalTemplateKind } from '@consultorio/contracts';

import { GeneralFields } from './GeneralFields.js';
import { NutritionFields } from './NutritionFields.js';
import { OdontologyFields } from './OdontologyFields.js';
import { PhysiotherapyFields } from './PhysiotherapyFields.js';
import { PsychologyFields } from './PsychologyFields.js';

/** The fields of the template a note was created with. */
export function TemplateFields({
  kind,
  patientId,
  disabled = false,
}: {
  kind: ClinicalTemplateKind;
  patientId: string;
  disabled?: boolean;
}) {
  switch (kind) {
    case 'general':
      return <GeneralFields disabled={disabled} />;
    case 'psychology':
      return <PsychologyFields disabled={disabled} />;
    case 'physiotherapy':
      return <PhysiotherapyFields disabled={disabled} />;
    case 'nutrition':
      return <NutritionFields disabled={disabled} />;
    case 'odontology':
      return <OdontologyFields patientId={patientId} disabled={disabled} />;
  }
}
