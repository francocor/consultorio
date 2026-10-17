import { createMemoryHistory } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';

import { CHECKLIST_LINKS } from '../features/onboarding/checklist-links.js';

import { createAppRouter } from './router.js';
import { createAppServices } from './services.js';

/**
 * The first run sends people to other screens ("Ir a la agenda", every item of the checklist). The
 * addresses are written as strings in the onboarding feature, so this keeps them real: each one
 * must be a route of the application.
 */
describe('the addresses the first run links to', () => {
  const services = createAppServices({
    fetch: () => Promise.reject(new Error('no network in this test')),
    isOnline: () => true,
    retry: () => false,
  });
  const router = createAppRouter({
    services,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const routes = new Set(Object.keys(router.routesByPath));

  it.each(['/calendar', '/patients/new', '/onboarding'])('%s is a route', (path) => {
    expect(routes.has(path)).toBe(true);
  });

  it.each(Object.entries(CHECKLIST_LINKS))(
    'the checklist item %s links to a route',
    (_item, link) => {
      expect(routes.has(link.to)).toBe(true);
    },
  );
});
