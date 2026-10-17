import type {
  PublicAvailabilityResponse,
  PublicConfirmationDto,
  PublicManageDto,
} from '@consultorio/contracts';
import { screen } from '@testing-library/react';
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
const TOKEN = 'a'.repeat(43);
const LOCATION = '0190a000-0000-7000-8000-0000000000a1';

const view = (overrides: Partial<PublicManageDto> = {}): PublicManageDto => ({
  appointment: {
    status: 'scheduled',
    startsAt: '2031-05-12T13:00:00.000Z',
    endsAt: '2031-05-12T13:30:00.000Z',
    timeZone: ZONE,
    professionalName: 'Dra. Ana Pérez',
    locationName: 'Sede Centro',
    typeName: 'Consulta',
    mode: 'in_person',
  },
  organizationName: 'Aillu',
  canChange: true,
  changeDeadline: '2031-05-12T01:00:00.000Z',
  ...overrides,
});

const SLOTS: PublicAvailabilityResponse = {
  slots: [
    {
      startsAt: '2031-05-19T13:00:00.000Z',
      endsAt: '2031-05-19T13:30:00.000Z',
      locationId: LOCATION,
      date: '2031-05-19',
    },
  ],
  nextAvailable: null,
};

const CONFIRMATION: PublicConfirmationDto = {
  status: 'scheduled',
  startsAt: '2031-05-19T13:00:00.000Z',
  endsAt: '2031-05-19T13:30:00.000Z',
  timeZone: ZONE,
  organizationName: 'Aillu',
  professionalName: 'Dra. Ana Pérez',
  locationName: 'Sede Centro',
  typeName: 'Consulta',
  mode: 'in_person',
  calendarFile: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
  managePath: '/book/manage/' + 'b'.repeat(43),
};

function open(routes: Record<string, FetchHandler | Response> = {}) {
  const bodies: Record<string, unknown[]> = {};
  const record =
    (key: string, answer: () => Response): FetchHandler =>
    (_url, init) => {
      (bodies[key] ??= []).push(jsonBody(init));
      return answer();
    };
  const app = renderApp({
    me: null,
    path: `/book/manage/${TOKEN}`,
    boot: bootFor('Aillu'),
    routes: {
      [`GET /api/public/t/${TOKEN}/appointment`]: jsonResponse(view()),
      [`GET /api/public/t/${TOKEN}/slots`]: jsonResponse(SLOTS),
      [`POST /api/public/t/${TOKEN}/reschedule`]: record('reschedule', () =>
        jsonResponse(CONFIRMATION),
      ),
      [`POST /api/public/t/${TOKEN}/cancel`]: record('cancel', () =>
        jsonResponse(
          view({ appointment: { ...view().appointment, status: 'cancelled' }, canChange: false }),
        ),
      ),
      ...routes,
    },
  });
  return Object.assign(app, { bodies });
}

describe('the link in the confirmation', () => {
  it('shows when, where and with whom, and offers to change or cancel', async () => {
    const app = open();

    expect(await screen.findByRole('heading', { level: 1, name: 'Su turno' })).toBeInTheDocument();
    expect(screen.getByText('Sede Centro')).toBeInTheDocument();
    expect(screen.getByText('Dra. Ana Pérez')).toBeInTheDocument();
    expect(screen.getByText('Reservado')).toBeInTheDocument();
    expect(screen.getByText(/Puede cambiarlo o cancelarlo hasta el/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cambiar el horario' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancelar el turno' })).toBeInTheDocument();
    expect(app.missingKeys).toEqual([]);
    expect(await a11yViolations(app.container)).toEqual([]);
  });

  it('shows the generic page for a link that does not work', async () => {
    open({ [`GET /api/public/t/${TOKEN}/appointment`]: problemResponse(404, 'not_found') });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Este enlace no está disponible' }),
    ).toBeInTheDocument();
  });

  it('says to contact the organization after the deadline, and offers nothing to change', async () => {
    open({
      [`GET /api/public/t/${TOKEN}/appointment`]: jsonResponse(view({ canChange: false })),
    });

    expect(
      await screen.findByText(/Ya pasó el plazo para cambiar este turno por internet/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cambiar el horario' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancelar el turno' })).not.toBeInTheDocument();
  });

  it('shows a cancelled appointment as cancelled', async () => {
    open({
      [`GET /api/public/t/${TOKEN}/appointment`]: jsonResponse(
        view({ appointment: { ...view().appointment, status: 'cancelled' }, canChange: false }),
      ),
    });

    expect(await screen.findByText('Este turno está cancelado.')).toBeInTheDocument();
  });

  it('cancels after an explicit confirmation, and keeps the appointment if the patient backs out', async () => {
    const user = userEvent.setup();
    const app = open();
    await screen.findByRole('heading', { name: 'Su turno' });

    await user.click(screen.getByRole('button', { name: 'Cancelar el turno' }));
    await user.click(await screen.findByRole('button', { name: 'No, conservar el turno' }));
    expect(app.bodies['cancel']).toBeUndefined();

    await user.click(screen.getByRole('button', { name: 'Cancelar el turno' }));
    expect(await screen.findByText(/El horario queda libre para otra persona/)).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Sí, cancelar el turno' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Su turno quedó cancelado' }),
    ).toBeInTheDocument();
    expect(app.bodies['cancel']).toHaveLength(1);
  });

  it('moves the appointment to another time after the patient confirms it', async () => {
    const user = userEvent.setup();
    const app = open();
    await user.click(await screen.findByRole('button', { name: 'Cambiar el horario' }));

    await user.click(await screen.findByRole('button', { name: 'lunes 19 de mayo a las 10:00' }));
    expect(app.bodies['reschedule']).toBeUndefined();
    await user.click(screen.getByRole('button', { name: 'Mover mi turno a este horario' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Su turno cambió de horario' }),
    ).toBeInTheDocument();
    expect(app.bodies['reschedule']?.[0]).toEqual({ startsAt: '2031-05-19T13:00:00.000Z' });
    expect(await a11yViolations(app.container)).toEqual([]);
  });

  it('keeps the appointment and shows the times again when the new one was taken', async () => {
    const user = userEvent.setup();
    open({ [`POST /api/public/t/${TOKEN}/reschedule`]: problemResponse(409, 'slot_taken') });
    await user.click(await screen.findByRole('button', { name: 'Cambiar el horario' }));
    await user.click(await screen.findByRole('button', { name: 'lunes 19 de mayo a las 10:00' }));

    await user.click(screen.getByRole('button', { name: 'Mover mi turno a este horario' }));

    expect(
      await screen.findByText(
        /Ese horario ya no está disponible. Su turno sigue en el horario anterior/,
      ),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'lunes 19 de mayo a las 10:00' }),
    ).toBeInTheDocument();
  });
});
