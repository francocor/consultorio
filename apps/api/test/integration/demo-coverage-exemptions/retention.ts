/**
 * Tables of Stage 6 retention (track C) that the demo seed leaves empty on purpose. A demo
 * organization is never cancelled for real (its end is the demo reset), so nothing here is seeded;
 * Track D removes an entry when it seeds the table (S6.12).
 */
export const exemptions: Record<string, string> = {
  export_package:
    'Made when an organization is cancelled. A demo organization is never cancelled: its end is the demo reset.',
  archive_key:
    'The key pair of the retention archive is made when an organization is archived. A demo organization is never archived.',
  tenant_archive:
    'Written when the archive of a cancelled organization is made. A demo organization is never archived.',
};
