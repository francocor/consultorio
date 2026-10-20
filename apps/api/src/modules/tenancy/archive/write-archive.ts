import { createHash } from 'node:crypto';
import { open, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { asc, eq, sql } from 'drizzle-orm';
import { type z } from 'zod';

import { membership } from '../../../db/schema/identity.js';
import { professional } from '../../../db/schema/staff.js';
import {
  SYSTEM_USER_ID,
  type RequestContext,
  type WithTenant,
} from '../../../platform/db/tenant-context.js';
import { uuidv7 } from '../../../platform/db/uuid.js';
import { JobPayload } from '../../../platform/jobs/boss.js';
import {
  defineJob,
  type JobDefinition,
  type WorkerLog,
} from '../../../platform/jobs/define-job.js';
import type { ObjectStorage } from '../../../platform/storage/object-storage.js';
import type { ExportRegistry } from '../application/export-registry.js';
import { readOrganizationName } from '../application/organization-name.js';
import { writePackageFile } from '../cancellation/package-file.js';

import { sealObject } from './archive-crypto.js';
import {
  beginArchive,
  cancellationFacts,
  findArchive,
  markArchiveFailed,
  markArchiveWritten,
  writeArchiveAudit,
} from './archive-state.js';
import type { ArchiveKeyWriter } from './keys.js';
import {
  manifestBytes,
  objectCount,
  type ArchiveManifest,
  type ManifestObject,
  type ManifestPart,
} from './manifest.js';
import type { ArchiveStore } from './ports.js';

/**
 * `archive.write` (tenancy, "Retention archive after cancellation"): once the export window has
 * passed, the records of a cancelled organization are copied into the write-once store, encrypted
 * with the archive key of the organization, and the organization gets its `archived_at`.
 *
 * What is archived is what the export is made of, with the same contributors and the same rules: the
 * administrative package, and the clinical package of EVERY professional the organization ever had,
 * the ones who left included (their patients' records have no one to hand them to, so the platform
 * keeps them in custody). Each package is written to a scratch file, then cut into segments, and each
 * segment is encrypted with a fresh data key and stored under its own name. A manifest closes the
 * archive.
 *
 * - **The hot rows stay.** Nothing here deletes a row of the organization; v1 keeps them in Postgres,
 *   read-only, and the archive is the custody copy.
 * - **A retry never mixes.** Every attempt writes into a folder of its own, so a segment stored by a
 *   failed attempt is an orphan that the manifest never names, and never a piece of another zip. (An
 *   object cannot be removed for the length of the retention; an orphan is the price of that, and a
 *   failed attempt is the exception.)
 * - **No transaction across the store.** The segments are sealed and stored with no transaction open;
 *   the framework's one stays idle, which is why this queue is in `CONNECTION_HOLDING_JOBS`.
 */

export const ARCHIVE_WRITE_JOB = 'archive.write';

const Payload = JobPayload.extend({});
export type ArchiveWritePayload = z.infer<typeof Payload>;

/** The size of a piece of a package before encryption. */
export const ARCHIVE_SEGMENT_BYTES = 8 * 1024 * 1024;
/** How long one call to the store may take before it is given up. */
const STORE_TIMEOUT_MS = 120_000;
/** How many times a segment is tried before the attempt is left to the queue. */
const SEGMENT_TRIES = 3;
/** How many times the queue redelivers `archive.write` (queues.ts): the last delivery gives up. */
const RETRY_LIMIT = 2;
const DAY_MS = 86_400_000;

export interface ArchiveWriteDeps {
  exports: ExportRegistry;
  withTenant: WithTenant;
  /** The bucket of the organization's own files (documents), whose copies go in the packages. */
  storage: ObjectStorage;
  /** The write-once store. */
  store: ArchiveStore;
  keys: ArchiveKeyWriter;
  clock: () => Date;
  /** How long an object is retained (`ARCHIVE_RETENTION_DAYS`). */
  retentionDays: number;
  /** Days after the cancellation before the archive is written (`ARCHIVE_AFTER_DAYS`). */
  afterDays: number;
  /** A piece of a package before encryption. Tests lower it to get several pieces from a small file. */
  segmentBytes?: number;
  workDir?: string;
  log?: WorkerLog;
}

interface PlannedPart {
  part: string;
  kind: 'administrative' | 'clinical';
  professionalId: string | null;
  professional: ManifestPart['professional'];
  context: RequestContext;
  professionalName: string | null;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The pad that keeps the names of the pieces in order. */
const pad = (index: number) => String(index).padStart(6, '0');

class StoreUnavailableError extends Error {
  constructor() {
    super('the archive store could not take the object');
    this.name = 'StoreUnavailableError';
  }
}

class ArchiveRefusedError extends Error {
  constructor(readonly code: string) {
    super(`the archive store refused: ${code}`);
    this.name = 'ArchiveRefusedError';
  }
}

export function createArchiveWriteJob(deps: ArchiveWriteDeps): JobDefinition<ArchiveWritePayload> {
  return defineJob({
    name: ARCHIVE_WRITE_JOB,
    category: 'export',
    payload: Payload,
    handler: async ({ tx, tenantId, job }) => {
      // One attempt at a time per organization, for as long as the transaction of this job lives.
      const lock = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${`archive:${tenantId}`}, 0)) as locked`,
      );
      if (lock.rows[0]?.locked !== true) return;

      const system: RequestContext = { tenantId, userId: SYSTEM_USER_ID };
      const now = deps.clock();
      const facts = await deps.withTenant(system, async (inner) => ({
        facts: await cancellationFacts(inner),
        archive: await findArchive(inner),
      }));
      // Only a cancelled organization is archived, once, and not before the export window is over.
      if (facts.facts?.status !== 'cancelled' || facts.facts.cancelledAt === null) return;
      if (facts.archive && facts.archive.status !== 'pending') return;
      const dueAt = facts.facts.cancelledAt.getTime() + deps.afterDays * DAY_MS;
      if (now.getTime() < dueAt) return;

      const key = await deps.keys.current(system);
      const archive = await deps.withTenant(system, (inner) =>
        beginArchive(inner, {
          keyVersion: key.version,
          retainUntil: new Date(now.getTime() + deps.retentionDays * DAY_MS),
        }),
      );
      const organizationName = await deps.withTenant(system, readOrganizationName);
      const parts = await deps.withTenant(system, (inner) => plan(inner, tenantId));

      const attemptId = uuidv7();
      try {
        const manifest = await writeAttempt(deps, {
          tenantId,
          archiveId: archive.archiveId,
          attemptId,
          keyVersion: archive.keyVersion,
          publicKey: key.publicKey,
          retainUntil: archive.retainUntil ?? new Date(now.getTime() + deps.retentionDays * DAY_MS),
          createdAt: archive.createdAt,
          organizationName,
          parts,
        });
        const stored = await storeManifest(deps, tenantId, archive.archiveId, attemptId, manifest);
        const bytesTotal =
          manifest.parts.reduce(
            (total, part) =>
              total + part.objects.reduce((sum, object) => sum + object.sealedBytes, 0),
            0,
          ) + stored.sizeBytes;
        await deps.withTenant(system, async (inner) => {
          const closed = await markArchiveWritten(inner, archive.id, {
            manifestKey: stored.key,
            manifestSha256: stored.sha256,
            objectsCount: objectCount(manifest),
            bytesTotal,
            at: deps.clock(),
          });
          if (!closed) return;
          await writeArchiveAudit(inner, {
            action: 'archive.written',
            resourceType: 'tenant_archive',
            resourceId: archive.id,
            metadata: {
              objects: objectCount(manifest),
              bytes: bytesTotal,
              parts: manifest.parts.length,
              keyVersion: archive.keyVersion,
            },
          });
        });
      } catch (error) {
        if (error instanceof ArchiveRefusedError) {
          await deps.withTenant(system, (inner) =>
            markArchiveFailed(inner, archive.id, error.code),
          );
        } else if (job.retryCount >= RETRY_LIMIT) {
          deps.log?.error({ job: ARCHIVE_WRITE_JOB }, 'the archive could not be written');
          await deps.withTenant(system, (inner) =>
            markArchiveFailed(inner, archive.id, 'write_failed'),
          );
        } else {
          throw error;
        }
      }
    },
  });
}

/** The parts of the archive: the administrative package, and one clinical package per professional ever. */
async function plan(
  tx: Parameters<typeof readOrganizationName>[0],
  tenantId: string,
): Promise<PlannedPart[]> {
  const professionals = await tx
    .select({
      id: professional.id,
      userId: membership.userId,
      name: membership.displayName,
      matricula: professional.matricula,
      matriculaJurisdiction: professional.matriculaJurisdiction,
      matriculaStatus: professional.matriculaStatus,
    })
    .from(professional)
    .innerJoin(membership, eq(membership.id, professional.membershipId))
    .orderBy(asc(professional.createdAt), asc(professional.id));
  return [
    {
      part: 'administrative',
      kind: 'administrative',
      professionalId: null,
      professional: null,
      context: { tenantId, userId: SYSTEM_USER_ID },
      professionalName: null,
    },
    ...professionals.map((entry): PlannedPart => ({
      part: `clinical-${entry.id}`,
      kind: 'clinical',
      professionalId: entry.id,
      professional: {
        matriculaJurisdiction: entry.matriculaJurisdiction,
        matricula: entry.matricula,
        matriculaStatus: entry.matriculaStatus,
      },
      // Acting as the professional, active or not: the clinical policies of the database decide
      // what they may read, and what they wrote is theirs.
      context: { tenantId, userId: entry.userId, actingProfessionalId: entry.id },
      professionalName: entry.name,
    })),
  ];
}

interface AttemptInput {
  tenantId: string;
  archiveId: string;
  attemptId: string;
  keyVersion: number;
  publicKey: Buffer;
  retainUntil: Date;
  createdAt: Date;
  organizationName: string;
  parts: readonly PlannedPart[];
}

async function writeAttempt(deps: ArchiveWriteDeps, input: AttemptInput): Promise<ArchiveManifest> {
  const written: ManifestPart[] = [];
  for (const part of input.parts) {
    const scratch = await mkdtemp(join(deps.workDir ?? tmpdir(), 'archive-write-'));
    try {
      const file = await writePackageFile(deps, {
        tenantId: input.tenantId,
        kind: part.kind,
        professionalId: part.professionalId ?? undefined,
        context: part.context,
        organizationName: input.organizationName,
        professionalName: part.professionalName,
        // The date of the files in the zip is the day the archive began, so a rebuilt package is the same bytes.
        now: input.createdAt,
        scratch,
      });
      const objects = await storePieces(deps, input, part, file.path);
      written.push({
        part: part.part,
        kind: part.kind,
        professionalId: part.professionalId,
        professional: part.professional,
        zipBytes: file.sizeBytes,
        zipSha256: file.sha256,
        objects,
      });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  return {
    format: 1,
    tenantId: input.tenantId,
    archiveId: input.archiveId,
    attemptId: input.attemptId,
    keyVersion: input.keyVersion,
    createdAt: input.createdAt.toISOString(),
    retainUntil: input.retainUntil.toISOString(),
    parts: written,
  };
}

/** Cuts a package into pieces, seals each one with the public key and stores it. */
async function storePieces(
  deps: ArchiveWriteDeps,
  input: AttemptInput,
  part: PlannedPart,
  path: string,
): Promise<ManifestObject[]> {
  const size = deps.segmentBytes ?? ARCHIVE_SEGMENT_BYTES;
  const objects: ManifestObject[] = [];
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(size);
    for (let index = 1; ; index += 1) {
      // A regular file returns fewer bytes than asked only at its end.
      const { bytesRead } = await handle.read(buffer, 0, size, (index - 1) * size);
      if (bytesRead === 0 && index > 1) break;
      const name = `tenants/${input.tenantId}/${input.archiveId}/${input.attemptId}/${part.part}/${pad(index)}.enc`;
      objects.push(await putPiece(deps, input, name, buffer.subarray(0, bytesRead)));
      if (bytesRead < size) break;
    }
  } finally {
    await handle.close();
  }
  return objects;
}

async function putPiece(
  deps: ArchiveWriteDeps,
  input: AttemptInput,
  name: string,
  plain: Buffer,
): Promise<ManifestObject> {
  const sealed = sealObject(Buffer.from(plain), input.publicKey, {
    tenantId: input.tenantId,
    name,
    keyVersion: input.keyVersion,
  });
  return storeSealed(deps, name, sealed, input.retainUntil, plain.length);
}

/**
 * Stores an object, looking first when a previous call left the outcome unknown: the object is ours
 * if it is there with the checksum of the bytes we hold, and is stored again only if it is not.
 */
async function storeSealed(
  deps: ArchiveWriteDeps,
  name: string,
  sealed: Uint8Array,
  retainUntil: Date,
  plainBytes: number,
): Promise<ManifestObject> {
  const digest = sha256(sealed);
  for (let attempt = 1; attempt <= SEGMENT_TRIES; attempt += 1) {
    const signal = AbortSignal.timeout(STORE_TIMEOUT_MS);
    const known = await deps.store
      .head(name, signal)
      .catch(() => ({ status: 'retryable' }) as const);
    if (known.status === 'found') {
      if (known.object.sha256 === digest) return describe(name, sealed, digest, plainBytes);
      throw new ArchiveRefusedError('object_exists_with_other_bytes');
    }
    const result = await deps.store
      .put(name, sealed, { sha256: digest, retainUntil }, signal)
      .catch(() => ({ status: 'retryable', outcomeUnknown: true, message: '' }) as const);
    if (result.status === 'stored' || result.status === 'already_stored') {
      return describe(name, sealed, digest, plainBytes);
    }
    if (result.status === 'locked') throw new ArchiveRefusedError('object_exists_with_other_bytes');
    if (result.status === 'rejected') throw new ArchiveRefusedError('store_rejected_object');
    // retryable: look again, with a pause that grows.
    await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
  }
  throw new StoreUnavailableError();
}

function describe(
  name: string,
  sealed: Uint8Array,
  digest: string,
  plainBytes: number,
): ManifestObject {
  return { name, sealedBytes: sealed.byteLength, sealedSha256: digest, plainBytes };
}

async function storeManifest(
  deps: ArchiveWriteDeps,
  tenantId: string,
  archiveId: string,
  attemptId: string,
  manifest: ArchiveManifest,
): Promise<{ key: string; sha256: string; sizeBytes: number }> {
  const key = `tenants/${tenantId}/${archiveId}/${attemptId}/manifest.json`;
  const bytes = manifestBytes(manifest);
  const stored = await storeSealed(
    deps,
    key,
    bytes,
    new Date(manifest.retainUntil),
    bytes.byteLength,
  );
  return { key, sha256: stored.sealedSha256, sizeBytes: bytes.byteLength };
}
