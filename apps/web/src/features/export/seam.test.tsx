import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { defaultRegistry } from '../../app/registry.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';
import { jsonResponse } from '../../shared/test/render.js';

const routes = {
  'GET /api/worklist/count': () => jsonResponse({ open: 0 }),
};
const boot = bootFor('Centro Médico Aillu');
const single = bootFor('Centro Médico Aillu', { deploymentMode: 'single' });

describe('the export registrations (the owner page, the professional page and the entry)', () => {
  it('opens /export for the owner, who receives the administrative package', async () => {
    renderApp({ me: meFor(['owner']), boot, path: '/export', routes });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Exportación' }),
    ).toBeInTheDocument();
  });

  it.each([['admin'], ['professional'], ['reception']] as const)(
    'shows the no-access screen at /export to %s',
    async (role) => {
      renderApp({ me: meFor([role]), boot, path: '/export', routes });

      expect(await screen.findByText('No tiene acceso a esta sección')).toBeInTheDocument();
    },
  );

  it('opens /export/clinical for a professional, who receives the clinical package of their own patients', async () => {
    renderApp({ me: meFor(['professional']), boot, path: '/export/clinical', routes });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Exportación clínica' }),
    ).toBeInTheDocument();
  });

  it.each([['owner'], ['admin'], ['reception']] as const)(
    'shows the no-access screen at /export/clinical to %s, who never read a clinical record',
    async (role) => {
      renderApp({ me: meFor([role]), boot, path: '/export/clinical', routes });

      expect(await screen.findByText('No tiene acceso a esta sección')).toBeInTheDocument();
    },
  );

  it('lists the entry for the owner only, in single-tenant deployments too (the operator can cancel one)', async () => {
    renderApp({ me: meFor(['owner']), boot: single, path: '/', routes });

    const links = await screen.findAllByRole('link', { name: 'Exportación' });
    expect(links.map((link) => link.getAttribute('href'))).toContain('/export');
  });

  it('does not list the entry for an admin or reception', async () => {
    renderApp({ me: meFor(['admin']), boot, path: '/calendar', routes });

    await screen.findAllByRole('navigation');
    expect(screen.queryByRole('link', { name: 'Exportación' })).not.toBeInTheDocument();
  });

  it('registers the entry with the permission of the owner and no deployment restriction', async () => {
    const registry = defaultRegistry();
    await registry.ready();
    const entry = registry.navItems.find((item) => item.id === 'export');

    expect(entry).toMatchObject({ to: '/export', anyOf: ['billing.manage'] });
    expect(entry?.multiModeOnly).toBeUndefined();
  });
});
