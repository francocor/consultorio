import type { AppointmentDto, AppointmentStatus, HolidayDto } from '@consultorio/contracts';

import type { AuditEventInput } from '../../../platform/audit/writer.js';
import type { Occupancy } from '../domain/lanes.js';
import type { HoursPeriod, HoursRow, TimeRange } from '../domain/working-hours.js';

/**
 * What the scheduling use cases need from the database, as a port. The Drizzle implementation
 * (`createSchedulingPorts`) runs inside one `withTenant` transaction; unit tests use an in-memory
 * one, so the rules (order of checks, overrides, lanes) are proven without a database. Row level
 * security applies to every call: an id of another organization is simply `null`.
 */

export interface ProfessionalRecord {
  id: string;
  membershipId: string;
  status: 'active' | 'inactive';
  /** Overbooking capacity: 1 means no overbooking. */
  maxSimultaneous: number;
  specialties: string[];
}

export interface LocationRecord {
  id: string;
  timeZone: string;
  active: boolean;
}

export interface TypeRecord {
  id: string;
  durationMinutes: number;
  bufferMinutes: number;
  active: boolean;
  requiresApproval: boolean;
  professionalIds: string[];
  specialties: string[];
}

export interface PatientRecord {
  id: string;
  status: 'active' | 'inactive';
}

/** An appointment or a hold taking time, as the occupancy table sees it. */
export interface ActiveOccupancy extends Occupancy {
  locationId: string;
  kind: 'appointment' | 'hold';
  /** The professional's origin of a hold: `public` holds can never be overbooked. */
  holdOrigin?: 'public' | 'staff';
}

export interface LaneMoveCommand {
  kind: 'appointment' | 'hold';
  id: string;
  lane: number;
}

export interface NewAppointment {
  patientId: string;
  professionalId: string;
  locationId: string;
  appointmentTypeId: string;
  startsAt: Date;
  endsAt: Date;
  bufferMinutes: number;
  lane: number;
  status: 'scheduled' | 'pending_approval';
  source: 'staff' | 'online' | 'waitlist_offer';
  bookedBy: string | null;
  identityConfirmed: boolean;
  outOfHours: boolean;
  overrideReason: string | null;
  seriesId?: string | null;
  seriesIndex?: number | null;
}

export interface NewEvent {
  appointmentId: string;
  kind:
    | 'created'
    | 'status_changed'
    | 'rescheduled'
    | 'reassigned'
    | 'status_corrected'
    | 'identity_confirmed'
    | 'identity_rejected';
  fromStatus?: string | null;
  toStatus?: string | null;
  actorUserId: string | null;
  actorKind: 'staff' | 'patient' | 'system';
  details?: Record<string, string | number | boolean | null | string[]>;
}

/** An appointment as the use cases read it (administrative data only). */
export interface AppointmentRecord {
  id: string;
  patientId: string;
  professionalId: string;
  locationId: string;
  appointmentTypeId: string;
  startsAt: Date;
  endsAt: Date;
  bufferMinutes: number;
  lane: number;
  status: AppointmentStatus;
  source: 'staff' | 'online' | 'waitlist_offer';
  bookedBy: string | null;
  identityConfirmed: boolean;
  identityConfirmedBy: string | null;
  identityConfirmation: 'staff' | 'self_confirmed' | null;
  outOfHours: boolean;
  overrideReason: string | null;
  videoRoom: string | null;
  seriesId: string | null;
  seriesIndex: number | null;
  version: number;
}

/** What a use case may change on an appointment. The version is bumped by the port. */
export interface AppointmentPatch {
  status?: AppointmentStatus;
  startsAt?: Date;
  endsAt?: Date;
  professionalId?: string;
  locationId?: string;
  lane?: number;
  identityConfirmed?: boolean;
  identityConfirmedBy?: string | null;
  identityConfirmation?: 'staff' | 'self_confirmed' | null;
  outOfHours?: boolean;
  overrideReason?: string | null;
  videoRoom?: string | null;
  cancelledByKind?: 'patient' | 'professional' | 'organization' | null;
  cancelReason?: string | null;
  cancelNote?: string | null;
  cancelledAt?: Date | null;
  lateCancellation?: boolean | null;
  patientId?: string;
}

export interface SchedulingPorts {
  /** Takes the row lock that serializes every write of one professional (design 4.6). */
  lockProfessional(id: string): Promise<ProfessionalRecord | null>;
  findLocation(id: string): Promise<LocationRecord | null>;
  findType(id: string): Promise<TypeRecord | null>;
  findPatient(id: string): Promise<PatientRecord | null>;
  /** Marks the professional's holds that ran out as expired (lazy expiry under the lock). */
  expireHolds(professionalId: string, now: Date): Promise<void>;
  hours(
    professionalId: string,
    locationId: string,
    fromDate: string,
    toDate: string,
  ): Promise<{ weekly: HoursRow[]; periods: HoursPeriod[] }>;
  /** Live blocks of the professional (or of the location) that touch the range. */
  blocks(professionalId: string, locationId: string, range: TimeRange): Promise<TimeRange[]>;
  /** The merged holiday calendar between two local dates, both included. */
  holidays(fromDate: string, toDate: string): Promise<HolidayDto[]>;
  /** Active occupancies of the professional that overlap the range. */
  occupancies(professionalId: string, range: TimeRange): Promise<ActiveOccupancy[]>;
  invalidateHolds(holdIds: readonly string[]): Promise<void>;
  /** Changes lanes with the no-overlap constraint deferred, so several rows can swap. */
  applyLaneMoves(moves: readonly LaneMoveCommand[]): Promise<void>;
  /** Inserts the appointment. Returns `slot_taken` when the database refused the overlap (23P01). */
  insertAppointment(
    values: NewAppointment,
  ): Promise<{ ok: true; appointment: AppointmentDto } | { ok: false; reason: 'slot_taken' }>;
  /** Reads an appointment; `lock` takes the row lock (FOR UPDATE) so a change cannot interleave. */
  findAppointment(id: string, options?: { lock?: boolean }): Promise<AppointmentRecord | null>;
  /** Writes the changes and bumps the version. */
  updateAppointment(id: string, patch: AppointmentPatch): Promise<AppointmentDto>;
  /** The organization's late-cancellation window, in hours (default 24). */
  lateCancellationHours(): Promise<number>;
  insertEvent(event: NewEvent): Promise<void>;
  audit(event: AuditEventInput): Promise<void>;
}
