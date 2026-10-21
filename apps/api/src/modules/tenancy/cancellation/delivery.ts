import {
  effectivePermissions,
  type DownloadLinkResponse,
  type ExportPackageResponse,
} from '@consultorio/contracts';

import type { ExportPackageRow } from '../../../db/schema/export-package.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Actor } from '../../../platform/authz/actor.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { FileRefused, type FileResource } from '../../../platform/files/file-resources.js';
import { AppError } from '../../../platform/http/problem.js';
import type { ActionTokens } from '../../../platform/tokens/index.js';

import {
  findAdministrativePackage,
  findClinicalPackage,
  findPackage,
  toPackageDto,
} from './packages.js';

/**
 * Who may have which package of the cancellation export, decided in ONE place and asked twice: when
 * the link is issued and again when it is used (the link lives five minutes, and a person can lose
 * their role in that time).
 *
 * - The administrative package belongs to the owner role (`billing.manage`, owner only). Nobody else
 *   has it, whatever else they can do: an administrator has no clinical access and no export.
 * - A clinical package belongs to the professional it was made for (`actor.professionalId`, which is
 *   set only for an active profile with a registration) and needs `clinical.note.read`. Not the
 *   owner, unless the owner is that professional; not a colleague; not the platform.
 */
export function mayHavePackage(actor: Actor, row: ExportPackageRow): boolean {
  const permissions = effectivePermissions(actor.roles, actor.grants);
  if (row.kind === 'administrative') return permissions.includes('billing.manage');
  return (
    row.professionalId !== null &&
    actor.professionalId === row.professionalId &&
    permissions.includes('clinical.note.read')
  );
}

export interface CancellationDelivery {
  /** The administrative package, as the owner sees it. */
  administrative(tx: Tx): Promise<ExportPackageResponse>;
  /** The clinical package of the signed-in professional; not found for anyone who is not one. */
  clinical(tx: Tx, actor: Actor): Promise<ExportPackageResponse>;
  /** A link to the file, for this session only. */
  issueLink(
    tx: Tx,
    input: {
      kind: 'administrative' | 'clinical';
      actor: Actor;
      auditActor: AuditActor;
      sessionId: string;
    },
  ): Promise<DownloadLinkResponse>;
}

export function createCancellationDelivery(deps: { tokens: ActionTokens }): CancellationDelivery {
  return {
    async administrative(tx) {
      const row = await findAdministrativePackage(tx);
      return { package: row ? toPackageDto(row) : null };
    },

    async clinical(tx, actor) {
      // A person without a professional profile has no clinical package to look for.
      if (!actor.professionalId) throw new AppError('not_found');
      const row = await findClinicalPackage(tx, actor.professionalId);
      return { package: row ? toPackageDto(row) : null };
    },

    async issueLink(tx, input) {
      const row =
        input.kind === 'administrative'
          ? await findAdministrativePackage(tx)
          : input.actor.professionalId
            ? await findClinicalPackage(tx, input.actor.professionalId)
            : null;
      if (!row) throw new AppError('not_found');
      if (!mayHavePackage(input.actor, row)) throw new AppError('forbidden');
      if (row.status !== 'ready' || row.objectKey === null || row.objectRemovedAt !== null) {
        throw new AppError('export_package_not_ready');
      }
      const issued = await deps.tokens.issue(tx, {
        kind: 'cancellation_export',
        subjectId: row.id,
        sessionId: input.sessionId,
      });
      await audit(tx, {
        action: 'export.cancellation.requested',
        outcome: 'allow',
        actor: input.auditActor,
        resourceType: 'export_package',
        resourceId: row.id,
        metadata: { kind: row.kind, origin: 'download' },
      });
      return { url: `/files/${issued.token}`, expiresAt: issued.expiresAt.toISOString() };
    },
  };
}

/**
 * The part of `GET /files/:token` that serves the packages: the links of `cancellation_export`. The
 * link is bound to the session, works once for five minutes, and is authorized AGAIN when used. The
 * download is audited here, in the same transaction that spends the link.
 */
export function createCancellationFileResource(tokens: ActionTokens): FileResource {
  return {
    kind: 'cancellation_export',
    audits: ['export.cancellation.downloaded'],
    async redeem(tx, input) {
      const redeemed = await tokens.redeem(tx, 'cancellation_export', input.token, {
        sessionId: input.sessionId,
      });
      // Not a live link of this kind: the door asks the other resources before it refuses.
      if (!redeemed) return null;

      const row = await findPackage(tx, redeemed.subjectId);
      if (!row || input.actor.kind !== 'staff' || !mayHavePackage(input.actor, row)) {
        throw new FileRefused('export_not_allowed', 'export_package', {
          resourceId: redeemed.subjectId,
        });
      }
      if (
        row.status !== 'ready' ||
        row.objectKey === null ||
        row.fileName === null ||
        row.objectRemovedAt !== null
      ) {
        throw new FileRefused('export_not_ready', 'export_package', { resourceId: row.id });
      }
      await audit(tx, {
        action: 'export.cancellation.downloaded',
        outcome: 'allow',
        actor: input.auditActor,
        resourceType: 'export_package',
        resourceId: row.id,
        metadata: { kind: row.kind },
      });
      return {
        objectKey: row.objectKey,
        contentType: 'application/zip',
        // The name was made by the job from the kind and the day: nothing a person typed.
        contentDisposition: `attachment; filename="${row.fileName}"`,
      };
    },
  };
}
