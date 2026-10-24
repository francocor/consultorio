import type { NavContribution, AnySlotContribution } from './registry.js';

/**
 * The navigation and the slot pieces of every feature, found by their file names. This module is
 * loaded with `import()` by the registry of the application (`defaultRegistry`), so it is a chunk
 * of its own that the signed-in route fetches while it asks for the profile: the sign-in page never
 * downloads it. Nothing else may import it statically, or it travels with the first bundle again.
 */
export const nav = import.meta.glob<{ default: NavContribution }>('../features/**/nav.ts', {
  eager: true,
});

export const slots = import.meta.glob<{ default: readonly AnySlotContribution[] }>(
  '../features/**/slots.tsx',
  { eager: true },
);
