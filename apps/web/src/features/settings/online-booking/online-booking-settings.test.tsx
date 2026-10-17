import { DEFAULT_SETTINGS_SECTIONS, type BookingLinkDto } from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { a11yViolations } from '../../../shared/test/a11y.js';
import { bootFor, meFor } from '../../../shared/test/fixtures.js';
import { renderApp, type RenderedApp } from '../../../shared/test/render-app.js';
import {
  jsonBody,
  jsonResponse,
  problemResponse,
  type FetchHandler,
} from '../../../shared/test/render.js';
import { IDS, LOCATIONS, PROFESSIONALS, TYPES } from '../../calendar/fixtures.js';

const ORG_LINK: BookingLinkDto = {
  id: '0190a000-0000-7000-8000-0000000000b1',
  professionalId: null,
  slug: 'clinica8x',
  enabled: true,
  locationIds: [],
  typeIds: [IDS.first, IDS.control],
  regeneratedAt: null,
  path: '/book/clinica8x',
};

const ANA_LINK: BookingLinkDto = {
  id: '0190a000-0000-7000-8000-0000000000b2',
  professionalId: IDS.ana,
  slug: 'anaslug1',
  enabled: false,
  locationIds: [IDS.central],
  typeIds: [IDS.control],
  regeneratedAt: null,
  path: '/book/clinica8x/p/anaslug1',
};

const settings = (overrides: Record<string, unknown> = {}) => ({
  receptionSeesClinicalMetadata: false,
  clinicalSharing: false,
  sharedTemplates: [],
  require2fa: false,
  quietHours: { start: '21:00', end: '08:00' },
  ...DEFAULT_SETTINGS_SECTIONS,
  ...overrides,
});

let current: RenderedApp | undefined;

afterEach(() => {
  expect(current?.missingKeys ?? []).toEqual([]);
  current = undefined;
  vi.restoreAllMocks();
});

interface Mount {
  links?: BookingLinkDto[];
  me?: ReturnType<typeof meFor>;
  loaded?: ReturnType<typeof settings>;
  routes?: Record<string, FetchHandler | Response>;
}

function open(options: Mount = {}) {
  current = renderApp({
    me: options.me ?? meFor(['owner']),
    path: '/settings/online-booking',
    boot: bootFor('Centro Médico Aillu'),
    routes: {
      'GET /api/booking-links': () =>
        jsonResponse({ links: options.links ?? [ORG_LINK, ANA_LINK] }),
      'GET /api/staff': () => jsonResponse({ staff: PROFESSIONALS }),
      'GET /api/appointment-types': () => jsonResponse({ types: TYPES }),
      'GET /api/locations': () => jsonResponse({ locations: LOCATIONS }),
      'GET /api/settings': () => jsonResponse(options.loaded ?? settings()),
      ...options.routes,
    },
  });
  return current;
}

/** The card of a professional or of the organization, found by its heading. */
async function cardOf(name: string) {
  const heading = await screen.findByRole('heading', { name });
  const card = heading.closest('section');
  if (!card) throw new Error(`no card for ${name}`);
  return within(card);
}

const addressOf = (name: string) =>
  `${window.location.origin}${(name === 'org' ? ORG_LINK.path : ANA_LINK.path) ?? ''}`;

describe('Settings > Turnos online: the section', () => {
  it('is offered to whoever manages online booking, with the words of the product', async () => {
    open();

    const nav = await screen.findByRole('navigation', { name: /Secciones/i });
    expect(within(nav).getByRole('link', { name: 'Turnos online' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Turnos online', level: 2 })).toBeVisible();
  });

  it('is not offered to reception, and the page refuses it if reached by address', async () => {
    open({ me: meFor(['reception']) });

    expect(await screen.findByText(/No tiene acceso/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Turnos online' })).toBeNull();
  });
});

describe('the links of the organization', () => {
  it('shows the link of the organization and one card per professional, with their state in words', async () => {
    open();

    const org = await cardOf('Enlace de la organización');
    expect(org.getByText('Activo')).toBeInTheDocument();
    expect(org.getByLabelText('Dirección del enlace de la organización')).toHaveValue(
      addressOf('org'),
    );

    const ana = await cardOf('Dra. Ana Pérez');
    expect(ana.getByText('Desactivado')).toBeInTheDocument();
    expect(ana.getByLabelText('Dirección del enlace de Dra. Ana Pérez')).toHaveValue(
      addressOf('ana'),
    );

    const beto = await cardOf('Dr. Beto Ruiz');
    expect(beto.getByText('Sin enlace')).toBeInTheDocument();
    expect(beto.getByRole('button', { name: 'Crear enlace' })).toBeEnabled();
  });

  it('says which types and places a professional link offers, and warns when it offers no type at all', async () => {
    open({ links: [ORG_LINK, { ...ANA_LINK, typeIds: [] }] });

    const ana = await cardOf('Dra. Ana Pérez');
    expect(ana.getByText(/Todavía no se puede reservar/)).toBeInTheDocument();
    expect(ana.getByText('Sede Central')).toBeInTheDocument();
  });

  it('lists the types and places of a professional by name', async () => {
    open();

    const ana = await cardOf('Dra. Ana Pérez');
    expect(ana.getByText('Control')).toBeInTheDocument();
    expect(ana.getByText('Sede Central')).toBeInTheDocument();
    expect(ana.queryByText(/Todavía no se puede reservar/)).toBeNull();
  });

  it('explains that the link of the organization carries no types or places of its own', async () => {
    open();

    const org = await cardOf('Enlace de la organización');
    expect(
      org.getByText(/Cada profesional elige sus propios tipos de turno y sedes/),
    ).toBeVisible();
    expect(org.queryByRole('button', { name: 'Elegir tipos y sedes' })).toBeNull();
    expect(org.queryByText(/Todavía no se puede reservar/)).toBeNull();
  });

  it('offers to create the link of the organization, and does not hold the professionals back', async () => {
    open({ links: [] });

    const org = await cardOf('Enlace de la organización');
    expect(org.getByText('Sin enlace')).toBeInTheDocument();
    expect(org.getByRole('button', { name: 'Crear enlace' })).toBeEnabled();
    const ana = await cardOf('Dra. Ana Pérez');
    expect(ana.getByRole('button', { name: 'Crear enlace' })).toBeEnabled();
  });

  it('creates the link of a professional with the types and places chosen, switched on', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    let links = [ORG_LINK];
    open({
      links,
      routes: {
        'GET /api/booking-links': () => jsonResponse({ links }),
        'POST /api/booking-links': (_url, init) => {
          bodies.push(jsonBody(init));
          links = [...links, ANA_LINK];
          return jsonResponse({ ...ANA_LINK, enabled: true }, 201);
        },
      },
    });

    const ana = await cardOf('Dra. Ana Pérez');
    await user.click(ana.getByRole('button', { name: 'Crear enlace' }));
    const dialog = await screen.findByRole('dialog', { name: 'Crear el enlace de Dra. Ana Pérez' });
    await user.click(within(dialog).getByRole('checkbox', { name: 'Control' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Sede Central' }));
    await user.click(within(dialog).getByRole('switch', { name: 'Activar el enlace ahora' }));
    await user.click(within(dialog).getByRole('button', { name: 'Crear enlace' }));

    await waitFor(() => {
      expect(bodies).toEqual([
        {
          professionalId: IDS.ana,
          enabled: true,
          typeIds: [IDS.control],
          locationIds: [IDS.central],
        },
      ]);
    });
    expect(await screen.findByText('Enlace creado.')).toBeInTheDocument();
  });

  it('creates the link of the organization without types or places, which it does not have', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open({
      links: [],
      routes: {
        'POST /api/booking-links': (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse(ORG_LINK, 201);
        },
      },
    });

    const org = await cardOf('Enlace de la organización');
    await user.click(org.getByRole('button', { name: 'Crear enlace' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Crear el enlace de la organización',
    });
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    await user.click(within(dialog).getByRole('switch', { name: 'Activar el enlace ahora' }));
    await user.click(within(dialog).getByRole('button', { name: 'Crear enlace' }));

    await waitFor(() => {
      expect(bodies).toEqual([{ enabled: true }]);
    });
  });

  it('switches a link on and off at once', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open({
      routes: {
        [`PATCH /api/booking-links/${ANA_LINK.id}`]: (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse({ ...ANA_LINK, enabled: true });
        },
      },
    });

    const ana = await cardOf('Dra. Ana Pérez');
    await user.click(ana.getByRole('switch', { name: 'Recibir reservas' }));

    await waitFor(() => {
      expect(bodies).toEqual([{ enabled: true }]);
    });
    expect(await screen.findByText('Enlace activado.')).toBeInTheDocument();
  });

  it('changes the types and places a link offers', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open({
      routes: {
        [`PATCH /api/booking-links/${ANA_LINK.id}`]: (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse({ ...ANA_LINK, typeIds: [IDS.control, IDS.first], locationIds: [] });
        },
      },
    });

    const ana = await cardOf('Dra. Ana Pérez');
    await user.click(ana.getByRole('button', { name: 'Elegir tipos y sedes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Tipos y sedes de Dra. Ana Pérez' });
    expect(within(dialog).getByRole('checkbox', { name: 'Control' })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'Primera consulta' })).not.toBeChecked();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Primera consulta' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Sede Central' }));
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    await waitFor(() => {
      expect(bodies).toEqual([{ typeIds: [IDS.first, IDS.control].sort(), locationIds: [] }]);
    });
  });
});

describe('sharing a link', () => {
  it('copies the whole address, not just the path', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    open();

    const org = await cardOf('Enlace de la organización');
    await user.click(org.getByRole('button', { name: 'Copiar enlace' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(addressOf('org'));
    });
    expect(await screen.findByText('Enlace copiado.')).toBeInTheDocument();
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('shows the QR code of the address, with a name for screen readers and the address in words', async () => {
    const user = userEvent.setup();
    open();

    const ana = await cardOf('Dra. Ana Pérez');
    await user.click(ana.getByRole('button', { name: 'Mostrar código QR' }));

    const dialog = await screen.findByRole('dialog', { name: 'Código QR de Dra. Ana Pérez' });
    expect(
      await within(dialog).findByRole('img', { name: 'Código QR del enlace de Dra. Ana Pérez' }),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(addressOf('ana'))).toBeInTheDocument();
    expect(await a11yViolations(dialog)).toEqual([]);
  });

  it('replaces the address only after an explicit confirmation that says what stops working', async () => {
    const user = userEvent.setup();
    const posted: string[] = [];
    open({
      routes: {
        [`POST /api/booking-links/${ORG_LINK.id}/regenerate`]: (url) => {
          posted.push(url);
          return jsonResponse({ ...ORG_LINK, slug: 'nuevo1234', path: '/book/nuevo1234' });
        },
      },
    });

    const org = await cardOf('Enlace de la organización');
    await user.click(org.getByRole('button', { name: 'Generar un enlace nuevo' }));
    const confirm = await screen.findByRole('alertdialog', { name: '¿Generar un enlace nuevo?' });
    expect(within(confirm).getByText(/dejará de funcionar de inmediato/)).toBeInTheDocument();
    expect(within(confirm).getByText(/Los turnos ya reservados no cambian/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Cancelar' }));
    expect(posted).toEqual([]);

    await user.click(org.getByRole('button', { name: 'Generar un enlace nuevo' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Generar enlace nuevo',
      }),
    );

    await waitFor(() => {
      expect(posted).toHaveLength(1);
    });
    expect(await screen.findByText('Se generó un enlace nuevo.')).toBeInTheDocument();
  });
});

describe('the rules of online booking', () => {
  it('shows the current rules and saves only what changed', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open({
      routes: {
        'PATCH /api/settings': (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse(
            settings({
              onlineBooking: { ...DEFAULT_SETTINGS_SECTIONS.onlineBooking, horizonDays: 90 },
            }),
          );
        },
      },
    });

    const horizon = await screen.findByLabelText('Hasta cuántos días adelante se puede reservar');
    expect(horizon).toHaveValue('60');
    expect(screen.getByLabelText('Anticipación mínima, en horas')).toHaveValue('2');
    expect(screen.getByLabelText('Máximo de reservas por profesional y día')).toHaveValue('');
    expect(
      screen.getByLabelText('Hasta cuántas horas antes el paciente puede cambiar o cancelar'),
    ).toHaveValue('12');

    await user.clear(horizon);
    await user.type(horizon, '90');
    await user.click(screen.getByRole('button', { name: 'Guardar reglas' }));

    await waitFor(() => {
      expect(bodies).toEqual([{ onlineBooking: { horizonDays: 90 } }]);
    });
    expect(await screen.findByText('Reglas guardadas.')).toBeInTheDocument();
  });

  it('turns on the approval of every booking, and sets a daily limit', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open({
      routes: {
        'PATCH /api/settings': (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse(settings());
        },
      },
    });

    await user.click(
      await screen.findByRole('switch', { name: 'Aprobar cada reserva antes de confirmarla' }),
    );
    await user.type(screen.getByLabelText('Máximo de reservas por profesional y día'), '8');
    await user.click(screen.getByRole('button', { name: 'Guardar reglas' }));

    await waitFor(() => {
      expect(bodies).toEqual([{ onlineBooking: { requireApproval: true, dailyCap: 8 } }]);
    });
  });

  it('says what is wrong before it asks the server, and sends nothing', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open({
      routes: {
        'PATCH /api/settings': (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse(settings());
        },
      },
    });

    const horizon = await screen.findByLabelText('Hasta cuántos días adelante se puede reservar');
    await user.clear(horizon);
    await user.type(horizon, '400');
    await user.type(screen.getByLabelText('Máximo de reservas por profesional y día'), '0');
    await user.click(screen.getByRole('button', { name: 'Guardar reglas' }));

    expect(await screen.findByText('Ingrese un número entero entre 1 y 365.')).toBeInTheDocument();
    expect(
      screen.getByText('Ingrese un número entero entre 1 y 500, o deje vacío.'),
    ).toBeInTheDocument();
    expect(bodies).toEqual([]);
  });

  it('shows the rules without a save button to someone who cannot change the settings', async () => {
    open({ me: meFor(['owner'], { permissions: ['booking.manage'] }) });

    expect(await screen.findByLabelText('Anticipación mínima, en horas')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Guardar reglas' })).toBeNull();
    expect(
      screen.getByText(/Solo quien administra la organización puede cambiar estas reglas/),
    ).toBeVisible();
  });
});

describe('when something goes wrong or the organization is read-only', () => {
  it('offers to try again when the links cannot be loaded', async () => {
    open({ routes: { 'GET /api/booking-links': problemResponse(500, 'internal_error') } });

    expect(await screen.findByRole('button', { name: /Reintentar/i })).toBeInTheDocument();
  });

  it('says it when the server refuses a change, and keeps the switch where it was', async () => {
    const user = userEvent.setup();
    open({
      routes: {
        [`PATCH /api/booking-links/${ANA_LINK.id}`]: problemResponse(409, 'conflict'),
      },
    });

    const ana = await cardOf('Dra. Ana Pérez');
    await user.click(ana.getByRole('switch', { name: 'Recibir reservas' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(ana.getByRole('switch', { name: 'Recibir reservas' })).not.toBeChecked();
  });

  it('disables every change in a read-only organization and says why', async () => {
    open({ me: meFor(['owner'], { tenantStatus: 'read_only' }) });

    expect(await screen.findByText(/solo lectura/i)).toBeInTheDocument();
    const ana = await cardOf('Dra. Ana Pérez');
    expect(ana.getByRole('switch', { name: 'Recibir reservas' })).toBeDisabled();
    expect(ana.getByRole('button', { name: 'Generar un enlace nuevo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Guardar reglas' })).toBeDisabled();
    // Looking and copying are still fine.
    expect(ana.getByRole('button', { name: 'Copiar enlace' })).toBeEnabled();
  });
});

describe('accessibility', () => {
  it('has no violations with every section on the page', async () => {
    const view = open();
    await cardOf('Dra. Ana Pérez');
    await screen.findByLabelText('Anticipación mínima, en horas');

    expect(await a11yViolations(view.container)).toEqual([]);
  });
});
