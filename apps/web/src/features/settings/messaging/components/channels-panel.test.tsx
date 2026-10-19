import type { ChannelStateDto, PatientChannelsResponse } from '@consultorio/contracts';
import { useQuery } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { useApi } from '../../../../app/providers.js';
import { meQueryOptions } from '../../../../app/session.js';
import { a11yViolations } from '../../../../shared/test/a11y.js';
import { bootFor, meFor } from '../../../../shared/test/fixtures.js';
import { renderInRouter } from '../../../../shared/test/render-app.js';
import { jsonResponse, problemResponse } from '../../../../shared/test/render.js';

import { ChannelsPanel } from './ChannelsPanel.js';

const PATIENT_ID = '0190a000-0000-7000-8000-0000000000c1';

type Handler = (url: string, init: RequestInit) => Response;

const state = (overrides: Partial<ChannelStateDto> = {}): ChannelStateDto => ({
  state: 'none',
  source: null,
  recordedAt: null,
  ...overrides,
});

const channels = (overrides: Partial<PatientChannelsResponse> = {}): PatientChannelsResponse => ({
  email: state({ state: 'default' }),
  whatsapp: state(),
  noMessages: false,
  hasEmail: true,
  hasMobile: true,
  ...overrides,
});

let missing: string[] | undefined;

/** The panel lives below the authenticated layout, which loads the profile first: do the same. */
function AfterSignIn({ children }: { children: ReactNode }) {
  const me = useQuery(meQueryOptions(useApi()));
  return me.data ? children : null;
}

afterEach(() => {
  expect(missing ?? []).toEqual([]);
  missing = undefined;
});

const channelsUrl = `GET /api/patients/${PATIENT_ID}/channels`;
const optInUrl = `POST /api/patients/${PATIENT_ID}/channels/whatsapp/opt-in`;
const optInEmailUrl = `POST /api/patients/${PATIENT_ID}/channels/email/opt-in`;
const optOutUrl = `POST /api/patients/${PATIENT_ID}/opt-out`;
const requestUrl = `POST /api/patients/${PATIENT_ID}/whatsapp-opt-in-request`;

function open(routes: Record<string, Handler | Response>, me = meFor(['reception'])) {
  const app = renderInRouter(
    <AfterSignIn>
      <ChannelsPanel patientId={PATIENT_ID} />
    </AfterSignIn>,
    {
      me,
      boot: bootFor('Centro Médico Aillu'),
      routes,
    },
  );
  missing = app.missingKeys;
  return app;
}

describe('the channels of a patient', () => {
  it('shows each channel with what the patient chose and where it was recorded', async () => {
    open({
      [channelsUrl]: () =>
        jsonResponse(
          channels({
            whatsapp: state({
              state: 'opted_in',
              source: 'online_booking',
              recordedAt: '2031-03-02T15:00:00.000Z',
            }),
          }),
        ),
    });

    const email = await screen.findByRole('region', { name: 'Email' });
    expect(within(email).getByText('Activo')).toBeInTheDocument();
    const whatsapp = screen.getByRole('region', { name: 'WhatsApp' });
    expect(within(whatsapp).getByText('Aceptado')).toBeInTheDocument();
    expect(within(whatsapp).getByText(/en la reserva online/)).toBeInTheDocument();
  });

  it('says what is missing when the record has no email or no mobile number', async () => {
    open({ [channelsUrl]: () => jsonResponse(channels({ hasEmail: false, hasMobile: false })) });

    expect(await screen.findByText('El paciente no tiene email registrado.')).toBeInTheDocument();
    expect(
      screen.getByText('El paciente no tiene un celular que se pueda usar para WhatsApp.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Registrar que acepta WhatsApp (en persona)' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Enviar por email el pedido de WhatsApp' }),
    ).toBeDisabled();
  });

  it('records an opt-in the patient gave in person and shows the new state', async () => {
    const user = userEvent.setup();
    let called = false;
    open({
      [channelsUrl]: () => jsonResponse(channels()),
      [optInUrl]: () => {
        called = true;
        return jsonResponse(
          channels({
            whatsapp: state({
              state: 'opted_in',
              source: 'staff',
              recordedAt: '2031-03-02T15:00:00.000Z',
            }),
          }),
        );
      },
    });

    await user.click(
      await screen.findByRole('button', { name: 'Registrar que acepta WhatsApp (en persona)' }),
    );

    await waitFor(() => {
      expect(called).toBe(true);
    });
    expect(await screen.findByText('Aceptado')).toBeInTheDocument();
    expect(screen.getByText(/registrado por recepción/)).toBeInTheDocument();
  });

  it('sends the WhatsApp request by email', async () => {
    const user = userEvent.setup();
    let called = false;
    open({
      [channelsUrl]: () => jsonResponse(channels()),
      [requestUrl]: () => {
        called = true;
        return jsonResponse({ sent: true });
      },
    });

    await user.click(
      await screen.findByRole('button', { name: 'Enviar por email el pedido de WhatsApp' }),
    );

    await waitFor(() => {
      expect(called).toBe(true);
    });
    expect(
      await screen.findByText(
        'Le enviamos al paciente un email con el enlace para aceptar WhatsApp.',
      ),
    ).toBeInTheDocument();
  });

  it('says "Sin avisos" when the patient opted out and no channel is open again (B7)', async () => {
    open({
      [channelsUrl]: () =>
        jsonResponse(
          channels({
            email: state({
              state: 'opted_out',
              source: 'whatsapp_keyword',
              recordedAt: '2031-03-02T15:00:00.000Z',
            }),
            whatsapp: state({
              state: 'opted_out',
              source: 'whatsapp_keyword',
              recordedAt: '2031-03-02T15:00:00.000Z',
            }),
            noMessages: true,
          }),
        ),
    });

    const title = await screen.findByText('Sin avisos');
    const notice = title.closest('[role="status"]');
    expect(notice).toHaveTextContent('no recibe mensajes de esta organización por ningún canal');
    // A baja already recorded has no second one to record.
    expect(screen.queryByRole('button', { name: 'Registrar la baja' })).not.toBeInTheDocument();
  });

  it('does not say "Sin avisos" while a channel is open', async () => {
    open({ [channelsUrl]: () => jsonResponse(channels()) });

    await screen.findByRole('region', { name: 'Email' });
    expect(screen.queryByText('Sin avisos')).not.toBeInTheDocument();
  });

  it('asks for confirmation before recording a baja for every channel, and records nothing if reception backs out', async () => {
    const user = userEvent.setup();
    let called = false;
    open({
      [channelsUrl]: () => jsonResponse(channels()),
      [optOutUrl]: () => {
        called = true;
        return jsonResponse(channels({ noMessages: true }));
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Registrar la baja' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText('¿Registrar la baja de todos los canales?'),
    ).toBeInTheDocument();
    expect(dialog).toHaveTextContent('Email y WhatsApp');
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    expect(called).toBe(false);
  });

  it('records the baja of every channel once reception confirms, and shows "Sin avisos"', async () => {
    const user = userEvent.setup();
    let called = false;
    open({
      [channelsUrl]: () => jsonResponse(channels()),
      [optOutUrl]: () => {
        called = true;
        return jsonResponse(
          channels({
            email: state({ state: 'opted_out', source: 'staff' }),
            whatsapp: state({ state: 'opted_out', source: 'staff' }),
            noMessages: true,
          }),
        );
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Registrar la baja' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Registrar la baja' }));

    await waitFor(() => {
      expect(called).toBe(true);
    });
    expect(await screen.findByText('Sin avisos')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
  });

  it('lets reception switch email back on after a baja, once it confirms (B7)', async () => {
    const user = userEvent.setup();
    let called = false;
    open({
      [channelsUrl]: () =>
        jsonResponse(
          channels({
            email: state({ state: 'opted_out', source: 'email_link' }),
            whatsapp: state({ state: 'opted_out', source: 'email_link' }),
            noMessages: true,
          }),
        ),
      [optInEmailUrl]: () => {
        called = true;
        return jsonResponse(
          channels({
            email: state({ state: 'opted_in', source: 'staff' }),
            whatsapp: state({ state: 'opted_out', source: 'email_link' }),
            noMessages: false,
          }),
        );
      },
    });

    await user.click(
      within(await screen.findByRole('region', { name: 'Email' })).getByRole('button', {
        name: 'Volver a activar el canal',
      }),
    );
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('¿Volver a activar Email?')).toBeInTheDocument();
    expect(called).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Volver a activar' }));

    await waitFor(() => {
      expect(called).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByText('Sin avisos')).not.toBeInTheDocument();
    });
    expect(
      within(screen.getByRole('region', { name: 'Email' })).getByText('Aceptado'),
    ).toBeInTheDocument();
  });

  it('lets reception record WhatsApp again after a baja, asking first', async () => {
    const user = userEvent.setup();
    let called = false;
    open({
      [channelsUrl]: () =>
        jsonResponse(
          channels({
            whatsapp: state({ state: 'opted_out', source: 'whatsapp_keyword' }),
          }),
        ),
      [optInUrl]: () => {
        called = true;
        return jsonResponse(channels({ whatsapp: state({ state: 'opted_in', source: 'staff' }) }));
      },
    });

    const optIn = await screen.findByRole('button', {
      name: 'Registrar que acepta WhatsApp (en persona)',
    });
    expect(optIn).toBeEnabled();
    await user.click(optIn);
    const dialog = await screen.findByRole('alertdialog');
    expect(called).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Volver a activar' }));

    await waitFor(() => {
      expect(called).toBe(true);
    });
  });

  it('asks for the email to be switched on first when it is the one that is off', async () => {
    open({
      [channelsUrl]: () =>
        jsonResponse(channels({ email: state({ state: 'opted_out', source: 'staff' }) })),
    });

    const request = await screen.findByRole('button', {
      name: 'Enviar por email el pedido de WhatsApp',
    });
    expect(request).toBeDisabled();
    expect(request).toHaveAccessibleDescription(
      'Para enviar el pedido, primero vuelva a activar el email del paciente.',
    );
  });

  it('shows what the server says when it refuses', async () => {
    const user = userEvent.setup();
    open({
      [channelsUrl]: () => jsonResponse(channels()),
      [optInUrl]: problemResponse(422, 'patient_without_phone'),
    });

    await user.click(
      await screen.findByRole('button', { name: 'Registrar que acepta WhatsApp (en persona)' }),
    );

    expect(
      await screen.findByText(
        'El paciente no tiene un celular que se pueda usar para WhatsApp. Cargue uno en su ficha.',
      ),
    ).toBeInTheDocument();
  });

  it('offers no controls to someone who cannot edit patients', async () => {
    open(
      { [channelsUrl]: () => jsonResponse(channels()) },
      meFor(['reception'], { permissions: ['patients.read'] }),
    );

    expect(await screen.findByRole('region', { name: 'Email' })).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const app = open({ [channelsUrl]: () => jsonResponse(channels()) });
    await screen.findByRole('region', { name: 'Email' });

    expect(await a11yViolations(app.container)).toEqual([]);
  });
});
