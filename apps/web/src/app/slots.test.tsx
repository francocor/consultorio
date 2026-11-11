import { createRoute } from '@tanstack/react-router';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { bootFor, meFor } from '../shared/test/fixtures.js';
import { renderApp } from '../shared/test/render-app.js';

import {
  createRegistry,
  type AnySlotContribution,
  type FeatureRoute,
  type SlotContribution,
} from './registry.js';
import { SlotOutlet } from './slots.js';

/** A screen that does nothing but host a slot, like the screens that own one. */
const hostRoute: FeatureRoute = {
  mount: 'authed',
  create: (parent) =>
    createRoute({
      getParentRoute: () => parent,
      path: '/fixture-host',
      component: () => (
        <section>
          <SlotOutlet slot="settings-section" area="scheduling" />
        </section>
      ),
    }),
};

const piece = (
  id: string,
  text: string,
  extra: Partial<SlotContribution<'settings-section'>> = {},
): SlotContribution<'settings-section'> => ({
  slot: 'settings-section',
  id,
  Component: ({ area }) => (
    <p>
      {text} in {area}
    </p>
  ),
  ...extra,
});

const open = (pieces: readonly AnySlotContribution[], roles: Parameters<typeof meFor>[0]) =>
  renderApp({
    me: meFor(roles),
    boot: bootFor('Centro Médico Aillu'),
    path: '/fixture-host',
    registry: createRegistry({
      routes: { '../features/host/routes.tsx': { default: [hostRoute] } },
      nav: {},
      slots: { '../features/fixture/slots.tsx': { default: pieces } },
    }),
    routes: { 'GET /api/worklist/count': () => new Response(JSON.stringify({ open: 0 })) },
  });

describe('a slot hosts the pieces that features register for it', () => {
  it('renders every piece with the props the slot hands out, in the order they ask for', async () => {
    open(
      [piece('late', 'Late piece', { order: 50 }), piece('early', 'Early piece', { order: 5 })],
      ['owner'],
    );

    const texts = await screen.findAllByText(/piece in scheduling/);

    expect(texts.map((node) => node.textContent)).toEqual([
      'Early piece in scheduling',
      'Late piece in scheduling',
    ]);
  });

  it('hides a piece from a viewer who holds none of the permissions it asks for', async () => {
    open(
      [
        piece('open', 'Open piece'),
        piece('owner-only', 'Owner piece', { anyOf: ['booking.manage'] }),
      ],
      ['reception'],
    );

    expect(await screen.findByText('Open piece in scheduling')).toBeInTheDocument();
    expect(screen.queryByText('Owner piece in scheduling')).not.toBeInTheDocument();
  });

  it('shows the piece of the permission to a viewer who holds it', async () => {
    open([piece('owner-only', 'Owner piece', { anyOf: ['booking.manage'] })], ['owner']);

    expect(await screen.findByText('Owner piece in scheduling')).toBeInTheDocument();
  });

  it('renders nothing for a slot without pieces, and leaves the host as it was', async () => {
    open([], ['owner']);

    await waitFor(() => {
      expect(document.querySelector('section')).not.toBeNull();
    });
    expect(document.querySelector('section')?.childElementCount).toBe(0);
  });

  it('keeps the pieces of another slot out', async () => {
    const other: SlotContribution<'patient-detail-tab'> = {
      slot: 'patient-detail-tab',
      id: 'other',
      labelKey: 'patients:tab.data',
      Component: () => <p>Other slot piece</p>,
    };
    open([piece('mine', 'My piece'), other], ['owner']);

    expect(await screen.findByText('My piece in scheduling')).toBeInTheDocument();
    expect(screen.queryByText('Other slot piece')).not.toBeInTheDocument();
  });
});
