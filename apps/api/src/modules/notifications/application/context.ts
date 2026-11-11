import { eq } from 'drizzle-orm';

import { membership } from '../../../db/schema/identity.js';
import { appointmentType } from '../../../db/schema/scheduling-config.js';
import { appointment } from '../../../db/schema/scheduling.js';
import { professional } from '../../../db/schema/staff.js';
import { location, tenant } from '../../../db/schema/tenant.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

/** What a sending job needs to know about the organization at the moment it runs. */
export interface TenantState {
  id: string;
  slug: string;
  status: 'active' | 'read_only' | 'cancelled';
  isDemo: boolean;
}

export async function loadTenantState(tx: Tx, tenantId: string): Promise<TenantState | null> {
  const [row] = await tx
    .select({
      id: tenant.id,
      slug: tenant.slug,
      status: tenant.status,
      isDemo: tenant.isDemo,
    })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  if (!row) return null;
  return {
    ...row,
    status: row.status === 'read_only' || row.status === 'cancelled' ? row.status : 'active',
  };
}

/** An appointment as a message needs it: when, where, with whom, and what state it is in. */
export interface AppointmentContext {
  id: string;
  patientId: string;
  professionalId: string;
  locationId: string;
  appointmentTypeId: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  version: number;
  locationName: string;
  timeZone: string;
  /** Null when the member has no display name. */
  professionalName: string | null;
  appointmentTypeName: string;
  /** True for a video consultation, which the reminder gives a join address. */
  virtual: boolean;
}

export async function loadAppointment(
  tx: Tx,
  appointmentId: string,
): Promise<AppointmentContext | null> {
  const [row] = await tx
    .select({
      id: appointment.id,
      patientId: appointment.patientId,
      professionalId: appointment.professionalId,
      locationId: appointment.locationId,
      appointmentTypeId: appointment.appointmentTypeId,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      status: appointment.status,
      version: appointment.version,
      locationName: location.name,
      timeZone: location.timeZone,
      professionalName: membership.displayName,
      appointmentTypeName: appointmentType.name,
      mode: appointmentType.mode,
    })
    .from(appointment)
    .innerJoin(location, eq(location.id, appointment.locationId))
    .innerJoin(appointmentType, eq(appointmentType.id, appointment.appointmentTypeId))
    .innerJoin(professional, eq(professional.id, appointment.professionalId))
    .innerJoin(membership, eq(membership.id, professional.membershipId))
    .where(eq(appointment.id, appointmentId));
  if (!row) return null;
  const { mode, ...rest } = row;
  return { ...rest, virtual: mode === 'virtual' };
}
