import type { CalendarEntryDto, ChargeDto, InvoiceDto } from '@consultorio/contracts';
import { createRoute } from '@tanstack/react-router';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { createRegistry, type FeatureRoute } from '../../app/registry.js';
import { SlotOutlet } from '../../app/slots.js';
import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp, type RenderedApp } from '../../shared/test/render-app.js';
import { jsonResponse } from '../../shared/test/render.js';

import slots from './slots.js';
import {
  charge,
  fullyInvoiced,
  IDS,
  invoice,
  monotributoOptions,
  pending,
  readyToIssue,
} from './test-fixtures.js';

/**
 * The invoices of the charge, in the appointment drawer (S4.13, task 4.55: "issue flow from a
 * charge"): under the charge, what was invoiced and the actions to ask for another.
 */

const entry = (readOnly = false) => ({
  entry: {
    id: IDS.appointment,
    patientId: IDS.patient,
    professionalId: IDS.professional,
    locationId: IDS.location,
    appointmentTypeId: '0190a000-0000-7000-8000-0000000000e1',
    startsAt: '2031-05-12T13:00:00.000Z',
    endsAt: '2031-05-12T13:30:00.000Z',
    bufferMinutes: 0,
    status: 'checked_in' as const,
    source: 'staff' as const,
    bookedBy: null,
    identityConfirmed: true,
    identityConfirmation: null,
    outOfHours: false,
    seriesId: null,
    seriesIndex: null,
    version: 1,
    patientName: 'Fernández, Lucía',
    typeName: 'Consulta',
    typeColor: null,
    mode: 'in_person' as const,
  } satisfies CalendarEntryDto,
  readOnly,
});

const hostRoute = (readOnly: boolean): FeatureRoute => ({
  mount: 'authed',
  create: (parent) =>
    createRoute({
      getParentRoute: () => parent,
      path: '/fixture-host',
      component: () => (
        <section>
          <SlotOutlet
            slot="appointment-drawer"
            appointment={entry(readOnly).entry}
            readOnly={readOnly}
          />
        </section>
      ),
    }),
});

let current: RenderedApp | undefined;
afterEach(() => {
  expect(current?.missingKeys ?? []).toEqual([]);
  current = undefined;
});

function open({
  roles = ['reception'],
  readOnly = false,
  charges = [charge()],
  invoices = [],
}: {
  roles?: Parameters<typeof meFor>[0];
  readOnly?: boolean;
  charges?: ChargeDto[];
  invoices?: InvoiceDto[];
} = {}) {
  current = renderApp({
    me: meFor(roles),
    boot: bootFor('Centro Médico Aillu'),
    path: '/fixture-host',
    registry: createRegistry({
      routes: { '../features/host/routes.tsx': { default: [hostRoute(readOnly)] } },
      nav: {},
      slots: { '../features/invoicing/slots.tsx': { default: slots } },
    }),
    routes: {
      'GET /api/worklist/count': () => jsonResponse({ open: 0 }),
      'GET /api/billing/charges': () => jsonResponse({ charges }),
      'GET /api/invoices': () => jsonResponse({ invoices, outageThresholdHours: 24 }),
      'GET /api/invoicing/readiness': () => jsonResponse(readyToIssue),
      'GET /api/invoicing/options': () => jsonResponse(monotributoOptions),
    },
  });
  return current;
}

describe('the invoices of the charge of an appointment', () => {
  it('draws nothing while the appointment has no charge', async () => {
    open({ charges: [] });

    await waitFor(() => {
      expect(current?.requests).toContain('GET /api/billing/charges');
    });
    expect(screen.queryByRole('heading', { name: 'Facturación' })).not.toBeInTheDocument();
  });

  it('says the charge has no invoices yet and offers to invoice it', async () => {
    open();

    const section = await screen.findByRole('region', { name: 'Facturación' });

    expect(
      await within(section).findByText('Este cobro todavía no tiene facturas.'),
    ).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Facturar' })).toBeInTheDocument();
  });

  it('lists the invoices that cover the charge with their state', async () => {
    open({ invoices: [invoice(), pending(5, { id: '0190a000-0000-7000-8000-0000000000b2' })] });

    const list = await screen.findByRole('list', { name: 'Facturas del cobro' });

    expect(within(list).getByText('Factura C 0001-00000077')).toBeInTheDocument();
    expect(within(list).getByText('Emitida')).toBeInTheDocument();
    expect(within(list).getByText('Pendiente')).toBeInTheDocument();
  });

  it('opens the dialog to invoice the charge', async () => {
    open();

    await userEvent.click(await screen.findByRole('button', { name: 'Facturar' }));

    expect(await screen.findByRole('dialog', { name: 'Facturar' })).toBeInTheDocument();
  });

  it('offers the manual entry to the owner and not to reception', async () => {
    open({ roles: ['reception'] });
    await screen.findByRole('button', { name: 'Facturar' });
    expect(
      screen.queryByRole('button', { name: 'Registrar factura emitida por fuera' }),
    ).not.toBeInTheDocument();
  });

  it('offers the manual entry to the owner', async () => {
    open({ roles: ['owner'] });

    expect(
      await screen.findByRole('button', { name: 'Registrar factura emitida por fuera' }),
    ).toBeInTheDocument();
  });

  it('offers no action when the charge is invoiced in full or the drawer is read-only', async () => {
    const full = fullyInvoiced();
    open({ charges: [full], invoices: [invoice()] });
    await screen.findByRole('list', { name: 'Facturas del cobro' });
    expect(screen.queryByRole('button', { name: 'Facturar' })).not.toBeInTheDocument();
  });

  it('offers no action in a read-only drawer', async () => {
    open({ readOnly: true });

    await screen.findByRole('region', { name: 'Facturación' });
    expect(screen.queryByRole('button', { name: 'Facturar' })).not.toBeInTheDocument();
  });

  it('is not there for a professional, who does not issue invoices', async () => {
    open({ roles: ['professional'] });

    // The drawer of the host is there; the piece of invoicing is not mounted, so it asks for nothing.
    await waitFor(() => {
      expect(document.querySelector('section')).not.toBeNull();
    });
    expect(screen.queryByRole('region', { name: 'Facturación' })).not.toBeInTheDocument();
    expect(current?.requests).not.toContain('GET /api/billing/charges');
  });

  it('has no accessibility violations', async () => {
    const app = open({ invoices: [invoice()] });
    await screen.findByRole('list', { name: 'Facturas del cobro' });

    expect(await a11yViolations(app.container)).toEqual([]);
  });
});
