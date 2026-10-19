/**
 * How long after the e-mail or the birth date of a record changed (JD-S5 R2-2) giving anybody access
 * to that patient through the portal needs an owner or an administrator. The portal trusts those two
 * facts (where its notices go, who is a minor), and the staff can edit both.
 */
export const RECENT_RECORD_CHANGE_DAYS = 7;
