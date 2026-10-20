/**
 * Tables of Stage 6 retention (track C) that the demo seed leaves empty on purpose. A demo
 * organization is never cancelled for real (its end is the demo reset), so nothing here is seeded;
 * Track D removes an entry when it seeds the table (S6.12).
 */
export const exemptions: Record<string, string> = {
  export_package:
    'Made when an organization is cancelled. A demo organization is never cancelled: its end is the demo reset.',
};
