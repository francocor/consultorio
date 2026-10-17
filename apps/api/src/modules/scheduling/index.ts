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

import { createAppointmentTypeService } from './application/appointment-types.js';
import { createBlockService } from './application/blocks.js';
import { createHolidayService } from './application/holidays.js';
import { createHoursPeriodService } from './application/hours-periods.js';
import { createWorklistService, type WorklistService } from './application/worklist.js';
import { appointmentRoutes } from './http/appointment-routes.js';
import { configRoutes } from './http/config-routes.js';
import { worklistRoutes } from './http/worklist-routes.js';

export type { OpenItemInput, WorklistService } from './application/worklist.js';
export { HOLD_EXPIRE_JOB, holdExpireJob } from './application/hold-expiry.js';

export interface SchedulingOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  /** Encrypts the detail of worklist items. */
  keys: TenantKeys;
  clock?: () => Date;
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
  const config = configRoutes({
    withTenant: options.withTenant,
    auditDeny: options.auditDeny,
    types: createAppointmentTypeService(),
    blocks: createBlockService(),
    holidays: createHolidayService(),
    hoursPeriods: createHoursPeriodService(options.clock ? { clock: options.clock } : {}),
  });

  const worklist = createWorklistService({ keys: options.keys });
  const worklistApi = worklistRoutes({
    withTenant: options.withTenant,
    auditDeny: options.auditDeny,
    keys: options.keys,
    worklist,
  });
  const appointments = appointmentRoutes({
    withTenant: options.withTenant,
    keys: options.keys,
    auditDeny: options.auditDeny,
    clock: options.clock ?? (() => new Date()),
  });

  return {
    worklist,
    routes: (app) => {
      config(app);
      appointments(app);
      worklistApi(app);
    },
  };
}
