import { and, eq } from 'drizzle-orm';

import { careRelationship } from '../../../db/schema/care.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AccessRefused } from '../../access/index.js';

/** Who is writing, for the rule "a professional edits only patients they treat". */
export interface DemographicsEditor {
  /** Holds patient administration (role or grant): may edit any patient. */
  canAdminister: boolean;
  /** Set only for a professional with a valid profile. */
  professionalId: string | null;
}

/**
 * Demographics and coverage are organization-wide to READ. To WRITE them a professional needs the
 * patient to be theirs (authorization, "Demographics are organization-wide"), unless they hold the
 * patient-administration permission. The care relationship is the same table the clinical backstop
 * reads, so "treating" means one thing everywhere.
 */
export async function assertMayWriteDemographics(
  tx: Tx,
  editor: DemographicsEditor,
  patientId: string,
): Promise<void> {
  if (editor.canAdminister) return;
  if (editor.professionalId !== null) {
    const [row] = await tx
      .select({ id: careRelationship.id })
      .from(careRelationship)
      .where(
        and(
          eq(careRelationship.patientId, patientId),
          eq(careRelationship.professionalId, editor.professionalId),
          eq(careRelationship.active, true),
        ),
      );
    if (row) return;
  }
  throw new AccessRefused('patient_edit_not_treating');
}
