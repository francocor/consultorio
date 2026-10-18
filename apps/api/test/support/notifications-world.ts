import { and, eq, sql } from 'drizzle-orm';

import {
  createFakeEmailSender,
  type FakeEmailSender,
} from '../../src/adapters/fake-email/index.js';
import {
  createFakeWhatsAppSender,
  type FakeWhatsAppSender,
} from '../../src/adapters/whatsapp-fake/index.js';
import { message, messageAttempt, type MessageRow } from '../../src/db/schema/notifications.js';
import { worklistItem } from '../../src/db/schema/worklist.js';
import type { MessagingDeps } from '../../src/modules/notifications/application/deps.js';
import { createNotificationJobs } from '../../src/modules/notifications/application/jobs.js';
import type { WhatsAppSender } from '../../src/modules/notifications/application/ports.js';
import {
  queueMessage,
  type QueueMessageInput,
} from '../../src/modules/notifications/application/queue.js';
import { createWorklist } from '../../src/modules/notifications/application/worklist.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { createPublicOrigins } from '../../src/platform/http/public-origin.js';
import {
  EmailDeliveryError,
  type EmailMessage,
  type EmailSender,
} from '../../src/platform/mail/email-sender.js';
import { createActionTokens } from '../../src/platform/tokens/index.js';

import { BASE_DOMAIN } from './app.js';
import { createRecordingJobClient, runPending, type RecordingJobClient } from './jobs.js';
import type { SchedulingHttpWorld } from './scheduling-world.js';

/** An email sender whose next outcomes a test decides. After the script it accepts everything. */
export interface ScriptedEmail extends EmailSender {
  readonly sent: readonly EmailMessage[];
  /** The outcomes of the next calls, oldest first: `ok`, or the error the call fails with. */
  script: ('ok' | { responseCode: number } | Error)[];
  /** How many times `send` was called, successful or not. */
  calls: number;
  /** Forgets what was sent and scripted. */
  reset(): void;
}

export function createScriptedEmail(): ScriptedEmail {
  const sent: EmailMessage[] = [];
  const email: ScriptedEmail = {
    sent,
    script: [],
    calls: 0,
    reset() {
      sent.length = 0;
      email.script = [];
      email.calls = 0;
    },
    send(input) {
      email.calls += 1;
      const next = email.script.shift() ?? 'ok';
      if (next === 'ok') {
        sent.push(input);
        return Promise.resolve();
      }
      const cause = next instanceof Error ? next : Object.assign(new Error('smtp'), next);
      return Promise.reject(new EmailDeliveryError({ cause }));
    },
  };
  return email;
}

export interface NotificationsWorld {
  world: SchedulingHttpWorld;
  deps: MessagingDeps;
  jobs: RecordingJobClient;
  email: ScriptedEmail;
  demoEmail: FakeEmailSender;
  whatsapp: WhatsAppSender;
  demoWhatsapp: FakeWhatsAppSender;
  /** The clock of messaging (the jobs). Independent from the clock of scheduling. */
  now(): Date;
  setNow(date: Date): void;
  /** Runs the pending jobs of messaging once, the way the worker would. */
  runJobs(): Promise<unknown[]>;
  /** Runs rounds until nothing is pending (each retry waits for its round). */
  runAllJobs(limit?: number): Promise<number>;
  /** A patient of the organization with these contact data. */
  patient(contact?: {
    email?: string | null;
    phone?: string | null;
    givenNames?: string;
  }): Promise<string>;
  /** Books an appointment for that patient on a Monday of the scheduling world. */
  book(
    patientId: string,
    weeksAfter?: number,
    time?: string,
  ): Promise<{ id: string; startsAt: string; version: number }>;
  /** Queues a message the way the planner does and returns its id. */
  queue(input: Partial<QueueMessageInput> & Pick<QueueMessageInput, 'patientId'>): Promise<string>;
  message(id: string): Promise<MessageRow>;
  messagesOf(appointmentId: string): Promise<MessageRow[]>;
  attemptsOf(
    messageId: string,
  ): Promise<{ attemptNo: number; outcome: string; reason: string | null }[]>;
  worklistKinds(appointmentId: string): Promise<string[]>;
  /** Sets the lifecycle of the organization (read-only, demo...). */
  setTenant(patch: { status: 'active' | 'read_only' }): Promise<void>;
}

/**
 * The messaging jobs wired to the scheduling world with doubles for the providers: a scripted
 * email sender, the in-memory WhatsApp fake, a recording job client and a clock of their own.
 */
export function createNotificationsWorld(
  world: SchedulingHttpWorld,
  options: { jobs?: RecordingJobClient; whatsapp?: WhatsAppSender } = {},
): NotificationsWorld {
  let current = new Date('2031-05-06T12:00:00.000Z');
  const jobs = options.jobs ?? createRecordingJobClient();
  const email = createScriptedEmail();
  const demoEmail = createFakeEmailSender();
  const whatsapp = options.whatsapp ?? createFakeWhatsAppSender();
  const demoWhatsapp = createFakeWhatsAppSender();
  const clock = () => current;
  const deps: MessagingDeps = {
    withTenant: createWithTenant(world.runtime.db),
    channels: {
      email: (tenant) => (tenant.isDemo ? demoEmail : email),
      whatsapp: (tenant) => (tenant.isDemo ? demoWhatsapp : whatsapp),
    },
    jobs,
    clock,
    origins: createPublicOrigins({ mode: 'multi', baseDomain: BASE_DOMAIN }, { secure: true }),
    tokens: createActionTokens({ clock }),
    worklist: createWorklist({ keys: world.keys }),
    keys: world.keys,
  };
  const definitions = createNotificationJobs(deps).all;

  const patient: NotificationsWorld['patient'] = (contact = {}) =>
    world.inTenant(async (tx) => {
      const result = await tx.execute<{ id: string }>(
        sql`INSERT INTO patient (tenant_id, family_name, given_names, birth_date, email, phone)
              VALUES (${world.tenant.id}, 'Prueba', ${contact.givenNames ?? 'Ana María'}, '1990-01-01',
                      ${contact.email === undefined ? 'ana@example.test' : contact.email},
                      ${contact.phone ?? null})
              RETURNING id`,
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error('patient insert returned no id');
      return id;
    });

  return {
    world,
    deps,
    jobs,
    email,
    demoEmail,
    whatsapp,
    demoWhatsapp,
    now: () => current,
    setNow: (date) => {
      current = date;
    },
    runJobs: () => runPending(world.runtime.db, jobs, definitions),
    async runAllJobs(limit = 10) {
      let rounds = 0;
      while (rounds < limit && jobs.jobs.some((job) => !job.done)) {
        await runPending(world.runtime.db, jobs, definitions);
        rounds += 1;
      }
      return rounds;
    },
    patient,
    async book(patientId, weeksAfter = 1, time = '10:00') {
      const booked = await world.book(weeksAfter, time, { patientId });
      return { id: booked.id, startsAt: booked.startsAt, version: booked.version };
    },
    queue: (input) =>
      world.inTenant(async (tx) => {
        const queued = await queueMessage(deps, tx, {
          kind: 'reminder',
          channel: 'email',
          appointmentId: null,
          professionalId: null,
          plannedStartsAt: null,
          appointmentVersion: null,
          sendAt: current,
          dedupeKey: `test:${Math.random().toString(36).slice(2)}:email`,
          ...input,
        });
        return queued.id;
      }),
    async message(id) {
      const [row] = await world.inTenant((tx) =>
        tx.select().from(message).where(eq(message.id, id)),
      );
      if (!row) throw new Error(`no message ${id}`);
      return row;
    },
    messagesOf: (appointmentId) =>
      world.inTenant((tx) =>
        tx
          .select()
          .from(message)
          .where(eq(message.appointmentId, appointmentId))
          .orderBy(message.createdAt, message.dedupeKey),
      ),
    attemptsOf: (messageId) =>
      world.inTenant((tx) =>
        tx
          .select({
            attemptNo: messageAttempt.attemptNo,
            outcome: messageAttempt.outcome,
            reason: messageAttempt.reason,
          })
          .from(messageAttempt)
          .where(eq(messageAttempt.messageId, messageId))
          .orderBy(messageAttempt.attemptNo),
      ),
    async worklistKinds(appointmentId) {
      const rows = await world.inTenant((tx) =>
        tx
          .select({ kind: worklistItem.kind })
          .from(worklistItem)
          .where(and(eq(worklistItem.subjectId, appointmentId), eq(worklistItem.status, 'open'))),
      );
      return rows.map((row) => row.kind).sort();
    },
    async setTenant(patch) {
      await world.inTenant(async (tx) => {
        if (patch.status === 'read_only') {
          await tx.execute(
            sql`UPDATE tenant SET status = 'read_only', read_only_since = now() WHERE id = ${world.tenant.id}`,
          );
        } else {
          await tx.execute(
            sql`UPDATE tenant SET status = 'active', read_only_since = NULL WHERE id = ${world.tenant.id}`,
          );
        }
      });
    },
  };
}
