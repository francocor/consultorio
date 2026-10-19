import { createRoute } from '@tanstack/react-router';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createRegistry, defaultRegistry, type FeatureRoute } from '../../app/registry.js';
import { SlotOutlet } from '../../app/slots.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';
import { jsonResponse } from '../../shared/test/render.js';

import slots from './slots.js';

const PATIENT = '0190a000-0000-7000-8000-0000000000c1';
const boot = bootFor('Centro Médico Aillu');
const routes = { 'GET /api/worklist/count': () => jsonResponse({ open: 0 }) };

describe('the prescriptions seam (route, navigation entry and patient tab: stubs of Stage 5)', () => {
  it('opens /prescriptions for a professional, in the signed-in shell', async () => {
    renderApp({ me: meFor(['professional']), boot, path: '/prescriptions', routes });

    expect(await screen.findByRole('heading', { level: 1, name: 'Recetas' })).toBeInTheDocument();
    expect(screen.getAllByRole('navigation').length).toBeGreaterThan(0);
  });

  it.each([['reception'], ['owner'], ['admin']] as const)(
    'shows the no-access screen to %s: only a professional prescribes',
    async (role) => {
      renderApp({ me: meFor([role]), boot, path: '/prescriptions', routes });

      expect(await screen.findByText('No tiene acceso a esta sección')).toBeInTheDocument();
      expect(screen.queryByRole('heading', { level: 1, name: 'Recetas' })).not.toBeInTheDocument();
    },
  );

  it('lists the entry in the navigation of a professional, pointing at the route', async () => {
    renderApp({ me: meFor(['professional']), boot, path: '/', routes });

    const links = await screen.findAllByRole('link', { name: 'Recetas' });
    expect(links.map((link) => link.getAttribute('href'))).toContain('/prescriptions');
  });

  it('does not list the entry for reception', async () => {
    renderApp({ me: meFor(['reception']), boot, path: '/calendar', routes });

    await screen.findAllByRole('navigation');
    expect(screen.queryByRole('link', { name: 'Recetas' })).not.toBeInTheDocument();
  });

  it('registers a tab of the patient record for whoever may read prescriptions', () => {
    const tab = defaultRegistry().slots.find(
      (piece) => piece.slot === 'patient-detail-tab' && piece.id === 'prescriptions.list',
    );

    expect(tab).toMatchObject({
      anyOf: ['clinical.prescription.read'],
      labelKey: 'prescriptions:patientTab',
    });
  });

  describe('the tab piece', () => {
    const hostRoute: FeatureRoute = {
      mount: 'authed',
      create: (parent) =>
        createRoute({
          getParentRoute: () => parent,
          path: '/fixture-host',
          component: () => <SlotOutlet slot="patient-detail-tab" patientId={PATIENT} />,
        }),
    };
    const openAs = (role: 'professional' | 'reception') =>
      renderApp({
        me: meFor([role]),
        boot,
        path: '/fixture-host',
        registry: createRegistry({
          routes: { '../features/host/routes.tsx': { default: [hostRoute] } },
          nav: {},
          slots: { '../features/prescriptions/slots.tsx': { default: slots } },
        }),
        routes,
      });

    it('shows a professional where the prescriptions of the patient will be', async () => {
      openAs('professional');

      expect(
        await screen.findByText('Las recetas de este paciente aparecerán aquí.'),
      ).toBeInTheDocument();
    });

    it('shows reception nothing: the piece is not mounted without the permission', async () => {
      openAs('reception');

      await screen.findAllByRole('navigation');
      expect(
        screen.queryByText('Las recetas de este paciente aparecerán aquí.'),
      ).not.toBeInTheDocument();
    });
  });
});
