import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';
import { jsonResponse } from '../../shared/test/render.js';
import { PATIENT_IDS, SUMMARIES, patient } from '../patients/fixtures.js';

const routes = {
  'GET /api/patients': () => jsonResponse({ patients: SUMMARIES, nextCursor: null }),
  [`GET /api/patients/${PATIENT_IDS.valentina}`]: () => jsonResponse(patient()),
  [`GET /api/patients/${PATIENT_IDS.valentina}/representatives`]: () =>
    jsonResponse({ minor: false, representatives: [] }),
};

describe('home: finding a patient fast', () => {
  it('has the search at the top for whoever can read patients, and opens the record chosen', async () => {
    const user = userEvent.setup();
    const app = renderApp({
      me: meFor(['reception']),
      path: '/',
      boot: bootFor('Centro Médico Aillu'),
      routes,
    });

    const search = await screen.findByRole('combobox', {
      name: 'Buscar paciente por DNI o nombre',
    });
    await user.type(search, 'gomez');
    await user.click(await screen.findByRole('option', { name: /Gómez, Valentina/ }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Valentina Gómez' }),
    ).toBeInTheDocument();
    expect(app.router.state.location.pathname).toBe(`/patients/${PATIENT_IDS.valentina}`);
    expect(app.missingKeys).toEqual([]);
  });

  it('is not there for somebody who cannot read patients', async () => {
    renderApp({
      me: meFor(['patient']),
      path: '/',
      boot: bootFor('Centro Médico Aillu'),
      routes,
    });

    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
});
