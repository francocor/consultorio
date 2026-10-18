/**
 * Public API of the scheduling module: appointment types, blocks, days off and the holiday
 * calendar, working hours for a range of dates, and (later slices) booking, the appointment
 * lifecycle, holds, availability and the reception worklist. Other modules and the composition
 * root import from here only.
 */
import type { FastifyInstance } from 'fastify';

import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { TenantKeys } from '../../platform/crypto/tenant-keys.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { AppointmentEvents } from '../../platform/events/appointment-events.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { createAppointmentTypeService } from './application/appointment-types.js';
import { createBlockService } from './application/blocks.js';
import { createCalendar } from './application/calendar.js';
import { exportScheduling } from './application/export-contributor.js';
import { createHolidayService } from './application/holidays.js';
import { createHoursPeriodService } from './application/hours-periods.js';
import { createWorklistService, type WorklistService } from './application/worklist.js';
import { appointmentRoutes } from './http/appointment-routes.js';
import { configRoutes } from './http/config-routes.js';
import { planningRoutes } from './http/planning-routes.js';
import { worklistRoutes } from './http/worklist-routes.js';

export {
  findCareSourceAppointment,
  type CareSourceAppointment,
} from './application/care-source.js';
export type { OpenItemInput, WorklistService } from './application/worklist.js';
export { createAppointmentTypeService } from './application/appointment-types.js';
export type { AppointmentTypeService } from './application/appointment-types.js';
export { HOLD_EXPIRE_JOB, holdExpireJob } from './application/hold-expiry.js';

// The use cases the capability modules of Stage 3 (online booking, the waitlist, notifications,
// teleconsultation) call: they book, move, hold and read availability through here, never through
// the files of this module.
export { availability } from './application/availability.js';
export { bookAppointment } from './application/book-appointment.js';
export type { BookInput } from './application/book-appointment.js';
export { createSchedulingPorts } from './application/drizzle-ports.js';
export { createHold, HOLD_MINUTES, releaseHold } from './application/holds.js';
export { rescheduleAppointment, transitionAppointment } from './application/lifecycle.js';
export type { RescheduleInput, TransitionInput } from './application/lifecycle.js';
export { SlotNoLongerAvailableError, SlotTakenError } from './application/placement.js';
export type { BookActor } from './application/placement.js';
export type { SchedulingPorts } from './application/ports.js';

// What the reports module reads (Stage 4, Track B): counts, hours and the appointments behind them.
export {
  appointmentRecords,
  availableMinutes,
  operationalFacts,
  reportProfessionals,
} from './application/report-facts.js';
export type {
  AppointmentRecord,
  AttendanceFigures,
  OperationalFacts,
  ReportAppointmentScope,
  ReportCohort,
  ReportProfessional,
} from './application/report-facts.js';

/** Registers what scheduling takes with an organization that leaves (the cancellation export). */
export function registerSchedulingExportContributors(registry: ExportRegistry): void {
  registry.registerExportContributor('administrative', 'scheduling', exportScheduling);
}

export interface SchedulingOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  /** Encrypts the detail of worklist items. */
  keys: TenantKeys;
  clock?: () => Date;
  /**
   * The appointment event bus: every booking, move, status change and freed slot is published to
   * it inside the transaction of the write. Absent, nothing is published (scripts, some tests).
   */
  events?: AppointmentEvents;
}

export interface Scheduling {
  /** The HTTP routes of the module. */
  routes: (app: FastifyInstance) => void;
  /**
   * The reception worklist. Other capabilities (online booking, notifications, waitlist) add their
   * items with `worklist.openItem`, in their own transaction, instead of keeping queues of their own.
   */
  worklist: WorklistService;
}

export function createScheduling(options: SchedulingOptions): Scheduling {
  const blocks = createBlockService({ events: options.events });
  const holidays = createHolidayService();
  const config = configRoutes({
    withTenant: options.withTenant,
    auditDeny: options.auditDeny,
    types: createAppointmentTypeService(),
    blocks,
    holidays,
    hoursPeriods: createHoursPeriodService(options.clock ? { clock: options.clock } : {}),
  });

  const worklist = createWorklistService({ keys: options.keys });
  const worklistApi = worklistRoutes({
    withTenant: options.withTenant,
    auditDeny: options.auditDeny,
    keys: options.keys,
    events: options.events,
    worklist,
  });
  const planning = planningRoutes({
    withTenant: options.withTenant,
    auditDeny: options.auditDeny,
    keys: options.keys,
    events: options.events,
    clock: options.clock ?? (() => new Date()),
  });
  const appointments = appointmentRoutes({
    withTenant: options.withTenant,
    keys: options.keys,
    events: options.events,
    auditDeny: options.auditDeny,
    clock: options.clock ?? (() => new Date()),
    calendar: createCalendar({ blocks, holidays }),
  });

  return {
    worklist,
    routes: (app) => {
      config(app);
      // Registered before the appointment routes: `/appointments/series` is not an appointment id.
      planning(app);
      appointments(app);
      worklistApi(app);
    },
  };
}
