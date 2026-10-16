import { z } from 'zod';

import { STAFF_ROLES } from './roles.js';

/**
 * Contracts of the staff module: invitations, the directory, professional profiles and weekly
 * hours. Whether a matricula is verified is never an input anywhere here: only the platform
 * operator changes it, and a tenant request cannot even name the field.
 */

const Email = z.string().trim().pipe(z.email().max(254));
const PersonName = z.string().trim().min(1).max(120);

export const InviteStaffRequest = z.strictObject({
  email: Email,
  roles: z
    .array(z.enum(STAFF_ROLES))
    .min(1)
    .max(STAFF_ROLES.length)
    .refine((roles) => new Set(roles).size === roles.length, 'roles must be distinct'),
  /** How the invitee appears in the staff directory. */
  displayName: PersonName.optional(),
});
export type InviteStaffRequest = z.infer<typeof InviteStaffRequest>;

/** The link itself only travels by email; the answer says when it stops working. */
export const InviteStaffResponse = z.strictObject({ expiresAt: z.iso.datetime() });
export type InviteStaffResponse = z.infer<typeof InviteStaffResponse>;

export const MatriculaInput = z.strictObject({
  jurisdiction: z.string().trim().min(1).max(16),
  number: z.string().trim().min(1).max(32),
});
export type MatriculaInput = z.infer<typeof MatriculaInput>;

const Specialty = z.string().trim().min(1).max(80);

export const ProfessionalProfileRequest = z.strictObject({
  fullName: PersonName,
  /** One or more disciplines. The product never infers one from the role. */
  specialties: z
    .array(Specialty)
    .min(1)
    .max(10)
    .refine(
      (items) => new Set(items.map((item) => item.toLowerCase())).size === items.length,
      'specialties must be distinct',
    ),
  /** `null` clears the registration: the profile is then incomplete and opens nothing clinical. */
  matricula: MatriculaInput.nullable(),
  /** 1 means no overbooking. Only an owner or admin sets it. */
  maxSimultaneous: z.number().int().min(1).max(20).optional(),
});
export type ProfessionalProfileRequest = z.infer<typeof ProfessionalProfileRequest>;

export const MATRICULA_STATUSES = ['unverified', 'verified'] as const;

export const MatriculaDto = z.strictObject({
  jurisdiction: z.string(),
  number: z.string(),
  status: z.enum(MATRICULA_STATUSES),
});
export type MatriculaDto = z.infer<typeof MatriculaDto>;

export const ProfessionalDto = z.strictObject({
  id: z.uuid(),
  membershipId: z.uuid(),
  fullName: z.string().nullable(),
  status: z.enum(['active', 'inactive']),
  specialties: z.array(z.string()),
  matricula: MatriculaDto.nullable(),
  maxSimultaneous: z.number().int(),
  /** Active with a recorded registration: what opens clinical work, verified or not. */
  clinicalAccess: z.boolean(),
});
export type ProfessionalDto = z.infer<typeof ProfessionalDto>;

export const StaffMemberStatus = z.enum(['active', 'deactivated']);

/**
 * A row of the staff directory. Names, roles, disciplines and locations are visible to the whole
 * staff. The email and the matricula only to those who manage staff and to the person themselves
 * (staff-professionals, "Staff directory visibility"); for everyone else they are `null`.
 */
export const StaffMemberDto = z.strictObject({
  membershipId: z.uuid(),
  displayName: z.string().nullable(),
  roles: z.array(z.enum(STAFF_ROLES)),
  status: StaffMemberStatus,
  email: z.string().nullable(),
  locations: z.array(z.strictObject({ id: z.uuid(), name: z.string() })),
  professional: z
    .strictObject({
      id: z.uuid(),
      status: z.enum(['active', 'inactive']),
      specialties: z.array(z.string()),
      matricula: MatriculaDto.nullable(),
    })
    .nullable(),
});
export type StaffMemberDto = z.infer<typeof StaffMemberDto>;

export const StaffListResponse = z.strictObject({ staff: z.array(StaffMemberDto) });
export type StaffListResponse = z.infer<typeof StaffListResponse>;

/** A person edits their own name; an owner or admin edits anyone's. Nothing privileged is here. */
export const UpdateStaffProfileRequest = z.strictObject({ displayName: PersonName });
export type UpdateStaffProfileRequest = z.infer<typeof UpdateStaffProfileRequest>;

// Weekly hours ------------------------------------------------------------------------------

export const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');

/** An interval of one weekday at one location, in THAT location's time zone. 1 is Monday. */
export const WeeklyInterval = z.strictObject({
  locationId: z.uuid(),
  weekday: z.number().int().min(1).max(7),
  start: ClockTime,
  end: z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/, 'expected HH:MM'),
});
export type WeeklyInterval = z.infer<typeof WeeklyInterval>;

/** Replaces the whole weekly schedule of the professional. */
export const SetWeeklyHoursRequest = z.strictObject({ hours: z.array(WeeklyInterval).max(200) });
export type SetWeeklyHoursRequest = z.infer<typeof SetWeeklyHoursRequest>;

export const WeeklyHoursResponse = z.strictObject({
  professionalId: z.uuid(),
  hours: z.array(WeeklyInterval),
});
export type WeeklyHoursResponse = z.infer<typeof WeeklyHoursResponse>;
