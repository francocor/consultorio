import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { ExportPackageRow } from '../../../db/schema/export-package.js';
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
import type { ExportKind, ExportRegistry } from '../application/export-registry.js';
import { readOrganizationName } from '../application/organization-name.js';

import { packageReadyNotice } from './emails.js';
import { writePackageFile } from './package-file.js';
import {
  clinicalRecipient,
  markPackageFailed,
  markPackageReady,
  ownerRecipients,
  queuedPackages,
  requestClinicalPackages,
  tenantSlug,
} from './packages.js';
import { ClinicalKeyInAdministrativePartError } from './redaction.js';
import { packageFileName } from './summary.js';
import { ZipLimitError } from './zip.js';

/**
 * The queue of the cancellation export. It is `export.build`, which billing's exports already use
 * (category `export`: it runs for a read-only and a cancelled organization). Two handlers cannot
 * share one queue, so the worker merges the definitions that carry this name into one that tells
 * them apart by the shape of the payload (`combineWorkerContributions`): billing's carries an
 * `exportId`, this one carries `reason: 'cancellation'`.
 */
export const CANCELLATION_EXPORT_JOB = 'export.build';

const Payload = JobPayload.extend({ reason: z.literal('cancellation') });
export type CancellationExportPayload = z.infer<typeof Payload>;

/** How many times pg-boss redelivers `export.build` (queues.ts); the last delivery gives up. */
const RETRY_LIMIT = 2;

export interface CancellationExportDeps {
  /** Every module's contributor. */
  exports: ExportRegistry;
  /** Opens the short transactions: one per contributor, one to record a result. */
  withTenant: WithTenant;
  storage: ObjectStorage;
  clock: () => Date;
  /** Where the scratch files live. Defaults to the temporary directory of the machine. */
  workDir?: string;
  /** Tells the people a package is for that it is ready. Absent: nobody is told. */
  notify?: { email: EmailSender; origins: PublicOrigins };
  log?: WorkerLog;
}

/** The context a contributor runs in: the organization, and for a clinical part the professional. */
function contextOf(
  tenantId: string,
  row: ExportPackageRow,
  recipient: { userId: string } | null,
): RequestContext {
  if (row.kind === 'clinical' && recipient && row.professionalId) {
    return { tenantId, userId: recipient.userId, actingProfessionalId: row.professionalId };
  }
  // The administrative part runs as the system and with no professional, so the clinical policies of
  // the database show it no clinical row even if a contributor asked for one.
  return { tenantId, userId: SYSTEM_USER_ID };
}

/**
 * `export.build` for a cancelled organization: makes every package that was asked for.
 *
 * - One build at a time per organization: the advisory lock belongs to the transaction the framework
 *   holds for this job, so it is released when the job ends or dies.
 * - Each contributor runs in a transaction of its own that closes before the next thing happens; the
 *   zip, the attached files and the upload run with no transaction open (the one the framework
 *   holds for the job stays idle: this family is in `CONNECTION_HOLDING_JOBS`).
 * - A package that cannot be made for a reason that will not change (a clinical field in the
 *   administrative part, a size the format cannot hold) is recorded as failed; any other failure is
 *   thrown so the queue tries again, and the last delivery records `build_failed`.
 * - Idempotent: only a queued package is built, and recording the result moves it once.
 */
export function createCancellationExportJob(
  deps: CancellationExportDeps,
): JobDefinition<CancellationExportPayload> {
  return defineJob({
    name: CANCELLATION_EXPORT_JOB,
    category: 'export',
    payload: Payload,
    handler: async ({ tx, tenantId, job }) => {
      const lock = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${`cancellation_export:${tenantId}`}, 0)) as locked`,
      );
      if (lock.rows[0]?.locked !== true) return;

      // Everything below runs on transactions of its own that commit as they go: the requests are
      // written and read there, because the transaction the framework holds is idle (and its writes
      // would be invisible to the ones that record the outcome).
      const system: RequestContext = { tenantId, userId: SYSTEM_USER_ID };
      const { queued, organizationName } = await deps.withTenant(system, async (inner) => {
        await requestClinicalPackages(inner);
        return {
          queued: await queuedPackages(inner),
          organizationName: await readOrganizationName(inner),
        };
      });
      if (queued.length === 0) return;

      for (const row of queued) {
        const now = deps.clock();
        const recipient =
          row.kind === 'clinical' && row.professionalId
            ? await deps.withTenant(system, (inner) =>
                clinicalRecipient(inner, row.professionalId as string),
              )
            : null;
        const failWith = (code: string) =>
          deps.withTenant(system, (inner) => markPackageFailed(inner, row.id, code));
        try {
          const built = await buildPackage(deps, {
            tenantId,
            row,
            context: contextOf(tenantId, row, recipient),
            organizationName,
            professionalName: recipient?.displayName ?? null,
            now,
          });
          const recorded = await deps.withTenant(system, (inner) =>
            markPackageReady(inner, row.id, { ...built, at: now }),
          );
          if (recorded) {
            await tellPeople(deps, tenantId, row, organizationName, recipient?.email ?? null);
          }
        } catch (error) {
          if (error instanceof ClinicalKeyInAdministrativePartError) {
            // The names of the module and of the field, never a value: enough to fix the contributor.
            deps.log?.error(
              { job: CANCELLATION_EXPORT_JOB, contributor: error.contributor, field: error.key },
              'a clinical field is in the administrative part of the export',
            );
            await failWith('clinical_key_in_administrative_part');
          } else if (error instanceof ZipLimitError) {
            await failWith('package_too_large');
          } else if (job.retryCount >= RETRY_LIMIT) {
            await failWith('build_failed');
          } else {
            throw error;
          }
        }
      }
    },
  });
}

interface BuildInput {
  tenantId: string;
  row: ExportPackageRow;
  context: RequestContext;
  organizationName: string;
  professionalName: string | null;
  now: Date;
}

/** Builds the file of one package and stores it. Resolves with what the row records. */
async function buildPackage(
  deps: CancellationExportDeps,
  input: BuildInput,
): Promise<{
  objectKey: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  entryCount: number;
}> {
  const kind: ExportKind = input.row.kind === 'clinical' ? 'clinical' : 'administrative';
  const scratch = await mkdtemp(join(deps.workDir ?? tmpdir(), 'cancellation-export-'));
  try {
    const written = await writePackageFile(deps, {
      tenantId: input.tenantId,
      kind,
      professionalId: input.row.professionalId ?? undefined,
      context: input.context,
      organizationName: input.organizationName,
      professionalName: input.professionalName,
      now: input.now,
      scratch,
    });
    const objectKey = tenantKey(input.tenantId, 'cancellation-export', `${input.row.id}.zip`);
    await deps.storage.put(input.tenantId, objectKey, {
      body: createReadStream(written.path),
      contentType: 'application/zip',
      contentLength: written.sizeBytes,
    });
    return {
      objectKey,
      fileName: packageFileName(kind, input.now),
      sizeBytes: written.sizeBytes,
      sha256: written.sha256,
      entryCount: written.entryCount,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Best effort: the package is ready whether or not the notice arrives; the screen shows it too. */
async function tellPeople(
  deps: CancellationExportDeps,
  tenantId: string,
  row: ExportPackageRow,
  organizationName: string,
  professionalEmail: string | null,
): Promise<void> {
  if (!deps.notify) return;
  const system: RequestContext = { tenantId, userId: SYSTEM_USER_ID };
  const kind: ExportKind = row.kind === 'clinical' ? 'clinical' : 'administrative';
  try {
    const { slug, to } = await deps.withTenant(system, async (tx) => ({
      slug: await tenantSlug(tx),
      to:
        kind === 'clinical'
          ? professionalEmail === null
            ? []
            : [professionalEmail]
          : (await ownerRecipients(tx)).map((owner) => owner.email),
    }));
    if (slug === null) return;
    const url = `${deps.notify.origins(slug)}${kind === 'clinical' ? '/export/clinical' : '/export'}`;
    const notice = packageReadyNotice(kind, { organizationName, url });
    for (const address of to) {
      await deps.notify.email.send({
        to: address,
        subject: notice.subject,
        text: notice.text,
        tenant: { id: tenantId, isDemo: false },
      });
    }
  } catch {
    // The email provider being down must not undo a package. No address, no text in the log.
    deps.log?.error({ job: CANCELLATION_EXPORT_JOB, kind }, 'could not send the export notice');
  }
}
