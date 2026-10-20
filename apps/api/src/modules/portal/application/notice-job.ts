import { ROLES } from '@consultorio/contracts';
import { and, asc, eq, gte, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import { patientRecordChange } from '../../../db/schema/portal.js';
import { tenant } from '../../../db/schema/tenant.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import { SYSTEM_USER_ID, type Tx, type WithTenant } from '../../../platform/db/tenant-context.js';
import { JobPayload } from '../../../platform/jobs/boss.js';
import { defineJob } from '../../../platform/jobs/define-job.js';
import type { EmailSender } from '../../../platform/mail/email-sender.js';
import { readOrganizationName } from '../../tenancy/index.js';
import { RECENT_RECORD_CHANGE_DAYS } from '../domain/record-change.js';

import { renderPortalSecurityNoticeEmail } from './mail.js';

export const PORTAL_NOTICE_JOB = 'portal.notice_send';
export const PORTAL_NOTICE_SWEEP_JOB = 'portal.notice_sweep';

/**
 * A notice about the access of the portal that a member of the staff caused: an account moved to
 * another address, or a representative given access to a minor. It is queued in the transaction of
 * the change (JD-S5 R2-2): both exist or neither does, and a mail provider that is down only delays
 * it. The payload holds the address to tell, which is the one thing the job cannot read back from
 * the database (the account no longer has it); it names no one else and no clinical content.
 */
const NoticePayload = JobPayload.extend({
  kind: z.enum(['email_changed', 'representative_added']),
  to: z.string().min(3).max(320),
  /** The portal identity the notice is about. */
  resourceId: z.uuid(),
  patientId: z.uuid().optional(),
  /** The member of the staff who made the change, for the trail. */
  actorUserId: z.uuid().nullable().optional(),
  actingRole: z.enum(ROLES).nullable().optional(),
});
export type PortalNoticePayload = z.infer<typeof NoticePayload>;

const SYSTEM: AuditActor = {
  userId: null,
  actingRole: null,
  ip: null,
  userAgent: null,
  requestId: null,
};

async function recipientOf(tx: Tx, tenantId: string) {
  const [owner] = await tx.select({ isDemo: tenant.isDemo }).from(tenant);
  return { id: tenantId, isDemo: owner?.isDemo ?? false };
}

/**
 * Sends the notice and writes the entry of the trail that says it was sent. The queue is classified
 * `patient_protective`: a notice that warns a person that somebody was given their access goes out
 * whatever the state of the subscription.
 */
export function createPortalNoticeJob(deps: { email: EmailSender }) {
  return defineJob({
    name: PORTAL_NOTICE_JOB,
    category: 'patient_protective',
    payload: NoticePayload,
    handler: async ({ tx, tenantId, payload }) => {
      await deps.email.send({
        to: payload.to,
        tenant: await recipientOf(tx, tenantId),
        ...renderPortalSecurityNoticeEmail({
          organizationName: await readOrganizationName(tx),
          kind: payload.kind,
        }),
      });
      await audit(tx, {
        action: 'portal.notice.sent',
        outcome: 'allow',
        actor: {
          ...SYSTEM,
          userId: payload.actorUserId ?? null,
          actingRole: payload.actingRole ?? null,
        },
        resourceType: 'portal_identity',
        resourceId: payload.resourceId,
        ...(payload.patientId === undefined ? {} : { patientId: payload.patientId }),
        metadata: { kind: payload.kind },
      });
    },
  });
}

/** Most changes one pass tells. */
const SWEEP_BATCH = 20;
/** The longest one pass runs (real time): the next minute picks up what is left. */
const SWEEP_BUDGET_MS = 50_000;
/** Times a notice is tried before it is given up (JD-S5 R3-5). */
const MAX_ATTEMPTS = 5;
/** The wait after the first, second, third and fourth failure. */
const BACKOFF_MINUTES = [1, 5, 15, 60] as const;
/** How long a claim keeps the row for the pass that took it (a pass that died leaves a stale one). */
const CLAIM_LEASE = sql`interval '5 minutes'`;

/** Where the failures nobody is waiting for are written (the worker's log). Never an address. */
export interface NoticeLog {
  error(object: Record<string, unknown>, message: string): void;
}

export interface NoticeSweepDeps {
  email: EmailSender;
  /** Opens the short transactions of the pass: nothing is held while a message is sent. */
  withTenant: WithTenant;
  log?: NoticeLog | undefined;
}

const staleClaim = () =>
  or(
    isNull(patientRecordChange.noticeClaimedAt),
    lt(patientRecordChange.noticeClaimedAt, sql`now() - ${CLAIM_LEASE}`),
  );

const errorCodeOf = (error: unknown): string => {
  const cause = (error as { cause?: { code?: unknown }; code?: unknown } | null) ?? {};
  const code = cause.cause?.code ?? cause.code;
  return typeof code === 'string' ? code : 'unknown';
};

/**
 * Gives up the notices that cannot be told (JD-S5 R3-5): the week ended without them being sent, or
 * they failed `MAX_ATTEMPTS` times. The address leaves the row, the previous address counts as never
 * told, so the public registration of the patient closes (R3-4), and the entry is in the trail and in
 * the log. A row that a pass holds right now (a fresh claim) is not touched.
 */
async function expireNotices(
  run: <T>(work: (tx: Tx) => Promise<T>) => Promise<T>,
  deps: NoticeSweepDeps,
  tenantId: string,
  reason: 'week_over' | 'send_failed',
  only?: string,
): Promise<number> {
  const weekAgo = sql`now() - make_interval(days => ${RECENT_RECORD_CHANGE_DAYS})`;
  const expired = await run(async (tx) => {
    const rows = await tx
      .update(patientRecordChange)
      .set({
        noticeEmail: null,
        noticeExpiredAt: sql`now()`,
        registrationRequiresInvitation: true,
      })
      .where(
        and(
          isNotNull(patientRecordChange.noticeEmail),
          isNull(patientRecordChange.noticeSentAt),
          isNull(patientRecordChange.noticeExpiredAt),
          staleClaim(),
          only === undefined ? undefined : eq(patientRecordChange.id, only),
          reason === 'week_over'
            ? lt(patientRecordChange.createdAt, weekAgo)
            : gte(patientRecordChange.noticeAttempts, MAX_ATTEMPTS),
        ),
      )
      .returning({ id: patientRecordChange.id, patientId: patientRecordChange.patientId });
    for (const row of rows) {
      await audit(tx, {
        action: 'portal.notice.expired',
        outcome: 'allow',
        actor: SYSTEM,
        resourceType: 'patient',
        resourceId: row.patientId,
        patientId: row.patientId,
        metadata: { kind: 'record_changed', reason },
      });
    }
    return rows;
  });
  if (expired.length > 0) {
    deps.log?.error(
      { tenantId, reason, count: expired.length },
      'notices about a change to a record expired unsent',
    );
  }
  return expired.length;
}

/**
 * Tells the address a record HAD that its e-mail or birth date was changed (JD-S5 R2-2). The change
 * itself is written by the database, in the transaction of the update, whoever makes it
 * (`patient_record_change`); this pass is what delivers the notice, so a change that nobody expected
 * is told even when the application that made it knew nothing about the portal.
 *
 * Each notice goes through three steps, none of which holds a connection while a message is sent
 * (JD-S5 R3-5): a short transaction CLAIMS the row (and counts the attempt), the message is sent with
 * nothing open, and another short transaction marks it told, the address leaving the row with it.
 * The audit entry is written after the mark, in a transaction of its own: if it fails the notice is
 * not sent again, the failure is logged. A send that fails is logged and tried again after a longer
 * wait, at most `MAX_ATTEMPTS` times; one failing notice does not stop the others. A notice that
 * cannot be told (the week ended, or it failed every time) is given up, audited and logged, and the
 * public registration of that patient closes until an owner or an administrator invites them (R3-4).
 */
export async function sendRecordChangeNotices(
  deps: NoticeSweepDeps,
  input: { tenantId: string; now: Date },
): Promise<{ sent: number; expired: number; failed: number }> {
  const result = { sent: 0, expired: 0, failed: 0 };
  const run = <T>(work: (tx: Tx) => Promise<T>) =>
    deps.withTenant({ tenantId: input.tenantId, userId: SYSTEM_USER_ID }, work);
  const started = performance.now();

  result.expired += await expireNotices(run, deps, input.tenantId, 'week_over');
  result.expired += await expireNotices(run, deps, input.tenantId, 'send_failed');

  const context = await run(async (tx) => ({
    organizationName: await readOrganizationName(tx),
    recipient: await recipientOf(tx, input.tenantId),
  }));

  for (let turn = 0; turn < SWEEP_BATCH; turn += 1) {
    if (performance.now() - started > SWEEP_BUDGET_MS) break;
    const claimed = await run(async (tx) => {
      const [next] = await tx
        .select()
        .from(patientRecordChange)
        .where(
          and(
            isNotNull(patientRecordChange.noticeEmail),
            isNull(patientRecordChange.noticeSentAt),
            isNull(patientRecordChange.noticeExpiredAt),
            lt(patientRecordChange.noticeAttempts, MAX_ATTEMPTS),
            staleClaim(),
            or(
              isNull(patientRecordChange.noticeNextAttemptAt),
              lte(patientRecordChange.noticeNextAttemptAt, sql`now()`),
            ),
          ),
        )
        .orderBy(asc(patientRecordChange.createdAt), asc(patientRecordChange.id))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!next?.noticeEmail) return undefined;
      const attempts = next.noticeAttempts + 1;
      await tx
        .update(patientRecordChange)
        .set({ noticeClaimedAt: sql`now()`, noticeAttempts: attempts })
        .where(eq(patientRecordChange.id, next.id));
      return { id: next.id, patientId: next.patientId, to: next.noticeEmail, attempts };
    });
    if (!claimed) break;

    try {
      await deps.email.send({
        to: claimed.to,
        tenant: context.recipient,
        ...renderPortalSecurityNoticeEmail({
          organizationName: context.organizationName,
          kind: 'record_changed',
        }),
      });
    } catch (error) {
      result.failed += 1;
      deps.log?.error(
        { tenantId: input.tenantId, attempt: claimed.attempts, code: errorCodeOf(error) },
        'a notice about a change to a record could not be sent',
      );
      try {
        const wait = BACKOFF_MINUTES[Math.min(claimed.attempts, BACKOFF_MINUTES.length) - 1] ?? 60;
        await run((tx) =>
          tx
            .update(patientRecordChange)
            .set({
              noticeClaimedAt: null,
              noticeNextAttemptAt: sql`now() + make_interval(mins => ${wait})`,
            })
            .where(eq(patientRecordChange.id, claimed.id)),
        );
        if (claimed.attempts >= MAX_ATTEMPTS) {
          result.expired += await expireNotices(
            run,
            deps,
            input.tenantId,
            'send_failed',
            claimed.id,
          );
        }
      } catch (inner) {
        deps.log?.error(
          { tenantId: input.tenantId, code: errorCodeOf(inner) },
          'a failed notice could not be put back in the queue',
        );
      }
      continue;
    }

    // The message left. First the mark, so that nothing that happens next can send it again.
    try {
      await run((tx) =>
        tx
          .update(patientRecordChange)
          .set({ noticeEmail: null, noticeSentAt: input.now })
          .where(eq(patientRecordChange.id, claimed.id)),
      );
    } catch (error) {
      deps.log?.error(
        { tenantId: input.tenantId, code: errorCodeOf(error) },
        'a notice about a change to a record was sent but could not be marked as sent',
      );
      continue;
    }
    result.sent += 1;
    try {
      await run((tx) =>
        audit(tx, {
          action: 'portal.notice.sent',
          outcome: 'allow',
          actor: SYSTEM,
          resourceType: 'patient',
          resourceId: claimed.patientId,
          patientId: claimed.patientId,
          metadata: { kind: 'record_changed' },
        }),
      );
    } catch (error) {
      deps.log?.error(
        { tenantId: input.tenantId, code: errorCodeOf(error) },
        'a notice about a change to a record was sent but its audit entry could not be written',
      );
    }
  }
  return result;
}

/** The tick of every organization (a minute): tells the changes that were written since the last one. */
export function createPortalNoticeSweepJob(deps: NoticeSweepDeps & { clock?: () => Date }) {
  const clock = deps.clock ?? (() => new Date());
  return defineJob({
    name: PORTAL_NOTICE_SWEEP_JOB,
    category: 'patient_protective',
    payload: JobPayload,
    // The transaction the framework opens for the job holds nothing: every step of the pass runs in
    // short transactions of its own (`deps.withTenant`), so no connection waits for a message.
    handler: async ({ tenantId }) => {
      await sendRecordChangeNotices(
        { email: deps.email, withTenant: deps.withTenant, log: deps.log },
        { tenantId, now: clock() },
      );
    },
  });
}
