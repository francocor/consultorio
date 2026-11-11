import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { TenantArchiveRow } from '../../../db/schema/archive-key.js';
import {
  archiveReleaseRequest,
  type ArchiveReleaseRequestRow,
} from '../../../db/schema/archive-release.js';
import {
  SYSTEM_USER_ID,
  type RequestContext,
  type WithTenant,
} from '../../../platform/db/tenant-context.js';
import type { PublicOrigins } from '../../../platform/http/public-origin.js';
import { JobPayload } from '../../../platform/jobs/boss.js';
import {
  defineJob,
  type JobDefinition,
  type WorkerLog,
} from '../../../platform/jobs/define-job.js';
import type { EmailSender } from '../../../platform/mail/email-sender.js';
import { tenantKey, type ObjectStorage } from '../../../platform/storage/object-storage.js';
import type { ActionTokens } from '../../../platform/tokens/index.js';
import { readOrganizationName } from '../application/organization-name.js';
import { ownerRecipients, tenantSlug } from '../cancellation/packages.js';

import { findArchive, isUnderErased, partIsErased, writeReleaseAudit } from './archive-state.js';
import type { ArchiveKeyReleaser } from './keys.js';
import { parseManifest, type ArchiveManifest } from './manifest.js';
import type { ArchiveStore } from './ports.js';
import { contactNotice, requesterNotice } from './release-emails.js';
import {
  buildPatientPackage,
  findPatientId,
  findProfessionalPart,
  type BuiltPackage,
} from './release-package.js';
import { restoreParts, RestoreError } from './restore.js';

/**
 * `archive.release` (tenancy, "Tenant cancellation export"): carries out an APPROVED release request.
 * It runs only in the `releaser` process, the one that holds `ARCHIVE_RELEASER_KEK`: no other process
 * can open the private key of an organization, so no other process can read the archive.
 *
 * For each approved request it decrypts the scope (the part of the archive the requester is entitled
 * to), builds the package, stores it for the length of the link, issues a single-use link of 72 hours
 * and emails it to the address that was verified; it also tells the former contact of the organization
 * that records in custody were handed over. Every step is an entry of the platform trail, and the
 * operator, who approved the request, never sees anything of the package.
 *
 * - **Bounded.** An approval has a window (`expires_at`); after it the request expires instead of being
 *   carried out.
 * - **No transaction across the store.** The restore, the package and the upload run on no transaction;
 *   the one the framework holds for the job stays idle (it is a long job in its own process).
 * - **Idempotent.** A request that is not approved any more is left alone.
 * - **The row first, then the email** (JD-S6 R1-S6-8). The request is marked `released` before the link
 *   is emailed, so a link in a mailbox always belongs to a request that says so. If the email cannot be
 *   sent the release is undone: the link is revoked, the request goes to `failed` and the package is
 *   taken out of the bucket.
 * - **A failed or expired release leaves no package.** Whatever ended the release removes the package
 *   it may have stored (the sweep removes it later if that fails).
 * - **Erased is erased** (JD-S6 R1-S6-7). A scope that a legal erasure removed is answered `erased`.
 */

export const ARCHIVE_RELEASE_JOB = 'archive.release';

const Payload = JobPayload.extend({ requestId: z.uuid() });
export type ArchiveReleasePayload = z.infer<typeof Payload>;

/** How long the link lives (the token kind caps it at the same 72 hours). */
const LINK_HOURS = 72;
const RETRY_LIMIT = 1;
/** How many times the email is tried before the release is undone. */
const SEND_ATTEMPTS = 3;

/** Where the package of a request waits for its link: derived from the ids, never from the request. */
export function packageKeyOf(tenantId: string, requestId: string): string {
  return tenantKey(tenantId, 'archive-release', `${requestId}.zip`);
}

export interface ArchiveReleaseDeps {
  withTenant: WithTenant;
  store: ArchiveStore;
  /** The bucket of the organization's own files: the package waits there for its link. */
  storage: ObjectStorage;
  keys: ArchiveKeyReleaser;
  tokens: ActionTokens;
  email: EmailSender;
  origins: PublicOrigins;
  clock: () => Date;
  workDir?: string;
  log?: WorkerLog;
}

class ReleaseFailure extends Error {
  constructor(readonly code: string) {
    super(`The release could not be carried out (${code}).`);
    this.name = 'ReleaseFailure';
  }
}

export function createArchiveReleaseJob(
  deps: ArchiveReleaseDeps,
): JobDefinition<ArchiveReleasePayload> {
  return defineJob({
    name: ARCHIVE_RELEASE_JOB,
    category: 'export',
    payload: Payload,
    handler: async ({ tx, tenantId, payload, job }) => {
      const lock = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${`archive-release:${payload.requestId}`}, 0)) as locked`,
      );
      if (lock.rows[0]?.locked !== true) return;

      const system: RequestContext = { tenantId, userId: SYSTEM_USER_ID };
      const now = deps.clock();
      const request = await deps.withTenant(system, async (inner) => {
        const [row] = await inner
          .select()
          .from(archiveReleaseRequest)
          .where(eq(archiveReleaseRequest.id, payload.requestId));
        return row ?? null;
      });
      if (request?.status !== 'approved') return;

      const kind = request.requesterKind === 'professional' ? 'professional' : 'patient';
      if (request.expiresAt !== null && request.expiresAt.getTime() < now.getTime()) {
        await settle(deps, system, request, 'expired', null, 'expired');
        return;
      }

      try {
        await carryOut(deps, system, request, kind, now);
      } catch (error) {
        if (error instanceof ReleaseFailure) {
          await settle(deps, system, request, 'failed', error.code, 'failed');
        } else if (error instanceof RestoreError) {
          // The archive could not be put back together: a finding for the operator, not a retry.
          await settle(deps, system, request, 'failed', `restore_${error.code}`, 'failed');
        } else if (job.retryCount >= RETRY_LIMIT) {
          deps.log?.error({ job: ARCHIVE_RELEASE_JOB }, 'a release could not be carried out');
          await settle(deps, system, request, 'failed', 'release_failed', 'failed');
        } else {
          throw error;
        }
      }
    },
  });
}

/**
 * Takes the package of a request out of the bucket and records that it is gone. The object goes first
 * and the mark follows; if either fails the request keeps no `package_removed_at` and the sweep of the
 * releaser (`app.archive_release_cleanup_due`) does it later.
 */
export async function removePackage(
  deps: Pick<ArchiveReleaseDeps, 'withTenant' | 'storage' | 'clock'>,
  system: RequestContext,
  requestId: string,
): Promise<void> {
  await deps.storage.remove(system.tenantId, packageKeyOf(system.tenantId, requestId));
  await deps.withTenant(system, (inner) =>
    inner
      .update(archiveReleaseRequest)
      .set({ packageRemovedAt: deps.clock() })
      .where(eq(archiveReleaseRequest.id, requestId)),
  );
}

/**
 * Closes a request that will not be carried out, says so in the platform trail, and removes whatever
 * package an attempt may have stored before it failed (a failed or expired release leaves none).
 */
async function settle(
  deps: ArchiveReleaseDeps,
  system: RequestContext,
  request: ArchiveReleaseRequestRow,
  status: 'expired' | 'failed',
  code: string | null,
  phase: string,
): Promise<void> {
  await deps.withTenant(system, async (inner) => {
    await inner
      .update(archiveReleaseRequest)
      .set({ status, ...(code === null ? {} : { failureCode: code }) })
      .where(eq(archiveReleaseRequest.id, request.id));
    await writeReleaseAudit(inner, {
      action: 'archive.released',
      requestId: request.id,
      metadata: { phase, ...(code === null ? {} : { code }) },
    });
  });
  await removePackage(deps, system, request.id).catch(() => {
    deps.log?.error({ job: ARCHIVE_RELEASE_JOB }, 'could not take the package out of the bucket');
  });
}

async function carryOut(
  deps: ArchiveReleaseDeps,
  system: RequestContext,
  request: ArchiveReleaseRequestRow,
  kind: 'patient' | 'professional',
  now: Date,
): Promise<void> {
  const archive = await deps.withTenant(system, findArchive);
  if (archive?.status !== 'written' || !archive.manifestKey || !archive.manifestSha256) {
    throw new ReleaseFailure('no_archive');
  }
  // Erased is erased: say so, instead of failing to find what is gone.
  if (archive.erasedAt !== null || isUnderErased(archive, archive.manifestKey)) {
    throw new ReleaseFailure('erased');
  }
  const manifestObject = await deps.store.get(archive.manifestKey);
  if (manifestObject.status === 'retryable') throw new Error('the archive store is not available');
  if (
    manifestObject.status !== 'found' ||
    createHash('sha256').update(manifestObject.body).digest('hex') !== archive.manifestSha256
  ) {
    throw new ReleaseFailure('manifest_not_intact');
  }
  const manifest = parseManifest(manifestObject.body);

  // Opening the archive is an access, with the reason that was stated, in the platform trail.
  await deps.withTenant(system, (inner) =>
    writeReleaseAudit(inner, {
      action: 'archive.accessed',
      requestId: request.id,
      reason: request.reason,
      metadata: { phase: 'decrypt', requesterKind: kind },
    }),
  );
  const privateKey = await deps.withTenant(system, (inner) =>
    deps.keys.privateKey(inner, system.tenantId, manifest.keyVersion),
  );

  const scratch = await mkdtemp(join(deps.workDir ?? tmpdir(), 'archive-release-'));
  try {
    const built = await buildFor(deps, request, kind, archive, manifest, privateKey, scratch, now);
    // The private key of the organization is needed to decrypt and for nothing else: it does not
    // outlive the decryption in the memory of the releaser (JD-S6 R1-A-T8).
    privateKey.fill(0);
    const organizationName = await deps.withTenant(system, readOrganizationName);
    const slug = await deps.withTenant(system, tenantSlug);
    if (slug === null) throw new ReleaseFailure('organization_not_found');

    // The package waits in the bucket of the organization for the length of its link.
    const objectKey = packageKeyOf(system.tenantId, request.id);
    await deps.storage.put(system.tenantId, objectKey, {
      body: createReadStream(built.path),
      contentType: 'application/zip',
      contentLength: built.sizeBytes,
    });

    const issued = await deps.withTenant(system, async (inner) => {
      // A retry issues a new link: the one of the earlier run is revoked.
      await deps.tokens.revokeForSubject(inner, 'archive_release', request.id);
      return deps.tokens.issue(inner, {
        kind: 'archive_release',
        subjectId: request.id,
        ttlMs: LINK_HOURS * 3_600_000,
      });
    });

    // The row first: from here on a link in a mailbox belongs to a request that says it was released.
    await deps.withTenant(system, async (inner) => {
      await inner
        .update(archiveReleaseRequest)
        .set({
          status: 'released',
          releasedAt: now,
          packageKey: objectKey,
          packageSha256: built.sha256,
          packageBytes: built.sizeBytes,
          linkExpiresAt: issued.expiresAt,
        })
        .where(eq(archiveReleaseRequest.id, request.id));
      await writeReleaseAudit(inner, {
        action: 'archive.released',
        requestId: request.id,
        metadata: { phase: 'delivered', requesterKind: kind, bytes: built.sizeBytes },
      });
    });

    const notice = requesterNotice({
      organizationName,
      requesterKind: kind,
      link: `${deps.origins(slug)}/archive-release/${issued.token}`,
      linkExpiresAt: issued.expiresAt,
    });
    // The address that was verified out of band: the only place the link goes.
    const sent = await sendWithRetries(deps, () =>
      deps.email.send({
        to: request.requesterEmail,
        subject: notice.subject,
        text: notice.text,
        tenant: { id: system.tenantId, isDemo: false },
      }),
    );
    if (!sent) {
      await undoRelease(deps, system, request);
      return;
    }
    await markEmailed(deps, system, request.id);
    await tellTheFormerContact(deps, system, organizationName, kind, now);
  } finally {
    privateKey.fill(0);
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Records that the link reached the mail provider: from now on the sweep does not look for this request. */
async function markEmailed(
  deps: Pick<ArchiveReleaseDeps, 'withTenant' | 'clock'>,
  system: RequestContext,
  requestId: string,
): Promise<void> {
  await deps.withTenant(system, (inner) =>
    inner
      .update(archiveReleaseRequest)
      .set({ emailedAt: deps.clock() })
      .where(eq(archiveReleaseRequest.id, requestId)),
  );
}

/**
 * A request that was released and whose email was lost (the process died between the row and the
 * email, or the undo of a failed email did not complete): a new link is issued, because the token is
 * stored hashed and the first one cannot be sent again, and it is emailed to the verified address. The
 * old link is revoked first, so only the one in the new email works. If the email fails again the
 * request stays as it is for the next sweep (and the alert on unsent releases fires meanwhile).
 */
export async function redeliverRelease(
  deps: ArchiveReleaseDeps,
  system: RequestContext,
  requestId: string,
): Promise<boolean> {
  const request = await deps.withTenant(system, async (inner) => {
    const [row] = await inner
      .select()
      .from(archiveReleaseRequest)
      .where(eq(archiveReleaseRequest.id, requestId));
    return row ?? null;
  });
  const now = deps.clock();
  if (
    request?.status !== 'released' ||
    request.emailedAt !== null ||
    request.packageRemovedAt !== null ||
    request.linkExpiresAt === null ||
    request.linkExpiresAt.getTime() <= now.getTime()
  ) {
    return false;
  }
  const linkEnds = request.linkExpiresAt;
  const kind = request.requesterKind === 'professional' ? 'professional' : 'patient';
  const organizationName = await deps.withTenant(system, readOrganizationName);
  const slug = await deps.withTenant(system, tenantSlug);
  if (slug === null) return false;
  const issued = await deps.withTenant(system, async (inner) => {
    await deps.tokens.revokeForSubject(inner, 'archive_release', request.id);
    return deps.tokens.issue(inner, {
      kind: 'archive_release',
      subjectId: request.id,
      ttlMs: Math.max(linkEnds.getTime() - now.getTime(), 60_000),
    });
  });
  const notice = requesterNotice({
    organizationName,
    requesterKind: kind,
    link: `${deps.origins(slug)}/archive-release/${issued.token}`,
    linkExpiresAt: issued.expiresAt,
  });
  const sent = await sendWithRetries(deps, () =>
    deps.email.send({
      to: request.requesterEmail,
      subject: notice.subject,
      text: notice.text,
      tenant: { id: system.tenantId, isDemo: false },
    }),
  );
  if (!sent) return false;
  await markEmailed(deps, system, request.id);
  await deps.withTenant(system, (inner) =>
    writeReleaseAudit(inner, {
      action: 'archive.released',
      requestId: request.id,
      metadata: { phase: 'redelivered', requesterKind: kind },
    }),
  );
  return true;
}

/** A few tries at the email: a blip of the provider should not undo a release two people approved. */
async function sendWithRetries(
  deps: ArchiveReleaseDeps,
  send: () => Promise<unknown>,
): Promise<boolean> {
  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt += 1) {
    try {
      await send();
      return true;
    } catch {
      deps.log?.error(
        { job: ARCHIVE_RELEASE_JOB, attempt },
        'the release link could not be emailed',
      );
    }
  }
  return false;
}

/**
 * The link did not reach the requester: it is revoked, the request goes to `failed` with no package
 * (the row says it was never delivered), and the package leaves the bucket. The operator sees
 * `email_failed` and records a new request.
 */
async function undoRelease(
  deps: ArchiveReleaseDeps,
  system: RequestContext,
  request: ArchiveReleaseRequestRow,
): Promise<void> {
  await deps.withTenant(system, async (inner) => {
    await deps.tokens.revokeForSubject(inner, 'archive_release', request.id);
    await inner
      .update(archiveReleaseRequest)
      .set({
        status: 'failed',
        failureCode: 'email_failed',
        releasedAt: null,
        packageKey: null,
        packageSha256: null,
        packageBytes: null,
        linkExpiresAt: null,
      })
      .where(eq(archiveReleaseRequest.id, request.id));
    await writeReleaseAudit(inner, {
      action: 'archive.released',
      requestId: request.id,
      metadata: { phase: 'failed', code: 'email_failed' },
    });
  });
  await removePackage(deps, system, request.id).catch(() => {
    deps.log?.error({ job: ARCHIVE_RELEASE_JOB }, 'could not take the package out of the bucket');
  });
}

/** Restores the parts the requester is entitled to and builds what is handed over. */
async function buildFor(
  deps: ArchiveReleaseDeps,
  request: ArchiveReleaseRequestRow,
  kind: 'patient' | 'professional',
  archive: TenantArchiveRow,
  manifest: ArchiveManifest,
  privateKey: Buffer,
  scratch: string,
  now: Date,
): Promise<BuiltPackage> {
  if (kind === 'professional') {
    if (request.scopeMatriculaJurisdiction === null || request.scopeMatricula === null) {
      throw new ReleaseFailure('scope_incomplete');
    }
    const part = findProfessionalPart(manifest, {
      jurisdiction: request.scopeMatriculaJurisdiction,
      matricula: request.scopeMatricula,
    });
    if (!part) throw new ReleaseFailure('scope_not_found');
    if (partIsErased(archive, part)) throw new ReleaseFailure('erased');
    // Only the part of this professional is decrypted: the rest of the archive stays closed.
    const [restored] = await restoreParts({
      store: deps.store,
      manifest,
      privateKey,
      outDir: scratch,
      select: (candidate) => candidate.part === part.part,
    });
    if (!restored) throw new ReleaseFailure('scope_not_found');
    return fileInfo(restored.path);
  }

  if (request.scopeDocumentType === null || request.scopeDocument === null) {
    throw new ReleaseFailure('scope_incomplete');
  }
  const adminPart = manifest.parts.find((part) => part.kind === 'administrative');
  if (!adminPart) throw new ReleaseFailure('scope_not_found');
  // A patient's records are the identity part and every clinical part: one erased is a gap.
  if (manifest.parts.some((part) => partIsErased(archive, part))) {
    throw new ReleaseFailure('erased');
  }
  const [admin] = await restoreParts({
    store: deps.store,
    manifest,
    privateKey,
    outDir: scratch,
    select: (candidate) => candidate.part === adminPart.part,
  });
  if (!admin) throw new ReleaseFailure('scope_not_found');
  const patientId = await findPatientId(admin.path, {
    documentType: request.scopeDocumentType,
    document: request.scopeDocument,
  });
  if (!patientId) throw new ReleaseFailure('scope_not_found');

  const clinical = await restoreParts({
    store: deps.store,
    manifest,
    privateKey,
    outDir: scratch,
    select: (candidate) => candidate.kind === 'clinical',
  });
  return buildPatientPackage({
    adminZip: admin.path,
    clinicalZips: clinical.map((part) => part.path),
    patientId,
    organizationName: await organizationNameOf(deps, manifest.tenantId),
    now,
    scratch,
  });
}

async function organizationNameOf(deps: ArchiveReleaseDeps, tenantId: string): Promise<string> {
  return deps.withTenant({ tenantId, userId: SYSTEM_USER_ID }, readOrganizationName);
}

async function fileInfo(path: string): Promise<BuiltPackage> {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    hash.update(chunk);
    sizeBytes += chunk.length;
  }
  return { path, sizeBytes, sha256: hash.digest('hex'), entryCount: 0 };
}

/** Best effort: the release happened whether or not the notice arrives. */
async function tellTheFormerContact(
  deps: ArchiveReleaseDeps,
  system: RequestContext,
  organizationName: string,
  kind: 'patient' | 'professional',
  now: Date,
): Promise<void> {
  try {
    const owners = await deps.withTenant(system, ownerRecipients);
    const notice = contactNotice({ organizationName, requesterKind: kind, at: now });
    for (const owner of owners) {
      await deps.email.send({
        to: owner.email,
        subject: notice.subject,
        text: notice.text,
        tenant: { id: system.tenantId, isDemo: false },
      });
    }
  } catch {
    deps.log?.error({ job: ARCHIVE_RELEASE_JOB }, 'could not tell the former contact of a release');
  }
}
