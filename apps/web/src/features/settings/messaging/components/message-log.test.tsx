import type {
  AppointmentMessagesResponse,
  CalendarEntryDto,
  MessageLogEntryDto,
} from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { a11yViolations } from '../../../../shared/test/a11y.js';
import { bootFor, meFor } from '../../../../shared/test/fixtures.js';
import { renderInRouter } from '../../../../shared/test/render-app.js';
import { jsonBody, jsonResponse, problemResponse } from '../../../../shared/test/render.js';

import { MessageLog } from './MessageLog.js';

const APPOINTMENT_ID = '0190a000-0000-7000-8000-0000000000a1';
const MESSAGE_ID = '0190a000-0000-7000-8000-0000000000b1';

const entry = (overrides: Partial<CalendarEntryDto> = {}): CalendarEntryDto => ({
  id: APPOINTMENT_ID,
  patientId: '0190a000-0000-7000-8000-0000000000c1',
  professionalId: '0190a000-0000-7000-8000-0000000000d1',
  locationId: '0190a000-0000-7000-8000-0000000000e1',
  appointmentTypeId: '0190a000-0000-7000-8000-0000000000f1',
  startsAt: '2031-05-12T13:00:00.000Z',
  endsAt: '2031-05-12T13:30:00.000Z',
  bufferMinutes: 0,
  status: 'scheduled',
  source: 'staff',
  bookedBy: null,
  identityConfirmed: true,
  identityConfirmation: null,
  outOfHours: false,
  seriesId: null,
  seriesIndex: null,
  version: 1,
  patientName: 'Ana Pérez',
  typeName: 'Consulta',
  typeColor: null,
  mode: 'in_person',
  ...overrides,
});

const log = (
  overrides: Partial<AppointmentMessagesResponse> = {},
): AppointmentMessagesResponse => ({
  messages: [],
  noAutomatedReminders: false,
  resendsLeft: 3,
  ...overrides,
});

const message = (overrides: Partial<MessageLogEntryDto> = {}): MessageLogEntryDto => ({
  id: MESSAGE_ID,
  kind: 'reminder',
  channel: 'email',
  status: 'sent',
  trigger: 'automatic',
  cancelReason: null,
  failureReason: null,
  sendAt: '2031-05-11T13:00:00.000Z',
  sentAt: '2031-05-11T13:00:05.000Z',
  deliveredAt: null,
  readAt: null,
  attempts: 1,
  ...overrides,
});

type Handler = (url: string, init: RequestInit) => Response;
let missing: string[] | undefined;

afterEach(() => {
  expect(missing ?? []).toEqual([]);
  missing = undefined;
});

function open(
  routes: Record<string, Handler | Response>,
  props: Partial<{ appointment: CalendarEntryDto; readOnly: boolean }> = {},
) {
  const app = renderInRouter(
    <MessageLog appointment={props.appointment ?? entry()} readOnly={props.readOnly ?? false} />,
    { me: meFor(['reception']), boot: bootFor('Centro Médico Aillu'), routes },
  );
  missing = app.missingKeys;
  return app;
}

const messagesUrl = `GET /api/appointments/${APPOINTMENT_ID}/messages`;
const resendUrl = `POST /api/appointments/${APPOINTMENT_ID}/messages/resend`;

describe('the message log in the appointment drawer', () => {
  it('shows each message with its kind, channel, status and when', async () => {
    open({
      [messagesUrl]: () =>
        jsonResponse(
          log({
            messages: [
              message(),
              message({
                id: '0190a000-0000-7000-8000-0000000000b2',
                channel: 'whatsapp',
                status: 'delivered',
                deliveredAt: '2031-05-11T13:01:00.000Z',
              }),
            ],
          }),
        ),
    });

    const list = await screen.findByRole('list', { name: 'Mensajes enviados por este turno' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Recordatorio');
    expect(items[0]).toHaveTextContent('Email');
    expect(items[0]).toHaveTextContent('Enviado');
    expect(items[1]).toHaveTextContent('WhatsApp');
    expect(items[1]).toHaveTextContent('Entregado');
  });

  it('says why a message failed or was cancelled, in words', async () => {
    open({
      [messagesUrl]: () =>
        jsonResponse(
          log({
            messages: [
              message({ status: 'failed', failureReason: 'not_on_whatsapp', channel: 'whatsapp' }),
              message({
                id: '0190a000-0000-7000-8000-0000000000b2',
                status: 'cancelled',
                cancelReason: 'opted_out',
              }),
            ],
          }),
        ),
    });

    expect(await screen.findByText('el número no tiene WhatsApp')).toBeInTheDocument();
    expect(screen.getByText('el paciente dio de baja el canal')).toBeInTheDocument();
  });

  it('marks a manual resend as such', async () => {
    open({
      [messagesUrl]: () => jsonResponse(log({ messages: [message({ trigger: 'manual' })] })),
    });

    expect(await screen.findByText('reenvío manual')).toBeInTheDocument();
  });

  it('warns when the appointment has no automated reminders', async () => {
    open({ [messagesUrl]: () => jsonResponse(log({ noAutomatedReminders: true })) });

    expect(await screen.findByText(/no tiene recordatorios automáticos/)).toBeInTheDocument();
  });

  it('says nothing was sent yet when the log is empty', async () => {
    open({ [messagesUrl]: () => jsonResponse(log()) });

    expect(
      await screen.findByText('Todavía no se envió ningún mensaje por este turno.'),
    ).toBeInTheDocument();
  });

  it('shows no text of any message and no address', async () => {
    const app = open({ [messagesUrl]: () => jsonResponse(log({ messages: [message()] })) });
    await screen.findByRole('list', { name: 'Mensajes enviados por este turno' });

    expect(app.container.textContent).not.toMatch(/@|\+54|Hola/);
  });
});

describe('the manual resend', () => {
  it('resends on the chosen channel and shows the updated log with the count left', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open({
      [messagesUrl]: () => jsonResponse(log()),
      [resendUrl]: (_url, init) => {
        body = jsonBody(init);
        return jsonResponse(log({ messages: [message({ trigger: 'manual' })], resendsLeft: 2 }));
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Reenviar por email' }));

    await waitFor(() => {
      expect(body).toEqual({ channel: 'email' });
    });
    expect(await screen.findByText('Reenvíos disponibles: 2 de 3.')).toBeInTheDocument();
    expect(screen.getByText('reenvío manual')).toBeInTheDocument();
  });

  it('shows what the server says when the patient opted out of the channel', async () => {
    const user = userEvent.setup();
    open({
      [messagesUrl]: () => jsonResponse(log()),
      [resendUrl]: problemResponse(409, 'channel_opted_out'),
    });

    await user.click(await screen.findByRole('button', { name: 'Reenviar por WhatsApp' }));

    expect(
      await screen.findByText(
        'El paciente dio de baja este canal. Solo el paciente puede volver a activarlo.',
      ),
    ).toBeInTheDocument();
  });

  it('disables both buttons when the three resends are used', async () => {
    open({ [messagesUrl]: () => jsonResponse(log({ resendsLeft: 0 })) });

    expect(await screen.findByRole('button', { name: 'Reenviar por email' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reenviar por WhatsApp' })).toBeDisabled();
    expect(screen.getByText('Ya se usaron los 3 reenvíos de este turno.')).toBeInTheDocument();
  });

  it('offers no resend for an organization in read-only mode or an appointment that is over', async () => {
    const readOnly = open({ [messagesUrl]: () => jsonResponse(log()) }, { readOnly: true });
    await screen.findByText('Todavía no se envió ningún mensaje por este turno.');
    expect(screen.queryByRole('button', { name: 'Reenviar por email' })).not.toBeInTheDocument();
    readOnly.unmount();

    open(
      { [messagesUrl]: () => jsonResponse(log()) },
      { appointment: entry({ status: 'cancelled' }) },
    );
    await screen.findByText('Todavía no se envió ningún mensaje por este turno.');
    expect(screen.queryByRole('button', { name: 'Reenviar por email' })).not.toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const app = open({ [messagesUrl]: () => jsonResponse(log({ messages: [message()] })) });
    await screen.findByRole('list', { name: 'Mensajes enviados por este turno' });

    expect(await a11yViolations(app.container)).toEqual([]);
  });
});
