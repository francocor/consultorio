import type { Permission } from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { createRegistry } from '../../app/registry.js';
import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';
import { jsonBody, jsonResponse, problemResponse } from '../../shared/test/render.js';

import { PATIENT_IDS, patient } from './fixtures.js';

type Handler = (url: string, init: RequestInit) => Response;
const ID = PATIENT_IDS.valentina;

function open(
  routes: Record<string, Handler> = {},
  me = meFor(['reception']),
  loaded = patient(),
  path = `/patients/${ID}`,
) {
  return renderApp({
    me,
    path,
    boot: bootFor('Centro Médico Aillu'),
    routes: {
      [`GET /api/patients/${ID}`]: () => jsonResponse(loaded),
      [`GET /api/patients/${ID}/representatives`]: () =>
        jsonResponse({ minor: false, representatives: [] }),
      ...routes,
    },
  });
}

describe('patient record: header and data', () => {
  it('shows who the patient is: name, age, birth date, document and the personal data', async () => {
    const app = open();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Valentina Gómez' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Nació el 04\/05\/1988/)).toBeInTheDocument();
    expect(screen.getAllByText('99.000.001').length).toBeGreaterThan(0);
    expect(screen.getByText('valentina.gomez@demo.invalid')).toBeInTheDocument();
    expect(screen.getByText('Marta Gómez · +54 11 0000 9999')).toBeInTheDocument();
    expect(screen.getByText('Prefiere turnos por la tarde.')).toBeInTheDocument();
    expect(app.missingKeys).toEqual([]);
  });

  it('puts the safety alert in the header as "see professional", never the detail', async () => {
    open({}, meFor(['reception']), patient({ hasSafetyFlag: true }));

    expect(await screen.findByText('Consultar con el profesional')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/alergia|anticoagul|embarazo/i);
  });

  it('warns when the data-processing consent is missing', async () => {
    open({}, meFor(['reception']), patient({ consentStatus: 'missing' }));

    expect(await screen.findByText('Consentimiento pendiente')).toBeInTheDocument();
  });

  it('says calmly when the record does not exist or is not available', async () => {
    open({ [`GET /api/patients/${ID}`]: () => problemResponse(404, 'not_found') });

    expect(
      await screen.findByRole('heading', { name: 'No encontramos a este paciente' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Volver a pacientes' })).toHaveAttribute(
      'href',
      '/patients',
    );
  });

  it('has no accessibility violations', async () => {
    const app = open();
    await screen.findByRole('heading', { level: 1, name: 'Valentina Gómez' });

    expect(await a11yViolations(app.container)).toEqual([]);
  });
});

describe('patient record: editing', () => {
  it('sends only what changed, with the version the edit started from', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open({
      [`PATCH /api/patients/${ID}`]: (_url, init) => {
        body = jsonBody(init);
        return jsonResponse(patient({ phone: '+54 11 0000 7777', version: 3 }));
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Editar datos' }));
    const dialog = await screen.findByRole('dialog', { name: 'Editar datos personales' });

    const phone = within(dialog).getByLabelText('Teléfono');
    await user.clear(phone);
    await user.type(phone, '+54 11 0000 7777');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar cambios' }));

    await waitFor(() => {
      expect(body).toEqual({ phone: '+54 11 0000 7777', expectedVersion: 2 });
    });
    expect(await screen.findByText('Datos actualizados.')).toBeInTheDocument();
  });

  it('does not call the server when nothing changed', async () => {
    const user = userEvent.setup();
    const app = open();
    await user.click(await screen.findByRole('button', { name: 'Editar datos' }));
    const dialog = await screen.findByRole('dialog', { name: 'Editar datos personales' });

    await user.click(within(dialog).getByRole('button', { name: 'Guardar cambios' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(app.requests.filter((request) => request.startsWith('PATCH'))).toEqual([]);
  });

  it('a stale edit asks to refresh instead of overwriting what somebody else saved', async () => {
    const user = userEvent.setup();
    open({ [`PATCH /api/patients/${ID}`]: () => problemResponse(409, 'stale_revision') });
    await user.click(await screen.findByRole('button', { name: 'Editar datos' }));
    const dialog = await screen.findByRole('dialog', { name: 'Editar datos personales' });
    const phone = within(dialog).getByLabelText('Teléfono');
    await user.clear(phone);
    await user.type(phone, '1140000000');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar cambios' }));

    expect(await within(dialog).findByText('Otra persona modificó esta ficha')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Actualizar la ficha' })).toBeInTheDocument();
  });

  it('shows the validation of the country next to the document', async () => {
    const user = userEvent.setup();
    const app = open();
    await user.click(await screen.findByRole('button', { name: 'Editar datos' }));
    const dialog = await screen.findByRole('dialog', { name: 'Editar datos personales' });
    const number = within(dialog).getByLabelText('Número de documento');
    await user.clear(number);
    await user.type(number, '12');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar cambios' }));

    expect(await within(dialog).findByText(/El DNI no es válido/)).toBeInTheDocument();
    expect(app.requests.filter((request) => request.startsWith('PATCH'))).toEqual([]);
  });
});

describe('patient record: deactivating', () => {
  it('only people who administer patients see the action, and it asks first', async () => {
    const user = userEvent.setup();
    let calls = 0;
    open(
      {
        [`POST /api/patients/${ID}/deactivate`]: () => {
          calls += 1;
          return jsonResponse(patient({ status: 'inactive' }));
        },
      },
      meFor(['reception']),
    );

    await user.click(await screen.findByRole('button', { name: 'Desactivar' }));
    const confirmation = await screen.findByRole('alertdialog', {
      name: '¿Desactivar a Valentina Gómez?',
    });
    expect(confirmation).toHaveTextContent('Los pacientes nunca se eliminan');
    await user.click(within(confirmation).getByRole('button', { name: 'Desactivar paciente' }));

    await waitFor(() => {
      expect(calls).toBe(1);
    });
    expect(await screen.findByText('Paciente desactivado.')).toBeInTheDocument();
  });

  it('a professional cannot deactivate a patient', async () => {
    open({}, meFor(['professional']));

    await screen.findByRole('heading', { level: 1, name: 'Valentina Gómez' });
    expect(screen.queryByRole('button', { name: 'Desactivar' })).not.toBeInTheDocument();
  });

  it('an inactive patient offers to reactivate', async () => {
    const user = userEvent.setup();
    let calls = 0;
    open(
      {
        [`POST /api/patients/${ID}/reactivate`]: () => {
          calls += 1;
          return jsonResponse(patient());
        },
      },
      meFor(['reception']),
      patient({ status: 'inactive' }),
    );

    expect(await screen.findByText('Inactivo')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reactivar' }));

    await waitFor(() => {
      expect(calls).toBe(1);
    });
  });
});

describe('patient record: tabs that features register (slot patient-detail-tab)', () => {
  const registry = (anyOf?: readonly Permission[]) =>
    createRegistry({
      routes: {},
      nav: {},
      slots: {
        '../features/messaging/slots.tsx': {
          default: [
            {
              slot: 'patient-detail-tab',
              id: 'channels',
              labelKey: 'patients:tab.coverage',
              ...(anyOf ? { anyOf } : {}),
              Component: ({ patientId }: { patientId: string }) => <p>Channels of {patientId}</p>,
            },
          ],
        },
      },
    });

  it('adds a tab after the record tabs, with the id of the patient, and switches to it', async () => {
    const user = userEvent.setup();
    renderApp({
      me: meFor(['reception']),
      path: `/patients/${ID}`,
      boot: bootFor('Centro Médico Aillu'),
      registry: registry(),
      routes: {
        [`GET /api/patients/${ID}`]: () => jsonResponse(patient()),
        [`GET /api/patients/${ID}/representatives`]: () =>
          jsonResponse({ minor: false, representatives: [] }),
      },
    });
    await screen.findByRole('heading', { level: 1, name: 'Valentina Gómez' });

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(7);
    await user.click(tabs.at(-1) as HTMLElement);

    expect(await screen.findByText(`Channels of ${ID}`)).toBeInTheDocument();
  });

  it('leaves the tab out for a user without the permission the feature asks for', async () => {
    renderApp({
      me: meFor(['reception']),
      path: `/patients/${ID}`,
      boot: bootFor('Centro Médico Aillu'),
      registry: registry(['booking.manage']),
      routes: {
        [`GET /api/patients/${ID}`]: () => jsonResponse(patient()),
        [`GET /api/patients/${ID}/representatives`]: () =>
          jsonResponse({ minor: false, representatives: [] }),
      },
    });
    await screen.findByRole('heading', { level: 1, name: 'Valentina Gómez' });

    // The six tabs of the record for reception, and none added.
    expect(screen.getAllByRole('tab')).toHaveLength(6);
  });
});
