/**
 * Public API of the scheduling module: appointment types, blocks, days off and the holiday
 * calendar, working hours for a range of dates, and (later slices) booking, the appointment
 * lifecycle, holds, availability and the reception worklist. Other modules and the composition
 * root import from here only.
 */
import type { FastifyInstance } from 'fastify';

import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';

import { createAppointmentTypeService } from './application/appointment-types.js';
import { createBlockService } from './application/blocks.js';
import { createHolidayService } from './application/holidays.js';
import { createHoursPeriodService } from './application/hours-periods.js';
import { appointmentRoutes } from './http/appointment-routes.js';
import { configRoutes } from './http/config-routes.js';

export interface SchedulingOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  clock?: () => Date;
}

export interface Scheduling {
  /** The HTTP routes of the module. */
  routes: (app: FastifyInstance) => void;
}

export function createScheduling(options: SchedulingOptions): Scheduling {
  const config = configRoutes({
    withTenant: options.withTenant,
    auditDeny: options.auditDeny,
    types: createAppointmentTypeService(),
    blocks: createBlockService(),
    holidays: createHolidayService(),
    hoursPeriods: createHoursPeriodService(options.clock ? { clock: options.clock } : {}),
  });

  const appointments = appointmentRoutes({
    withTenant: options.withTenant,
    auditDeny: options.auditDeny,
    clock: options.clock ?? (() => new Date()),
  });

  return {
    routes: (app) => {
      config(app);
      appointments(app);
    },
  };
}
