import { createRejectionNotifier } from '../modules/documents/application/rejection-email.js';
import { createDocumentJobs } from '../modules/documents/index.js';
import type { WorkerOptions } from '../platform/jobs/worker.js';
import type { EmailSender } from '../platform/mail/email-sender.js';
import type { MalwareScanner } from '../platform/scanning/malware-scanner.js';
import type { ObjectStorage } from '../platform/storage/object-storage.js';

export interface DocumentWorkerDeps {
  storage: ObjectStorage;
  scanner: MalwareScanner;
  /** Tells an uploader that a file was refused. */
  email: EmailSender;
}

/**
 * The documents module's part of the worker: the scan job, wired to the worker's queue client,
 * metrics and log. The platform worker knows no module; the composition root hands it these.
 */
export function documentWorker(deps: DocumentWorkerDeps): Pick<WorkerOptions, 'jobs'> {
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
  };
}
