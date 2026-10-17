import { randomBytes } from 'node:crypto';

import type {
  BookingLinkDto,
  BookingLinksResponse,
  CreateBookingLinkRequest,
  UpdateBookingLinkRequest,
} from '@consultorio/contracts';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { bookingLink, type BookingLinkRow } from '../../../db/schema/online-booking.js';
import { appointmentType } from '../../../db/schema/scheduling-config.js';
import { professional } from '../../../db/schema/staff.js';
import { location } from '../../../db/schema/tenant.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { slugFromBytes } from '../domain/booking-rules.js';

type Actor = AuditActor & { userId: string };

export interface LinkService {
  list(tx: Tx): Promise<BookingLinksResponse>;
  create(
    tx: Tx,
    input: { actor: Actor; request: CreateBookingLinkRequest },
  ): Promise<BookingLinkDto>;
  update(
    tx: Tx,
    input: { actor: Actor; id: string; request: UpdateBookingLinkRequest },
  ): Promise<BookingLinkDto>;
  regenerate(tx: Tx, input: { actor: Actor; id: string; now: Date }): Promise<BookingLinkDto>;
}

const SLUG_CONSTRAINT = 'booking_link_slug_key';
const UNIQUE_VIOLATION = '23505';

function violation(error: unknown): { code?: string; constraint?: string } {
  const cause = (error as { cause?: { code?: unknown; constraint?: unknown } } | null)?.cause;
  return {
    ...(typeof cause?.code === 'string' ? { code: cause.code } : {}),
    ...(typeof cause?.constraint === 'string' ? { constraint: cause.constraint } : {}),
  };
}

/** The address a visitor opens: the organization page, or a professional page under it. */
function pathOf(row: BookingLinkRow, organizationSlug: string | undefined): string | null {
  if (row.professionalId === null) return `/book/${row.slug}`;
  return organizationSlug === undefined ? null : `/book/${organizationSlug}/p/${row.slug}`;
}

function toDto(row: BookingLinkRow, organizationSlug: string | undefined): BookingLinkDto {
  return {
    id: row.id,
    professionalId: row.professionalId,
    slug: row.slug,
    enabled: row.enabled,
    locationIds: row.locationIds,
    typeIds: row.typeIds,
    regeneratedAt: row.regeneratedAt?.toISOString() ?? null,
    path: pathOf(row, organizationSlug),
  };
}

function fieldError(path: string, i18nKey: string): AppError {
  return new AppError('validation_failed', [{ path, i18nKey }]);
}

async function organizationSlugOf(tx: Tx): Promise<string | undefined> {
  const [row] = await tx
    .select({ slug: bookingLink.slug })
    .from(bookingLink)
    .where(isNull(bookingLink.professionalId));
  return row?.slug;
}

/** Every id must be a live row of the organization (another organization's look missing). */
async function assertTypes(tx: Tx, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const found = await tx
    .select({ id: appointmentType.id })
    .from(appointmentType)
    .where(and(inArray(appointmentType.id, [...ids]), eq(appointmentType.active, true)));
  if (found.length !== new Set(ids).size) {
    throw fieldError('typeIds', 'booking.link.type_unknown');
  }
}

async function assertLocations(tx: Tx, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const found = await tx
    .select({ id: location.id })
    .from(location)
    .where(and(inArray(location.id, [...ids]), eq(location.active, true)));
  if (found.length !== new Set(ids).size) {
    throw fieldError('locationIds', 'booking.link.location_unknown');
  }
}

function auditEntry(
  row: BookingLinkRow,
  action: Parameters<typeof audit>[1]['action'],
  actor: Actor,
) {
  return {
    action,
    outcome: 'allow' as const,
    actor,
    resourceType: 'booking_link',
    resourceId: row.id,
    metadata: {
      scope: row.professionalId === null ? 'organization' : 'professional',
      ...(row.professionalId === null ? {} : { professionalId: row.professionalId }),
    },
  };
}

/**
 * The staff side of the public links (online-booking, "Public booking links"): enable, disable,
 * regenerate and choose what a link exposes. A link is never deleted; regenerating it replaces the
 * slug, so the old address stops resolving in the same transaction.
 */
export function createLinkService(
  options: { randomBytes?: (size: number) => Uint8Array } = {},
): LinkService {
  const random = options.randomBytes ?? ((size: number) => randomBytes(size));

  /** Inserts a link with a fresh slug; a slug someone else holds is drawn again. */
  async function insertLink(
    tx: Tx,
    values: Omit<typeof bookingLink.$inferInsert, 'slug' | 'tenantId'>,
  ): Promise<BookingLinkRow> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const [row] = await tx.transaction((inner) =>
          inner
            .insert(bookingLink)
            .values({
              ...values,
              tenantId: sql`current_setting('app.tenant_id')::uuid`,
              slug: slugFromBytes(random(16)),
            })
            .returning(),
        );
        if (!row) throw new Error('booking link insert returned no row');
        return row;
      } catch (error) {
        const { code, constraint } = violation(error);
        if (code === UNIQUE_VIOLATION && constraint === SLUG_CONSTRAINT) continue;
        if (code === UNIQUE_VIOLATION) throw new AppError('conflict');
        throw error;
      }
    }
    throw new Error('Could not find a free booking slug');
  }

  async function lockLink(tx: Tx, id: string): Promise<BookingLinkRow> {
    const [row] = await tx.select().from(bookingLink).where(eq(bookingLink.id, id)).for('update');
    if (!row) throw new AppError('not_found');
    return row;
  }

  return {
    async list(tx) {
      const rows = await tx
        .select()
        .from(bookingLink)
        .orderBy(asc(bookingLink.professionalId), asc(bookingLink.createdAt), asc(bookingLink.id));
      const organization = rows.find((row) => row.professionalId === null)?.slug;
      // The organization link first, then the professionals in the order they were given a link.
      const ordered = [
        ...rows.filter((row) => row.professionalId === null),
        ...rows.filter((row) => row.professionalId !== null),
      ];
      return { links: ordered.map((row) => toDto(row, organization)) };
    },

    async create(tx, input) {
      const { request } = input;
      const types = request.typeIds ?? [];
      const locations = request.locationIds ?? [];
      if (request.professionalId === undefined) {
        // The organization link carries no types or locations: each professional chooses theirs.
        if (types.length > 0) throw fieldError('typeIds', 'booking.link.organization_has_none');
        if (locations.length > 0) {
          throw fieldError('locationIds', 'booking.link.organization_has_none');
        }
        const existing = await organizationSlugOf(tx);
        if (existing !== undefined) throw new AppError('conflict');
        const row = await insertLink(tx, {
          professionalId: null,
          enabled: request.enabled ?? false,
        });
        if (row.enabled) await audit(tx, auditEntry(row, 'booking.link.enabled', input.actor));
        return toDto(row, row.slug);
      }

      const [owner] = await tx
        .select({ id: professional.id, status: professional.status })
        .from(professional)
        .where(eq(professional.id, request.professionalId));
      if (!owner) throw new AppError('not_found');
      if (owner.status !== 'active') throw new AppError('conflict');
      await assertTypes(tx, types);
      await assertLocations(tx, locations);

      let organizationSlug = await organizationSlugOf(tx);
      if (organizationSlug === undefined) {
        // A professional link lives under the organization link; it exists (disabled) from here on.
        organizationSlug = (await insertLink(tx, { professionalId: null, enabled: false })).slug;
      }
      const row = await insertLink(tx, {
        professionalId: request.professionalId,
        enabled: request.enabled ?? false,
        typeIds: [...new Set(types)],
        locationIds: [...new Set(locations)],
      });
      if (row.enabled) await audit(tx, auditEntry(row, 'booking.link.enabled', input.actor));
      return toDto(row, organizationSlug);
    },

    async update(tx, input) {
      const current = await lockLink(tx, input.id);
      const { request } = input;
      if (current.professionalId === null) {
        if (request.typeIds !== undefined) {
          throw fieldError('typeIds', 'booking.link.organization_has_none');
        }
        if (request.locationIds !== undefined) {
          throw fieldError('locationIds', 'booking.link.organization_has_none');
        }
      }
      if (request.typeIds !== undefined) await assertTypes(tx, request.typeIds);
      if (request.locationIds !== undefined) await assertLocations(tx, request.locationIds);

      const [row] = await tx
        .update(bookingLink)
        .set({
          ...(request.enabled === undefined ? {} : { enabled: request.enabled }),
          ...(request.typeIds === undefined ? {} : { typeIds: [...new Set(request.typeIds)] }),
          ...(request.locationIds === undefined
            ? {}
            : { locationIds: [...new Set(request.locationIds)] }),
        })
        .where(eq(bookingLink.id, current.id))
        .returning();
      if (!row) throw new AppError('not_found');
      if (request.enabled !== undefined && request.enabled !== current.enabled) {
        await audit(
          tx,
          auditEntry(
            row,
            request.enabled ? 'booking.link.enabled' : 'booking.link.disabled',
            input.actor,
          ),
        );
      }
      return toDto(row, await organizationSlugOf(tx));
    },

    async regenerate(tx, input) {
      const current = await lockLink(tx, input.id);
      let row: BookingLinkRow | undefined;
      for (let attempt = 0; attempt < 5 && row === undefined; attempt += 1) {
        try {
          [row] = await tx.transaction((inner) =>
            inner
              .update(bookingLink)
              .set({ slug: slugFromBytes(random(16)), regeneratedAt: input.now })
              .where(eq(bookingLink.id, current.id))
              .returning(),
          );
        } catch (error) {
          const { code, constraint } = violation(error);
          if (!(code === UNIQUE_VIOLATION && constraint === SLUG_CONSTRAINT)) throw error;
        }
      }
      if (!row) throw new Error('Could not find a free booking slug');
      await audit(tx, auditEntry(row, 'booking.link.regenerated', input.actor));
      return toDto(row, await organizationSlugOf(tx));
    },
  };
}
