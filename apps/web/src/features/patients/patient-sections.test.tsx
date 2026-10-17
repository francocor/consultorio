import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp, type RenderedApp } from '../../shared/test/render-app.js';
import { bodyText, jsonBody, jsonResponse } from '../../shared/test/render.js';

import { PATIENT_IDS, patient } from './fixtures.js';

type Handler = (url: string, init: RequestInit) => Response;
const ID = PATIENT_IDS.valentina;
const PLAN = '0190a000-0000-7000-8000-0000000000f1';
const PARTICULAR = '0190a000-0000-7000-8000-0000000000f2';
const PRO = '0190a000-0000-7000-8000-0000000000b2';

let current: RenderedApp | undefined;

afterEach(() => {
  // A message without a translation shows a raw key to the person: no screen may leave one.
  expect(current?.missingKeys ?? []).toEqual([]);
  current = undefined;
});

function open(routes: Record<string, Handler> = {}, me = meFor(['reception']), loaded = patient()) {
  current = renderApp({
    me,
    path: `/patients/${ID}`,
    boot: bootFor('Centro Médico Aillu'),
    routes: {
      [`GET /api/patients/${ID}`]: () => jsonResponse(loaded),
      [`GET /api/patients/${ID}/representatives`]: () =>
        jsonResponse({ minor: false, representatives: [] }),
      ...routes,
    },
  });
  return current;
}

async function goToTab(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('tab', { name }));
}

const coverage = (overrides: Record<string, unknown> = {}) => ({
  id: '0190a000-0000-7000-8000-0000000000d1',
  payerPlanId: PLAN,
  payerName: 'OSDE',
  payerKind: 'prepaga',
  planName: '210',
  memberNumber: '1234567/0',
  validFrom: null,
  validTo: null,
  primary: true,
  expired: false,
  ...overrides,
});

describe('coverage', () => {
  it('lists the coverages with the primary one marked and an expired one flagged', async () => {
    const user = userEvent.setup();
    open({
      [`GET /api/patients/${ID}/coverages`]: () =>
        jsonResponse({
          coverages: [
            coverage(),
            coverage({
              id: '0190a000-0000-7000-8000-0000000000d2',
              payerName: 'PAMI (INSSJP)',
              planName: null,
              memberNumber: '99/1',
              primary: false,
              expired: true,
              validTo: '2025-12-31',
            }),
          ],
          defaultCoverageId: '0190a000-0000-7000-8000-0000000000d1',
        }),
    });
    await goToTab(user, 'Cobertura');

    const first = (await screen.findByText('OSDE')).closest('li');
    expect(within(first as HTMLElement).getByText('Principal')).toBeInTheDocument();
    expect(within(first as HTMLElement).getByText('Plan 210')).toBeInTheDocument();
    expect(within(first as HTMLElement).getByText('Afiliado 1234567/0')).toBeInTheDocument();
    const second = screen.getByText('PAMI (INSSJP)').closest('li');
    expect(within(second as HTMLElement).getByText('Vencida')).toBeInTheDocument();
    expect(within(second as HTMLElement).getByText('Vigente hasta 31/12/2025')).toBeInTheDocument();
  });

  it('adds a coverage with its affiliate number', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open({
      [`GET /api/patients/${ID}/coverages`]: () =>
        jsonResponse({ coverages: [], defaultCoverageId: null }),
      'GET /api/payer-plans': () =>
        jsonResponse({
          plans: [
            {
              id: PLAN,
              payerId: PLAN,
              name: 'OSDE',
              kind: 'prepaga',
              planName: '210',
              active: true,
            },
            {
              id: PARTICULAR,
              payerId: PARTICULAR,
              name: 'Particular',
              kind: 'private',
              planName: null,
              active: true,
            },
          ],
        }),
      [`POST /api/patients/${ID}/coverages`]: (_url, init) => {
        body = jsonBody(init);
        return jsonResponse(coverage(), 201);
      },
    });
    await goToTab(user, 'Cobertura');
    await user.click(await screen.findByRole('button', { name: 'Agregar cobertura' }));
    const dialog = await screen.findByRole('dialog', { name: 'Agregar una cobertura' });

    await user.selectOptions(within(dialog).getByLabelText('Cobertura'), PLAN);
    await user.type(within(dialog).getByLabelText('Número de afiliado'), '1234567/0');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar cobertura' }));

    await waitFor(() => {
      expect(body).toEqual({ payerPlanId: PLAN, memberNumber: '1234567/0' });
    });
    expect(await screen.findByText('Cobertura guardada.')).toBeInTheDocument();
  });

  it('"Particular" does not need an affiliate number', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open({
      [`GET /api/patients/${ID}/coverages`]: () =>
        jsonResponse({ coverages: [], defaultCoverageId: null }),
      'GET /api/payer-plans': () =>
        jsonResponse({
          plans: [
            {
              id: PARTICULAR,
              payerId: PARTICULAR,
              name: 'Particular',
              kind: 'private',
              planName: null,
              active: true,
            },
          ],
        }),
      [`POST /api/patients/${ID}/coverages`]: (_url, init) => {
        body = jsonBody(init);
        return jsonResponse(coverage({ payerName: 'Particular', memberNumber: null }), 201);
      },
    });
    await goToTab(user, 'Cobertura');
    await user.click(await screen.findByRole('button', { name: 'Agregar cobertura' }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('Cobertura'), PARTICULAR);
    await user.click(within(dialog).getByRole('button', { name: 'Guardar cobertura' }));

    await waitFor(() => {
      expect(body).toEqual({ payerPlanId: PARTICULAR });
    });
  });

  it('removes a coverage', async () => {
    const user = userEvent.setup();
    let removed = false;
    open({
      [`GET /api/patients/${ID}/coverages`]: () =>
        jsonResponse({ coverages: removed ? [] : [coverage()], defaultCoverageId: null }),
      [`DELETE /api/patients/${ID}/coverages/0190a000-0000-7000-8000-0000000000d1`]: () => {
        removed = true;
        return new Response(null, { status: 204 });
      },
    });
    await goToTab(user, 'Cobertura');

    await user.click(await screen.findByRole('button', { name: 'Quitar la cobertura OSDE' }));

    expect(
      await screen.findByText('Este paciente no tiene cobertura cargada.'),
    ).toBeInTheDocument();
  });

  it('has an empty state with the action', async () => {
    const user = userEvent.setup();
    open({
      [`GET /api/patients/${ID}/coverages`]: () =>
        jsonResponse({ coverages: [], defaultCoverageId: null }),
    });
    await goToTab(user, 'Cobertura');

    expect(
      await screen.findByText('Este paciente no tiene cobertura cargada.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Agregar cobertura' })).toBeInTheDocument();
  });
});

describe('representatives of a minor', () => {
  it('shows them as administrative contacts with the review date', async () => {
    open(
      {
        [`GET /api/patients/${ID}/representatives`]: () =>
          jsonResponse({
            minor: true,
            representatives: [
              {
                id: '0190a000-0000-7000-8000-0000000000a9',
                fullName: 'Lorena Domínguez',
                relation: 'mother',
                phone: '+54 11 0000 4444',
                email: null,
                majorityReviewOn: '2037-03-10',
              },
            ],
          }),
      },
      meFor(['reception']),
      patient({ birthDate: '2019-03-10' }),
    );

    expect(await screen.findByText('Lorena Domínguez')).toBeInTheDocument();
    expect(screen.getByText('Madre')).toBeInTheDocument();
    expect(screen.getByText('Es menor de edad.')).toBeInTheDocument();
    expect(
      screen.getByText('Revisar al cumplir la mayoría de edad: 10/03/2037'),
    ).toBeInTheDocument();
  });
});

describe('consent and rights over the data', () => {
  it('records a missing consent', async () => {
    const user = userEvent.setup();
    let recorded = false;
    open(
      {
        [`GET /api/patients/${ID}/consent`]: () =>
          jsonResponse({ status: recorded ? 'granted' : 'missing', current: null, history: [] }),
        [`POST /api/patients/${ID}/consent`]: () => {
          recorded = true;
          return jsonResponse(
            {
              id: '0190a000-0000-7000-8000-0000000000c9',
              textKey: 'consent.data_processing',
              textVersion: '1',
              grantedAt: '2026-10-16T12:00:00.000Z',
              recordedBy: '0190a000-0000-7000-8000-000000000001',
              revokedAt: null,
              revokedBy: null,
            },
            201,
          );
        },
        [`GET /api/patients/${ID}/rights-requests`]: () => jsonResponse({ requests: [] }),
      },
      meFor(['reception']),
      patient({ consentStatus: 'missing' }),
    );
    await goToTab(user, 'Privacidad');

    await user.click(await screen.findByRole('button', { name: 'Registrar consentimiento' }));

    expect(await screen.findByText('Consentimiento registrado.')).toBeInTheDocument();
  });

  it('revokes a consent after confirming and keeps the history', async () => {
    const user = userEvent.setup();
    let revoked = false;
    const record = {
      id: '0190a000-0000-7000-8000-0000000000c9',
      textKey: 'consent.data_processing',
      textVersion: '1',
      grantedAt: '2026-10-01T12:00:00.000Z',
      recordedBy: '0190a000-0000-7000-8000-000000000001',
      revokedAt: null as string | null,
      revokedBy: null as string | null,
    };
    open({
      [`GET /api/patients/${ID}/consent`]: () =>
        jsonResponse({
          status: revoked ? 'revoked' : 'granted',
          current: revoked ? { ...record, revokedAt: '2026-10-16T12:00:00.000Z' } : record,
          history: [record],
        }),
      [`POST /api/patients/${ID}/consent/revoke`]: () => {
        revoked = true;
        return new Response(null, { status: 204 });
      },
      [`GET /api/patients/${ID}/rights-requests`]: () => jsonResponse({ requests: [] }),
    });
    await goToTab(user, 'Privacidad');
    expect(await screen.findByText('Consentimiento otorgado')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Registrar revocación' }));
    const confirmation = await screen.findByRole('alertdialog', {
      name: '¿Registrar la revocación?',
    });
    await user.click(within(confirmation).getByRole('button', { name: 'Registrar revocación' }));

    expect(await screen.findByText('Consentimiento revocado')).toBeInTheDocument();
    expect(screen.getByText('Historial de consentimientos')).toBeInTheDocument();
  });

  it('registers an access request and fulfills it, offering the copy as a file', async () => {
    const user = userEvent.setup();
    let state = 'none';
    const request = {
      id: '0190a000-0000-7000-8000-0000000000b1',
      kind: 'access',
      status: 'open',
      requestedAt: '2026-10-16T12:00:00.000Z',
      requestedBy: '0190a000-0000-7000-8000-000000000001',
      note: 'Llegó por correo',
      fulfilledAt: null,
      fulfilledBy: null,
    };
    open({
      [`GET /api/patients/${ID}/consent`]: () =>
        jsonResponse({ status: 'granted', current: null, history: [] }),
      [`GET /api/patients/${ID}/rights-requests`]: () =>
        jsonResponse({
          requests:
            state === 'none'
              ? []
              : [
                  state === 'open'
                    ? request
                    : { ...request, status: 'fulfilled', fulfilledAt: '2026-10-16T13:00:00.000Z' },
                ],
        }),
      [`POST /api/patients/${ID}/rights-requests`]: (_url, init) => {
        expect(bodyText(init)).toBe('{"kind":"access","note":"Llegó por correo"}');
        state = 'open';
        return jsonResponse(request, 201);
      },
      [`POST /api/patients/${ID}/rights-requests/${request.id}/fulfill`]: () => {
        state = 'fulfilled';
        return jsonResponse({
          request: { ...request, status: 'fulfilled' },
          copy: {
            generatedAt: '2026-10-16T13:00:00.000Z',
            patient: patient(),
            coverages: [],
            consent: { status: 'granted', current: null, history: [] },
            representatives: [],
            history: [],
            rightsRequests: [],
            clinicalCopy: 'requires_professional',
          },
        });
      },
    });
    await goToTab(user, 'Privacidad');

    await user.click(await screen.findByRole('button', { name: 'Registrar un pedido' }));
    const dialog = await screen.findByRole('dialog', { name: 'Registrar un pedido' });
    await user.selectOptions(within(dialog).getByLabelText('Tipo de pedido'), 'access');
    await user.type(within(dialog).getByLabelText('Nota administrativa'), 'Llegó por correo');
    await user.click(within(dialog).getByRole('button', { name: 'Registrar pedido' }));
    expect(await screen.findByText('Acceso a los datos')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Resolver' }));

    expect(await screen.findByText('Copia de los datos')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Descargar copia (JSON)' })).toBeInTheDocument();
    expect(
      screen.getByText(/La copia de la historia clínica la entrega un profesional/),
    ).toBeInTheDocument();
  });
});

describe('rectification requests', () => {
  it('are resolved by correcting the data: the edit form saves it and closes the request', async () => {
    const user = userEvent.setup();
    let body: unknown;
    const request = {
      id: '0190a000-0000-7000-8000-0000000000b8',
      kind: 'rectification',
      status: 'open',
      requestedAt: '2026-10-16T12:00:00.000Z',
      requestedBy: '0190a000-0000-7000-8000-000000000001',
      note: 'Apellido mal escrito',
      fulfilledAt: null,
      fulfilledBy: null,
    };
    open({
      [`GET /api/patients/${ID}/consent`]: () =>
        jsonResponse({ status: 'granted', current: null, history: [] }),
      [`GET /api/patients/${ID}/rights-requests`]: () => jsonResponse({ requests: [request] }),
      [`POST /api/patients/${ID}/rights-requests/${request.id}/fulfill`]: (_url, init) => {
        body = jsonBody(init);
        return jsonResponse({ request: { ...request, status: 'fulfilled' }, copy: null });
      },
    });
    await goToTab(user, 'Privacidad');

    await user.click(await screen.findByRole('button', { name: 'Resolver' }));
    const dialog = await screen.findByRole('dialog', { name: 'Editar datos personales' });
    const family = within(dialog).getByLabelText('Apellido');
    await user.clear(family);
    await user.type(family, 'Gomez');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar cambios' }));

    await waitFor(() => {
      expect(body).toEqual({ changes: { familyName: 'Gomez', expectedVersion: 2 } });
    });
    expect(await screen.findByText('Pedido resuelto.')).toBeInTheDocument();
  });
});

describe('adding a representative', () => {
  it('sends the person with the way to reach them', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open(
      {
        [`GET /api/patients/${ID}/representatives`]: () =>
          jsonResponse({ minor: true, representatives: [] }),
        [`POST /api/patients/${ID}/representatives`]: (_url, init) => {
          body = jsonBody(init);
          return jsonResponse(
            {
              id: '0190a000-0000-7000-8000-0000000000a9',
              fullName: 'Lorena Domínguez',
              relation: 'mother',
              phone: '+54 11 0000 4444',
              email: null,
              majorityReviewOn: '2037-03-10',
            },
            201,
          );
        },
      },
      meFor(['reception']),
      patient({ birthDate: '2019-03-10' }),
    );

    expect(await screen.findByText('No hay representantes cargados.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Agregar representante' }));
    const dialog = await screen.findByRole('dialog', { name: 'Agregar representante' });
    await user.type(
      within(dialog).getByLabelText('Nombre completo del representante'),
      'Lorena Domínguez',
    );
    await user.selectOptions(within(dialog).getByLabelText('Vínculo'), 'mother');
    await user.type(
      within(dialog).getByLabelText('Teléfono del representante'),
      '+54 11 0000 4444',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Guardar representante' }));

    await waitFor(() => {
      expect(body).toEqual({
        fullName: 'Lorena Domínguez',
        relation: 'mother',
        phone: '+54 11 0000 4444',
      });
    });
  });

  it('asks for a phone or an email before sending', async () => {
    const user = userEvent.setup();
    const app = open(
      {
        [`GET /api/patients/${ID}/representatives`]: () =>
          jsonResponse({ minor: true, representatives: [] }),
      },
      meFor(['reception']),
      patient({ birthDate: '2019-03-10' }),
    );
    await user.click(await screen.findByRole('button', { name: 'Agregar representante' }));
    const dialog = await screen.findByRole('dialog', { name: 'Agregar representante' });
    await user.type(within(dialog).getByLabelText('Nombre completo del representante'), 'Lorena');
    await user.selectOptions(within(dialog).getByLabelText('Vínculo'), 'mother');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar representante' }));

    expect(
      await within(dialog).findByText('Cargue un teléfono o un correo del representante.'),
    ).toBeInTheDocument();
    expect(app.requests.filter((request) => request.startsWith('POST'))).toEqual([]);
  });
});

describe('history and care assignment', () => {
  it('lists the versions with what changed', async () => {
    const user = userEvent.setup();
    open({
      [`GET /api/patients/${ID}/history`]: () =>
        jsonResponse({
          versions: [
            {
              version: 2,
              changedAt: '2026-10-02T10:00:00.000Z',
              changedBy: null,
              changedFields: ['phone', 'address'],
              snapshot: {},
            },
            {
              version: 1,
              changedAt: '2026-10-01T10:00:00.000Z',
              changedBy: null,
              changedFields: [],
              snapshot: {},
            },
          ],
        }),
    });
    await goToTab(user, 'Historial');

    expect(await screen.findByText('Versión 2')).toBeInTheDocument();
    expect(screen.getByText('Cambios: teléfono, domicilio')).toBeInTheDocument();
    expect(screen.getByText('Registro inicial')).toBeInTheDocument();
  });

  it('assigns a patient to a professional so they can record the anamnesis', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open(
      {
        [`GET /api/patients/${ID}/assignments`]: () => jsonResponse({ assignments: [] }),
        'GET /api/staff': () =>
          jsonResponse({
            staff: [
              {
                membershipId: '0190a000-0000-7000-8000-0000000000a2',
                displayName: 'Dra. Lucía Paz Ferrer',
                roles: ['professional'],
                status: 'active',
                email: null,
                locations: [],
                professional: {
                  id: PRO,
                  status: 'active',
                  specialties: ['Cardiología'],
                  matricula: null,
                },
              },
            ],
          }),
        [`POST /api/patients/${ID}/assignments`]: (_url, init) => {
          body = jsonBody(init);
          return jsonResponse(
            {
              professionalId: PRO,
              professionalName: 'Dra. Lucía Paz Ferrer',
              assignedBy: '0190a000-0000-7000-8000-000000000001',
              assignedAt: '2026-10-16T12:00:00.000Z',
            },
            201,
          );
        },
      },
      meFor(['reception']),
    );
    await goToTab(user, 'Atención');

    await user.click(await screen.findByRole('button', { name: 'Asignar a un profesional' }));
    const dialog = await screen.findByRole('dialog', { name: 'Asignar a un profesional' });
    await user.selectOptions(within(dialog).getByLabelText('Profesional'), PRO);
    await user.click(within(dialog).getByRole('button', { name: 'Asignar' }));

    await waitFor(() => {
      expect(body).toEqual({ professionalId: PRO });
    });
    expect(await screen.findByText('Asignación registrada.')).toBeInTheDocument();
  });

  it('the page has no accessibility violations on the coverage tab', async () => {
    const user = userEvent.setup();
    const app = renderApp({
      me: meFor(['reception']),
      path: `/patients/${ID}`,
      boot: bootFor(),
      routes: {
        [`GET /api/patients/${ID}`]: () => jsonResponse(patient()),
        [`GET /api/patients/${ID}/representatives`]: () =>
          jsonResponse({ minor: false, representatives: [] }),
        [`GET /api/patients/${ID}/coverages`]: () =>
          jsonResponse({ coverages: [coverage()], defaultCoverageId: null }),
      },
    });
    await goToTab(user, 'Cobertura');
    await screen.findByText('OSDE');

    expect(await a11yViolations(app.container)).toEqual([]);
  });
});
