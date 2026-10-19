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

describe('the consent seam (route, navigation entry and patient tab: stubs of Stage 5)', () => {
  it.each([['owner'], ['admin'], ['professional']] as const)(
    'opens /consents for %s, who manage the templates',
    async (role) => {
      renderApp({ me: meFor([role]), boot, path: '/consents', routes });

      expect(
        await screen.findByRole('heading', { level: 1, name: 'Consentimientos' }),
      ).toBeInTheDocument();
    },
  );

  it('shows the no-access screen to reception, which asks for consents but does not write them', async () => {
    renderApp({ me: meFor(['reception']), boot, path: '/consents', routes });

    expect(await screen.findByText('No tiene acceso a esta sección')).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 1, name: 'Consentimientos' }),
    ).not.toBeInTheDocument();
  });

  it.each([['owner'], ['professional']] as const)(
    'lists the entry in the navigation of %s, pointing at the route',
    async (role) => {
      renderApp({ me: meFor([role]), boot, path: '/', routes });

      const links = await screen.findAllByRole('link', { name: 'Consentimientos' });
      expect(links.map((link) => link.getAttribute('href'))).toContain('/consents');
    },
  );

  it('does not list the entry for reception', async () => {
    renderApp({ me: meFor(['reception']), boot, path: '/calendar', routes });

    await screen.findAllByRole('navigation');
    expect(screen.queryByRole('link', { name: 'Consentimientos' })).not.toBeInTheDocument();
  });

  it('registers a tab of the patient record for whoever asks for consents or runs the templates', () => {
    const tab = defaultRegistry().slots.find(
      (piece) => piece.slot === 'patient-detail-tab' && piece.id === 'consent.list',
    );

    expect(tab).toMatchObject({
      anyOf: ['consent.request', 'consent.template.manage', 'clinical.consent.read'],
      labelKey: 'consent:patientTab',
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
    const openAs = (role: 'professional' | 'reception' | 'admin' | 'patient') =>
      renderApp({
        me: meFor([role]),
        boot,
        path: '/fixture-host',
        registry: createRegistry({
          routes: { '../features/host/routes.tsx': { default: [hostRoute] } },
          nav: {},
          slots: { '../features/consent/slots.tsx': { default: slots } },
        }),
        routes,
      });

    it.each([['professional'], ['reception'], ['admin']] as const)(
      'shows %s where the consents of the patient will be',
      async (role) => {
        openAs(role);

        expect(
          await screen.findByText('Los consentimientos de este paciente aparecerán aquí.'),
        ).toBeInTheDocument();
      },
    );

    it('is not mounted for a role that holds none of the permissions', async () => {
      openAs('patient');

      await screen.findAllByRole('navigation');
      expect(
        screen.queryByText('Los consentimientos de este paciente aparecerán aquí.'),
      ).not.toBeInTheDocument();
    });
  });
});
