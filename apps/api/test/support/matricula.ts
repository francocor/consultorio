import { eq, sql } from 'drizzle-orm';

import { professional } from '../../src/db/schema/staff.js';
import type { DbHandle } from '../../src/platform/db/pool.js';
import { uuidv7 } from '../../src/platform/db/uuid.js';

/**
 * Verifies the matricula of a professional the way the platform operator's database role does, for
 * tests that need a professional who may prescribe (the e-prescription gate reads
 * `matricula_status`) without signing in to the console. Pass the handle of the operator harness
 * (`createOperatorHarness().db`). The trigger of migration 0013 accepts the change only from that
 * role, exactly as in production; a test of the console itself goes through the route instead.
 */
export async function verifyMatriculaAsOperator(
  operatorDb: DbHandle,
  tenantId: string,
  professionalId: string,
  operatorId: string = uuidv7(),
): Promise<void> {
  await operatorDb.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    const verified = await tx
      .update(professional)
      .set({ matriculaStatus: 'verified', verifiedByOperator: operatorId, verifiedAt: new Date() })
      .where(eq(professional.id, professionalId))
      .returning({ id: professional.id });
    if (verified.length === 0) throw new Error('no professional to verify in that organization');
  });
}
