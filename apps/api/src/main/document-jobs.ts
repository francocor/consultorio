import { createRejectionNotifier } from '../modules/documents/application/rejection-email.js';
import { CLEANUP_JOB, createDocumentJobs } from '../modules/documents/index.js';
import { fanOut, type WorkerOptions } from '../platform/jobs/worker.js';
import type { EmailSender } from '../platform/mail/email-sender.js';
import type { MalwareScanner } from '../platform/scanning/malware-scanner.js';
import type { ObjectStorage } from '../platform/storage/object-storage.js';

export interface DocumentWorkerDeps {
  storage: ObjectStorage;
  scanner: MalwareScanner;
  /** Tells an uploader that a file was refused. */
  email: EmailSender;
}

/** How often every organization's abandoned uploads are looked at. */
const CLEANUP_EVERY_MS = 3_600_000;

/**
 * The documents module's part of the worker: the scan and cleanup jobs wired to the worker's queue
 * client, metrics and log, and the hourly tick that queues the cleanup of every organization. The
 * platform worker knows no module; the composition root hands it these.
 */
export function documentWorker(
  deps: DocumentWorkerDeps,
): Pick<WorkerOptions, 'jobs' | 'schedules'> {
  return {
    jobs: ({ client, metrics, log }) =>
      createDocumentJobs({
        storage: deps.storage,
        scanner: deps.scanner,
        jobs: client,
        clock: () => new Date(),
        notifyRejected: createRejectionNotifier({ email: deps.email }),
        alert: (alert) => {
          metrics.increment('document_scan_overdue_total', { tenant: alert.tenantId });
          log.error(
            {
              alert: alert.kind,
              tenant: alert.tenantId,
              document: alert.documentId,
              attempts: alert.attempts,
              waitingMinutes: alert.waitingMinutes,
            },
            'a document has waited more than an hour for its malware scan',
          );
        },
      }).all,
    schedules: ({ client, db }) => [
      {
        name: 'document.cleanup tick',
        intervalMs: CLEANUP_EVERY_MS,
        run: async () => {
          // One cleanup per organization and per hour at most, even with several workers.
          await fanOut(db, client, CLEANUP_JOB, { singletonSeconds: 3000 });
        },
      },
    ],
  };
}
