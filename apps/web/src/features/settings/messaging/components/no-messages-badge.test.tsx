import type { ChannelStateDto, PatientChannelsResponse } from '@consultorio/contracts';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { bootFor, meFor } from '../../../../shared/test/fixtures.js';
import { renderInRouter } from '../../../../shared/test/render-app.js';
import { jsonResponse } from '../../../../shared/test/render.js';

import { NoMessagesBadge } from './NoMessagesBadge.js';

const PATIENT_ID = '0190a000-0000-7000-8000-0000000000c2';
const channelsUrl = `GET /api/patients/${PATIENT_ID}/channels`;

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

afterEach(() => {
  expect(missing ?? []).toEqual([]);
  missing = undefined;
});

function open(response: PatientChannelsResponse) {
  const app = renderInRouter(<NoMessagesBadge patientId={PATIENT_ID} />, {
    me: meFor(['reception']),
    boot: bootFor('Centro Médico Aillu'),
    routes: { [channelsUrl]: () => jsonResponse(response) },
  });
  missing = app.missingKeys;
  return app;
}

describe('the "Sin avisos" mark in the header of the patient record', () => {
  it('shows when the patient opted out and no channel is open', async () => {
    open(
      channels({
        email: state({ state: 'opted_out', source: 'email_link' }),
        whatsapp: state({ state: 'opted_out', source: 'email_link' }),
        noMessages: true,
      }),
    );

    expect(await screen.findByText('Sin avisos')).toBeInTheDocument();
  });

  it('shows nothing for a patient who can be reached', async () => {
    const app = open(channels());

    // The request was made and answered: the mark is absent because of the answer.
    await waitFor(() => {
      expect(app.requests).toContain(channelsUrl);
    });
    await waitFor(() => {
      expect(
        app.services.queryClient.getQueryData(['messaging', 'channels', PATIENT_ID]),
      ).toMatchObject({ noMessages: false });
    });
    expect(screen.queryByText('Sin avisos')).not.toBeInTheDocument();
  });
});
