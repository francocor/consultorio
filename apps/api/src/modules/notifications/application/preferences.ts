import type { MessageChannel } from '@consultorio/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';

import {
  channelPreference,
  type OPT_IN_SOURCES,
  type OPT_OUT_SOURCES,
} from '../../../db/schema/channel-preference.js';
import { message } from '../../../db/schema/notifications.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { createActionTokens } from '../../../platform/tokens/index.js';

import { releaseWhatsappUsage } from './usage.js';

/**
 * The channel choices of patients (spec "Opt-out and consent"). A history of events; the latest
 * event of a (patient, channel) is the choice in force.
 *
 * - An opt-out is effective at once: what is still queued on that channel is cancelled in the same
 *   transaction, with the reason `opted_out`.
 * - Reception can opt a patient back in, per channel, when the patient asks for it in person
 *   (owner decision B7); the opt-in is audited and says it reopened a channel the patient had
 *   closed. The patient can do it too, by the booking form or their own email link.
 * - A message from the patient never opts in: this module has no entry for it.
 * - An opt-out on any channel is an opt-out of all of them: that is `optOutPatient`
 *   (`opt-out.ts`), which this module's `recordOptOut` serves one channel at a time.
 */

export type OptInSource = (typeof OPT_IN_SOURCES)[number];
export type OptOutSource = (typeof OPT_OUT_SOURCES)[number];

/** What the channel policy reads. */
export interface PatientPreferences {
  /** Email needs no opt-in: `default` means "not opted out". */
  email: 'default' | 'opted_out';
  /** `none` means the patient never opted in: WhatsApp stays unused. */
  whatsapp: 'none' | 'opted_in' | 'opted_out';
}

/** The state in force on a channel, from the latest event. */
async function currentState(
  tx: Tx,
  patientId: string,
  channel: MessageChannel,
): Promise<'opted_in' | 'opted_out' | null> {
  const [latest] = await tx
    .select({ state: channelPreference.state })
    .from(channelPreference)
    .where(and(eq(channelPreference.patientId, patientId), eq(channelPreference.channel, channel)))
    .orderBy(desc(channelPreference.createdAt), desc(channelPreference.id))
    .limit(1);
  if (!latest) return null;
  return latest.state === 'opted_out' ? 'opted_out' : 'opted_in';
}

export async function loadPreferences(tx: Tx, patientId: string): Promise<PatientPreferences> {
  const email = await currentState(tx, patientId, 'email');
  const whatsapp = await currentState(tx, patientId, 'whatsapp');
  return {
    email: email === 'opted_out' ? 'opted_out' : 'default',
    whatsapp: whatsapp ?? 'none',
  };
}

interface RecordInput {
  patientId: string;
  channel: MessageChannel;
  /** The staff member, for the `staff` source. */
  recordedBy?: string | undefined;
  actor: AuditActor;
}

/**
 * A link to accept WhatsApp that was still waiting must not undo an opt-out: following it later
 * would opt the patient back in (judgment day round 2, finding B10). It covers the links of a
 * public form (they belong to the submission and remember the patient in their payload) and the
 * ones reception sent from the record. A patient who changes their mind asks for a new one.
 */
export async function revokeWhatsappOptInLinks(tx: Tx, patientId: string): Promise<void> {
  const tokens = createActionTokens();
  await tokens.revokeForSubject(tx, 'whatsapp_opt_in', patientId);
  await tokens.revokeForPayload(tx, 'whatsapp_opt_in', 'patientId', patientId);
}

/**
 * Records that the patient does not want automated messages on a channel. Idempotent: a channel
 * already opted out keeps its first time and source. Returns how many queued messages it cancelled.
 */
export async function recordOptOut(
  tx: Tx,
  input: RecordInput & { source: OptOutSource },
): Promise<{ recorded: boolean; cancelled: number }> {
  if ((await currentState(tx, input.patientId, input.channel)) === 'opted_out') {
    return { recorded: false, cancelled: 0 };
  }
  await tx.insert(channelPreference).values({
    tenantId: sql`current_setting('app.tenant_id')::uuid`,
    patientId: input.patientId,
    channel: input.channel,
    state: 'opted_out',
    source: input.source,
    recordedBy: input.source === 'staff' ? (input.recordedBy ?? null) : null,
  });
  const cancelled = await tx
    .update(message)
    .set({ status: 'cancelled', cancelReason: 'opted_out' })
    .where(
      and(
        eq(message.patientId, input.patientId),
        eq(message.channel, input.channel),
        eq(message.status, 'queued'),
      ),
    )
    .returning({ id: message.id });
  if (input.channel === 'whatsapp') {
    // The messages that will not go give their places in the quota back.
    await releaseWhatsappUsage(
      tx,
      cancelled.map((row) => row.id),
    );
    await revokeWhatsappOptInLinks(tx, input.patientId);
  }
  await audit(tx, {
    action: 'notification.optout.recorded',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'patient',
    resourceId: input.patientId,
    patientId: input.patientId,
    metadata: { channel: input.channel, source: input.source },
  });
  return { recorded: true, cancelled: cancelled.length };
}

/**
 * Records that the patient accepts a channel, or accepts it again after opting out of it (owner
 * decision B7: reception can do that for the patient, per channel, and it is audited with
 * `reopened`). Idempotent: a channel already opted in keeps its first time and source.
 */
export async function recordOptIn(
  tx: Tx,
  input: RecordInput & { source: OptInSource },
): Promise<{ recorded: boolean }> {
  const state = await currentState(tx, input.patientId, input.channel);
  if (state === 'opted_in') return { recorded: false };
  await tx.insert(channelPreference).values({
    tenantId: sql`current_setting('app.tenant_id')::uuid`,
    patientId: input.patientId,
    channel: input.channel,
    state: 'opted_in',
    source: input.source,
    recordedBy: input.source === 'staff' ? (input.recordedBy ?? null) : null,
  });
  await audit(tx, {
    action: 'notification.optin.recorded',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'patient',
    resourceId: input.patientId,
    patientId: input.patientId,
    metadata: {
      channel: input.channel,
      source: input.source,
      ...(state === 'opted_out' ? { reopened: true } : {}),
    },
  });
  return { recorded: true };
}

/** The latest event of a channel, for a screen that shows where a choice came from. */
export async function describeChannel(
  tx: Tx,
  patientId: string,
  channel: MessageChannel,
): Promise<{
  state: 'opted_in' | 'opted_out' | null;
  source: string | null;
  recordedAt: Date | null;
}> {
  const [latest] = await tx
    .select({
      state: channelPreference.state,
      source: channelPreference.source,
      recordedAt: channelPreference.createdAt,
    })
    .from(channelPreference)
    .where(and(eq(channelPreference.patientId, patientId), eq(channelPreference.channel, channel)))
    .orderBy(desc(channelPreference.createdAt), desc(channelPreference.id))
    .limit(1);
  if (!latest) return { state: null, source: null, recordedAt: null };
  return {
    state: latest.state === 'opted_out' ? 'opted_out' : 'opted_in',
    source: latest.source,
    recordedAt: latest.recordedAt,
  };
}
