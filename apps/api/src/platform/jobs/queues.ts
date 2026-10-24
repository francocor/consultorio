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

  // Stage 4, revenue. Same rule: the owning track writes the handler, the queue exists from the seam.
  // Submits one invoice to AFIP. The handler chooses its own backoff (1 minute to 6 hours) by
  // queuing itself again, so the queue allows only a quick redelivery. It is the one job that still
  // runs in a read-only tenant when it was queued before the freeze.
  { name: 'afip.issue', options: { retryLimit: 2, retryDelay: 30, expireInSeconds: 300 } },
  // Daily, per organization: warns the owner when the fiscal certificate has 30 days or fewer left.
  {
    name: 'fiscal.credential_watch',
    options: { retryLimit: 1, retryDelay: 300, expireInSeconds: 900 },
  },
  // Renders the PDF of an issued invoice (with its QR) and stores it.
  { name: 'invoice.pdf', options: { retryLimit: 3, retryDelay: 30, expireInSeconds: 300 } },
  // Emails an issued invoice to its recipient.
  { name: 'invoice.deliver', options: { retryLimit: 3, retryDelay: 60, expireInSeconds: 300 } },
  // Builds a CSV, xlsx or PDF export (billing exports and reports) and stores the result.
  { name: 'export.build', options: { retryLimit: 2, retryDelay: 30, expireInSeconds: 900 } },

  // Stage 5, compliance and portal. Same rule: the owning track writes the handler, the queue exists
  // from the seam.
  // Submits (or retries) a prescription the provider has not confirmed. The handler asks the
  // provider for the key before it issues, and chooses its own backoff by queuing itself again.
  { name: 'erx.submit', options: { retryLimit: 2, retryDelay: 30, expireInSeconds: 300 } },
  // Asks the provider where the prescriptions of an organization stand (dispensed, expired,
  // cancelled) and settles the ones whose answer was lost.
  { name: 'erx.reconcile', options: { retryLimit: 1, retryDelay: 60, expireInSeconds: 600 } },
  // Daily, per organization: closes the consent requests whose time ran out.
  { name: 'consent.expire', options: { retryLimit: 1, retryDelay: 300, expireInSeconds: 900 } },
  // Daily, per organization: suspends the representative links of the dependents who turned 18.
  {
    name: 'portal.majority_review',
    options: { retryLimit: 1, retryDelay: 300, expireInSeconds: 900 },
  },
  // Emails the sign-in code of the patient portal (track B, S5.07). It is not `otp.send`: signing in
  // to the portal is authentication, which a read-only organization keeps, while the code of the
  // public booking is a plain write that ends cancelled there.
  { name: 'portal.code_send', options: { retryLimit: 3, retryDelay: 15, expireInSeconds: 120 } },
  // Emails a warning about a change to the access of the portal that the staff made (an account moved
  // to another address, a representative given access to a minor). Queued in the transaction of the
  // change (JD-S5 R2-2). A person is protected whatever the state of the subscription.
  { name: 'portal.notice_send', options: { retryLimit: 5, retryDelay: 60, expireInSeconds: 120 } },
  // Every minute, per organization: tells the address a record HAD that its e-mail or birth date was
  // changed (the change is written by the database, in the transaction of the update).
  { name: 'portal.notice_sweep', options: { retryLimit: 1, retryDelay: 60, expireInSeconds: 300 } },
];
