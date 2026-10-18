import type { CalendarEntryDto, VideoSessionSummary } from '@consultorio/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import {
  fakeFetch,
  jsonResponse,
  problemResponse,
  renderWithApp,
  urlOf,
  type FetchHandler,
} from '../../shared/test/render.js';

import { VideoJoinButton } from './components/VideoJoinButton.js';

const APPOINTMENT = '0190a000-0000-7000-8000-0000000000a1';

const entry = (overrides: Partial<CalendarEntryDto> = {}): CalendarEntryDto => ({
  id: APPOINTMENT,
  patientId: '0190a000-0000-7000-8000-0000000000c1',
  professionalId: '0190a000-0000-7000-8000-0000000000d1',
  locationId: '0190a000-0000-7000-8000-0000000000b1',
  appointmentTypeId: '0190a000-0000-7000-8000-0000000000e1',
  startsAt: '2031-05-12T13:00:00.000Z',
  endsAt: '2031-05-12T13:30:00.000Z',
  bufferMinutes: 0,
  status: 'confirmed',
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
  ...overrides,
});

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
  canJoin: true,
  canAttachManualLink: true,
  noShowAllowedFrom: '2031-05-12T13:15:00.000Z',
  ...overrides,
});

const VIDEO = `GET /api/appointments/${APPOINTMENT}/video`;

function show(
  routes: Record<string, FetchHandler | Response>,
  props: { appointment?: CalendarEntryDto; readOnly?: boolean } = {},
) {
  const requests: string[] = [];
  const fetch = fakeFetch(routes);
  const recording: typeof globalThis.fetch = (input, init) => {
    requests.push(`${init?.method ?? 'GET'} ${urlOf(input)}`);
    return fetch(input, init);
  };
  const view = renderWithApp(
    <VideoJoinButton
      appointment={props.appointment ?? entry()}
      readOnly={props.readOnly ?? false}
    />,
    { fetch: recording },
  );
  return { ...view, requests };
}

describe('the join button of the professional day', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens the video call in a new tab when the API allows joining', async () => {
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    show({
      [VIDEO]: jsonResponse(summary()),
      [`POST /api/appointments/${APPOINTMENT}/video/join`]: jsonResponse({
        url: 'https://meet.jit.si/0f8a3c2e9b1d4a7f8c6e5d4b3a291807',
      }),
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
  });

  it('asks nothing and shows nothing for an appointment in person', async () => {
    const view = show({}, { appointment: entry({ mode: 'in_person' }) });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.queryByRole('button')).toBeNull();
    expect(view.requests).toEqual([]);
  });

  it('shows no button outside the join window', async () => {
    const view = show({ [VIDEO]: jsonResponse(summary({ canJoin: false })) });

    await waitFor(() => {
      expect(view.requests).toContain(`GET /api/appointments/${APPOINTMENT}/video`);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows no button in a read-only organization', async () => {
    const view = show({ [VIDEO]: jsonResponse(summary()) }, { readOnly: true });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.queryByRole('button')).toBeNull();
    expect(view.requests).toEqual([]);
  });

  it('shows nothing to a person who is not the professional of the appointment', async () => {
    show({ [VIDEO]: problemResponse(403, 'forbidden') });

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says so when the call could not be opened', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    show({
      [VIDEO]: jsonResponse(summary()),
      [`POST /api/appointments/${APPOINTMENT}/video/join`]: problemResponse(
        409,
        'video_outside_window',
      ),
    });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Entrar a la videoconsulta' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const view = show({ [VIDEO]: jsonResponse(summary()) });
    await screen.findByRole('button', { name: 'Entrar a la videoconsulta' });

    expect(await a11yViolations(view.container)).toEqual([]);
  });
});
