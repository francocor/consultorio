import type {
  PortalProfileResponse,
  PortalRepresentativeDto,
  PortalSessionDto,
} from '@consultorio/contracts';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';
import {
  jsonBody,
  jsonResponse,
  problemResponse,
  type FetchHandler,
} from '../../shared/test/render.js';

import { CHILD_LINK, meOf, SELF_LINK, signedInRoutes } from './portal-fixtures.js';

/**
 * The account of the patient (S5.10, task 5.41): the data they see and change, what they ask of the
 * consultorio, who represents them and where they are signed in.
 */
function open(
  path: string,
  extra: Record<string, FetchHandler | Response>,
  me = meOf([SELF_LINK], SELF_LINK.id),
) {
  return renderApp({
    me: null,
    path,
    boot: bootFor('Centro Médico Aillu'),
    routes: signedInRoutes(me, extra),
  });
}

const PROFILE: PortalProfileResponse = {
  givenNames: 'Ana',
  familyName: 'Pérez',
  birthDate: '1990-03-04',
  document: { type: 'DNI', number: '30111222' },
  phone: '+54 11 5555-1111',
  email: 'ana@example.test',
  address: 'Calle 1 234',
  emergencyContact: { name: 'Luis Pérez', phone: '+54 11 5555-2222' },
  version: 3,
  dataProcessing: { granted: true, grantedAt: '2031-01-15T12:00:00.000Z' },
  requests: [],
};

const REPRESENTATIVE: PortalRepresentativeDto = {
  id: '0190a000-0000-7000-8000-000000000201',
  relation: 'mother',
  status: 'suspended',
  maskedEmail: 'm***@example.test',
  majorityReviewOn: '2031-04-01',
};

const NO_REPRESENTATIVES = jsonResponse({ representatives: [] });

describe('my data', () => {
  it('shows the personal data as read-only and the contact data as a form', async () => {
    const app = open('/portal/mis-datos', {
      'GET /api/portal/profile': jsonResponse(PROFILE),
      'GET /api/portal/representatives': NO_REPRESENTATIVES,
    });

    expect(await screen.findByText('30111222')).toBeInTheDocument();
    expect(screen.getByText('Ana Pérez', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText('ana@example.test')).toBeInTheDocument();
    expect(screen.getByText(/Vigente desde el/)).toBeInTheDocument();
    expect(screen.getByLabelText('Teléfono')).toHaveValue('+54 11 5555-1111');
    expect(screen.getByLabelText('Domicilio')).toHaveValue('Calle 1 234');
    expect(screen.getByLabelText('Nombre del contacto')).toHaveValue('Luis Pérez');
    // The identity is not editable here: it goes by request.
    expect(screen.queryByLabelText('Apellido')).not.toBeInTheDocument();
    expect(screen.getByText('Todavía no hizo ningún pedido.')).toBeInTheDocument();
    expect(app.missingKeys).toEqual([]);
    expect(await a11yViolations(app.container)).toEqual([]);
  });

  it('saves the contact data with the version it was showing', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open('/portal/mis-datos', {
      'GET /api/portal/profile': jsonResponse(PROFILE),
      'GET /api/portal/representatives': NO_REPRESENTATIVES,
      'PATCH /api/portal/profile': (_url, init) => {
        bodies.push(jsonBody(init));
        return jsonResponse({ ...PROFILE, phone: '+54 11 6666-3333', version: 4 });
      },
    });

    const phone = await screen.findByLabelText('Teléfono');
    await user.clear(phone);
    await user.type(phone, '+54 11 6666-3333');
    await user.click(screen.getByRole('button', { name: 'Guardar los cambios' }));

    await vi.waitFor(() => {
      expect(bodies).toEqual([
        {
          phone: '+54 11 6666-3333',
          address: 'Calle 1 234',
          emergencyContact: { name: 'Luis Pérez', phone: '+54 11 5555-2222' },
          expectedVersion: 3,
        },
      ]);
    });
    expect(await screen.findByLabelText('Teléfono')).toHaveValue('+54 11 6666-3333');
  });

  it('clears a field by sending null, and the whole emergency contact when both are empty', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open('/portal/mis-datos', {
      'GET /api/portal/profile': jsonResponse(PROFILE),
      'GET /api/portal/representatives': NO_REPRESENTATIVES,
      'PATCH /api/portal/profile': (_url, init) => {
        bodies.push(jsonBody(init));
        return jsonResponse({ ...PROFILE, version: 4 });
      },
    });

    await user.clear(await screen.findByLabelText('Domicilio'));
    await user.clear(screen.getByLabelText('Nombre del contacto'));
    await user.clear(screen.getByLabelText('Teléfono del contacto'));
    await user.click(screen.getByRole('button', { name: 'Guardar los cambios' }));

    await vi.waitFor(() => {
      expect(bodies).toEqual([
        {
          phone: '+54 11 5555-1111',
          address: null,
          emergencyContact: null,
          expectedVersion: 3,
        },
      ]);
    });
  });

  it('refuses half an emergency contact before asking the server', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open('/portal/mis-datos', {
      'GET /api/portal/profile': jsonResponse(PROFILE),
      'GET /api/portal/representatives': NO_REPRESENTATIVES,
      'PATCH /api/portal/profile': (_url, init) => {
        bodies.push(jsonBody(init));
        return jsonResponse(PROFILE);
      },
    });

    await user.clear(await screen.findByLabelText('Teléfono del contacto'));
    await user.click(screen.getByRole('button', { name: 'Guardar los cambios' }));

    expect(
      await screen.findByText('Complete el nombre y el teléfono, o deje ambos vacíos.'),
    ).toBeInTheDocument();
    expect(bodies).toEqual([]);
  });

  it('explains a failed save in plain words and keeps what the person typed', async () => {
    const user = userEvent.setup();
    open('/portal/mis-datos', {
      'GET /api/portal/profile': jsonResponse(PROFILE),
      'GET /api/portal/representatives': NO_REPRESENTATIVES,
      'PATCH /api/portal/profile': problemResponse(409, 'portal_state_conflict'),
    });

    const address = await screen.findByLabelText('Domicilio');
    await user.clear(address);
    await user.type(address, 'Calle 2 345');
    await user.click(screen.getByRole('button', { name: 'Guardar los cambios' }));

    expect(
      await screen.findByText(/La cuenta o el vínculo ya estaba dado de baja/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Domicilio')).toHaveValue('Calle 2 345');
  });

  it('asks for a correction of the identity, which the organization reviews', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open('/portal/mis-datos', {
      'GET /api/portal/profile': jsonResponse(PROFILE),
      'GET /api/portal/representatives': NO_REPRESENTATIVES,
      'POST /api/portal/rectification-requests': (_url, init) => {
        bodies.push(jsonBody(init));
        return jsonResponse(
          {
            request: {
              id: '0190a000-0000-7000-8000-000000000301',
              kind: 'rectification',
              status: 'open',
              requestedAt: '2031-05-22T12:00:00.000Z',
            },
          },
          201,
        );
      },
    });

    // Nothing typed: refused on the screen.
    await user.click(await screen.findByRole('button', { name: 'Enviar el pedido' }));
    expect(await screen.findByText('Escriba cómo debería figurar el dato.')).toBeInTheDocument();
    expect(bodies).toEqual([]);

    await user.selectOptions(screen.getByLabelText('Dato a corregir'), 'givenNames');
    await user.type(screen.getByLabelText('Cómo debería figurar'), 'Ana María');
    await user.type(screen.getByLabelText('Aclaración (opcional)'), 'Segundo nombre omitido');
    await user.click(screen.getByRole('button', { name: 'Enviar el pedido' }));

    await vi.waitFor(() => {
      expect(bodies).toEqual([
        { field: 'givenNames', correctValue: 'Ana María', note: 'Segundo nombre omitido' },
      ]);
    });
    expect(screen.getByLabelText('Cómo debería figurar')).toHaveValue('');
  });

  it('asks for a copy of the clinical history, which is prepared outside the portal', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open('/portal/mis-datos', {
      'GET /api/portal/profile': jsonResponse(PROFILE),
      'GET /api/portal/representatives': NO_REPRESENTATIVES,
      'POST /api/portal/copy-requests': (_url, init) => {
        bodies.push(jsonBody(init));
        return jsonResponse(
          {
            request: {
              id: '0190a000-0000-7000-8000-000000000302',
              kind: 'access',
              status: 'open',
              requestedAt: '2031-05-22T12:00:00.000Z',
            },
          },
          201,
        );
      },
    });

    expect(
      await screen.findByText(/la historia clínica no se muestra en el portal/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Pedir una copia' }));

    await vi.waitFor(() => {
      expect(bodies).toEqual([{}]);
    });
  });

  it('lists what the patient asked for and where it stands', async () => {
    open('/portal/mis-datos', {
      'GET /api/portal/profile': jsonResponse({
        ...PROFILE,
        requests: [
          {
            id: '0190a000-0000-7000-8000-000000000303',
            kind: 'access',
            status: 'open',
            requestedAt: '2031-05-20T12:00:00.000Z',
          },
          {
            id: '0190a000-0000-7000-8000-000000000304',
            kind: 'rectification',
            status: 'fulfilled',
            requestedAt: '2031-04-20T12:00:00.000Z',
          },
        ],
      }),
      'GET /api/portal/representatives': NO_REPRESENTATIVES,
    });

    expect(await screen.findByText('En revisión')).toBeInTheDocument();
    expect(screen.getByText('Resuelto')).toBeInTheDocument();
    expect(screen.getByText('Corrección de un dato')).toBeInTheDocument();
  });
});

describe('who represents me', () => {
  it('shows nothing when nobody does', async () => {
    open('/portal/mis-datos', {
      'GET /api/portal/profile': jsonResponse(PROFILE),
      'GET /api/portal/representatives': NO_REPRESENTATIVES,
    });
    await screen.findByText('30111222');

    expect(screen.queryByText('Quién me representa')).not.toBeInTheDocument();
  });

  it('is not asked about when the record is somebody else’s', async () => {
    const app = open(
      '/portal/mis-datos',
      { 'GET /api/portal/profile': jsonResponse(PROFILE) },
      meOf([CHILD_LINK], CHILD_LINK.id),
    );
    await screen.findByText('30111222');

    expect(app.requests).not.toContain('GET /api/portal/representatives');
  });

  it('lets the adult authorize a paused representative', async () => {
    const user = userEvent.setup();
    let authorized = false;
    const app = open('/portal/mis-datos', {
      'GET /api/portal/profile': jsonResponse(PROFILE),
      'GET /api/portal/representatives': () =>
        jsonResponse({
          representatives: [authorized ? { ...REPRESENTATIVE, status: 'active' } : REPRESENTATIVE],
        }),
      [`POST /api/portal/links/${REPRESENTATIVE.id}/authorize`]: () => {
        authorized = true;
        return new Response(null, { status: 204 });
      },
    });

    expect(await screen.findByText('Quién me representa')).toBeInTheDocument();
    expect(screen.getByText('m***@example.test')).toBeInTheDocument();
    expect(screen.getByText('En pausa')).toBeInTheDocument();
    expect(
      screen.getByText(/Su acceso está en pausa desde que usted cumplió la mayoría de edad/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Autorizar el acceso' }));

    expect(await screen.findByText('Con acceso')).toBeInTheDocument();
    expect(app.requests).toContain(`POST /api/portal/links/${REPRESENTATIVE.id}/authorize`);
    expect(screen.queryByRole('button', { name: 'Autorizar el acceso' })).not.toBeInTheDocument();
  });

  it('ends the access of a representative after asking', async () => {
    const user = userEvent.setup();
    let ended = false;
    const app = open('/portal/mis-datos', {
      'GET /api/portal/profile': jsonResponse(PROFILE),
      'GET /api/portal/representatives': () =>
        jsonResponse({ representatives: ended ? [] : [{ ...REPRESENTATIVE, status: 'active' }] }),
      [`POST /api/portal/links/${REPRESENTATIVE.id}/revoke`]: () => {
        ended = true;
        return new Response(null, { status: 204 });
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Quitar el acceso' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: '¿Quitar el acceso a esta persona?',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Sí, quitar el acceso' }));

    await vi.waitFor(() => {
      expect(screen.queryByText('Quién me representa')).not.toBeInTheDocument();
    });
    expect(app.requests).toContain(`POST /api/portal/links/${REPRESENTATIVE.id}/revoke`);
  });
});

const CURRENT: PortalSessionDto = {
  id: '0190a000-0000-7000-8000-000000000401',
  createdAt: '2031-05-22T10:00:00.000Z',
  lastSeenAt: '2031-05-22T11:00:00.000Z',
  expiresAt: '2031-05-22T22:00:00.000Z',
  userAgent: 'Firefox en Windows',
  current: true,
};
const OTHER: PortalSessionDto = {
  ...CURRENT,
  id: '0190a000-0000-7000-8000-000000000402',
  userAgent: null,
  current: false,
};

describe('my sessions', () => {
  it('marks this device and offers to end only the others', async () => {
    const app = open('/portal/sesiones', {
      'GET /api/portal/sessions': jsonResponse({ sessions: [CURRENT, OTHER] }),
    });

    expect(await screen.findByText('Firefox en Windows')).toBeInTheDocument();
    expect(screen.getByText('Este dispositivo')).toBeInTheDocument();
    expect(screen.getByText('Dispositivo sin nombre')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Cerrar esta sesión' })).toHaveLength(1);
    expect(await a11yViolations(app.container)).toEqual([]);
  });

  it('ends another session and refreshes the list', async () => {
    const user = userEvent.setup();
    let ended = false;
    const app = open('/portal/sesiones', {
      'GET /api/portal/sessions': () =>
        jsonResponse({ sessions: ended ? [CURRENT] : [CURRENT, OTHER] }),
      [`DELETE /api/portal/sessions/${OTHER.id}`]: () => {
        ended = true;
        return new Response(null, { status: 204 });
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Cerrar esta sesión' }));

    await vi.waitFor(() => {
      expect(screen.queryByText('Dispositivo sin nombre')).not.toBeInTheDocument();
    });
    expect(app.requests).toContain(`DELETE /api/portal/sessions/${OTHER.id}`);
  });
});
