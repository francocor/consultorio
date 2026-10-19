import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { defaultRegistry } from '../../app/registry.js';
import { bootFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';

import routes from './routes.js';

describe('the portal seam (a shell of its own: stub of Stage 5)', () => {
  it('mounts the portal in the shell of the portal, not in the staff shell or the public frame', () => {
    expect(routes.map((route) => route.mount)).toEqual(['portal']);
    expect(defaultRegistry().routes.filter((route) => route.mount === 'portal')).toHaveLength(1);
  });

  it('opens /portal without a session and without any staff navigation', async () => {
    renderApp({ me: null, boot: bootFor('Centro Médico Aillu'), path: '/portal' });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Portal de pacientes' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });
});
