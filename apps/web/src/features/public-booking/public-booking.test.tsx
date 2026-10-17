import type {
  PublicAvailabilityResponse,
  PublicBookingPageDto,
  PublicConfirmationDto,
  PublicHoldDto,
  PublicProfessionalDto,
} from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';
import {
  jsonBody,
  jsonResponse,
  problemResponse,
  type FetchHandler,
} from '../../shared/test/render.js';

const ZONE = 'America/Argentina/Buenos_Aires';
const LOCATION = '0190a000-0000-7000-8000-0000000000a1';
const TYPE = '0190a000-0000-7000-8000-0000000000b1';
const HOLD_ID = '0190a000-0000-7000-8000-0000000000c1';

const professional = (slug: string, name: string): PublicProfessionalDto => ({
  slug,
  name,
  specialties: ['Clínica médica'],
  types: [{ id: TYPE, name: 'Consulta', durationMinutes: 30, mode: 'in_person' }],
  locations: [{ id: LOCATION, name: 'Sede Centro', timeZone: ZONE }],
});

const page = (
  professionals: PublicProfessionalDto[],
  scope: PublicBookingPageDto['scope'] = 'organization',
): PublicBookingPageDto => ({
  organizationName: 'Aillu',
  scope,
  professionals,
  requiresApproval: false,
  horizonDays: 60,
});

const SLOTS: PublicAvailabilityResponse = {
  slots: [
    {
      startsAt: '2031-05-12T13:00:00.000Z',
      endsAt: '2031-05-12T13:30:00.000Z',
      locationId: LOCATION,
      date: '2031-05-12',
    },
    {
      startsAt: '2031-05-12T13:30:00.000Z',
      endsAt: '2031-05-12T14:00:00.000Z',
      locationId: LOCATION,
      date: '2031-05-12',
    },
    {
      startsAt: '2031-05-14T13:00:00.000Z',
      endsAt: '2031-05-14T13:30:00.000Z',
      locationId: LOCATION,
      date: '2031-05-14',
    },
  ],
  nextAvailable: null,
};

const hold = (): PublicHoldDto => ({
  id: HOLD_ID,
  startsAt: '2031-05-12T13:00:00.000Z',
  endsAt: '2031-05-12T13:30:00.000Z',
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  locationId: LOCATION,
  appointmentTypeId: TYPE,
});

const CONFIRMATION: PublicConfirmationDto = {
  status: 'scheduled',
  startsAt: '2031-05-12T13:00:00.000Z',
  endsAt: '2031-05-12T13:30:00.000Z',
  timeZone: ZONE,
  organizationName: 'Aillu',
  professionalName: 'Dra. Ana Pérez',
  locationName: 'Sede Centro',
  typeName: 'Consulta',
  mode: 'in_person',
  calendarFile: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
  managePath: '/book/manage/' + 'a'.repeat(43),
};

interface Network {
  routes: Record<string, FetchHandler | Response>;
  bodies: Record<string, unknown[]>;
}

/** A fake API for the public booking: every request that carries a body is recorded by its path. */
function network(overrides: Record<string, FetchHandler | Response> = {}): Network {
  const bodies: Record<string, unknown[]> = {};
  const record =
    (key: string, answer: () => Response): FetchHandler =>
    (_url, init) => {
      (bodies[key] ??= []).push(jsonBody(init));
      return answer();
    };
  return {
    bodies,
    routes: {
      'GET /api/public/challenge': jsonResponse({ kind: 'fake', payload: {} }),
      'GET /api/public/aillu/booking': jsonResponse(
        page([professional('proone2345ab', 'Dra. Ana Pérez')]),
      ),
      'GET /api/public/aillu/booking/availability': jsonResponse(SLOTS),
      'POST /api/public/aillu/booking/holds': record('hold', () => jsonResponse(hold(), 201)),
      [`POST /api/public/aillu/booking/holds/${HOLD_ID}/submission`]: record('submission', () =>
        jsonResponse({ maskedEmail: 'l***@example.test', codeExpiresAt: new Date().toISOString() }),
      ),
      [`POST /api/public/aillu/booking/holds/${HOLD_ID}/code`]: record('code', () =>
        jsonResponse({ maskedEmail: 'l***@example.test', codeExpiresAt: new Date().toISOString() }),
      ),
      [`POST /api/public/aillu/booking/holds/${HOLD_ID}/confirm`]: record('confirm', () =>
        jsonResponse(CONFIRMATION),
      ),
      ...overrides,
    },
  };
}

function open(net: Network, path = '/book/aillu') {
  return renderApp({ me: null, path, boot: bootFor('Aillu'), routes: net.routes });
}

async function pickFirstTime(user: ReturnType<typeof userEvent.setup>) {
  const time = await screen.findByRole('button', {
    name: 'lunes 12 de mayo a las 10:00',
  });
  await user.click(time);
}

async function fillForm(
  user: ReturnType<typeof userEvent.setup>,
  overrides: Partial<Record<'document' | 'email', string>> = {},
) {
  await user.type(await screen.findByLabelText('Nombres'), 'Lucía');
  await user.type(screen.getByLabelText('Apellido'), 'Fernández');
  await user.type(screen.getByLabelText('DNI'), overrides.document ?? '30111222');
  await user.type(screen.getByLabelText('Fecha de nacimiento'), '1990-04-02');
  await user.type(
    screen.getByLabelText('Correo electrónico'),
    overrides.email ?? 'lucia@example.test',
  );
  await user.click(screen.getByRole('checkbox', { name: /Acepto que el consultorio trate/ }));
}

describe('the public booking, step by step', () => {
  it('books in four steps and shows the confirmation, with no missing translation', async () => {
    const user = userEvent.setup();
    const net = network();
    const app = open(net);

    // 1. The time. One professional, one type and one place: nothing to choose but the time.
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Reserve su turno' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Horarios en hora de Buenos Aires (GMT-3)')).toBeInTheDocument();
    await pickFirstTime(user);

    // 2. The data.
    expect(await screen.findByRole('heading', { name: 'Sus datos' })).toBeInTheDocument();
    expect(screen.getByText(/lunes 12 de mayo, 10:00/)).toBeInTheDocument();
    expect(screen.getByText(/Guardamos este horario para usted durante/)).toBeInTheDocument();
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Continuar' }));

    // 3. The code.
    expect(await screen.findByRole('heading', { name: 'Confirme su correo' })).toBeInTheDocument();
    expect(screen.getByText(/l\*\*\*@example\.test/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Código de 6 dígitos'), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirmar el turno' }));

    // 4. The confirmation.
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Su turno está reservado' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Sede Centro')).toBeInTheDocument();
    expect(screen.getByText('Dra. Ana Pérez')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Agregar al calendario' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Cambiar o cancelar el turno' })).toHaveAttribute(
      'href',
      CONFIRMATION.managePath,
    );

    // What went to the server: no WhatsApp opt-in unless asked, the consent, a proof each time.
    expect(net.bodies['hold']?.[0]).toMatchObject({
      professional: 'proone2345ab',
      startsAt: '2031-05-12T13:00:00.000Z',
      appointmentTypeId: TYPE,
      challengeProof: expect.stringMatching(/./) as unknown,
    });
    expect(net.bodies['submission']?.[0]).toMatchObject({
      givenNames: 'Lucía',
      document: { type: 'dni', number: '30111222' },
      email: 'lucia@example.test',
      whatsappOptIn: false,
      dataProcessingConsent: true,
    });
    expect(net.bodies['confirm']?.[0]).toEqual({ code: '123456' });
    expect(app.missingKeys).toEqual([]);
  });

  it('has no accessibility violations on any step', async () => {
    const user = userEvent.setup();
    const app = open(network());

    await screen.findByRole('button', { name: 'lunes 12 de mayo a las 10:00' });
    expect(await a11yViolations(app.container)).toEqual([]);
    await pickFirstTime(user);
    await screen.findByRole('heading', { name: 'Sus datos' });
    expect(await a11yViolations(app.container)).toEqual([]);
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Continuar' }));
    await screen.findByRole('heading', { name: 'Confirme su correo' });
    expect(await a11yViolations(app.container)).toEqual([]);
    await user.type(screen.getByLabelText('Código de 6 dígitos'), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirmar el turno' }));
    await screen.findByRole('heading', { level: 1, name: 'Su turno está reservado' });
    expect(await a11yViolations(app.container)).toEqual([]);
  });

  it('asks which professional first on the page of an organization with several', async () => {
    const user = userEvent.setup();
    const net = network({
      'GET /api/public/aillu/booking': jsonResponse(
        page([
          professional('proone2345ab', 'Dra. Ana Pérez'),
          professional('protwo2345ab', 'Dr. Luis Gómez'),
        ]),
      ),
    });
    open(net);

    await screen.findByRole('heading', { name: '¿Con quién quiere atenderse?' });
    await user.click(screen.getByRole('button', { name: 'Elegir a Dr. Luis Gómez' }));

    expect(await screen.findByText('Horarios en hora de Buenos Aires (GMT-3)')).toBeInTheDocument();
    expect(screen.getByText('Dr. Luis Gómez')).toBeInTheDocument();
  });

  it('opens straight on the time for a link of one professional', async () => {
    const net = network({
      'GET /api/public/aillu/p/proone2345ab': jsonResponse(
        page([professional('proone2345ab', 'Dra. Ana Pérez')], 'professional'),
      ),
    });
    open(net, '/book/aillu/p/proone2345ab');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Reserve su turno con Dra. Ana Pérez' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Horarios en hora de Buenos Aires (GMT-3)')).toBeInTheDocument();
  });

  it('asks for the type of visit and the place when there is a choice', async () => {
    const two = {
      ...professional('proone2345ab', 'Dra. Ana Pérez'),
      types: [
        { id: TYPE, name: 'Consulta', durationMinutes: 30, mode: 'in_person' as const },
        {
          id: '0190a000-0000-7000-8000-0000000000b2',
          name: 'Control',
          durationMinutes: 15,
          mode: 'virtual' as const,
        },
      ],
      locations: [
        { id: LOCATION, name: 'Sede Centro', timeZone: ZONE },
        { id: '0190a000-0000-7000-8000-0000000000a2', name: 'Sede Norte', timeZone: ZONE },
      ],
    };
    open(network({ 'GET /api/public/aillu/booking': jsonResponse(page([two])) }));

    expect(await screen.findByRole('radio', { name: /Consulta/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Control/ })).toBeInTheDocument();
    expect(screen.getByText(/Por videollamada/)).toBeInTheDocument();
    expect(screen.getByLabelText('Lugar')).toHaveValue(LOCATION);
  });

  it('says up front that the organization approves each booking', async () => {
    open(
      network({
        'GET /api/public/aillu/booking': jsonResponse({
          ...page([professional('proone2345ab', 'Dra. Ana Pérez')]),
          requiresApproval: true,
        }),
      }),
    );

    expect(await screen.findByText(/El consultorio confirma cada turno/)).toBeInTheDocument();
  });

  it('shows the generic page, and nothing else, when the address does not work', async () => {
    const app = open(
      network({ 'GET /api/public/aillu/booking': problemResponse(404, 'not_found') }),
    );

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Este enlace no está disponible' }),
    ).toBeInTheDocument();
    expect(await a11yViolations(app.container)).toEqual([]);
  });
});

describe('the bot challenge', () => {
  it('solves the puzzle of the API on its own and sends the proof with the hold', async () => {
    const user = userEvent.setup();
    const net = network({
      'GET /api/public/challenge': jsonResponse({
        kind: 'pow',
        payload: {
          algorithm: 'sha256-leading-zero-bits',
          id: 'puzzle-id-1',
          difficulty: 6,
          expiresAt: 1_900_000_000_000,
          signature: 'signed',
        },
      }),
    });
    open(net);

    await pickFirstTime(user);

    await screen.findByRole('heading', { name: 'Sus datos' });
    const [sent] = net.bodies['hold'] as { challengeProof: string }[];
    expect(sent?.challengeProof).toMatch(/^puzzle-id-1\.6\.1900000000000\.signed\.\d+$/);
  });

  it('tells the visitor if the challenge cannot be read, instead of freezing', async () => {
    const user = userEvent.setup();
    const net = network({
      'GET /api/public/challenge': jsonResponse({ kind: 'turnstile', payload: {} }),
    });
    open(net);

    await pickFirstTime(user);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(net.bodies['hold']).toBeUndefined();
  });
});

describe('the form', () => {
  it('explains every missing or wrong answer in Spanish, and sends nothing', async () => {
    const user = userEvent.setup();
    const net = network();
    open(net);
    await pickFirstTime(user);
    await screen.findByRole('heading', { name: 'Sus datos' });

    await user.click(screen.getByRole('button', { name: 'Continuar' }));

    expect(
      await screen.findByText(
        'Para reservar el turno tiene que aceptar el tratamiento de sus datos.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Escriba el DNI con 7 u 8 números.')).toBeInTheDocument();
    expect(screen.getByText('Escriba una fecha de nacimiento válida.')).toBeInTheDocument();
    expect(screen.getAllByText('Este dato es obligatorio.').length).toBeGreaterThan(0);
    expect(net.bodies['submission']).toBeUndefined();
  });

  it('keeps the WhatsApp choice unticked, and asks for the mobile number when it is ticked', async () => {
    const user = userEvent.setup();
    const net = network();
    open(net);
    await pickFirstTime(user);
    await screen.findByRole('heading', { name: 'Sus datos' });
    const whatsapp = screen.getByRole('checkbox', {
      name: /recordatorios y confirmaciones por WhatsApp/,
    });
    expect(whatsapp).not.toBeChecked();

    await fillForm(user);
    await user.click(whatsapp);
    await user.click(screen.getByRole('button', { name: 'Continuar' }));

    expect(
      await screen.findByText('Para recibir avisos por WhatsApp escriba su celular.'),
    ).toBeInTheDocument();
    expect(net.bodies['submission']).toBeUndefined();
  });

  it('warns not to write health details in the reason, and asks no clinical question', async () => {
    const user = userEvent.setup();
    open(network());
    await pickFirstTime(user);
    await screen.findByRole('heading', { name: 'Sus datos' });

    expect(screen.getByText(/No escriba síntomas ni datos de salud/)).toBeInTheDocument();
    for (const clinical of [/síntomas?:/i, /alergias/i, /medicaci/i, /diagn/i]) {
      expect(screen.queryByLabelText(clinical)).not.toBeInTheDocument();
    }
  });

  it('shows what the API refused next to the field it names', async () => {
    const user = userEvent.setup();
    const net = network({
      [`POST /api/public/aillu/booking/holds/${HOLD_ID}/submission`]: () =>
        new Response(
          JSON.stringify({
            type: 'about:blank',
            title: 'validation_failed',
            status: 400,
            code: 'validation_failed',
            i18nKey: 'errors.validation_failed',
            requestId: 'r1',
            errors: [{ path: 'birthDate', i18nKey: 'booking.minor_contact_organization' }],
          }),
          { status: 400, headers: { 'content-type': 'application/problem+json' } },
        ),
    });
    open(net);
    await pickFirstTime(user);
    await fillForm(user);

    await user.click(screen.getByRole('button', { name: 'Continuar' }));

    expect(
      await screen.findByText(
        'Los turnos de menores se piden por el consultorio. Comuníquese con la recepción.',
      ),
    ).toBeInTheDocument();
    // Still on the form, with what was typed.
    expect(screen.getByLabelText('Nombres')).toHaveValue('Lucía');
  });
});

describe('when the slot cannot be had', () => {
  it('goes back to the times with a plain explanation when somebody else took it', async () => {
    const user = userEvent.setup();
    const net = network({
      'POST /api/public/aillu/booking/holds': problemResponse(409, 'slot_taken'),
    });
    open(net);

    await pickFirstTime(user);

    expect(
      await screen.findByText(
        'Alguien reservó ese horario un momento antes. Elija otro, por favor.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'lunes 12 de mayo a las 10:00' }),
    ).toBeInTheDocument();
  });

  it('returns to the times when the time to finish ran out while the code was being checked', async () => {
    const user = userEvent.setup();
    const net = network({
      [`POST /api/public/aillu/booking/holds/${HOLD_ID}/confirm`]: problemResponse(
        409,
        'slot_no_longer_available',
      ),
    });
    open(net);
    await pickFirstTime(user);
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Continuar' }));
    await screen.findByRole('heading', { name: 'Confirme su correo' });
    await user.type(screen.getByLabelText('Código de 6 dígitos'), '123456');

    await user.click(screen.getByRole('button', { name: 'Confirmar el turno' }));

    expect(await screen.findByText(/Pasó el tiempo para completar la reserva/)).toBeInTheDocument();
    expect(await screen.findByText('Horarios en hora de Buenos Aires (GMT-3)')).toBeInTheDocument();
  });

  it('points at the next free time, and at whom to ask, when nothing is free', async () => {
    const user = userEvent.setup();
    const net = network({
      'GET /api/public/aillu/booking/availability': (url) =>
        jsonResponse(
          url.includes('from=2031-07-')
            ? SLOTS
            : { slots: [], nextAvailable: { ...SLOTS.slots[0], date: '2031-07-07' } },
        ),
    });
    open(net);

    expect(
      await screen.findByText('No hay horarios disponibles en estas fechas.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/comuníquese con el consultorio/)).toBeInTheDocument();
    const next = screen.getByRole('button', { name: /Ver el próximo horario libre/ });
    await user.click(next);

    await waitFor(() => {
      expect(
        screen.queryByText('No hay horarios disponibles en estas fechas.'),
      ).not.toBeInTheDocument();
    });
  });
});

describe('the code step', () => {
  async function toCode(user: ReturnType<typeof userEvent.setup>, net: Network) {
    open(net);
    await pickFirstTime(user);
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Continuar' }));
    await screen.findByRole('heading', { name: 'Confirme su correo' });
  }

  it('accepts only six digits and says so otherwise', async () => {
    const user = userEvent.setup();
    const net = network();
    await toCode(user, net);

    await user.type(screen.getByLabelText('Código de 6 dígitos'), '12ab');
    await user.click(screen.getByRole('button', { name: 'Confirmar el turno' }));

    expect(await screen.findByText('El código tiene que ser de 6 números.')).toBeInTheDocument();
    expect(net.bodies['confirm']).toBeUndefined();
  });

  it('says a wrong code is wrong without saying why, and lets the visitor try again', async () => {
    const user = userEvent.setup();
    const net = network({
      [`POST /api/public/aillu/booking/holds/${HOLD_ID}/confirm`]: problemResponse(
        400,
        'booking_code_invalid',
      ),
    });
    await toCode(user, net);

    await user.type(screen.getByLabelText('Código de 6 dígitos'), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirmar el turno' }));

    expect(
      await within(await screen.findByRole('alert')).findByText(
        /El código no es válido o ya venció/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Código de 6 dígitos')).toHaveValue('123456');
  });

  it('waits before another code can be asked for, then sends one', async () => {
    const user = userEvent.setup();
    const net = network();
    await toCode(user, net);

    expect(screen.getByRole('button', { name: 'Enviar un código nuevo' })).toBeDisabled();
    expect(screen.getByText(/Podrá pedir otro código en/)).toBeInTheDocument();
  });

  it('goes back to the form to fix the address, keeping what was typed', async () => {
    const user = userEvent.setup();
    await toCode(user, network());

    await user.click(screen.getByRole('button', { name: 'Cambiar el correo' }));

    expect(await screen.findByRole('heading', { name: 'Sus datos' })).toBeInTheDocument();
    expect(screen.getByLabelText('Correo electrónico')).toHaveValue('lucia@example.test');
    expect(screen.getByLabelText('Apellido')).toHaveValue('Fernández');
  });
});
