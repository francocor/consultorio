import {
  DEFAULT_INTEGRATION_SETTINGS,
  DEFAULT_TELECONSULTATION_SETTINGS,
  IntegrationSettings,
  TeleconsultationSettings,
  type AppointmentStatus,
} from '@consultorio/contracts';
import { and, eq } from 'drizzle-orm';

import { appointmentType } from '../../../db/schema/scheduling-config.js';
import { appointment } from '../../../db/schema/scheduling.js';
import { videoSession, type VideoSessionRow } from '../../../db/schema/teleconsultation.js';
import { location, tenant } from '../../../db/schema/tenant.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

/** What the module needs to know about the organization to decide what a video session does. */
export interface VideoPolicy {
  tenant: {
    id: string;
    slug: string;
    isDemo: boolean;
    status: 'active' | 'read_only' | 'cancelled';
  };
  /** The `integrations.video` switch: off leaves every virtual appointment to manual links. */
  integrationEnabled: boolean;
  joinOpensMinutes: number;
  noShowAfterMinutes: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The organization's video settings with their defaults. A stored value that does not pass the
 * schema counts as not set, so a bad row never switches the integration on or off by accident.
 */
export async function readVideoPolicy(tx: Tx): Promise<VideoPolicy> {
  const [row] = await tx
    .select({
      id: tenant.id,
      slug: tenant.slug,
      isDemo: tenant.isDemo,
      status: tenant.status,
      settings: tenant.settings,
    })
    .from(tenant);
  if (!row) throw new Error('This transaction has no organization.');
  const integrations = IntegrationSettings.safeParse({
    ...DEFAULT_INTEGRATION_SETTINGS,
    ...asRecord(row.settings['integrations']),
  });
  const teleconsultation = TeleconsultationSettings.safeParse({
    ...DEFAULT_TELECONSULTATION_SETTINGS,
    ...asRecord(row.settings['teleconsultation']),
  });
  return {
    tenant: {
      id: row.id,
      slug: row.slug,
      isDemo: row.isDemo,
      status: row.status === 'read_only' || row.status === 'cancelled' ? row.status : 'active',
    },
    integrationEnabled: (integrations.success ? integrations.data : DEFAULT_INTEGRATION_SETTINGS)
      .video,
    joinOpensMinutes: (teleconsultation.success
      ? teleconsultation.data
      : DEFAULT_TELECONSULTATION_SETTINGS
    ).joinOpensMinutes,
    noShowAfterMinutes: (teleconsultation.success
      ? teleconsultation.data
      : DEFAULT_TELECONSULTATION_SETTINGS
    ).noShowAfterMinutes,
  };
}

/** An appointment as the video side sees it: administrative facts only. */
export interface AppointmentVideoFacts {
  id: string;
  patientId: string;
  professionalId: string;
  locationId: string;
  startsAt: Date;
  endsAt: Date;
  status: AppointmentStatus;
  videoRoom: string | null;
  virtual: boolean;
  /** The time zone of the location, for the times the patient reads. */
  timeZone: string;
}

export async function loadAppointmentFacts(
  tx: Tx,
  appointmentId: string,
): Promise<AppointmentVideoFacts | null> {
  const [row] = await tx
    .select({
      id: appointment.id,
      patientId: appointment.patientId,
      professionalId: appointment.professionalId,
      locationId: appointment.locationId,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      status: appointment.status,
      videoRoom: appointment.videoRoom,
      mode: appointmentType.mode,
      timeZone: location.timeZone,
    })
    .from(appointment)
    .innerJoin(
      appointmentType,
      and(
        eq(appointmentType.tenantId, appointment.tenantId),
        eq(appointmentType.id, appointment.appointmentTypeId),
      ),
    )
    .innerJoin(
      location,
      and(eq(location.tenantId, appointment.tenantId), eq(location.id, appointment.locationId)),
    )
    .where(eq(appointment.id, appointmentId));
  if (!row) return null;
  return {
    id: row.id,
    patientId: row.patientId,
    professionalId: row.professionalId,
    locationId: row.locationId,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    status: row.status as AppointmentStatus,
    videoRoom: row.videoRoom,
    virtual: row.mode === 'virtual',
    timeZone: row.timeZone,
  };
}

export async function loadSession(tx: Tx, appointmentId: string): Promise<VideoSessionRow | null> {
  const [row] = await tx
    .select()
    .from(videoSession)
    .where(eq(videoSession.appointmentId, appointmentId));
  return row ?? null;
}

/** The room of an appointment is written here and nowhere else (`appointment.video_room`). */
export async function writeVideoRoom(
  tx: Tx,
  appointmentId: string,
  room: string | null,
): Promise<void> {
  await tx.update(appointment).set({ videoRoom: room }).where(eq(appointment.id, appointmentId));
}
