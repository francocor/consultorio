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
