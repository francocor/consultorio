import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp, type RenderedApp } from '../../shared/test/render-app.js';
import { jsonBody, jsonResponse, problemResponse } from '../../shared/test/render.js';

import { PATIENT_IDS, patient } from './fixtures.js';

type Handler = (url: string, init: RequestInit) => Response;
const ID = PATIENT_IDS.valentina;
const PRO = '0190a000-0000-7000-8000-0000000000b2';

let current: RenderedApp | undefined;

afterEach(() => {
  expect(current?.missingKeys ?? []).toEqual([]);
  current = undefined;
});

function open(
  routes: Record<string, Handler> = {},
  roles: ('professional' | 'reception')[] = ['professional'],
) {
  current = renderApp({
    me: meFor(roles),
    path: `/patients/${ID}`,
    boot: bootFor('Centro Médico Aillu'),
    routes: {
      [`GET /api/patients/${ID}`]: () => jsonResponse(patient()),
      [`GET /api/patients/${ID}/representatives`]: () =>
        jsonResponse({ minor: false, representatives: [] }),
      ...routes,
    },
  });
  return current;
}

const saved = (version: number, content: unknown) => ({
  version,
  savedAt: '2026-10-16T12:00:00.000Z',
  authorProfessionalId: PRO,
  content,
});

const EMPTY = {
  allergies: [],
  medications: [],
  conditions: [],
  antecedents: '',
  indicators: { pregnant: false, implantedDevice: false, anticoagulated: false },
};

const CONTENT = {
  allergies: [{ substance: 'Penicilina', reaction: 'Urticaria', severity: 'severe' }],
  medications: [{ name: 'Acenocumarol', dose: '2 mg', anticoagulant: true }],
  conditions: [{ name: 'Hipertensión', since: '2019' }],
  antecedents: 'Madre con diabetes.',
  indicators: { pregnant: false, implantedDevice: false, anticoagulated: false },
};

async function openTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('tab', { name: 'Anamnesis' }));
}

describe('anamnesis: who sees it', () => {
  it('only a professional has the tab', async () => {
    open({}, ['reception']);

    await screen.findByRole('heading', { level: 1, name: 'Valentina Gómez' });
    expect(screen.queryByRole('tab', { name: 'Anamnesis' })).not.toBeInTheDocument();
    expect(current?.requests.some((request) => request.includes('/anamnesis'))).toBe(false);
  });

  it('tells a professional without a relationship why they cannot record it', async () => {
    const user = userEvent.setup();
    open({ [`GET /api/patients/${ID}/anamnesis`]: () => problemResponse(403, 'forbidden') });
    await openTab(user);

    expect(
      await screen.findByText(/este paciente tiene que estar asignado a usted/),
    ).toBeInTheDocument();
  });
});

describe('anamnesis: recording', () => {
  it('starts empty, with a plain explanation and no alert', async () => {
    const user = userEvent.setup();
    open({ [`GET /api/patients/${ID}/anamnesis`]: () => jsonResponse({ current: null }) });
    await openTab(user);

    expect(
      await screen.findByText('Todavía no hay anamnesis registrada para este paciente.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Con estos datos no se muestra ninguna alerta.')).toBeInTheDocument();
  });

  it('saves the first version from nothing (version 0) and cleans the empty rows', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open({
      [`GET /api/patients/${ID}/anamnesis`]: () => jsonResponse({ current: null }),
      [`PUT /api/patients/${ID}/anamnesis`]: (_url, init) => {
        body = jsonBody(init);
        return jsonResponse(
          saved(1, { ...EMPTY, allergies: [{ substance: 'Penicilina', severity: 'severe' }] }),
        );
      },
    });
    await openTab(user);
    await user.click(await screen.findByRole('button', { name: 'Agregar alergia' }));
    await user.type(screen.getByLabelText('Sustancia'), 'Penicilina');
    await user.selectOptions(screen.getByLabelText('Gravedad'), 'severe');
    await user.click(screen.getByRole('button', { name: 'Agregar medicamento' }));
    await user.click(screen.getByRole('button', { name: 'Guardar anamnesis' }));

    await waitFor(() => {
      expect(body).toEqual({
        content: { ...EMPTY, allergies: [{ substance: 'Penicilina', severity: 'severe' }] },
        expectedVersion: 0,
      });
    });
    expect(await screen.findByText('Anamnesis guardada.')).toBeInTheDocument();
  });

  it('loads the latest version and sends the version it started from', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open({
      [`GET /api/patients/${ID}/anamnesis`]: () => jsonResponse({ current: saved(3, CONTENT) }),
      [`PUT /api/patients/${ID}/anamnesis`]: (_url, init) => {
        body = jsonBody(init);
        return jsonResponse(saved(4, CONTENT));
      },
    });
    await openTab(user);

    expect(await screen.findByDisplayValue('Penicilina')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Acenocumarol')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Madre con diabetes.')).toBeInTheDocument();
    expect(screen.getByText(/Versión 3, guardada el 16\/10\/2026/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Guardar anamnesis' }));

    await waitFor(() => {
      expect(body).toMatchObject({ expectedVersion: 3, content: CONTENT });
    });
  });

  it('previews the alert the team will see, with its kinds, as the facts change', async () => {
    const user = userEvent.setup();
    open({
      [`GET /api/patients/${ID}/anamnesis`]: () => jsonResponse({ current: saved(1, EMPTY) }),
    });
    await openTab(user);
    await screen.findByText('Con estos datos no se muestra ninguna alerta.');

    await user.click(screen.getByRole('checkbox', { name: /Embarazo/ }));

    const alert = screen
      .getByText('Alerta para el resto del equipo')
      .closest('section') as HTMLElement;
    expect(within(alert).getByText('Embarazo')).toBeInTheDocument();
    expect(within(alert).getByText(/automáticamente/)).toBeInTheDocument();
    expect(
      screen.queryByText('Con estos datos no se muestra ninguna alerta.'),
    ).not.toBeInTheDocument();
  });

  it('an anticoagulant medication raises the anticoagulant alert', async () => {
    const user = userEvent.setup();
    open({
      [`GET /api/patients/${ID}/anamnesis`]: () => jsonResponse({ current: saved(1, EMPTY) }),
    });
    await openTab(user);
    await user.click(await screen.findByRole('button', { name: 'Agregar medicamento' }));
    await user.type(screen.getByLabelText('Medicamento'), 'Warfarina');
    await user.click(screen.getByRole('checkbox', { name: 'Es un anticoagulante' }));

    const alert = screen
      .getByText('Alerta para el resto del equipo')
      .closest('section') as HTMLElement;
    expect(within(alert).getByText('Anticoagulantes')).toBeInTheDocument();
  });

  it('removes a row', async () => {
    const user = userEvent.setup();
    open({
      [`GET /api/patients/${ID}/anamnesis`]: () => jsonResponse({ current: saved(3, CONTENT) }),
    });
    await openTab(user);
    await screen.findByDisplayValue('Penicilina');

    await user.click(screen.getByRole('button', { name: 'Quitar la alergia 1' }));

    expect(screen.queryByDisplayValue('Penicilina')).not.toBeInTheDocument();
  });

  it('a version saved by somebody else asks to refresh instead of overwriting it', async () => {
    const user = userEvent.setup();
    open({
      [`GET /api/patients/${ID}/anamnesis`]: () => jsonResponse({ current: saved(3, CONTENT) }),
      [`PUT /api/patients/${ID}/anamnesis`]: () => problemResponse(409, 'stale_revision'),
    });
    await openTab(user);
    await screen.findByDisplayValue('Penicilina');
    await user.click(screen.getByRole('button', { name: 'Guardar anamnesis' }));

    expect(await screen.findByText(/Otra persona guardó una versión nueva/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actualizar la ficha' })).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const user = userEvent.setup();
    const app = open({
      [`GET /api/patients/${ID}/anamnesis`]: () => jsonResponse({ current: saved(3, CONTENT) }),
    });
    await openTab(user);
    await screen.findByDisplayValue('Penicilina');

    expect(await a11yViolations(app.container)).toEqual([]);
  });
});
