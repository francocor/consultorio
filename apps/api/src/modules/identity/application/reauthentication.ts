import { eq } from 'drizzle-orm';

import { userAccount } from '../../../db/schema/identity.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import type { PasswordHasher } from '../infrastructure/argon2.js';

import type { Lockout } from './lockout.js';

export interface Reauthentication {
  /**
   * Proves the signed-in user knows the password again, before a sensitive change (replacing the
   * second factor, new recovery codes). It is a password attempt like any other: it goes through
   * the lockout gate, a wrong password counts toward the lock, and the failure is audited. A
   * right password leaves the failure counters as they were.
   */
  confirmPassword(tx: Tx, userId: string, password: string, actor: AuditActor): Promise<boolean>;
}

export function createReauthentication(deps: {
  hasher: PasswordHasher;
  lockout: Lockout;
}): Reauthentication {
  return {
    async confirmPassword(tx, userId, password, actor) {
      const reservation = await deps.lockout.reserveAttempt(tx, userId, actor);
      if (reservation.kind !== 'proceed') {
        await deps.hasher.verifyOrDummy(null, password);
        return false;
      }

      const [account] = await tx
        .select({ passwordHash: userAccount.passwordHash })
        .from(userAccount)
        .where(eq(userAccount.id, userId));
      const matches = await deps.hasher.verifyOrDummy(account?.passwordHash, password);

      if (!matches) {
        await deps.lockout.recordFailure(tx, userId, 'password', actor, { charged: true });
        await audit(tx, {
          action: 'auth.login.failed',
          outcome: 'deny',
          actor: { ...actor, userId, actingRole: null },
          reason: 'reauth_failed',
        });
        return false;
      }
      await deps.lockout.refundAttempt(tx, userId, reservation.charge);
      return true;
    },
  };
}
