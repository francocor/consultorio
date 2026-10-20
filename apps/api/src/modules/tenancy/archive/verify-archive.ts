import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { type z } from 'zod';

import {
  SYSTEM_USER_ID,
  type RequestContext,
  type WithTenant,
} from '../../../platform/db/tenant-context.js';
import { JobPayload } from '../../../platform/jobs/boss.js';
import {
  defineJob,
  type JobDefinition,
  type WorkerLog,
} from '../../../platform/jobs/define-job.js';

import {
  findArchive,
  recordVerification,
  writeArchiveAudit,
  type VerifyStatus,
} from './archive-state.js';
import { parseManifest, type ArchiveManifest } from './manifest.js';
import type { ArchiveStore } from './ports.js';

/**
 * `archive.verify` (tenancy, "Retention archive after cancellation"): the archive of an organization
 * is read back from the store and compared with its manifest, object by object. It finds:
 *
 * - `missing`: an object the manifest names is not there;
 * - `corrupted`: an object is there with other bytes than the ones that were stored (bit rot, a
 *   damaged copy), or the manifest itself is not the one that was recorded;
 * - `overwritten`: the key holds more than one version, so something wrote under it behind the
 *   store's back (the original is untouched and is what is served: see the local adapter).
 *
 * The worker that runs it cannot decrypt anything, so this checks the stored bytes. That the bytes
 * DO open (a test restore) is `restore.ts`, which needs the key of the releaser: it runs in the
 * releaser's own checks and in the restore drill, never here.
 */

export const ARCHIVE_VERIFY_JOB = 'archive.verify';

const Payload = JobPayload.extend({});
export type ArchiveVerifyPayload = z.infer<typeof Payload>;

const STORE_TIMEOUT_MS = 120_000;

export interface ArchiveVerifyDeps {
  withTenant: WithTenant;
  store: ArchiveStore;
  clock: () => Date;
  log?: WorkerLog;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** What a read of one object found. */
type Finding = 'ok' | 'missing' | 'corrupted' | 'overwritten' | 'unavailable';

async function check(
  store: ArchiveStore,
  expected: { name: string; sha256: string; bytes: number },
): Promise<Finding> {
  const got = await store.get(expected.name, AbortSignal.timeout(STORE_TIMEOUT_MS));
  if (got.status === 'retryable') return 'unavailable';
  if (got.status === 'unknown') return 'missing';
  if (
    got.body.byteLength !== expected.bytes ||
    sha256(got.body) !== expected.sha256 ||
    got.object.sha256 !== expected.sha256
  ) {
    return 'corrupted';
  }
  return got.object.versions > 1 ? 'overwritten' : 'ok';
}

const ORDER: readonly VerifyStatus[] = ['missing', 'corrupted', 'overwritten', 'ok'];

function worst(findings: readonly Finding[]): VerifyStatus {
  for (const status of ORDER) if (findings.includes(status)) return status;
  return 'ok';
}

export function createArchiveVerifyJob(
  deps: ArchiveVerifyDeps,
): JobDefinition<ArchiveVerifyPayload> {
  return defineJob({
    name: ARCHIVE_VERIFY_JOB,
    category: 'export',
    payload: Payload,
    handler: async ({ tx, tenantId }) => {
      const lock = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${`archive-verify:${tenantId}`}, 0)) as locked`,
      );
      if (lock.rows[0]?.locked !== true) return;

      const system: RequestContext = { tenantId, userId: SYSTEM_USER_ID };
      const archive = await deps.withTenant(system, findArchive);
      if (archive?.status !== 'written' || !archive.manifestKey || !archive.manifestSha256) return;

      const findings: Finding[] = [];
      // The manifest first: it is what says what the rest should be.
      const raw = await deps.store.get(archive.manifestKey, AbortSignal.timeout(STORE_TIMEOUT_MS));
      if (raw.status === 'retryable') {
        // The store being down proves nothing about the archive: the queue tries again.
        throw new Error('the archive store is not available');
      }
      let manifest: ArchiveManifest | null = null;
      if (raw.status === 'found' && sha256(raw.body) === archive.manifestSha256) {
        try {
          manifest = parseManifest(raw.body);
        } catch {
          manifest = null;
        }
      }
      if (!manifest) {
        findings.push(raw.status === 'unknown' ? 'missing' : 'corrupted');
      } else {
        if (raw.status === 'found' && raw.object.versions > 1) findings.push('overwritten');
        for (const part of manifest.parts) {
          for (const object of part.objects) {
            const finding = await check(deps.store, {
              name: object.name,
              sha256: object.sealedSha256,
              bytes: object.sealedBytes,
            });
            if (finding === 'unavailable') throw new Error('the archive store is not available');
            findings.push(finding);
          }
        }
      }

      const status = worst(findings);
      const problems = findings.filter((finding) => finding !== 'ok').length;
      const at = deps.clock();
      await deps.withTenant(system, async (inner) => {
        await recordVerification(inner, archive.id, { status, problems, at });
        await writeArchiveAudit(inner, {
          action: 'archive.verified',
          resourceType: 'tenant_archive',
          resourceId: archive.id,
          metadata: { status, problems, objects: findings.length },
        });
      });
      if (status !== 'ok') {
        deps.log?.error(
          { job: ARCHIVE_VERIFY_JOB, status, problems },
          'the archive of an organization did not verify',
        );
      }
    },
  });
}
