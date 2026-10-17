import { createHash } from 'node:crypto';

import { DOCUMENT_MAX_BYTES, type DocumentRejectionReason } from '@consultorio/contracts';
import { and, asc, eq, ne } from 'drizzle-orm';
import { z } from 'zod';

import { document, type DocumentRow } from '../../../db/schema/documents.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { readCapped } from '../../../platform/files/read-capped.js';
import { sniffFile, type SniffRejection } from '../../../platform/files/sniff.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import { defineJob, type JobContext } from '../../../platform/jobs/define-job.js';
import {
  ScannerUnavailableError,
  type MalwareScanner,
} from '../../../platform/scanning/malware-scanner.js';
import {
  ObjectChangedError,
  tenantKey,
  type ObjectStorage,
} from '../../../platform/storage/object-storage.js';
import { isOverdue, scanBackoffSeconds } from '../domain/scan-schedule.js';

import { SCAN_JOB } from './uploads.js';

/** The system acts: no user, no role, no address. */
const SYSTEM_ACTOR: AuditActor = {
  userId: null,
  actingRole: null,
  ip: null,
  userAgent: null,
  requestId: null,
};

/** What the uploader is told when a file is refused. */
export interface RejectionNotice {
  tenantId: string;
  documentId: string;
  uploaderUserId: string;
  reason: DocumentRejectionReason;
  rejectedAt: Date;
}

/** Raised for a document that has waited more than an hour for a scan that cannot be done. */
export interface ScanAlert {
  kind: 'document_scan_overdue';
  tenantId: string;
  documentId: string;
  attempts: number;
  waitingMinutes: number;
}

export interface ScanJobDeps {
  storage: ObjectStorage;
  scanner: MalwareScanner;
  /** To queue the next attempt when the scanner cannot be reached. */
  jobs: JobClient;
  clock: () => Date;
  /** Tells the uploader a file was refused. Best effort: a failure here never changes the outcome. */
  notifyRejected?: ((tx: Tx, notice: RejectionNotice) => Promise<void>) | undefined;
  alert?: ((alert: ScanAlert) => void) | undefined;
}

export const ScanPayload = z.looseObject({ tenantId: z.uuid(), documentId: z.uuid() });
export type ScanPayload = z.infer<typeof ScanPayload>;

function reasonFor(rejection: SniffRejection): DocumentRejectionReason {
  // A file that is two things at once, or damaged, is "corrupt"; the rest is simply not allowed.
  return rejection === 'polyglot' || rejection === 'corrupt' ? 'corrupt' : 'type_not_allowed';
}

/**
 * The scan of one document (design section 7, "Documents"). In order: read the object (capped),
 * decide its type from the bytes, compare with the declared type, hash it, then ask the malware
 * scanner. Every refusal before the scanner is final and cheap; the scanner is asked last.
 *
 * FAIL CLOSED: a scanner that cannot be reached leaves the document quarantined and queues another
 * attempt with a growing delay. Only a verdict releases a file. After an hour of waiting, an alert.
 */
export function createScanJob(deps: ScanJobDeps) {
  const { storage, scanner, clock } = deps;

  /** The object is under the quarantine key; a crash after the move left it under the docs key. */
  async function locate(tenantId: string, row: DocumentRow) {
    const docsKey = tenantKey(tenantId, 'docs', row.id);
    for (const key of [row.objectKey, docsKey]) {
      const stored = await storage.get(tenantId, key);
      if (stored) return { key, stored };
    }
    return null;
  }

  async function reject(
    tx: Tx,
    row: DocumentRow,
    tenantId: string,
    reason: DocumentRejectionReason,
    key: string | null,
  ): Promise<void> {
    const now = clock();
    await tx
      .update(document)
      .set({
        status: 'rejected',
        rejectionReason: reason,
        scanResult: reason === 'infected' ? 'infected' : 'rejected',
        scannedAt: now,
      })
      .where(eq(document.id, row.id));
    await audit(tx, {
      action: 'document.scanned',
      outcome: 'allow',
      actor: SYSTEM_ACTOR,
      resourceType: 'document',
      resourceId: row.id,
      patientId: row.patientId,
      metadata: { result: 'rejected', reason },
    });
    try {
      await deps.notifyRejected?.(tx, {
        tenantId,
        documentId: row.id,
        uploaderUserId: row.uploadedBy,
        reason,
        rejectedAt: now,
      });
    } catch {
      // The refusal stands whether or not the message went out; the list shows it anyway.
    }
    // Last, so a failure above leaves the object for the retry to find.
    if (key !== null) await storage.remove(tenantId, key);
  }

  async function scanOnce({ tx, tenantId, payload }: JobContext<ScanPayload>): Promise<void> {
    const [row] = await tx
      .select()
      .from(document)
      .where(eq(document.id, payload.documentId))
      .for('update');
    if (!row || row.status !== 'quarantined' || row.uploadCompletedAt === null) return;

    const located = await locate(tenantId, row);
    if (!located) return reject(tx, row, tenantId, 'corrupt', null);

    const read = await readCapped(located.stored.stream, DOCUMENT_MAX_BYTES);
    if (!read.ok) return reject(tx, row, tenantId, 'too_large', located.key);
    const bytes = read.bytes;

    const sniffed = sniffFile(bytes);
    if (!sniffed.ok) return reject(tx, row, tenantId, reasonFor(sniffed.reason), located.key);
    if (sniffed.type.mime !== row.declaredContentType) {
      return reject(tx, row, tenantId, 'type_mismatch', located.key);
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    let infected: boolean;
    try {
      infected = (await scanner.scan(bytes)).status === 'infected';
    } catch (error) {
      if (!(error instanceof ScannerUnavailableError)) throw error;
      return waitForScanner(tx, row, tenantId);
    }
    if (infected) return reject(tx, row, tenantId, 'infected', located.key);

    // Clean. Move the object out of quarantine, then record it; the move is idempotent, so a crash
    // between the two steps is finished by the next attempt. The uploader's link stays valid for
    // minutes, so the object could be swapped between the scan and the move: the move names the
    // exact object that was scanned (its etag) and is refused for any other.
    const releasedKey = tenantKey(tenantId, 'docs', row.id);
    if (located.key !== releasedKey) {
      let moved: boolean;
      try {
        moved = await storage.move(tenantId, located.key, releasedKey, {
          ifMatch: located.stored.etag,
        });
      } catch (error) {
        if (!(error instanceof ObjectChangedError)) throw error;
        moved = false;
      }
      // Replaced (or gone) since it was scanned: nothing was released. Look at what is there now.
      if (!moved) return scanAgain(tx, row, tenantId);
      // The released object is the one that was scanned: the hash is the proof.
      const released = await storage.get(tenantId, releasedKey);
      const releasedRead = released ? await readCapped(released.stream, DOCUMENT_MAX_BYTES) : null;
      if (
        !releasedRead?.ok ||
        createHash('sha256').update(releasedRead.bytes).digest('hex') !== sha256
      ) {
        return reject(tx, row, tenantId, 'corrupt', releasedKey);
      }
    }
    const [duplicate] = await tx
      .select({ id: document.id })
      .from(document)
      .where(
        and(
          eq(document.patientId, row.patientId),
          eq(document.sha256, sha256),
          eq(document.status, 'available'),
          ne(document.id, row.id),
        ),
      )
      .orderBy(asc(document.createdAt))
      .limit(1);
    await tx
      .update(document)
      .set({
        status: 'available',
        objectKey: releasedKey,
        contentType: sniffed.type.mime,
        sha256,
        scanResult: 'clean',
        scannedAt: clock(),
        duplicateOfId: duplicate?.id ?? null,
      })
      .where(eq(document.id, row.id));
    await audit(tx, {
      action: 'document.scanned',
      outcome: 'allow',
      actor: SYSTEM_ACTOR,
      resourceType: 'document',
      resourceId: row.id,
      patientId: row.patientId,
      metadata: { result: 'clean' },
    });
  }

  /** The object changed after it was scanned: stay quarantined and scan what is there now. */
  async function scanAgain(tx: Tx, row: DocumentRow, tenantId: string): Promise<void> {
    await deps.jobs.enqueue(tx, SCAN_JOB, { tenantId, documentId: row.id }, { startAfter: 5 });
  }

  /** The scanner did not answer: stay quarantined, try again later, raise the alarm if it drags on. */
  async function waitForScanner(tx: Tx, row: DocumentRow, tenantId: string): Promise<void> {
    const now = clock();
    const attempts = row.scanAttempts + 1;
    await tx
      .update(document)
      .set({ scanAttempts: attempts, lastScanErrorAt: now })
      .where(eq(document.id, row.id));
    if (row.uploadCompletedAt && isOverdue(row.uploadCompletedAt, now)) {
      deps.alert?.({
        kind: 'document_scan_overdue',
        tenantId,
        documentId: row.id,
        attempts,
        waitingMinutes: Math.floor((now.getTime() - row.uploadCompletedAt.getTime()) / 60_000),
      });
    }
    await deps.jobs.enqueue(
      tx,
      SCAN_JOB,
      { tenantId, documentId: row.id },
      { startAfter: scanBackoffSeconds(attempts) },
    );
  }

  return defineJob({
    name: SCAN_JOB,
    // The scan is the safety check on a file the organization already holds, and it writes its audit
    // entry: stopping it for a read-only organization would leave accepted files in limbo.
    category: 'audit_write',
    payload: ScanPayload,
    handler: scanOnce,
  });
}
