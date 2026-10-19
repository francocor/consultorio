import { ROLES } from '@consultorio/contracts';
import { and, asc, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';

import { patientRecordChange } from '../../../db/schema/portal.js';
import { tenant } from '../../../db/schema/tenant.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
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
const SWEEP_BATCH = 50;

/**
 * Tells the address a record HAD that its e-mail or birth date was changed (JD-S5 R2-2). The change
 * itself is written by the database, in the transaction of the update, whoever makes it
 * (`patient_record_change`); this pass is what delivers the notice, so a change that nobody expected
 * is told even when the application that made it knew nothing about the portal. The address is
 * cleared once it was told (and when the week is over without it having been possible), so the
 * previous address does not stay in the table. A notice that cannot be sent is tried again by the
 * next pass; one failing change does not stop the others.
 */
export async function sendRecordChangeNotices(
  tx: Tx,
  deps: { email: EmailSender; log?: (message: string) => void },
  input: { tenantId: string; now: Date },
): Promise<{ sent: number; expired: number }> {
  const result = { sent: 0, expired: 0 };
  // The week is counted by the clock of the database, like the rule that reads these rows.
  const weekAgo = sql`now() - make_interval(days => ${RECENT_RECORD_CHANGE_DAYS})`;
  const expired = await tx
    .update(patientRecordChange)
    .set({ noticeEmail: null })
    .where(
      and(isNotNull(patientRecordChange.noticeEmail), lt(patientRecordChange.createdAt, weekAgo)),
    )
    .returning({ id: patientRecordChange.id });
  result.expired = expired.length;

  const rows = await tx
    .select()
    .from(patientRecordChange)
    .where(
      and(isNotNull(patientRecordChange.noticeEmail), isNull(patientRecordChange.noticeSentAt)),
    )
    .orderBy(asc(patientRecordChange.createdAt), asc(patientRecordChange.id))
    .limit(SWEEP_BATCH)
    .for('update', { skipLocked: true });
  if (rows.length === 0) return result;

  const organizationName = await readOrganizationName(tx);
  const recipient = await recipientOf(tx, input.tenantId);
  for (const row of rows) {
    if (row.noticeEmail === null) continue;
    const to = row.noticeEmail;
    try {
      // A savepoint per change: one that fails leaves the others, and the mark is written with the send.
      await tx.transaction(async (inner) => {
        await deps.email.send({
          to,
          tenant: recipient,
          ...renderPortalSecurityNoticeEmail({
            organizationName,
            kind: 'record_changed',
            fields: { email: row.emailChanged, birthDate: row.birthDateChanged },
          }),
        });
        await inner
          .update(patientRecordChange)
          .set({ noticeEmail: null, noticeSentAt: input.now })
          .where(eq(patientRecordChange.id, row.id));
        await audit(inner, {
          action: 'portal.notice.sent',
          outcome: 'allow',
          actor: SYSTEM,
          resourceType: 'patient',
          resourceId: row.patientId,
          patientId: row.patientId,
          metadata: {
            kind: 'record_changed',
            email: row.emailChanged,
            birthDate: row.birthDateChanged,
          },
        });
      });
      result.sent += 1;
    } catch {
      deps.log?.('a notice about a change to a record could not be sent');
    }
  }
  return result;
}

/** The tick of every organization (a minute): tells the changes that were written since the last one. */
export function createPortalNoticeSweepJob(deps: {
  email: EmailSender;
  clock?: () => Date;
  log?: (message: string) => void;
}) {
  const clock = deps.clock ?? (() => new Date());
  return defineJob({
    name: PORTAL_NOTICE_SWEEP_JOB,
    category: 'patient_protective',
    payload: JobPayload,
    handler: async ({ tx, tenantId }) => {
      await sendRecordChangeNotices(
        tx,
        { email: deps.email, ...(deps.log ? { log: deps.log } : {}) },
        { tenantId, now: clock() },
      );
    },
  });
}
