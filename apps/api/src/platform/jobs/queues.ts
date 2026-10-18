import type { PgBoss } from 'pg-boss';

/** PostgreSQL schema that holds the pg-boss tables. */
export const JOBS_SCHEMA = 'pgboss';

export type QueueOptions = NonNullable<Parameters<PgBoss['createQueue']>[1]>;

export interface QueueDefinition {
  name: string;
  options?: QueueOptions;
}

/**
 * The queues the application uses (design section 7, "Jobs"). pg-boss needs every queue to exist
 * before a job is sent to it, so the installer (`installJobs`, run by `db:migrate` as the owner)
 * creates them. A slice that adds a job adds its queue here.
 */
export const QUEUES: readonly QueueDefinition[] = [
  // Seals new audit events into the hash chain, one job per tenant every few seconds.
  { name: 'audit.seal', options: { retryLimit: 2, retryDelay: 5, expireInSeconds: 120 } },
  // Nightly re-walk of every tenant's chain.
  { name: 'audit.verify', options: { retryLimit: 1, retryDelay: 60, expireInSeconds: 1800 } },
  // Ends the slot holds that ran out, one job per tenant every minute (scheduling).
  { name: 'hold.expire', options: { retryLimit: 1, retryDelay: 30, expireInSeconds: 120 } },
  // Scans an uploaded document (sniff, hash, malware scan). A scanner that cannot be reached is not
  // a failure of the job: the job queues itself again with a delay, so the document stays
  // quarantined until it has really been scanned.
  { name: 'document.scan', options: { retryLimit: 3, retryDelay: 60, expireInSeconds: 600 } },
  // Marks uploads nobody confirmed as abandoned and removes their orphan objects.
  { name: 'document.cleanup', options: { retryLimit: 1, retryDelay: 300, expireInSeconds: 600 } },

  // Stage 3, patient engagement. The owning track writes the handler; the queue exists from the
  // seam on, so no track edits this file. Each is classified in `read-only/jobs.ts`.
  // Plans the reminders of an appointment after a booking, move or cancellation.
  { name: 'reminder.plan', options: { retryLimit: 2, retryDelay: 30, expireInSeconds: 300 } },
  // Sends one reminder or confirmation. Retries are chosen by the handler, which never sends past
  // the appointment start, so the queue allows a few quick redeliveries only.
  { name: 'reminder.send', options: { retryLimit: 3, retryDelay: 60, expireInSeconds: 300 } },
  // Hourly: opens a worklist item for appointments whose patient cannot be reached.
  { name: 'reminder.sweep', options: { retryLimit: 1, retryDelay: 120, expireInSeconds: 900 } },
  // Sends a one-time code by email (public booking, waitlist join, portal).
  { name: 'otp.send', options: { retryLimit: 3, retryDelay: 15, expireInSeconds: 120 } },
  // Hourly: deletes the unverified online-booking submissions older than 24 hours.
  { name: 'booking.purge', options: { retryLimit: 1, retryDelay: 300, expireInSeconds: 900 } },
  { name: 'tokens.purge', options: { retryLimit: 1, retryDelay: 300, expireInSeconds: 900 } },
  // A slot was freed: finds the waiting entries that match it.
  { name: 'waitlist.match', options: { retryLimit: 2, retryDelay: 15, expireInSeconds: 120 } },
  // Delivers one waitlist offer.
  { name: 'waitlist.offer', options: { retryLimit: 2, retryDelay: 15, expireInSeconds: 120 } },
  // Closes the offers whose time ran out and offers the slot to the next entry.
  { name: 'waitlist.expire', options: { retryLimit: 1, retryDelay: 30, expireInSeconds: 120 } },
  // Creates (or rotates) the video room of a virtual appointment.
  { name: 'video.link.create', options: { retryLimit: 3, retryDelay: 30, expireInSeconds: 300 } },
];
