import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach } from 'vitest';

import { installZodMessages } from '../lib/zod-i18n.js';

installZodMessages();

// A lazy screen behind a router can take longer than one second to appear on a busy machine
// (the whole suite runs in parallel). A wait that is too short is a flaky test, not a fast one.
configure({ asyncUtilTimeout: 15_000 });

// Testing Library only registers its automatic cleanup when Vitest globals are enabled.
afterEach(() => {
  cleanup();
  // The toast queue is global: one test's message must not be on screen in the next one.
  toast.dismiss();
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
