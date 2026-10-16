import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library only registers its automatic cleanup when Vitest globals are enabled.
afterEach(() => {
  cleanup();
});

/** Defines a browser API jsdom lacks and Radix primitives or our UI call. */
function polyfill(target: object, name: string, value: unknown): void {
  if (Reflect.get(target, name) === undefined) {
    Object.defineProperty(target, name, { value, configurable: true, writable: true });
  }
}

if (typeof window !== 'undefined') {
  const element = window.HTMLElement.prototype;
  polyfill(element, 'scrollIntoView', () => undefined);
  polyfill(element, 'hasPointerCapture', () => false);
  polyfill(element, 'releasePointerCapture', () => undefined);
  // jsdom logs "not implemented" for these; the router scrolls and axe probes the canvas.
  Object.defineProperty(window, 'scrollTo', { value: () => undefined, configurable: true });
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'getContext', {
    value: () => null,
    configurable: true,
  });
  polyfill(window, 'matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  polyfill(
    globalThis,
    'ResizeObserver',
    class {
      observe() {
        /* jsdom has no layout engine */
      }
      unobserve() {
        /* jsdom has no layout engine */
      }
      disconnect() {
        /* jsdom has no layout engine */
      }
    },
  );
}
