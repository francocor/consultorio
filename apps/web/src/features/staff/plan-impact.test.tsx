import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';
import { jsonResponse } from '../../shared/test/render.js';

import { IDS, LOCATIONS, MEMBERS } from './fixtures.js';

/**
 * The invitation of a professional shows the owner what it does to the price (a professional takes a
 * priced seat), before the invitation is sent. Administration and reception are free, and an
 * administrator does not read the numbers of the subscription.
 */

const impact = {
  affectsPlan: true,
  activeProfessionals: { now: 2, after: 3 },
  monthlyCents: { now: 3_600_000, after: 5_400_000 },
  monthlyDifferenceCents: 1_800_000,
  proratedThisPeriodCents: 900_000,
  daysLeft: 15,
  daysInPeriod: 30,
  periodEndsOn: '2026-11-01',
  limit: { max: 20, reached: false },
};

function open(
  me = meFor(['owner'], { user: { id: IDS.owner, email: 'propietaria@demo.invalid' } }),
) {
  return renderApp({
    me,
    path: '/staff',
    boot: bootFor('Centro Médico Aillu'),
    routes: {
      'GET /api/staff': () => jsonResponse({ staff: MEMBERS }),
      'GET /api/locations': () => jsonResponse({ locations: LOCATIONS }),
      'GET /api/subscription/plan-impact': () => jsonResponse(impact),
    },
  });
}

describe('inviting a professional shows what it costs', () => {
  it('shows the owner the new monthly cost once a professional is chosen', async () => {
    const user = userEvent.setup();
    const app = open();
    await user.click(await screen.findByRole('button', { name: 'Invitar a una persona' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText('Qué cambia en su suscripción')).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('checkbox', { name: /Profesional/ }));

    expect(await within(dialog).findByText('Qué cambia en su suscripción')).toBeInTheDocument();
    expect(
      within(dialog).getByText(/pasa de \$ 36\.000,00 a \$ 54\.000,00 por mes/),
    ).toBeInTheDocument();
    expect(app.missingKeys).toEqual([]);
  });

  it('does not show it for reception, which is free', async () => {
    const user = userEvent.setup();
    const app = open();
    await user.click(await screen.findByRole('button', { name: 'Invitar a una persona' }));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('checkbox', { name: /Recepción/ }));

    expect(within(dialog).queryByText('Qué cambia en su suscripción')).not.toBeInTheDocument();
    expect(app.requests).not.toContain('GET /api/subscription/plan-impact');
  });

  it('does not ask for it when an administrator invites: only the owner reads the subscription', async () => {
    const user = userEvent.setup();
    const app = open(
      meFor(['admin'], { user: { id: IDS.owner, email: 'administracion@demo.invalid' } }),
    );
    await user.click(await screen.findByRole('button', { name: 'Invitar a una persona' }));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('checkbox', { name: /Profesional/ }));

    expect(within(dialog).queryByText('Qué cambia en su suscripción')).not.toBeInTheDocument();
    expect(app.requests).not.toContain('GET /api/subscription/plan-impact');
  });
});
