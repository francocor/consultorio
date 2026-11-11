import { afterEach } from 'vitest';

/**
 * Makes `window.matchMedia` answer for a viewport width, so a component test can render the phone
 * layout or the desktop one. jsdom has no layout engine; without this every query is "no match",
 * which reads as a very narrow screen.
 */
export function setViewport(width: number): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const min = /\(min-width:\s*(\d+)px\)/.exec(query);
      const max = /\(max-width:\s*(\d+)px\)/.exec(query);
      const matches =
        (min === null || width >= Number(min[1])) && (max === null || width <= Number(max[1]));
      return {
        matches,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      };
    },
  });
}

/** Registers the cleanup that puts the default (no-match) `matchMedia` back after each test. */
export function resetViewportAfterEach(): void {
  afterEach(() => {
    Reflect.deleteProperty(window, 'matchMedia');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
  });
}
