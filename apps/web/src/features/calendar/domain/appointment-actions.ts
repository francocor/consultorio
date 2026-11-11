import {
  APPOINTMENT_STATUSES,
  canRescheduleStatus,
  canTransitionStatus,
  isTerminalStatus,
  type AppointmentStatus,
  type Permission,
} from '@consultorio/contracts';

/** What a person can do with an appointment from the drawer, in the order they are offered. */
export const DRAWER_ACTIONS = [
  'approve',
  'confirm',
  'check_in',
  'start',
  'attend',
  'no_show',
  'cancel',
  'reschedule',
  'correct',
] as const;
export type DrawerAction = (typeof DRAWER_ACTIONS)[number];

/** The status each lifecycle action leads to; the table in `contracts` decides if it is allowed. */
const TARGET: Record<
  'approve' | 'confirm' | 'check_in' | 'start' | 'attend' | 'no_show' | 'cancel',
  AppointmentStatus
> = {
  approve: 'scheduled',
  confirm: 'confirmed',
  check_in: 'checked_in',
  start: 'in_progress',
  attend: 'attended',
  no_show: 'no_show',
  cancel: 'cancelled',
};

/** The permission the API asks for each action (`appointment-routes.ts`). */
const PERMISSION: Record<DrawerAction, Permission> = {
  approve: 'scheduling.book',
  confirm: 'scheduling.checkin',
  check_in: 'scheduling.checkin',
  start: 'scheduling.checkin',
  attend: 'scheduling.checkin',
  no_show: 'scheduling.checkin',
  cancel: 'scheduling.book',
  reschedule: 'scheduling.book',
  correct: 'scheduling.checkin',
};

export interface ActionContext {
  status: AppointmentStatus;
  startsAt: string;
  now: Date;
  permissions: readonly Permission[];
  /** The signed-in person is the professional this appointment is with. */
  isOwnProfessional: boolean;
}

/**
 * The actions worth showing: only those the lifecycle allows from the current status (the same
 * table the API enforces) and that the person's permissions cover. The API checks all of it again,
 * so a hidden action is a courtesy and never the protection.
 */
export function availableActions(context: ActionContext): DrawerAction[] {
  const granted = new Set(context.permissions);
  const started = new Date(context.startsAt).getTime() <= context.now.getTime();

  return DRAWER_ACTIONS.filter((action) => {
    if (!granted.has(PERMISSION[action])) return false;
    switch (action) {
      case 'reschedule':
        return canRescheduleStatus(context.status);
      case 'correct':
        return isTerminalStatus(context.status);
      case 'no_show':
        // A no-show cannot be recorded before the appointment was due to start.
        return canTransitionStatus(context.status, TARGET.no_show) && started;
      default:
        return canTransitionStatus(context.status, TARGET[action]);
    }
  });
}

/**
 * The statuses a terminal appointment may be corrected to. Putting it back "in progress" or
 * "attended" speaks for the clinical encounter, so only the professional it is with is offered
 * those two; for everybody else the API would refuse them. A pending approval is never offered.
 */
export function correctionTargets(
  from: AppointmentStatus,
  options: { isOwnProfessional: boolean },
): AppointmentStatus[] {
  if (!isTerminalStatus(from)) return [];
  return APPOINTMENT_STATUSES.filter(
    (to) =>
      to !== from &&
      to !== 'pending_approval' &&
      (options.isOwnProfessional || (to !== 'in_progress' && to !== 'attended')),
  );
}
