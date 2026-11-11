import { WORKLIST_KINDS, type WorklistItemDto, type WorklistKind } from '@consultorio/contracts';
import { z } from 'zod';

/**
 * One datum that the booking submitted and the record of the patient says otherwise. The producer
 * of an identity review (online booking, Stage 3) fills `detail.differences`; until then the list
 * is simply empty.
 */
const Difference = z.strictObject({
  field: z.string().min(1),
  submitted: z.string().nullable(),
  onFile: z.string().nullable(),
});
export type IdentityDifference = z.infer<typeof Difference>;

export function identityDifferences(
  detail: Record<string, unknown> | null,
): readonly IdentityDifference[] {
  const parsed = z.array(Difference).safeParse(detail?.['differences']);
  return parsed.success ? parsed.data : [];
}

/** Why a reply was left for reception, when the screen has words for it. */
export const REPLY_REASONS = [
  /** A BAJA from a number several patients share, and nobody could tell whose it was. */
  'email_optout_unconfirmed',
] as const;
export type ReplyReason = (typeof REPLY_REASONS)[number];

export function replyReason(detail: Record<string, unknown> | null): ReplyReason | null {
  const reason = detail?.['reason'];
  return REPLY_REASONS.find((known) => known === reason) ?? null;
}

/** How many items there are of each of the six kinds (the kinds with none count as zero). */
export function countByKind(items: readonly WorklistItemDto[]): Record<WorklistKind, number> {
  const counts = Object.fromEntries(WORKLIST_KINDS.map((kind) => [kind, 0])) as Record<
    WorklistKind,
    number
  >;
  for (const item of items) counts[item.kind] += 1;
  return counts;
}

/** An item of the whole organization (no location) is shown whichever location is chosen. */
export function filterItems(
  items: readonly WorklistItemDto[],
  filters: { kind?: WorklistKind | undefined; locationId?: string | undefined },
): WorklistItemDto[] {
  return items.filter(
    (item) =>
      (filters.kind === undefined || item.kind === filters.kind) &&
      (filters.locationId === undefined ||
        item.locationId === null ||
        item.locationId === filters.locationId),
  );
}
