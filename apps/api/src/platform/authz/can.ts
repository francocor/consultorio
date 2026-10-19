import {
  PERMISSIONS,
  PORTAL_ACTOR_PERMISSIONS,
  ROLES,
  effectivePermissions,
  isClinicalPermission,
  type Permission,
} from '@consultorio/contracts';

import type { Actor } from './actor.js';
import { calendarAccess } from './calendar-scope.js';

/** Why a request was denied. Goes to the audit entry, never to the client. */
export type DenyReason =
  /** The action is not in the permission catalog: unknown means no. */
  | 'unknown_action'
  /** The actor is malformed (no role, no tenant): evaluation fails closed. */
  | 'invalid_actor'
  /** The resource belongs to another tenant. */
  | 'cross_tenant'
  /** The role and the grants of the user do not include the permission. */
  | 'not_permitted'
  /** A clinical permission, and the user has no professional profile that passed the gate. */
  | 'professional_gate'
  /** A patient session reached a staff action. */
  | 'patient_on_staff_route'
  /** The action works in the calendar of a professional the actor was not given (scheduling). */
  | 'not_own_calendar';

export type Decision = { allowed: true } | { allowed: false; reason: DenyReason };

/** What the action is about, when the route already knows. */
export interface Resource {
  tenantId?: string;
  /** The professional whose calendar the action touches: a professional works in their own. */
  calendarOf?: string;
}

function isPermission(value: string): value is Permission {
  return PERMISSIONS.some((permission) => permission === value);
}

function isPortalActorPermission(action: Permission): boolean {
  return PORTAL_ACTOR_PERMISSIONS.some((permission) => permission === action);
}

const deny = (reason: DenyReason): Decision => ({ allowed: false, reason });

/**
 * The authorization decision (ADR-003): may this actor do this action on this resource?
 *
 * RBAC answers "does the role allow it": the permissions of the roles in the code catalog plus
 * the grants of the user that are on the grantable list. Grants outside that list are ignored, so
 * no grant can ever add a clinical or administrative permission. A clinical permission also needs
 * the professional gate: only an active profile with a recorded valid matricula gives the actor a
 * `professionalId`, and an owner or admin never reaches clinical content through their role.
 *
 * Every doubt is a denial: an unknown action, a malformed actor, an unknown role, a resource of
 * another tenant. Sharing-scope rules (which entries a professional may read) are separate and
 * apply after this check passes (`sharing-scope.ts`).
 */
export function can(actor: Actor, action: string, resource: Resource = {}): Decision {
  if (!isPermission(action)) return deny('unknown_action');

  if (actor.kind === 'patient') {
    // A patient session only ever holds the permissions of the portal actor, whatever else it claims
    // to hold. The prefix is not the rule: `portal.manage` is the staff's, to run the accounts.
    return isPortalActorPermission(action) ? { allowed: true } : deny('patient_on_staff_route');
  }

  if (
    actor.tenantId === '' ||
    actor.roles.length === 0 ||
    actor.roles.some((role) => !ROLES.includes(role))
  ) {
    return deny('invalid_actor');
  }
  if (resource.tenantId !== undefined && resource.tenantId !== actor.tenantId) {
    return deny('cross_tenant');
  }

  if (!effectivePermissions(actor.roles, actor.grants).includes(action))
    return deny('not_permitted');
  if (isClinicalPermission(action) && actor.professionalId === null)
    return deny('professional_gate');
  if (resource.calendarOf !== undefined && !calendarAccess(actor, resource.calendarOf)) {
    return deny('not_own_calendar');
  }
  return { allowed: true };
}
