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
const optOutEmailUrl = `POST /api/patients/${PATIENT_ID}/channels/email/opt-out`;
const optOutWhatsAppUrl = `POST /api/patients/${PATIENT_ID}/channels/whatsapp/opt-out`;
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

  it('disables the switch-back control with the reason when the patient opted out', async () => {
    open({
      [channelsUrl]: () =>
        jsonResponse(
          channels({
            whatsapp: state({
              state: 'opted_out',
              source: 'whatsapp_keyword',
              recordedAt: '2031-03-02T15:00:00.000Z',
            }),
          }),
        ),
    });

    const optIn = await screen.findByRole('button', {
      name: 'Registrar que acepta WhatsApp (en persona)',
    });
    expect(optIn).toBeDisabled();
    expect(optIn).toHaveAccessibleDescription(
      'El paciente dio de baja este canal. Solo el paciente puede volver a activarlo.',
    );
    expect(screen.getByText(/respondiendo BAJA por WhatsApp/)).toBeInTheDocument();
    // A channel already off has no second baja to record.
    expect(
      within(screen.getByRole('region', { name: 'WhatsApp' })).queryByRole('button', {
        name: 'Registrar la baja del canal',
      }),
    ).not.toBeInTheDocument();
  });

  it('asks for confirmation before recording a baja, and records nothing if reception backs out', async () => {
    const user = userEvent.setup();
    let called = false;
    open({
      [channelsUrl]: () => jsonResponse(channels()),
      [optOutEmailUrl]: () => {
        called = true;
        return jsonResponse(channels({ email: state({ state: 'opted_out' }) }));
      },
    });

    await user.click(
      within(await screen.findByRole('region', { name: 'Email' })).getByRole('button', {
        name: 'Registrar la baja del canal',
      }),
    );
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('¿Registrar la baja de Email?')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    expect(called).toBe(false);
  });

  it('records the baja once reception confirms', async () => {
    const user = userEvent.setup();
    let called = false;
    open({
      [channelsUrl]: () => jsonResponse(channels()),
      [optOutWhatsAppUrl]: () => {
        called = true;
        return jsonResponse(channels({ whatsapp: state({ state: 'opted_out', source: 'staff' }) }));
      },
    });

    await user.click(
      within(await screen.findByRole('region', { name: 'WhatsApp' })).getByRole('button', {
        name: 'Registrar la baja del canal',
      }),
    );
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Registrar la baja' }));

    await waitFor(() => {
      expect(called).toBe(true);
    });
    expect(await screen.findByText('Dado de baja')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
  });

  it('shows what the server says when it refuses', async () => {
    const user = userEvent.setup();
    open({
      [channelsUrl]: () => jsonResponse(channels()),
      [optInUrl]: problemResponse(409, 'channel_opted_out'),
    });

    await user.click(
      await screen.findByRole('button', { name: 'Registrar que acepta WhatsApp (en persona)' }),
    );

    expect(
      await screen.findByText(
        'El paciente dio de baja este canal. Solo el paciente puede volver a activarlo.',
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
