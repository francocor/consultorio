import { useQuery } from '@tanstack/react-query';
import { createElement } from 'react';

import { useApi, useServices } from './providers.js';
import type { SlotContribution, SlotName, SlotProps } from './registry.js';
import { hasAnyPermission, meQueryOptions } from './session.js';

/**
 * The pieces features registered for a slot (`features/<feature>/slots.tsx`) that the signed-in
 * user may see, in order. A screen that owns a slot calls this when it needs to lay the pieces out
 * itself (the tabs of the patient record); otherwise it mounts a `SlotOutlet`.
 */
export function useSlot<S extends SlotName>(slot: S): SlotContribution<S>[] {
  const { registry } = useServices();
  // Not `useMe`: a slot sits inside screens that a test (or a loading state) may render before the
  // profile arrived, and a piece that asks for a permission is simply not shown until it does.
  const { data: me } = useQuery(meQueryOptions(useApi()));
  const held = me?.permissions ?? [];
  const pieces: SlotContribution<S>[] = [];
  for (const contribution of registry.slots) {
    if (contribution.slot !== slot) continue;
    if (contribution.anyOf && !hasAnyPermission(held, contribution.anyOf)) continue;
    // The registry keeps one list for every slot; the check above is what makes this one S.
    pieces.push(contribution as unknown as SlotContribution<S>);
  }
  return pieces;
}

/** Renders every piece registered for the slot, each with the props the slot hands out. */
export function SlotOutlet<S extends SlotName>({ slot, ...props }: { slot: S } & SlotProps[S]) {
  const pieces = useSlot(slot);
  // The props of the slot are the ones every piece of that slot declares (SlotProps[S]).
  const slotProps = props as unknown as SlotProps[S];
  return (
    <>{pieces.map((piece) => createElement(piece.Component, { key: piece.id, ...slotProps }))}</>
  );
}
