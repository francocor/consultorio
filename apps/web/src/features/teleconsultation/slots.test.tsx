import { createRoute } from '@tanstack/react-router';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createRegistry, type FeatureRoute } from '../../app/registry.js';
import { SlotOutlet } from '../../app/slots.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';
import { jsonResponse } from '../../shared/test/render.js';

import slots from './slots.js';

const APPOINTMENT = '0190a000-0000-7000-8000-0000000000a1';

const appointment = {
  id: APPOINTMENT,
  patientId: '0190a000-0000-7000-8000-0000000000c1',
  professionalId: '0190a000-0000-7000-8000-0000000000d1',
  locationId: '0190a000-0000-7000-8000-0000000000b1',
  appointmentTypeId: '0190a000-0000-7000-8000-0000000000e1',
  startsAt: '2031-05-12T13:00:00.000Z',
  endsAt: '2031-05-12T13:30:00.000Z',
  bufferMinutes: 0,
  status: 'scheduled' as const,
  source: 'staff' as const,
  bookedBy: null,
  identityConfirmed: true,
  identityConfirmation: null,
  outOfHours: false,
  seriesId: null,
  seriesIndex: null,
  version: 1,
  patientName: 'Gómez, Valentina',
  typeName: 'Consulta virtual',
  typeColor: null,
};

const hostRoute: FeatureRoute = {
  mount: 'authed',
  create: (parent) =>
    createRoute({
      getParentRoute: () => parent,
      path: '/fixture-host',
      component: () => (
        <section>
          <SlotOutlet slot="appointment-drawer" appointment={appointment} readOnly={false} />
          <SlotOutlet slot="settings-section" area="scheduling" />
        </section>
      ),
    }),
};

const summary = {
  virtual: true,
  status: 'ready',
  pendingReason: null,
  hasLink: true,
  manual: false,
  patientOpenedLink: false,
  firstOpenedAt: null,
  integrationEnabled: true,
  window: { opensAt: '2031-05-12T12:45:00.000Z', closesAt: '2031-05-12T14:30:00.000Z' },
  canJoin: false,
  canAttachManualLink: true,
  noShowAllowedFrom: '2031-05-12T13:15:00.000Z',
};

function openAs(roles: Parameters<typeof meFor>[0]) {
  return renderApp({
    me: meFor(roles),
    boot: bootFor('Centro Médico Aillu'),
    path: '/fixture-host',
    registry: createRegistry({
      routes: { '../features/host/routes.tsx': { default: [hostRoute] } },
      nav: {},
      slots: { '../features/teleconsultation/slots.tsx': { default: slots } },
    }),
    routes: {
      'GET /api/worklist/count': () => new Response(JSON.stringify({ open: 0 })),
      [`GET /api/appointments/${APPOINTMENT}/video`]: jsonResponse(summary),
      'GET /api/locations': jsonResponse({ locations: [] }),
      'GET /api/settings': jsonResponse({
        receptionSeesClinicalMetadata: false,
        clinicalSharing: false,
        sharedTemplates: [],
        require2fa: true,
        quietHours: { start: '21:00', end: '08:00' },
        notifications: {
          reminderLeadHours: [24],
          hideProfessional: false,
          hideAppointmentType: false,
        },
        onlineBooking: {
          minLeadHours: 2,
          horizonDays: 60,
          dailyCap: null,
          rescheduleDeadlineHours: 12,
          requireApproval: false,
        },
        waitlist: {
          entryExpiryDays: 60,
          offerWindowMinutes: 30,
          minOfferLeadMinutes: 60,
          maxActiveEntries: 5,
        },
        teleconsultation: { joinOpensMinutes: 15, noShowAfterMinutes: 15 },
        integrations: { whatsapp: true, video: true },
      }),
    },
  });
}

describe('what the teleconsultation feature registers', () => {
  it('registers a piece for the appointment drawer and one for the scheduling settings', () => {
    expect(slots.map((piece) => [piece.slot, piece.id])).toEqual([
      ['appointment-drawer', 'teleconsultation.video-session'],
      ['settings-section', 'teleconsultation.settings'],
    ]);
  });

  it('shows the video panel to reception, who works on the calendar, and not the organization settings', async () => {
    openAs(['reception']);

    expect(await screen.findByRole('heading', { name: 'Videoconsulta' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('switch')).toBeNull();
    });
    expect(screen.getAllByRole('heading', { name: 'Videoconsulta' })).toHaveLength(1);
  });

  it('shows the video panel and the settings section to the owner', async () => {
    openAs(['owner']);

    expect(
      await screen.findByRole('switch', { name: 'Crear las salas automáticamente' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: 'Videoconsulta' })).toHaveLength(2);
  });
});
