import type { BlockDto, BlockListQuery } from '@consultorio/contracts';

import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Actor } from '../../../platform/authz/actor.js';
import { calendarAccess } from '../../../platform/authz/calendar-scope.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AccessRefused } from '../../access/index.js';

import type { BlockService } from './blocks.js';
import { isAdministrative, viewsOthersCalendar } from './delegated-view.js';
import { locationAccessOf } from './location-access.js';

/** Whose calendars a viewer looks at when they name nobody: everyone, or their own calendars. */
export function defaultProfessionals(actor: Actor): string[] | 'everyone' {
  if (isAdministrative(actor)) return 'everyone';
  return [
    ...(actor.professionalId ? [actor.professionalId] : []),
    ...(actor.delegatedProfessionalIds ?? []),
  ];
}

/**
 * Which blocks a viewer sees: the ones of the calendars they look at (and the ones that name no
 * professional), inside the locations they work at (plus their own calendar, wherever it is). The
 * calendar feed and the block list apply this one rule so they cannot disagree.
 */
export function blockVisibility(scope: {
  professionals: readonly string[] | 'everyone';
  /** The assigned locations, or `null` when the viewer is not limited by location. */
  assigned: readonly string[] | null;
  own: string | null;
  locationId: string | undefined;
}): (block: BlockDto) => boolean {
  const { professionals, assigned, own, locationId } = scope;
  return (block) =>
    (professionals === 'everyone' ||
      block.professionalId === null ||
      professionals.includes(block.professionalId)) &&
    (assigned === null ||
      block.locationId === null ||
      (locationId === undefined
        ? assigned.includes(block.locationId)
        : block.locationId === locationId && assigned.includes(block.locationId)) ||
      (own !== null && block.professionalId === own));
}

/**
 * The blocks of a window as one staff member may see them (scheduling, "Calendar views"): a
 * professional reads the blocks of their own calendar and the delegated ones, reception those of
 * the locations it works at. Asking for a calendar that is not theirs, or for a location that is
 * not assigned, is a refusal, as in the calendar feed. A look at a colleague's calendar is audited.
 */
export async function listVisibleBlocks(
  tx: Tx,
  input: {
    blocks: BlockService;
    query: BlockListQuery;
    actor: Actor;
    auditActor: AuditActor & { userId: string };
  },
): Promise<BlockDto[]> {
  const { blocks, query, actor } = input;
  if (query.professionalId !== undefined && !calendarAccess(actor, query.professionalId)) {
    throw new AccessRefused('not_own_calendar');
  }
  const professionals =
    query.professionalId === undefined ? defaultProfessionals(actor) : [query.professionalId];

  const access = await locationAccessOf(tx, actor);
  const own = access.scope.kind === 'assigned' ? access.scope.ownProfessionalId : null;
  const assigned = access.scope.kind === 'all' ? null : access.assigned;
  if (query.locationId && assigned && !assigned.includes(query.locationId) && own === null) {
    throw new AccessRefused('location_not_assigned');
  }

  const visible = (await blocks.list(tx, query)).filter(
    blockVisibility({ professionals, assigned, own, locationId: query.locationId }),
  );

  if (professionals !== 'everyone' && professionals.some((id) => viewsOthersCalendar(actor, id))) {
    await audit(tx, {
      action: 'appointment.calendar_viewed',
      outcome: 'allow',
      actor: input.auditActor,
      resourceType: 'calendar',
      metadata: {
        view: 'blocks',
        professionals: professionals.length,
        from: query.from ?? null,
        to: query.to ?? null,
      },
    });
  }
  return visible;
}
