import type { CalendarEntryDto, VideoSessionSummary } from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import {
  fakeFetch,
  jsonBody,
  jsonResponse,
  problemResponse,
  renderWithApp,
  type FetchHandler,
} from '../../shared/test/render.js';

import { VideoSessionPanel } from './components/VideoSessionPanel.js';

const APPOINTMENT = '0190a000-0000-7000-8000-0000000000a1';
const LOCATION = '0190a000-0000-7000-8000-0000000000b1';

const entry: CalendarEntryDto = {
  id: APPOINTMENT,
  patientId: '0190a000-0000-7000-8000-0000000000c1',
  professionalId: '0190a000-0000-7000-8000-0000000000d1',
  locationId: LOCATION,
  appointmentTypeId: '0190a000-0000-7000-8000-0000000000e1',
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
  version: 3,
  patientName: 'Gómez, Valentina',
  typeName: 'Consulta virtual',
  typeColor: null,
  mode: 'virtual',
};

const summary = (overrides: Partial<VideoSessionSummary> = {}): VideoSessionSummary => ({
  virtual: true,
  status: 'ready',
  pendingReason: null,
  hasLink: true,
  manual: false,
  patientOpenedLink: false,
  firstOpenedAt: null,
  integrationEnabled: true,
  window: { opensAt: '2031-05-12T12:45:00.000Z', closesAt: '2031-05-12T14:30:00.000Z' },
  canJoin: false,
  canAttachManualLink: true,
  noShowAllowedFrom: '2031-05-12T13:15:00.000Z',
  ...overrides,
});

const LOCATIONS = jsonResponse({
  locations: [
    {
      id: LOCATION,
      name: 'Sede Central',
      timeZone: 'America/Argentina/Buenos_Aires',
      active: true,
    },
  ],
});

function open(routes: Record<string, FetchHandler | Response>, props: { readOnly?: boolean } = {}) {
  return renderWithApp(
    <VideoSessionPanel appointment={entry} readOnly={props.readOnly ?? false} />,
    {
      fetch: fakeFetch({ 'GET /api/locations': LOCATIONS, ...routes }),
    },
  );
}

describe('the video panel of the appointment drawer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('marks the appointment as virtual and says when the room opens, in the time of the place', async () => {
    const view = open({ [`GET /api/appointments/${APPOINTMENT}/video`]: jsonResponse(summary()) });

    expect(await screen.findByRole('heading', { name: 'Videoconsulta' })).toBeInTheDocument();
    expect(screen.getByText('Virtual')).toBeInTheDocument();
    expect(
      screen.getByText(/La sala se habilita a las 09:45 y se cierra a las 11:30/),
    ).toBeInTheDocument();
    expect(screen.getByText('Enlace')).toBeInTheDocument();
    expect(screen.getByText('Listo')).toBeInTheDocument();
    expect(view.missingKeys).toEqual([]);
  });

  it('offers the join action only when the API says it is allowed, and opens the call in a new tab', async () => {
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    const joined: unknown[] = [];
    open({
      [`GET /api/appointments/${APPOINTMENT}/video`]: jsonResponse(summary({ canJoin: true })),
      [`POST /api/appointments/${APPOINTMENT}/video/join`]: (_url, init) => {
        joined.push(jsonBody(init));
        return jsonResponse({ url: 'https://meet.jit.si/0f8a3c2e9b1d4a7f8c6e5d4b3a291807' });
      },
    });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Entrar a la videoconsulta' }));

    await waitFor(() => {
      expect(opened).toHaveBeenCalledWith(
        'https://meet.jit.si/0f8a3c2e9b1d4a7f8c6e5d4b3a291807',
        '_blank',
        'noopener,noreferrer',
      );
    });
    expect(joined).toEqual([{}]);
  });

  it('does not show a join action outside the window, and says when it will be possible', async () => {
    open({
      [`GET /api/appointments/${APPOINTMENT}/video`]: jsonResponse(summary({ canJoin: false })),
    });

    await screen.findByRole('heading', { name: 'Videoconsulta' });

    expect(screen.queryByRole('button', { name: 'Entrar a la videoconsulta' })).toBeNull();
  });

  it('tells whether the patient opened the link, as information only', async () => {
    open({
      [`GET /api/appointments/${APPOINTMENT}/video`]: jsonResponse(
        summary({ patientOpenedLink: true, firstOpenedAt: '2031-05-12T12:55:00.000Z' }),
      ),
    });

    expect(await screen.findByText('El paciente abrió el enlace a las 09:55.')).toBeInTheDocument();
    expect(
      screen.getByText('Es solo informativo: no cambia el estado del turno.'),
    ).toBeInTheDocument();
  });

  it('says the patient has not opened the link yet, and when a no-show can be registered', async () => {
    open({ [`GET /api/appointments/${APPOINTMENT}/video`]: jsonResponse(summary()) });

    expect(await screen.findByText('El paciente todavía no abrió el enlace.')).toBeInTheDocument();
    expect(
      screen.getByText('La ausencia se puede registrar a partir de las 10:15.'),
    ).toBeInTheDocument();
  });

  it('renders nothing for an appointment in person', async () => {
    const view = open({
      [`GET /api/appointments/${APPOINTMENT}/video`]: jsonResponse(
        summary({
          virtual: false,
          status: null,
          hasLink: false,
          window: null,
          canAttachManualLink: false,
          noShowAllowedFrom: null,
        }),
      ),
    });

    await waitFor(() => {
      expect(view.services.queryClient.isFetching()).toBe(0);
    });
    expect(screen.queryByRole('heading', { name: 'Videoconsulta' })).toBeNull();
    expect(view.container.textContent).toBe('');
  });

  it('renders nothing for someone who may not see this calendar', async () => {
    const view = open({
      [`GET /api/appointments/${APPOINTMENT}/video`]: problemResponse(403, 'forbidden'),
    });

    await waitFor(() => {
      expect(view.services.queryClient.isFetching()).toBe(0);
    });
    expect(view.container.textContent).toBe('');
  });

  it('shows a calm error with a way to try again when the data cannot be loaded', async () => {
    let calls = 0;
    open({
      [`GET /api/appointments/${APPOINTMENT}/video`]: () => {
        calls += 1;
        return calls === 1
          ? problemResponse(500, 'internal_error')
          : jsonResponse(summary({ canJoin: true }));
      },
    });
    const user = userEvent.setup();

    expect(
      await screen.findByText('No pudimos cargar los datos de la videoconsulta.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));

    expect(
      await screen.findByRole('button', { name: 'Entrar a la videoconsulta' }),
    ).toBeInTheDocument();
  });

  it('keeps the actions out of a read-only organization', async () => {
    open(
      {
        [`GET /api/appointments/${APPOINTMENT}/video`]: jsonResponse(
          summary({
            canJoin: true,
            status: 'link_pending',
            pendingReason: 'provider_failed',
            hasLink: false,
          }),
        ),
      },
      { readOnly: true },
    );

    await screen.findByRole('heading', { name: 'Videoconsulta' });

    expect(screen.queryByRole('button', { name: 'Entrar a la videoconsulta' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Adjuntar enlace manual' })).toBeNull();
  });

  it('has no accessibility violations', async () => {
    const view = open({
      [`GET /api/appointments/${APPOINTMENT}/video`]: jsonResponse(
        summary({
          canJoin: true,
          patientOpenedLink: true,
          firstOpenedAt: '2031-05-12T12:55:00.000Z',
        }),
      ),
    });
    await screen.findByRole('button', { name: 'Entrar a la videoconsulta' });

    expect(await a11yViolations(view.container)).toEqual([]);
  });
});

describe('a session without a link', () => {
  const PENDING = (pendingReason: VideoSessionSummary['pendingReason']) =>
    summary({ status: 'link_pending', pendingReason, hasLink: false, canJoin: false });

  it.each([
    ['creating', 'Estamos creando la sala.'],
    ['integration_off', 'La videoconsulta automática está desactivada en esta organización.'],
    ['provider_unavailable', 'El servicio de video no está disponible.'],
    ['provider_failed', 'No pudimos crear la sala con el servicio de video.'],
  ] as const)(
    'explains why when it is %s, with a way to attach a manual link',
    async (reason, text) => {
      open({ [`GET /api/appointments/${APPOINTMENT}/video`]: jsonResponse(PENDING(reason)) });

      expect(await screen.findByText('Falta el enlace de la videoconsulta')).toBeInTheDocument();
      expect(screen.getByText(new RegExp(text))).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Adjuntar enlace manual' })).toBeInTheDocument();
      expect(screen.getByText('Sin enlace')).toBeInTheDocument();
    },
  );

  it('attaches a manual link and shows the session as ready', async () => {
    let attached = false;
    const bodies: unknown[] = [];
    open({
      [`GET /api/appointments/${APPOINTMENT}/video`]: () =>
        jsonResponse(
          attached
            ? summary({ manual: true, status: 'ready', hasLink: true })
            : PENDING('provider_failed'),
        ),
      [`PUT /api/appointments/${APPOINTMENT}/video/manual-link`]: (_url, init) => {
        bodies.push(jsonBody(init));
        attached = true;
        return jsonResponse(summary({ manual: true, status: 'ready', hasLink: true }));
      },
    });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Adjuntar enlace manual' }));
    const dialog = await screen.findByRole('dialog', { name: 'Enlace manual' });
    await user.type(
      within(dialog).getByLabelText('Dirección de la videollamada'),
      'https://meet.google.com/abc-defg-hij',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Adjuntar enlace' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(bodies).toEqual([{ url: 'https://meet.google.com/abc-defg-hij' }]);
    expect(await screen.findByText('Manual')).toBeInTheDocument();
    expect(screen.queryByText('Falta el enlace de la videoconsulta')).toBeNull();
  });

  it('shows the reason the API gives next to the field when the link is not accepted', async () => {
    open({
      [`GET /api/appointments/${APPOINTMENT}/video`]: jsonResponse(PENDING('integration_off')),
      [`PUT /api/appointments/${APPOINTMENT}/video/manual-link`]: new Response(
        JSON.stringify({
          type: 'about:blank',
          title: 'validation_failed',
          status: 400,
          code: 'validation_failed',
          i18nKey: 'errors.validation_failed',
          requestId: 'req-test',
          errors: [{ path: 'url', i18nKey: 'teleconsultation.manual_link.host_not_allowed' }],
        }),
        { status: 400, headers: { 'content-type': 'application/problem+json' } },
      ),
    });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Adjuntar enlace manual' }));
    const dialog = await screen.findByRole('dialog', { name: 'Enlace manual' });
    await user.type(
      within(dialog).getByLabelText('Dirección de la videollamada'),
      'https://evil.example/x',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Adjuntar enlace' }));

    expect(await within(dialog).findByText(/Ese servicio no está permitido/)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Enlace manual' })).toBeInTheDocument();
  });

  it('asks for an address before sending anything', async () => {
    const calls: string[] = [];
    open({
      [`GET /api/appointments/${APPOINTMENT}/video`]: jsonResponse(PENDING('integration_off')),
      [`PUT /api/appointments/${APPOINTMENT}/video/manual-link`]: () => {
        calls.push('put');
        return jsonResponse(summary());
      },
    });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Adjuntar enlace manual' }));
    const dialog = await screen.findByRole('dialog', { name: 'Enlace manual' });
    await user.click(within(dialog).getByRole('button', { name: 'Adjuntar enlace' }));

    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it('has no accessibility violations, with the dialog open', async () => {
    const view = open({
      [`GET /api/appointments/${APPOINTMENT}/video`]: jsonResponse(PENDING('provider_unavailable')),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Adjuntar enlace manual' }));
    await screen.findByRole('dialog', { name: 'Enlace manual' });

    expect(await a11yViolations(document.body)).toEqual([]);
    expect(view.missingKeys).toEqual([]);
  });
});
