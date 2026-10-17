import { createFakeScanner, type FakeScanner } from '../../src/adapters/fake-scanner/index.js';
import {
  createDocumentJobs,
  type DocumentJobs,
  type RejectionNotice,
  type ScanAlert,
} from '../../src/modules/documents/index.js';

import type { DocumentsHarness } from './documents.js';
import { runPending } from './jobs.js';

export interface ScanningHarness extends DocumentsHarness {
  scanner: FakeScanner;
  /** The jobs the worker would run, wired to this harness. */
  documentJobs: DocumentJobs;
  /** Rejections the uploader was told about, and the alerts a long outage raised. */
  notices: RejectionNotice[];
  alerts: ScanAlert[];
  /** Runs the scans that are pending now, the way the worker does. */
  runScans(): Promise<void>;
}

/** Adds the scan to a harness: a fake scanner you can switch off, and the document jobs. */
export function withScanning(harness: DocumentsHarness): ScanningHarness {
  const scanner = createFakeScanner();
  const notices: RejectionNotice[] = [];
  const alerts: ScanAlert[] = [];
  const documentJobs = createDocumentJobs({
    storage: harness.storage,
    scanner,
    jobs: harness.jobs,
    clock: () => new Date(),
    notifyRejected: (_tx, notice) => {
      notices.push(notice);
      return Promise.resolve();
    },
    alert: (alert) => {
      alerts.push(alert);
    },
  });
  return Object.assign(harness, {
    scanner,
    documentJobs,
    notices,
    alerts,
    async runScans() {
      await runPending(harness.runtime.db, harness.jobs, [documentJobs.scan]);
    },
  });
}
