import type { PublicBookingPageDto } from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { a11yViolations } from '../../../shared/test/a11y.js';
import { bootFor } from '../../../shared/test/fixtures.js';
import { renderApp } from '../../../shared/test/render-app.js';
import {
  jsonBody,
  jsonResponse,
  problemResponse,
  type FetchHandler,
} from '../../../shared/test/render.js';

const ZONE = 'America/Argentina/Buenos_Aires';
const LOCATION = '0190a000-0000-7000-8000-0000000000a1';
const TYPE = '0190a000-0000-7000-8000-0000000000b1';
const SUBMISSION = '0190a000-0000-7000-8000-0000000000c1';
const SLUG = 'proone2345ab';

const PAGE: PublicBookingPageDto = {
  organizationName: 'Aillu',
  scope: 'professional',
  professionals: [
    {
      slug: SLUG,
      name: 'Dra. Ana Pérez',
      specialties: ['Clínica médica'],
      types: [
        { id: TYPE, name: 'Consulta', durationMinutes: 30, mode: 'in_person' },
        {
          id: '0190a000-0000-7000-8000-0000000000b2',
          name: 'Control',
          durationMinutes: 20,
          mode: 'in_person',
        },
      ],
      locations: [{ id: LOCATION, name: 'Sede Centro', timeZone: ZONE }],
    },
  ],
  requiresApproval: false,
  horizonDays: 60,
};

interface Network {
  routes: Record<string, FetchHandler | Response>;
  bodies: Record<string, unknown[]>;
}

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
      [`GET /api/public/aillu/p/${SLUG}`]: jsonResponse(PAGE),
      'POST /api/public/aillu/waitlist': record('join', () =>
        jsonResponse({
          id: SUBMISSION,
          maskedEmail: 'l***@example.test',
          codeExpiresAt: '2031-05-05T12:10:00.000Z',
        }),
      ),
      [`POST /api/public/aillu/waitlist/${SUBMISSION}/code`]: record('code', () =>
        jsonResponse({
          id: SUBMISSION,
          maskedEmail: 'l***@example.test',
          codeExpiresAt: '2031-05-05T12:20:00.000Z',
        }),
      ),
      [`POST /api/public/aillu/waitlist/${SUBMISSION}/confirm`]: record('confirm', () =>
        jsonResponse({ joined: true, expiresAt: '2031-07-04T12:00:00.000Z' }),
      ),
      ...overrides,
    },
  };
}

function open(net: Network, search = `?type=${TYPE}&location=${LOCATION}`) {
  return renderApp({
    me: null,
    path: `/book/aillu/p/${SLUG}/waitlist${search}`,
    boot: bootFor('Aillu'),
    routes: net.routes,
  });
}

async function fill(user: ReturnType<typeof userEvent.setup>, overrides: { phone?: string } = {}) {
  await user.type(await screen.findByLabelText('Nombres'), 'Lucía');
  await user.type(screen.getByLabelText('Apellido'), 'Fernández');
  await user.type(screen.getByLabelText('DNI'), '30111222');
  await user.type(screen.getByLabelText('Fecha de nacimiento'), '1990-04-02');
  await user.type(screen.getByLabelText('Correo electrónico'), 'lucia@example.test');
  if (overrides.phone) await user.type(screen.getByLabelText(/Celular/), overrides.phone);
}

const agree = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('checkbox', { name: /Acepto que me escriban/ }));
  await user.click(screen.getByRole('checkbox', { name: /Acepto que el consultorio trate/ }));
};

describe('joining the waitlist from the public page', () => {
  it('explains what happens, with the choice of type and place the visitor came with', async () => {
    open(network());

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Anótese en la lista de espera' }),
    ).toBeVisible();
    expect(screen.getByText(/No encontró un horario con Dra\. Ana Pérez/)).toBeVisible();
    expect(screen.getByLabelText('Tipo de turno')).toHaveValue(TYPE);
    expect(screen.getByLabelText('Sede')).toHaveValue(LOCATION);
    expect(screen.getByText(/Le ofrecemos el horario por correo/)).toBeVisible();
  });

  it('starts with every agreement unticked and with any day and time', async () => {
    open(network());

    await screen.findByLabelText('Nombres');
    expect(screen.getByRole('checkbox', { name: /Acepto que me escriban/ })).not.toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: /Acepto que el consultorio trate/ }),
    ).not.toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: /También quiero recibir las ofertas por WhatsApp/ }),
    ).not.toBeChecked();
    expect(screen.getByText('Si no elige ninguno, sirve cualquier día.')).toBeVisible();
  });

  it('asks for the agreement and the consent in Spanish and sends nothing until they are given', async () => {
    const user = userEvent.setup();
    const net = network();
    open(net);
    await fill(user);

    await user.click(screen.getByRole('button', { name: 'Anotarme en la lista' }));

    expect(
      await screen.findByText(
        'Para anotarse hace falta aceptar que le escribamos cuando se libere un turno.',
      ),
    ).toBeVisible();
    expect(
      screen.getByText('Para anotarse en la lista tiene que aceptar el tratamiento de sus datos.'),
    ).toBeVisible();
    expect(net.bodies['join']).toBeUndefined();
  });

  it('wants a phone number for WhatsApp', async () => {
    const user = userEvent.setup();
    const net = network();
    open(net);
    await fill(user);
    await agree(user);
    await user.click(
      screen.getByRole('checkbox', { name: /También quiero recibir las ofertas por WhatsApp/ }),
    );

    await user.click(screen.getByRole('button', { name: 'Anotarme en la lista' }));

    expect(
      await screen.findByText('Para recibir avisos por WhatsApp escriba su celular.'),
    ).toBeVisible();
    expect(net.bodies['join']).toBeUndefined();
  });

  it('sends the form with what the visitor chose, then asks for the code', async () => {
    const user = userEvent.setup();
    const net = network();
    open(net);
    await fill(user, { phone: '+54 11 5555 0000' });
    await user.click(screen.getByRole('checkbox', { name: 'lunes' }));
    await user.click(screen.getByRole('checkbox', { name: 'miércoles' }));
    await user.click(screen.getByRole('button', { name: 'Mañana (8 a 12)' }));
    await agree(user);

    await user.click(screen.getByRole('button', { name: 'Anotarme en la lista' }));

    expect(await screen.findByRole('heading', { name: 'Confirme su correo' })).toBeVisible();
    expect(
      screen.getByText(/Enviamos un código de 6 dígitos a l\*\*\*@example\.test/),
    ).toBeVisible();
    expect(net.bodies['join']).toEqual([
      {
        professional: SLUG,
        appointmentTypeId: TYPE,
        locationId: LOCATION,
        weekdays: [1, 3],
        timeRanges: [{ from: '08:00', to: '12:00' }],
        earliestDate: null,
        latestDate: null,
        givenNames: 'Lucía',
        familyName: 'Fernández',
        document: { type: 'dni', number: '30111222' },
        birthDate: '1990-04-02',
        email: 'lucia@example.test',
        phone: '+54 11 5555 0000',
        channels: ['email'],
        offersOptIn: true,
        dataProcessingConsent: true,
        challengeProof: 'not-needed',
      },
    ]);
  });

  it('sends the WhatsApp choice as a second channel', async () => {
    const user = userEvent.setup();
    const net = network();
    open(net);
    await fill(user, { phone: '+54 11 5555 0000' });
    await agree(user);
    await user.click(
      screen.getByRole('checkbox', { name: /También quiero recibir las ofertas por WhatsApp/ }),
    );

    await user.click(screen.getByRole('button', { name: 'Anotarme en la lista' }));

    await screen.findByRole('heading', { name: 'Confirme su correo' });
    expect((net.bodies['join']?.[0] as { channels: string[] }).channels).toEqual([
      'email',
      'whatsapp',
    ]);
  });

  it('confirms with the code and says the visitor is on the list, until when', async () => {
    const user = userEvent.setup();
    const net = network();
    open(net);
    await fill(user);
    await agree(user);
    await user.click(screen.getByRole('button', { name: 'Anotarme en la lista' }));

    await user.type(await screen.findByLabelText('Código de 6 dígitos'), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirmar y anotarme' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Quedó anotado en la lista de espera' }),
    ).toBeVisible();
    expect(screen.getByText(/le escribimos a lucia@example\.test/)).toBeVisible();
    expect(screen.getByText(/vale hasta el 04\/07\/2031/)).toBeVisible();
    expect(net.bodies['confirm']).toEqual([{ code: '123456' }]);
    expect(screen.getByRole('link', { name: 'Volver a la reserva' })).toHaveAttribute(
      'href',
      `/book/aillu/p/${SLUG}`,
    );
  });

  it('shows one message for a wrong or expired code, and lets the visitor try again', async () => {
    const user = userEvent.setup();
    const net = network({
      [`POST /api/public/aillu/waitlist/${SUBMISSION}/confirm`]: () =>
        problemResponse(400, 'waitlist_code_invalid'),
    });
    open(net);
    await fill(user);
    await agree(user);
    await user.click(screen.getByRole('button', { name: 'Anotarme en la lista' }));

    await user.type(await screen.findByLabelText('Código de 6 dígitos'), '000000');
    await user.click(screen.getByRole('button', { name: 'Confirmar y anotarme' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'El código no es válido o ya venció',
    );
    expect(screen.getByLabelText('Código de 6 dígitos')).toBeVisible();
  });

  it('asks for another code, and goes back to the form to fix the address', async () => {
    const user = userEvent.setup();
    const net = network();
    open(net);
    await fill(user);
    await agree(user);
    await user.click(screen.getByRole('button', { name: 'Anotarme en la lista' }));
    await screen.findByRole('heading', { name: 'Confirme su correo' });

    await user.click(screen.getByRole('button', { name: 'Cambiar el correo' }));

    // What was typed is still there.
    expect(await screen.findByLabelText('Nombres')).toHaveValue('Lucía');
    expect(screen.getByLabelText('Correo electrónico')).toHaveValue('lucia@example.test');
  });

  it('shows the generic page when the link is not live', async () => {
    const net = network({ [`GET /api/public/aillu/p/${SLUG}`]: problemResponse(404, 'not_found') });
    open(net);

    expect(
      await screen.findByRole('heading', { name: 'Este enlace no está disponible' }),
    ).toBeVisible();
  });

  it('shows what the API refuses on the field it names', async () => {
    const user = userEvent.setup();
    const net = network({
      'POST /api/public/aillu/waitlist': () =>
        new Response(
          JSON.stringify({
            type: 'about:blank',
            title: 'Bad Request',
            status: 400,
            code: 'validation_failed',
            i18nKey: 'errors.validation_failed',
            requestId: 'req-1',
            errors: [{ path: 'birthDate', i18nKey: 'booking.minor_contact_organization' }],
          }),
          { status: 400, headers: { 'content-type': 'application/problem+json' } },
        ),
    });
    open(net);
    await fill(user);
    await agree(user);

    await user.click(screen.getByRole('button', { name: 'Anotarme en la lista' }));

    await waitFor(() => {
      expect(screen.getByLabelText('Fecha de nacimiento')).toHaveAttribute('aria-invalid', 'true');
    });
  });
});

describe('accessibility of the public join page', () => {
  it('has no violations in the form, the code step and the end', async () => {
    const user = userEvent.setup();
    const net = network();
    const app = open(net);
    await fill(user);
    await agree(user);
    await user.click(screen.getByRole('button', { name: 'Otra franja' }));
    expect(await a11yViolations(app.container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Quitar la franja 1' }));
    await user.click(screen.getByRole('button', { name: 'Anotarme en la lista' }));
    await screen.findByRole('heading', { name: 'Confirme su correo' });
    expect(await a11yViolations(app.container)).toEqual([]);

    await user.type(screen.getByLabelText('Código de 6 dígitos'), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirmar y anotarme' }));
    await screen.findByRole('heading', { name: 'Quedó anotado en la lista de espera' });
    expect(await a11yViolations(app.container)).toEqual([]);
    expect(within(app.container).getByRole('main')).toBeDefined();
  });
});
