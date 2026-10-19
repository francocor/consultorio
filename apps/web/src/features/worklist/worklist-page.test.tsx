import type { WorklistItemDto } from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';
import {
  jsonBody,
  jsonResponse,
  problemResponse,
  type FetchHandler,
} from '../../shared/test/render.js';
import { IDS, LOCATIONS, PROFESSIONALS, entry } from '../calendar/fixtures.js';
import { SUMMARIES } from '../patients/fixtures.js';

const ITEM = (n: number) => `0190a000-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`;

function item(overrides: Partial<WorklistItemDto>): WorklistItemDto {
  return {
    id: ITEM(1),
    kind: 'identity_review',
    subjectType: 'appointment',
    subjectId: IDS.appointmentGomez,
    locationId: IDS.central,
    status: 'open',
    createdAt: '2026-10-17T12:00:00.000Z',
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
    detail: null,
    appointment: {
      id: IDS.appointmentGomez,
      startsAt: '2026-10-17T13:00:00.000Z',
      endsAt: '2026-10-17T13:30:00.000Z',
      status: 'scheduled',
      professionalId: IDS.ana,
      patientId: IDS.patientGomez,
      patientName: 'Gómez, Valentina',
      locationId: IDS.central,
      identityConfirmed: false,
      version: 7,
    },
    actions: ['open_appointment', 'confirm_identity', 'detach_patient'],
    ...overrides,
  };
}

const IDENTITY = item({
  detail: {
    differences: [{ field: 'phone', submitted: '+54 11 5555 0000', onFile: '+54 11 4444 1111' }],
  },
});
const APPROVAL = item({
  id: ITEM(2),
  kind: 'pending_approval',
  subjectId: IDS.appointmentRios,
  appointment: {
    id: IDS.appointmentRios,
    startsAt: '2026-10-17T14:00:00.000Z',
    endsAt: '2026-10-17T14:45:00.000Z',
    status: 'pending_approval',
    professionalId: IDS.beto,
    patientId: IDS.patientRios,
    patientName: 'Ríos, Tomás',
    locationId: IDS.central,
    identityConfirmed: true,
    version: 2,
  },
  actions: ['open_appointment', 'approve', 'resolve', 'dismiss'],
});
const REMINDER = item({
  id: ITEM(3),
  kind: 'reminder_not_sent',
  subjectId: IDS.appointmentGomez,
  locationId: IDS.norte,
  actions: ['open_appointment', 'resolve', 'dismiss'],
  appointment: {
    ...(IDENTITY.appointment as NonNullable<typeof IDENTITY.appointment>),
    locationId: IDS.norte,
  },
});
const WAITLIST = item({
  id: ITEM(4),
  kind: 'waitlist_manual_contact',
  subjectType: 'waitlist_entry',
  subjectId: ITEM(40),
  locationId: null,
  appointment: null,
  actions: ['resolve', 'dismiss'],
});

const OPEN_ITEMS = [IDENTITY, APPROVAL, REMINDER, WAITLIST];

interface OpenOptions {
  me?: ReturnType<typeof meFor>;
  items?: WorklistItemDto[];
  routes?: Record<string, FetchHandler | Response>;
}

function open(options: OpenOptions = {}) {
  const lists: string[] = [];
  const app = renderApp({
    me:
      options.me ??
      meFor(['reception'], {
        user: { id: IDS.receptionMembership, email: 'recepcion@demo.invalid' },
      }),
    path: '/worklist',
    boot: bootFor('Centro Médico Aillu'),
    routes: {
      'GET /api/worklist': (url) => {
        lists.push(url);
        const status = new URL(url, 'http://x').searchParams.get('status');
        const items = (options.items ?? OPEN_ITEMS).filter(
          (entryItem) => entryItem.status === (status ?? 'open'),
        );
        return jsonResponse({
          items,
          openCount: (options.items ?? OPEN_ITEMS).filter((x) => x.status === 'open').length,
        });
      },
      'GET /api/locations': () => jsonResponse({ locations: LOCATIONS }),
      'GET /api/staff': () => jsonResponse({ staff: PROFESSIONALS }),
      'GET /api/patients': () => jsonResponse({ patients: SUMMARIES, nextCursor: null }),
      ...options.routes,
    },
  });
  return { ...app, lists };
}

async function card(name: RegExp | string) {
  const heading = await screen.findByRole('heading', { name });
  const found = heading.closest('li');
  if (!found) throw new Error('no card');
  return within(found);
}

describe('the worklist', () => {
  it('lists every open item with its kind, the patient, the time, the professional and the location', async () => {
    const app = open();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Pendientes' }),
    ).toBeInTheDocument();
    const identity = await card('Identidad por confirmar');
    expect(identity.getByText('Gómez, Valentina')).toBeInTheDocument();
    expect(identity.getByText(/sábado 17 de octubre, 10:00 a 10:30/)).toBeInTheDocument();
    expect(identity.getByText('Dra. Ana Pérez')).toBeInTheDocument();
    expect(identity.getByText('Sede Central')).toBeInTheDocument();
    const approval = await card('Reserva por aprobar');
    expect(approval.getByText('Ríos, Tomás')).toBeInTheDocument();
    expect(approval.getByText('Pendiente de aprobación')).toBeInTheDocument();
    expect(
      (await card('Contacto manual de lista de espera')).getByText('Toda la organización'),
    ).toBeInTheDocument();
    expect(app.missingKeys).toEqual([]);
  });

  it('filters by kind, with a count on each kind that has items', async () => {
    const user = userEvent.setup();
    open();
    await card('Identidad por confirmar');

    expect(screen.getByRole('button', { name: 'Todos (4)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Reserva por aprobar (1)' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Respuesta por revisar/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reserva por aprobar (1)' }));

    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(
      screen.queryByRole('heading', { name: 'Identidad por confirmar' }),
    ).not.toBeInTheDocument();
  });

  it('filters by location, always keeping what belongs to the whole organization', async () => {
    const user = userEvent.setup();
    open();
    await card('Identidad por confirmar');

    await user.selectOptions(screen.getByLabelText('Sede'), IDS.norte);

    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Recordatorio no enviado' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Contacto manual de lista de espera' }),
    ).toBeInTheDocument();
  });

  it('shows what the booking submitted against what is on file for an identity review', async () => {
    open();

    const identity = await card('Identidad por confirmar');
    const table = identity.getByRole('table', { name: 'Diferencias con la ficha' });
    expect(within(table).getByText('Teléfono')).toBeInTheDocument();
    expect(within(table).getByText('+54 11 5555 0000')).toBeInTheDocument();
    expect(within(table).getByText('+54 11 4444 1111')).toBeInTheDocument();
  });

  it('says so when there is nothing to do', async () => {
    open({ items: [] });

    expect(await screen.findByText('No hay pendientes. Todo está al día.')).toBeInTheDocument();
  });

  it('looks at resolved items on request', async () => {
    const user = userEvent.setup();
    const done = item({
      id: ITEM(9),
      status: 'resolved',
      actions: [],
      resolvedAt: '2026-10-17T13:00:00.000Z',
      resolution: 'identity_confirmed',
    });
    const app = open({ items: [IDENTITY, done] });
    await card('Identidad por confirmar');

    await user.click(screen.getByRole('button', { name: 'Resueltos' }));

    await waitFor(() => {
      expect(new URL(app.lists.at(-1) ?? '', 'http://x').searchParams.get('status')).toBe(
        'resolved',
      );
    });
    const resolved = await screen.findByRole('heading', { name: 'Identidad por confirmar' });
    expect(resolved.closest('li')).not.toBeNull();
    // A closed item offers no actions.
    expect(screen.queryByRole('button', { name: 'Confirmar identidad' })).not.toBeInTheDocument();
  });
});

describe('an invoice that needs a person (JD-S4 R1-C3, C8)', () => {
  const INVOICE = item({
    id: ITEM(5),
    kind: 'invoice_attention',
    subjectType: 'invoice',
    subjectId: ITEM(50),
    locationId: null,
    appointment: null,
    detail: { reason: 'number_taken', number: 77 },
    actions: ['open_invoice', 'resolve', 'dismiss'],
  });

  it('says why in words and links to the invoices, with no appointment to show', async () => {
    const app = open({ items: [INVOICE] });

    const found = await card('Factura para revisar');

    expect(
      found.getByText(/ARCA emitió un comprobante con un número que ya tenemos/),
    ).toBeInTheDocument();
    expect(found.getByText('Toda la organización')).toBeInTheDocument();
    expect(found.getByRole('link', { name: 'Ver facturas' })).toHaveAttribute('href', '/invoices');
    expect(found.queryByText('Sin turno asociado.')).not.toBeInTheDocument();
    expect(app.missingKeys).toEqual([]);
  });

  it('says that a series waits for an invoice whose outcome is unknown, without a count that would go stale (JD-S4 R3-2, R4-4)', async () => {
    // An item opened by an older version carries the count it had when it opened: it is not shown.
    const app = open({
      items: [{ ...INVOICE, detail: { reason: 'outcome_unknown', held: 3, pointOfSale: 1 } }],
    });

    const found = await card('Factura para revisar');

    expect(found.getByText(/No se sabe si ARCA emitió esta factura/)).toBeInTheDocument();
    expect(
      found.getByText(/las demás facturas de la misma serie esperan detrás/),
    ).toBeInTheDocument();
    expect(found.queryByText(/3 facturas/)).not.toBeInTheDocument();
    expect(app.missingKeys).toEqual([]);
  });

  it('says that a voucher cannot be told from this invoice, that nothing was sent, and that the outcome is unknown (JD-S4 R4-1)', async () => {
    const app = open({
      items: [
        {
          ...INVOICE,
          detail: { reason: 'voucher_ambiguous', outcomeUnknown: true, number: 12, cae: null },
        },
      ],
    });

    const found = await card('Factura para revisar');

    expect(found.getByText(/no se puede distinguir cuál es/)).toBeInTheDocument();
    expect(found.getByText(/no se envió nada/)).toBeInTheDocument();
    expect(found.getByText(/ARCA puede haber emitido esta factura/)).toBeInTheDocument();
    expect(app.missingKeys).toEqual([]);
  });

  it('names the numbers in doubt, or the range when it is too wide to list (JD-S4 R5-A-F4)', async () => {
    const listed = open({
      items: [
        {
          ...INVOICE,
          detail: { reason: 'voucher_ambiguous', outcomeUnknown: true, candidates: [12, 14] },
        },
      ],
    });

    const found = await card('Factura para revisar');

    expect(found.getByText(/Números para revisar en ARCA: 12, 14\./)).toBeInTheDocument();
    expect(listed.missingKeys).toEqual([]);
  });

  it('names the range of numbers in doubt when it is too wide to list (JD-S4 R5-A-F4)', async () => {
    const ranged = open({
      items: [
        {
          ...INVOICE,
          detail: {
            reason: 'voucher_ambiguous',
            outcomeUnknown: true,
            candidatesFrom: 30,
            candidatesTo: 80,
          },
        },
      ],
    });

    const found = await card('Factura para revisar');

    expect(found.getByText(/Números para revisar en ARCA: del 30 al 80\./)).toBeInTheDocument();
    expect(ranged.missingKeys).toEqual([]);
  });

  it('does not promise that a parked invoice goes on by itself, and warns when its outcome is unknown (JD-S4 R3-4)', async () => {
    open({
      items: [
        { ...INVOICE, detail: { reason: 'issuer_mismatch', outcomeUnknown: true, number: null } },
      ],
    });

    const found = await card('Factura para revisar');

    expect(found.getByText(/no se reintenta sola/)).toBeInTheDocument();
    expect(found.getByText(/registre a mano el comprobante/)).toBeInTheDocument();
    expect(found.getByText(/ARCA puede haber emitido esta factura/)).toBeInTheDocument();
    expect(found.queryByText(/Cargue el certificado/)).not.toBeInTheDocument();
  });

  it('falls back to a plain sentence for a reason it does not know', async () => {
    open({ items: [{ ...INVOICE, detail: { reason: 'something_new' } }] });

    const found = await card('Factura para revisar');

    expect(found.getByText('Esta factura necesita que una persona la revise.')).toBeInTheDocument();
  });
});

describe('working an item', () => {
  it('links to the appointment in the agenda', async () => {
    open();

    const identity = await card('Identidad por confirmar');
    const link = identity.getByRole('link', { name: 'Abrir turno' });

    expect(link.getAttribute('href')).toContain('/calendar');
    expect(link.getAttribute('href')).toContain(`appointment=${IDS.appointmentGomez}`);
    expect(link.getAttribute('href')).toContain('date=2026-10-17');
  });

  it('resolves an item', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    open({
      routes: {
        [`POST /api/worklist/${ITEM(3)}/resolve`]: () => {
          calls.push('resolve');
          return jsonResponse({ ...REMINDER, status: 'resolved', actions: [] });
        },
      },
    });

    await user.click(
      (await card('Recordatorio no enviado')).getByRole('button', { name: 'Marcar como resuelto' }),
    );

    await waitFor(() => {
      expect(calls).toEqual(['resolve']);
    });
  });

  it('asks before dismissing, and dismisses on confirmation', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    open({
      routes: {
        [`POST /api/worklist/${ITEM(3)}/dismiss`]: () => {
          calls.push('dismiss');
          return jsonResponse({ ...REMINDER, status: 'dismissed', actions: [] });
        },
      },
    });

    await user.click(
      (await card('Recordatorio no enviado')).getByRole('button', { name: 'Descartar' }),
    );
    expect(calls).toEqual([]);
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Descartar el pendiente' }));

    await waitFor(() => {
      expect(calls).toEqual(['dismiss']);
    });
  });

  it('approves a booking with the version its card was listed with', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open({
      routes: {
        [`POST /api/appointments/${IDS.appointmentRios}/approve`]: (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse({
            ...entry({ id: IDS.appointmentRios, version: 3 }),
            patientName: undefined,
            typeName: undefined,
            typeColor: undefined,
          });
        },
      },
    });

    await user.click(
      (await card('Reserva por aprobar')).getByRole('button', { name: 'Aprobar turno' }),
    );

    await waitFor(() => {
      expect(bodies).toEqual([{ expectedVersion: 2 }]);
    });
  });

  it('confirms the identity only after the staff member says they saw the document', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open({
      routes: {
        [`POST /api/worklist/${ITEM(1)}/confirm-identity`]: (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse({
            ...entry(),
            patientName: undefined,
            typeName: undefined,
            typeColor: undefined,
          });
        },
      },
    });

    await user.click(
      (await card('Identidad por confirmar')).getByRole('button', { name: 'Confirmar identidad' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Confirmar la identidad' });
    const confirm = within(dialog).getByRole('button', { name: 'Confirmar identidad' });
    expect(confirm).toBeDisabled();
    await user.click(
      within(dialog).getByRole('checkbox', { name: /Vi al paciente y su documento/ }),
    );
    await user.click(confirm);

    await waitFor(() => {
      expect(bodies).toEqual([{ expectedVersion: 7 }]);
    });
  });

  it('explains a refusal, for example the professional of the appointment confirming their own', async () => {
    const user = userEvent.setup();
    open({
      routes: {
        [`POST /api/worklist/${ITEM(1)}/confirm-identity`]: () => problemResponse(403, 'forbidden'),
      },
    });

    await user.click(
      (await card('Identidad por confirmar')).getByRole('button', { name: 'Confirmar identidad' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Confirmar la identidad' });
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Confirmar identidad' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('No tiene permiso');
  });

  it('says the appointment changed meanwhile when its version is stale (409), and reloads the list', async () => {
    const user = userEvent.setup();
    const app = open({
      routes: {
        [`POST /api/worklist/${ITEM(1)}/confirm-identity`]: () =>
          problemResponse(409, 'stale_revision'),
      },
    });

    await user.click(
      (await card('Identidad por confirmar')).getByRole('button', { name: 'Confirmar identidad' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Confirmar la identidad' });
    await user.click(within(dialog).getByRole('checkbox'));
    const listsBefore = app.lists.length;
    await user.click(within(dialog).getByRole('button', { name: 'Confirmar identidad' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('cambió');
    await waitFor(() => {
      expect(app.lists.length).toBeGreaterThan(listsBefore);
    });
  });

  it('moves the appointment to another patient when the match was wrong', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open({
      routes: {
        [`POST /api/appointments/${IDS.appointmentGomez}/detach-patient`]: (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse({
            ...entry(),
            patientName: undefined,
            typeName: undefined,
            typeColor: undefined,
          });
        },
      },
    });

    await user.click(
      (await card('Identidad por confirmar')).getByRole('button', { name: 'Corregir paciente' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Corregir el paciente del turno' });
    await user.type(within(dialog).getByRole('combobox', { name: 'Paciente correcto' }), 'rod');
    await user.click(await within(dialog).findByRole('option', { name: /Rodríguez, Santiago/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Mover el turno' }));

    await waitFor(() => {
      expect(bodies).toEqual([
        { resolution: 'move_to_patient', patientId: SUMMARIES[1]?.id, expectedVersion: 7 },
      ]);
    });
  });

  it('or cancels it, saying who and why', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open({
      routes: {
        [`POST /api/appointments/${IDS.appointmentGomez}/detach-patient`]: (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse({
            ...entry(),
            patientName: undefined,
            typeName: undefined,
            typeColor: undefined,
          });
        },
      },
    });

    await user.click(
      (await card('Identidad por confirmar')).getByRole('button', { name: 'Corregir paciente' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Corregir el paciente del turno' });
    await user.click(within(dialog).getByRole('radio', { name: 'Cancelar el turno' }));
    await user.selectOptions(within(dialog).getByLabelText('Quién cancela'), 'organization');
    await user.selectOptions(within(dialog).getByLabelText('Motivo'), 'duplicate');
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar el turno' }));

    await waitFor(() => {
      expect(bodies).toEqual([
        {
          resolution: 'cancel',
          cancelledBy: 'organization',
          reasonCode: 'duplicate',
          expectedVersion: 7,
        },
      ]);
    });
  });
});

describe('who can open the worklist', () => {
  it('shows no access, and fetches nothing, to a professional', async () => {
    const app = open({ me: meFor(['professional']) });

    expect(
      await screen.findByRole('heading', { name: 'No tiene acceso a esta sección' }),
    ).toBeInTheDocument();
    expect(app.requests.filter((request) => request.includes('/worklist'))).toEqual([]);
  });

  it('is accessible', async () => {
    const { container } = open();
    await card('Identidad por confirmar');

    expect(await a11yViolations(container)).toEqual([]);
  });

  it('shows a retryable error when the list cannot be loaded', async () => {
    open({
      routes: { 'GET /api/worklist': () => problemResponse(500, 'internal_error') },
    });

    expect(await screen.findByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
  });
});
