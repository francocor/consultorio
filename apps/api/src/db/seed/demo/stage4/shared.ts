import { STAFF_ROLES, validateCuit, type Role, type StaffRole } from '@consultorio/contracts';

import type { BillingActor } from '../../../../modules/billing/application/common.js';
import type { ScopeViewer } from '../../../../modules/billing/application/scope.js';
import type { InvoicingActor } from '../../../../modules/invoicing/application/common.js';
import { instantAtLocalMinute } from '../../../../modules/scheduling/domain/time.js';
import type { RequestContext } from '../../../../platform/db/tenant-context.js';
import type { DemoContributorContext } from '../contributors.js';

/**
 * Pieces the Stage 4 demo seeds share (billing, invoicing). Nothing here talks to the outside
 * world: the demonstration organization issues its invoices through the in-memory fake, no payment
 * leaves the process, and nothing is put on a queue.
 */

export type Stage4Context = DemoContributorContext;

/** Who does what in the seeded story. The owner sets the organization up; reception takes the money. */
export interface Stage4People {
  owner: Person;
  reception: Person;
}

export interface Person {
  userId: string;
  membershipId: string;
  roles: readonly StaffRole[];
}

export function peopleOf(context: Stage4Context): Stage4People {
  const owner = context.people.get('owner');
  if (!owner) throw new Error('The Stage 4 demo seed needs the owner of the demo organization.');
  const person = (source: {
    userId: string;
    membershipId: string;
    staff: { roles: readonly Role[] };
  }): Person => ({
    userId: source.userId,
    membershipId: source.membershipId,
    roles: STAFF_ROLES.filter((role) => source.staff.roles.includes(role)),
  });
  return { owner: person(owner), reception: person(context.reception) };
}

export function contextOf(context: Stage4Context, person: Person): RequestContext {
  return { tenantId: context.tenantId, userId: person.userId };
}

export function actorOf(person: Person): BillingActor & InvoicingActor {
  return {
    userId: person.userId,
    actingRole: person.roles.includes('owner') ? 'owner' : 'reception',
    ip: null,
    userAgent: 'demo-seed',
    requestId: null,
  };
}

export function viewerOf(person: Person): ScopeViewer & { roles: readonly StaffRole[] } {
  return { roles: person.roles, membershipId: person.membershipId, professionalId: null };
}

const DAY_MS = 86_400_000;

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The instant of a local wall-clock time (`HH:MM`) of a day at a time zone. */
export function localInstant(timeZone: string, date: string, hhmm: string): Date {
  const [hours, minutes] = hhmm.split(':').map(Number);
  return instantAtLocalMinute(timeZone, date, (hours ?? 0) * 60 + (minutes ?? 0));
}

/**
 * A CUIT that passes the check digit of the country pack, made from a number of the block the demo
 * uses (30-99xxxxxx-x): synthetic, never a real taxpayer.
 */
export function syntheticCuit(serial: number): string {
  for (let offset = 0; offset < 100; offset += 1) {
    const body = `3099${String(serial + offset).padStart(6, '0')}`;
    for (let digit = 0; digit <= 9; digit += 1) {
      const checked = validateCuit(`${body}${String(digit)}`);
      if (checked.ok) return checked.value;
    }
  }
  throw new Error('No synthetic CUIT could be built.');
}

/** `n % size` for any integer, so a cycle never runs out of range. */
export function cycle<T>(items: readonly T[], index: number): T {
  const found = items[((index % items.length) + items.length) % items.length];
  if (found === undefined) throw new Error('An empty cycle.');
  return found;
}
