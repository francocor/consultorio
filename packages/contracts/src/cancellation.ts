import { z } from 'zod';

export {
  ARCHIVE_PLATFORM_AUDIT_ACTIONS,
  CANCELLATION_AUDIT_ACTIONS,
  CANCELLATION_ERRORS,
  CANCELLATION_PLATFORM_AUDIT_ACTIONS,
} from './cancellation-catalog.js';

/**
 * Contracts of the cancellation of an organization: the split export (an administrative package for
 * the owner and one clinical package per professional) and the retention archive with its
 * break-glass release. This file holds what is certain from the design; the retention track (S6.08
 * to S6.10) adds its request and response shapes below, in this file only. A shape of the operator
 * side must carry counts and states, never content: the operator cannot read the archive.
 */

/** The two parts of the export. The clinical one is made once per professional. */
export const EXPORT_PACKAGE_KINDS = ['administrative', 'clinical'] as const;
export type ExportPackageKind = (typeof EXPORT_PACKAGE_KINDS)[number];

/** Where a package stands: asked for, ready to download, or not possible (with a code). */
export const EXPORT_PACKAGE_STATUSES = ['queued', 'ready', 'failed'] as const;
export type ExportPackageStatus = (typeof EXPORT_PACKAGE_STATUSES)[number];

/**
 * A package of the cancellation export as the person it is for sees it: its state and its file.
 * Never the key of the object, never what the package holds.
 */
export const ExportPackageDto = z.strictObject({
  id: z.uuid(),
  kind: z.enum(EXPORT_PACKAGE_KINDS),
  status: z.enum(EXPORT_PACKAGE_STATUSES),
  fileName: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  builtAt: z.iso.datetime().nullable(),
  /** Why a package could not be made, as a code the screen has a message for. */
  failureCode: z.string().nullable(),
});
export type ExportPackageDto = z.infer<typeof ExportPackageDto>;

/**
 * The package of the caller: the administrative one for the owner, the clinical one for the
 * professional it was made for. `null` before the organization is cancelled or while the request
 * has not been written yet.
 */
export const ExportPackageResponse = z.strictObject({
  package: ExportPackageDto.nullable(),
});
export type ExportPackageResponse = z.infer<typeof ExportPackageResponse>;

/** What the operator console answers after it cancels an organization (counts and states only). */
export const OperatorCancelTenantResponse = z.strictObject({
  status: z.literal('cancelled'),
});
export type OperatorCancelTenantResponse = z.infer<typeof OperatorCancelTenantResponse>;
