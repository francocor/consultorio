/**
 * The error codes and audit actions of the cancellation of an organization (the split export and the
 * retention archive), apart from its schemas (see `billing-catalog.ts` for why they live apart).
 */

/**
 * Error codes of the cancellation export and the archive, with their status and the key of the
 * es-AR message. They join the API catalog (errors.ts); the messages go in
 * `locales/es-AR/errors.archive.json`, keyed by the code. The retention track (Track C) adds its
 * codes here and nowhere else.
 */
export const CANCELLATION_ERRORS = {
  // The package is not a file yet (still being made) or could not be made: nothing to download.
  export_package_not_ready: { status: 409, i18nKey: 'errors.export_package_not_ready' },
  // The person who recorded a request, or verified the identity of its requester, cannot approve it:
  // the approver is a third pair of eyes (JD-S6 R1-S6-4).
  archive_release_same_operator: { status: 409, i18nKey: 'errors.archive_release_same_operator' },
  // The request is not in the step this action needs (verify the identity first, then approve).
  archive_release_wrong_step: { status: 409, i18nKey: 'errors.archive_release_wrong_step' },
  // The organization named has no archive written, so there is nothing to release.
  archive_release_no_archive: { status: 409, i18nKey: 'errors.archive_release_no_archive' },
  // The organization has a subscription: its end goes through the subscription (which cancels at the
  // provider first), not through the operator's cancel (JD-S6 R1-S6-2).
  operator_cancel_has_subscription: {
    status: 409,
    i18nKey: 'errors.operator_cancel_has_subscription',
  },
} as const satisfies Record<string, { status: number; i18nKey: string }>;

/**
 * Audit actions of the organization that cancels: its own trail is part of the export. The metadata
 * of an entry names the package and who asked for it, never what the package holds.
 */
export const CANCELLATION_AUDIT_ACTIONS = [
  'tenant.cancelled',
  'export.cancellation.requested',
  'export.cancellation.downloaded',
  // The plaintext package left the bucket once the archive that replaces it was verified (JD-S6 R1-A-W7).
  'export.cancellation.removed',
] as const;

/** The operator cancelled an organization (single-tenant deployments and local testing). */
export const CANCELLATION_PLATFORM_AUDIT_ACTIONS = ['tenant.cancelled'] as const;

/**
 * What the platform does with the records of a cancelled organization. They belong to the platform
 * trail only: the organization may be gone, and an access to the archive is the platform's to answer
 * for (tenancy, "Retention archive after cancellation").
 */
export const ARCHIVE_PLATFORM_AUDIT_ACTIONS = [
  'archive.written',
  'archive.verified',
  'archive.accessed',
  'archive.released',
  'archive.erased',
] as const;
