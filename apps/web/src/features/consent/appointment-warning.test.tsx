import type { AppointmentConsentStatusDto, CalendarEntryDto } from '@consultorio/contracts';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { jsonResponse, problemResponse } from '../../shared/test/render.js';

import { AppointmentConsentWarning } from './components/AppointmentConsentWarning.js';
import { renderHosted } from './test-host.js';

const APPOINTMENT = '0190a000-0000-7000-8000-0000000000a9';
const entry = {
  id: APPOINTMENT,
  patientId: '0190a000-0000-7000-8000-0000000000c1',
  professionalId: '0190a000-0000-7000-8000-0000000000b1',
  locationId: '0190a000-0000-7000-8000-0000000000b2',
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
  version: 1,
  patientName: 'Fernández, Lucía',
  typeName: 'Extracción',
  typeColor: null,
  mode: 'in_person',
} satisfies CalendarEntryDto;

let missing: string[] | undefined;
afterEach(() => {
  expect(missing ?? []).toEqual([]);
  missing = undefined;
});

function open(answer: () => Response) {
  const app = renderHosted(
    <>
      <p>Datos del turno</p>
      <AppointmentConsentWarning appointment={entry} readOnly={false} />
    </>,
    {
      me: meFor(['reception']),
      boot: bootFor('Centro Médico Aillu'),
      routes: { [`GET /api/appointments/${APPOINTMENT}/consent-status`]: answer },
    },
  );
  missing = app.missingKeys;
  return app;
}

const status = (state: AppointmentConsentStatusDto['state']) =>
  jsonResponse({
    appointmentId: APPOINTMENT,
    state,
    templateId: state === 'not_required' ? null : '0190a000-0000-7000-8000-0000000000e1',
  });

describe('the warning on an appointment that needs a consent', () => {
  it('warns when the patient has no consent, without naming one', async () => {
    open(() => status('missing'));

    expect(
      await screen.findByText(
        'Este turno requiere un consentimiento firmado y el paciente todavía no lo tiene.',
      ),
    ).toBeVisible();
    expect(screen.queryByText(/Extracción de muela/)).not.toBeInTheDocument();
  });

  it('warns that there is no valid consent once the patient revoked it', async () => {
    open(() => status('revoked'));

    expect(
      await screen.findByText(
        'El paciente revocó el consentimiento que requiere este turno: no hay un consentimiento vigente.',
      ),
    ).toBeVisible();
  });

  it.each([['valid'], ['not_required']] as const)(
    'says nothing when the state is %s',
    async (state) => {
      let asked = false;
      open(() => {
        asked = true;
        return status(state);
      });

      await screen.findByText('Datos del turno');
      await waitFor(() => {
        expect(asked).toBe(true);
      });
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.queryByText(/consentimiento/i)).not.toBeInTheDocument();
    },
  );

  it('says nothing when the check fails: it never blocks the appointment', async () => {
    let asked = false;
    open(() => {
      asked = true;
      return problemResponse(500, 'internal_error');
    });

    await screen.findByText('Datos del turno');
    await waitFor(() => {
      expect(asked).toBe(true);
    });
    expect(screen.queryByText(/consentimiento/i)).not.toBeInTheDocument();
  });
});
