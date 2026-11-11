import { createElement, lazy, Suspense, type ComponentType } from 'react';

/**
 * A slot piece whose code is fetched the first time the slot is shown. Slot contributions are
 * collected when the application starts (`registry.ts`), so a piece imported at the top of a
 * `slots.tsx` file would travel in the first bundle of every screen, the sign-in page included.
 * The piece renders nothing while its code arrives; it sits inside its own boundary, so the screen
 * that owns the slot never waits for it.
 */
export function lazySlot<Props extends object>(
  load: () => Promise<{ default: ComponentType<Props> }>,
): ComponentType<Props> {
  const Piece = lazy(load);
  return function LazySlotPiece(props: Props) {
    return createElement(Suspense, { fallback: null }, createElement(Piece, props));
  };
}
