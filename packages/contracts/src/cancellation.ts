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

// The break-glass release of archived records (S6.10) -------------------------------------------------

/** Who may ask for archived records: the patient, for their own, or a verified professional, for their patients. */
export const ARCHIVE_RELEASE_REQUESTER_KINDS = ['patient', 'professional'] as const;
export type ArchiveReleaseRequesterKind = (typeof ARCHIVE_RELEASE_REQUESTER_KINDS)[number];

export const ARCHIVE_RELEASE_STATUSES = [
  'requested',
  'identity_verified',
  'approved',
  'released',
  'rejected',
  'expired',
  'failed',
] as const;
export type ArchiveReleaseStatus = (typeof ARCHIVE_RELEASE_STATUSES)[number];

/** What an operator confirms out of band before a different operator can approve. */
export const ARCHIVE_RELEASE_CHECKLIST = [
  /** The identity document of the requester was seen and is valid. */
  'documentChecked',
  /** The person on the call or at the desk is the one in the document. */
  'photoMatches',
  /** The address the link goes to was confirmed with the requester. */
  'contactConfirmed',
  /** A patient is who the records belong to (or their legal representative); a professional's registration is verified. */
  'entitlementChecked',
] as const;

const RequesterName = z.string().trim().min(2).max(120);
const RequesterEmail = z.string().trim().toLowerCase().pipe(z.email().max(254));
const Reason = z.string().trim().min(5).max(500);

/**
 * An operator records a request. A patient is found in the archive by their document, a professional
 * by their registration; exactly the fields of the kind are accepted.
 */
export const RecordArchiveReleaseRequest = z
  .strictObject({
    /** The cancelled organization whose archive the records are in. */
    organization: z.uuid(),
    requesterKind: z.enum(ARCHIVE_RELEASE_REQUESTER_KINDS),
    requesterName: RequesterName,
    requesterEmail: RequesterEmail,
    documentType: z.string().trim().min(2).max(20).optional(),
    document: z.string().trim().min(3).max(30).optional(),
    matriculaJurisdiction: z.string().trim().min(2).max(20).optional(),
    matricula: z.string().trim().min(2).max(30).optional(),
    reason: Reason,
  })
  .superRefine((value, context) => {
    const patient = value.requesterKind === 'patient';
    const own = patient
      ? { documentType: value.documentType, document: value.document }
      : { matriculaJurisdiction: value.matriculaJurisdiction, matricula: value.matricula };
    const foreign = patient
      ? { matriculaJurisdiction: value.matriculaJurisdiction, matricula: value.matricula }
      : { documentType: value.documentType, document: value.document };
    for (const [field, entry] of Object.entries(own)) {
      if (entry === undefined) {
        context.addIssue({ code: 'custom', path: [field], message: 'required' });
      }
    }
    for (const [field, entry] of Object.entries(foreign)) {
      if (entry !== undefined) {
        context.addIssue({ code: 'custom', path: [field], message: 'not for this kind' });
      }
    }
  });
export type RecordArchiveReleaseRequest = z.infer<typeof RecordArchiveReleaseRequest>;

/** The checklist: every item must be ticked, so a request with one missing does not parse. */
export const VerifyArchiveReleaseIdentityRequest = z.strictObject({
  documentChecked: z.literal(true),
  photoMatches: z.literal(true),
  contactConfirmed: z.literal(true),
  entitlementChecked: z.literal(true),
});
export type VerifyArchiveReleaseIdentityRequest = z.infer<
  typeof VerifyArchiveReleaseIdentityRequest
>;

export const RejectArchiveReleaseRequest = z.strictObject({ reason: Reason });
export type RejectArchiveReleaseRequest = z.infer<typeof RejectArchiveReleaseRequest>;

/**
 * A request as the operator sees it: who asks and for what, and where it stands. The operator reads the
 * identity of the requester to verify it; it never reads a record, and nothing here is derived from one.
 */
export const ArchiveReleaseRequestDto = z.strictObject({
  id: z.uuid(),
  organization: z.uuid(),
  status: z.enum(ARCHIVE_RELEASE_STATUSES),
  requesterKind: z.enum(ARCHIVE_RELEASE_REQUESTER_KINDS),
  requesterName: z.string(),
  requesterEmail: z.string(),
  /** What finds the requester in the archive, as text: `DNI 20111222`, `AR-B 123456`. */
  scope: z.string(),
  reason: z.string(),
  createdAt: z.iso.datetime(),
  identityVerifiedAt: z.iso.datetime().nullable(),
  approvedAt: z.iso.datetime().nullable(),
  /** The end of the window to carry out an approved request. */
  expiresAt: z.iso.datetime().nullable(),
  releasedAt: z.iso.datetime().nullable(),
  linkExpiresAt: z.iso.datetime().nullable(),
  downloadedAt: z.iso.datetime().nullable(),
  rejectedReason: z.string().nullable(),
  failureCode: z.string().nullable(),
  /** What the signed-in operator may do now: the same person never verifies and approves. */
  canVerifyIdentity: z.boolean(),
  canApprove: z.boolean(),
  canReject: z.boolean(),
});
export type ArchiveReleaseRequestDto = z.infer<typeof ArchiveReleaseRequestDto>;

export const ArchiveReleaseListResponse = z.strictObject({
  requests: z.array(ArchiveReleaseRequestDto),
});
export type ArchiveReleaseListResponse = z.infer<typeof ArchiveReleaseListResponse>;

/** The state of the archive of one cancelled organization: counts and dates, never a name or a record. */
export const ArchiveOverviewDto = z.strictObject({
  organization: z.uuid(),
  status: z.enum(['pending', 'written', 'failed']),
  archivedAt: z.iso.datetime().nullable(),
  objects: z.number().int().nonnegative().nullable(),
  bytes: z.number().int().nonnegative().nullable(),
  retainUntil: z.iso.datetime().nullable(),
  verifiedAt: z.iso.datetime().nullable(),
  verifyStatus: z.enum(['ok', 'corrupted', 'missing', 'overwritten']).nullable(),
  verifyProblems: z.number().int().nonnegative().nullable(),
});
export type ArchiveOverviewDto = z.infer<typeof ArchiveOverviewDto>;

export const ArchiveOverviewResponse = z.strictObject({ archives: z.array(ArchiveOverviewDto) });
export type ArchiveOverviewResponse = z.infer<typeof ArchiveOverviewResponse>;

/** What the page of the requester asks of the link before it is spent: only when it ends. */
export const ArchiveReleaseLinkResponse = z.strictObject({
  expiresAt: z.iso.datetime(),
});
export type ArchiveReleaseLinkResponse = z.infer<typeof ArchiveReleaseLinkResponse>;
