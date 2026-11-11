import { defineJob } from '../../../platform/jobs/define-job.js';

import { callProvider, completeDelivery, prepareDelivery } from './delivery.js';
import type { MessagingDeps } from './deps.js';
import { REMINDER_SEND_JOB, SendPayload } from './queue.js';
import { createReminderSweepJob, REMINDER_SWEEP_JOB } from './sweep.js';

/**
 * `reminder.send`: delivers one queued message (a reminder, a confirmation, a fallback or a
 * resend). A write job: for a read-only organization the platform cancels it before it runs. The
 * handler still re-checks the organization, because the message must end `cancelled` with its
 * reason, never silently stay queued (see `delivery.ts`).
 */
export function createReminderSendJob(deps: MessagingDeps) {
  return defineJob({
    name: REMINDER_SEND_JOB,
    category: 'write',
    payload: SendPayload,
    handler: async ({ tx, tenantId, payload }) => {
      const prepared = await prepareDelivery(deps, tenantId, payload.messageId);
      if (prepared.kind !== 'send') return;
      const result = await callProvider(prepared.send);
      await completeDelivery(deps, tx, prepared.send, result);
    },
  });
}

/** The background jobs of the notifications module. Only the worker registers them. */
export function createNotificationJobs(deps: MessagingDeps) {
  const reminderSend = createReminderSendJob(deps);
  const reminderSweep = createReminderSweepJob(deps);
  return { reminderSend, reminderSweep, all: [reminderSend, reminderSweep] as const };
}

export { REMINDER_SWEEP_JOB };

export type NotificationJobs = ReturnType<typeof createNotificationJobs>;
