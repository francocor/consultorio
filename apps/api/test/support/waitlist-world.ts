import type { AppointmentDto, WaitlistEntryDto } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';

import { createFakeEmailSender } from '../../src/adapters/fake-email/index.js';
import { createSchedulingPorts } from '../../src/modules/scheduling/index.js';
import {
  createWaitlistJobs,
  type DeliverWaitlistOffer,
  type WaitlistOfferDelivery,
  type WaitlistJobs,
} from '../../src/modules/waitlist/index.js';
import {
  createAppointmentEvents,
  type AppointmentEvents,
} from '../../src/platform/events/appointment-events.js';
import { createPublicOrigins } from '../../src/platform/http/public-origin.js';
import type { JobDefinition, JobRunResult } from '../../src/platform/jobs/define-job.js';
import { createActionTokens } from '../../src/platform/tokens/index.js';

import { BASE_DOMAIN, hostOf } from './app.js';
import { createRecordingJobClient, runPending, type RecordingJobClient } from './jobs.js';
import { createSchedulingHttpWorld, type SchedulingHttpWorld } from './scheduling-world.js';
import { insertPatient } from './scheduling.js';
import type { TestSession } from './session.js';

export interface DeliveredOffer extends WaitlistOfferDelivery {
  /** The path of the link, without the origin. */
  token: string;
}

export interface WaitlistWorld extends Omit<SchedulingHttpWorld, 'setNow'> {
  jobs: RecordingJobClient;
  events: AppointmentEvents;
  /** The jobs of the module, built with the fakes of this world. */
  jobDefinitions: WaitlistJobs;
  /** What the (fake) delivery of offers received, in order. */
  deliveries: DeliveredOffer[];
  /** What the fake delivery answers next: set it to see the module react to `none`. */
  deliveryChannel: { current: 'email' | 'whatsapp' | 'none' };
  /** Makes the fake delivery throw, to see a retry. */
  deliveryFails: { current: boolean };
  /**
   * Moves the clock of the whole application (scheduling, waitlist, sessions). Staff sessions end
   * after 30 idle minutes, so a long move signs the members in again, as people would.
   */
  advance(ms: number): Promise<void>;
  setNow(date: Date): Promise<void>;
  /** A patient with an email address and a mobile number. */
  patient(options?: { email?: boolean; phone?: boolean }): Promise<string>;
  /** Reception puts a patient on the waitlist for the Consulta type, the way the screen does. */
  join(patientId: string, extra?: Record<string, unknown>): Promise<WaitlistEntryDto>;
  /** Runs the pending jobs of the given waitlist queues, the way the worker would. */
  run(...queues: string[]): Promise<{ name: string; result: JobRunResult }[]>;
  /** Cancels an appointment as reception does for a patient who called. */
  cancel(appointment: AppointmentDto, by?: TestSession): Promise<void>;
  /** Closes every entry and offer, forgets the jobs and deliveries and sets the clock back. */
  reset(): Promise<void>;
  /** The state of an entry, read straight from the database. */
  entryRow(id: string): Promise<Record<string, unknown>>;
  /** The offers of an entry, oldest first, read straight from the database. */
  offersOf(entryId: string): Promise<Record<string, unknown>[]>;
  /** The slots shown for calling, for an entry. */
  callsOf(entryId: string): Promise<Record<string, unknown>[]>;
  /** The token of the offer link that was delivered for an offer. */
  tokenOf(offerId: string): string;
  /** A visitor presses a button of the page behind an offer link (`accept` or `decline`). */
  press(token: string, choice: 'accept' | 'decline'): Promise<LightMyRequestResponse>;
}

let patients = 0;
let presses = 0;

/**
 * The scheduling world with the waitlist wired the way production wires it, except for what leaves
 * the process: the jobs go to a recording client the test runs by hand, and the delivery of offers
 * is a fake that remembers what it was given (the real one is the notifications module's).
 */
export async function createWaitlistWorld(
  runtime: Parameters<typeof createSchedulingHttpWorld>[0],
  options: { slug: string; now?: Date },
): Promise<WaitlistWorld> {
  const initial = options.now ?? new Date('2031-05-05T12:00:00.000Z');
  let current = initial;
  const jobs = createRecordingJobClient();
  const events = createAppointmentEvents();
  const email = createFakeEmailSender();
  const base = await createSchedulingHttpWorld(runtime, {
    slug: options.slug,
    now: current,
    app: { clock: () => current, jobs, appointmentEvents: events, email },
  });

  const deliveries: DeliveredOffer[] = [];
  const deliveryChannel: WaitlistWorld['deliveryChannel'] = { current: 'email' };
  const deliveryFails = { current: false };
  const deliver: DeliverWaitlistOffer = (_tx, input) => {
    if (deliveryFails.current) return Promise.reject(new Error('the provider is down'));
    const token = input.offerTokenUrl.split('/public/t/')[1] ?? '';
    deliveries.push({ ...input, token });
    return Promise.resolve({
      channel: deliveryChannel.current,
      messageId: deliveryChannel.current === 'none' ? null : `message-${String(deliveries.length)}`,
    });
  };

  const jobDefinitions = createWaitlistJobs({
    portsOf: (tx) => createSchedulingPorts(tx, { keys: base.keys, events }),
    jobs,
    clock: () => current,
    tokens: createActionTokens({ clock: () => current }),
    origins: createPublicOrigins({ mode: 'multi', baseDomain: BASE_DOMAIN }, { secure: true }),
    deliver,
  });

  // The members stay signed in across the jumps the tests make: a long jump signs them in again.
  const members = [base.owner, base.admin, base.reception, base.doctor, base.colleague];
  let signedInAt = current;
  const moveTo = async (date: Date) => {
    const jump = Math.abs(date.getTime() - signedInAt.getTime());
    current = date;
    base.setNow(date);
    if (jump < 20 * 60_000) return;
    for (const member of members) member.cookie = (await base.signIn(member.user)).cookie;
    signedInAt = date;
  };

  const entryRow = (id: string) =>
    base.inTenant(async (tx) => {
      const rows = (await tx.execute(sql`SELECT * FROM waitlist_entry WHERE id = ${id}`)).rows;
      const row = rows[0];
      if (!row) throw new Error(`no entry ${id}`);
      return row;
    });

  return {
    ...base,
    jobs,
    events,
    jobDefinitions,
    deliveries,
    deliveryChannel,
    deliveryFails,
    setNow: moveTo,
    now: () => current,
    advance: (ms) => moveTo(new Date(current.getTime() + ms)),
    patient: async (patientOptions = {}) => {
      patients += 1;
      return base.inTenant(async (tx) => {
        const id = await insertPatient(tx, base.tenant.id);
        await tx.execute(
          sql`UPDATE patient SET email = ${patientOptions.email === false ? null : `espera${String(patients)}@example.test`},
                phone = ${patientOptions.phone === false ? null : '+54 11 5555 0000'} WHERE id = ${id}`,
        );
        return id;
      });
    },
    join: async (patientId, extra = {}) => {
      const response = await base.api.post('/waitlist', base.reception, {
        patientId,
        appointmentTypeId: base.consulta,
        offersOptIn: true,
        ...extra,
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json<WaitlistEntryDto>();
    },
    run: (...queues) =>
      runPending(
        runtime.db,
        jobs,
        Object.values(jobDefinitions).filter((definition: JobDefinition) =>
          queues.includes(definition.name),
        ),
      ),
    cancel: async (appointment, by = base.reception) => {
      const response = await base.act(appointment, 'cancel', by, {
        cancelledBy: 'patient',
        reasonCode: 'patient_request',
      });
      expect(response.statusCode, response.body).toBe(200);
    },
    reset: async () => {
      await base.inTenant(async (tx) => {
        await tx.execute(
          sql`UPDATE waitlist_offer SET status = 'invalidated', end_reason = 'entry_closed', closed_at = now() WHERE status = 'open'`,
        );
        await tx.execute(
          sql`UPDATE waitlist_entry SET status = 'closed', close_reason = 'cancelled', closed_at = now() WHERE status <> 'closed'`,
        );
      });
      // Back to midday: where the clock stopped decides whether an offer falls in quiet hours.
      await moveTo(initial);
      jobs.jobs.length = 0;
      deliveries.length = 0;
      deliveryChannel.current = 'email';
      deliveryFails.current = false;
    },
    entryRow,
    offersOf: (entryId) =>
      base.inTenant(
        async (tx) =>
          (
            await tx.execute(
              sql`SELECT * FROM waitlist_offer WHERE entry_id = ${entryId} ORDER BY created_at, id`,
            )
          ).rows,
      ),
    callsOf: (entryId) =>
      base.inTenant(
        async (tx) =>
          (
            await tx.execute(
              sql`SELECT * FROM waitlist_call WHERE entry_id = ${entryId} ORDER BY starts_at, id`,
            )
          ).rows,
      ),
    press: (token, choice) => {
      presses += 1;
      return base.app.inject({
        method: 'POST',
        url: `/public/t/${token}`,
        headers: {
          host: hostOf(options.slug),
          origin: `https://${hostOf(options.slug)}`,
          'user-agent': 'vitest-visitor',
          'content-type': 'application/x-www-form-urlencoded',
        },
        remoteAddress: `10.77.${String(Math.floor(presses / 250))}.${String(presses % 250)}`,
        payload: `choice=${choice}`,
      });
    },
    tokenOf: (offerId) => {
      const delivered = deliveries.find((entry) => entry.offerId === offerId);
      if (!delivered) throw new Error(`offer ${offerId} was not delivered`);
      return delivered.token;
    },
  };
}
