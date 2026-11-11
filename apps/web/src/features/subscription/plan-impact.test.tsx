import type { PlanImpactResponse } from '@consultorio/contracts';
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { renderInRouter } from '../../shared/test/render-app.js';
import { jsonResponse, problemResponse } from '../../shared/test/render.js';

import { PlanImpactPanel } from './components/PlanImpactPanel.js';

const impact = (overrides: Partial<PlanImpactResponse> = {}): PlanImpactResponse => ({
  affectsPlan: true,
  activeProfessionals: { now: 2, after: 3 },
  monthlyCents: { now: 3_600_000, after: 5_400_000 },
  monthlyDifferenceCents: 1_800_000,
  proratedThisPeriodCents: 900_000,
  daysLeft: 15,
  daysInPeriod: 30,
  periodEndsOn: '2026-11-01',
  limit: { max: 20, reached: false },
  ...overrides,
});

let missing: string[] | undefined;
afterEach(() => {
  expect(missing ?? []).toEqual([]);
  missing = undefined;
});

function open(response: Response | PlanImpactResponse) {
  const app = renderInRouter(<PlanImpactPanel />, {
    routes: {
      'GET /api/subscription/plan-impact': () =>
        response instanceof Response ? response : jsonResponse(response),
    },
  });
  missing = app.missingKeys;
  return app;
}

describe('what adding a professional does to the price', () => {
  it('shows the new monthly cost, the proration of this month and the limit of the plan', async () => {
    const app = open(impact());

    const panel = await screen.findByRole('status');
    expect(panel).toHaveTextContent('Los profesionales activos pasan de 2 a 3.');
    expect(panel).toHaveTextContent(
      'La suscripción pasa de $ 36.000,00 a $ 54.000,00 por mes ($ 18.000,00 más).',
    );
    expect(panel).toHaveTextContent(
      'Este mes se cobran $ 9.000,00 por los 15 días que quedan, hasta el 01/11/2026.',
    );
    expect(panel).toHaveTextContent('Su plan admite hasta 20 profesionales activos.');
    expect(app.requests).toContain('GET /api/subscription/plan-impact');
    expect(await a11yViolations(document.body)).toEqual([]);
  });

  it('points to the plans when the limit was reached', async () => {
    open(impact({ limit: { max: 3, reached: true } }));

    expect(
      await screen.findByText(/ya llegó al máximo de 3 profesionales activos/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ver los planes' })).toHaveAttribute(
      'href',
      '/subscription',
    );
  });

  it('shows nothing where no plan is affected', async () => {
    const app = open(impact({ affectsPlan: false }));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(app.requests).toContain('GET /api/subscription/plan-impact');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows nothing, and does not get in the way, when it cannot be read', async () => {
    open(problemResponse(403, 'forbidden'));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
