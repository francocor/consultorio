import {
  latestTemplate,
  templatesForSpecialties,
  type TemplatesResponse,
} from '@consultorio/contracts';
import { eq } from 'drizzle-orm';

import { professional } from '../../../db/schema/staff.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

/**
 * The templates a professional is offered when they open an encounter (clinical-records,
 * "Specialty templates"): the generic one plus those of every specialty on their profile. A
 * specialty with no template of its own gets the generic one. The organization can restrict the
 * list in a later stage; the server accepts any registered template when an encounter is opened,
 * so a professional is never blocked from writing a note.
 */
export async function offeredTemplates(tx: Tx, professionalId: string): Promise<TemplatesResponse> {
  const [row] = await tx
    .select({ specialties: professional.specialties })
    .from(professional)
    .where(eq(professional.id, professionalId));
  const kinds = templatesForSpecialties(row?.specialties ?? []);
  return {
    templates: kinds.flatMap((kind) => {
      const template = latestTemplate(kind);
      return template
        ? [
            {
              kind: template.kind,
              version: template.version,
              labelKey: template.labelKey,
              requiredFields: [...template.requiredFields],
            },
          ]
        : [];
    }),
  };
}
