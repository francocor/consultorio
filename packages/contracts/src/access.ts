import { z } from 'zod';

import { GRANTABLE, STAFF_ROLES } from './roles.js';

/**
 * Contracts of the access module: grants, role changes, member locations, organization settings
 * and locations. The tenant is never a field: it comes from the session (design, ADR-002).
 */

/** What a grant narrows. Only a delegated calendar has a scope: the professionals it reaches. */
export const GrantScope = z.strictObject({
  professionalIds: z.array(z.uuid()).min(1).max(50),
});
export type GrantScope = z.infer<typeof GrantScope>;

/**
 * The permission is a plain string on purpose: the server, not the schema, decides what to do with
 * a permission outside the fixed set (it refuses and audits the attempt, authorization, "Clinical
 * permissions are locked to health professionals").
 */
export const GrantPermissionRequest = z.strictObject({
  permission: z.string().min(1).max(64),
  scope: GrantScope.optional(),
});
export type GrantPermissionRequest = z.infer<typeof GrantPermissionRequest>;

export const GrantDto = z.strictObject({
  id: z.uuid(),
  permission: z.enum(GRANTABLE),
  scope: z.record(z.string(), z.unknown()),
  grantedBy: z.uuid(),
  grantedAt: z.iso.datetime(),
});
export type GrantDto = z.infer<typeof GrantDto>;

export const GrantListResponse = z.strictObject({
  /** The permissions that can be granted, so the screen offers exactly these. */
  grantable: z.array(z.enum(GRANTABLE)),
  grants: z.array(GrantDto),
});
export type GrantListResponse = z.infer<typeof GrantListResponse>;

export const ChangeRolesRequest = z.strictObject({
  roles: z
    .array(z.enum(STAFF_ROLES))
    .min(1)
    .max(STAFF_ROLES.length)
    .refine((roles) => new Set(roles).size === roles.length, 'roles must be distinct'),
});
export type ChangeRolesRequest = z.infer<typeof ChangeRolesRequest>;

export const MemberRolesResponse = z.strictObject({
  membershipId: z.uuid(),
  roles: z.array(z.enum(STAFF_ROLES)),
});
export type MemberRolesResponse = z.infer<typeof MemberRolesResponse>;

export const SetMemberLocationsRequest = z.strictObject({
  locationIds: z.array(z.uuid()).max(100),
});
export type SetMemberLocationsRequest = z.infer<typeof SetMemberLocationsRequest>;

export const MemberLocationsResponse = z.strictObject({
  membershipId: z.uuid(),
  locationIds: z.array(z.uuid()),
});
export type MemberLocationsResponse = z.infer<typeof MemberLocationsResponse>;

// Locations ---------------------------------------------------------------------------------

/** IANA zone names look like `America/Argentina/Buenos_Aires` or `UTC`; the runtime must know it. */
export function isKnownTimeZone(value: string): boolean {
  if (!/^(UTC|[A-Za-z]+(\/[A-Za-z0-9_+-]+)+)$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const TimeZone = z.string().refine(isKnownTimeZone, 'unknown time zone');
const LocationName = z.string().trim().min(1).max(120);

export const LocationDto = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  timeZone: z.string(),
  active: z.boolean(),
});
export type LocationDto = z.infer<typeof LocationDto>;

export const LocationListResponse = z.strictObject({ locations: z.array(LocationDto) });
export type LocationListResponse = z.infer<typeof LocationListResponse>;

/** Without a time zone the location gets the country default (country-rules, "Locale ... defaults"). */
export const CreateLocationRequest = z.strictObject({
  name: LocationName,
  timeZone: TimeZone.optional(),
});
export type CreateLocationRequest = z.infer<typeof CreateLocationRequest>;

export const UpdateLocationRequest = z
  .strictObject({ name: LocationName.optional(), timeZone: TimeZone.optional() })
  .refine((body) => body.name !== undefined || body.timeZone !== undefined, 'nothing to change');
export type UpdateLocationRequest = z.infer<typeof UpdateLocationRequest>;

// Organization settings ----------------------------------------------------------------------

/** Template kinds an organization can put in its shared scope (clinical-records, "Specialty templates"). */
export const CLINICAL_TEMPLATE_KINDS = [
  'general',
  'odontology',
  'psychology',
  'physiotherapy',
  'nutrition',
] as const;
export type ClinicalTemplateKind = (typeof CLINICAL_TEMPLATE_KINDS)[number];

/**
 * The shared scope when sharing is first enabled: every template except psychology. Psychology
 * joins only by an explicit, audited choice, and templates published later never join on their own.
 */
export const DEFAULT_SHARED_TEMPLATES: readonly ClinicalTemplateKind[] = [
  'general',
  'odontology',
  'physiotherapy',
  'nutrition',
];

const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');

export const QuietHours = z.strictObject({ start: ClockTime, end: ClockTime });
export type QuietHours = z.infer<typeof QuietHours>;

/** Reminders and waitlist offers are not sent between these times, in the location's zone. */
export const DEFAULT_QUIET_HOURS: QuietHours = { start: '21:00', end: '08:00' };

export const SettingsDto = z.strictObject({
  /** One switch for what reception may know about clinical items without reading them. */
  receptionSeesClinicalMetadata: z.boolean(),
  clinicalSharing: z.boolean(),
  sharedTemplates: z.array(z.enum(CLINICAL_TEMPLATE_KINDS)),
  require2fa: z.boolean(),
  quietHours: QuietHours,
});
export type SettingsDto = z.infer<typeof SettingsDto>;

export const UpdateSettingsRequest = z
  .strictObject({
    receptionSeesClinicalMetadata: z.boolean().optional(),
    clinicalSharing: z.boolean().optional(),
    sharedTemplates: z
      .array(z.enum(CLINICAL_TEMPLATE_KINDS))
      .max(CLINICAL_TEMPLATE_KINDS.length)
      .optional(),
    /** Required to ADD psychology to the shared scope: it is a deliberate, audited choice. */
    confirmPsychologySharing: z.boolean().optional(),
    require2fa: z.boolean().optional(),
    quietHours: QuietHours.optional(),
  })
  .refine(
    (body) => Object.keys(body).some((key) => key !== 'confirmPsychologySharing'),
    'nothing to change',
  );
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequest>;
