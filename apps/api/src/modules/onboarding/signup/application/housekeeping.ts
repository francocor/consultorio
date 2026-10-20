import { SIGNUP_PURGE_AFTER_DAYS } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';

import type { Db } from '../../../../platform/db/pool.js';

import type { VerificationMailer } from './mailer.js';

const DAY_MS = 86_400_000;

/** At most this many organizations are purged, or signups retried, in one pass. */
const PASS_SIZE = 200;
const RETRY_PASS_SIZE = 50;

export interface SignupHousekeepingDeps {
  /** The runtime connection of the worker. */
  db: Db;
  mailer: VerificationMailer;
  clock: () => Date;
  /** Where a failure is told. Only a code, never an address or a message that can carry one. */
  onError: (code: string) => void;
}

export interface SignupHousekeeping {
  /**
   * Removes the organizations that were never confirmed and are older than seven days
   * (`SIGNUP_PURGE_AFTER_DAYS`), with what they hold, and records each one in the platform trail
   * (retention exception 2). It runs as a pass of its own, not as the job of an organization: a
   * `write` job is cancelled for an organization that is not active, and this is the very
   * organization it deletes. The guarantees are in `app.signup_purge`. Returns how many it removed.
   */
  purgeUnverified(): Promise<number>;
  /**
   * Sends again the verification email of the signups whose first one never went out (the provider
   * was down), with a backoff and at most five times (`app.signup_unsent`). A signup that fails
   * again is left for the next pass; the visitor can also ask for a new link at any time.
   */
  retryVerifications(): Promise<number>;
}

export function createSignupHousekeeping(deps: SignupHousekeepingDeps): SignupHousekeeping {
  return {
    async purgeUnverified() {
      const cutoff = new Date(deps.clock().getTime() - SIGNUP_PURGE_AFTER_DAYS * DAY_MS);
      const result = await deps.db.transaction((tx) =>
        tx.execute<{ purged: number }>(
          sql`select app.signup_purge(${cutoff.toISOString()}::timestamptz, ${PASS_SIZE}) as purged`,
        ),
      );
      return result.rows[0]?.purged ?? 0;
    },

    async retryVerifications() {
      const waiting = await deps.db.transaction((tx) =>
        tx.execute<{ tenant_id: string }>(
          sql`select tenant_id from app.signup_unsent(${RETRY_PASS_SIZE})`,
        ),
      );
      let retried = 0;
      for (const { tenant_id: tenantId } of waiting.rows) {
        try {
          await deps.mailer.issueAndSend(tenantId, { manual: false });
          retried += 1;
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          deps.onError(typeof code === 'string' ? code : 'email_failed');
        }
      }
      return retried;
    },
  };
}
