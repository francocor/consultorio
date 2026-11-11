import type { ChargeDto } from '@consultorio/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderInRouter } from '../../shared/test/render-app.js';
import { jsonBody, jsonResponse, problemResponse } from '../../shared/test/render.js';

import { PaymentDialog } from './components/PaymentDialog.js';
import { charge, payment } from './test-fixtures.js';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

let missing: string[] | undefined;
afterEach(() => {
  expect(missing ?? []).toEqual([]);
  missing = undefined;
});

/** The answer the server gives to a recorded payment: the payment and the charge as it stands. */
const recorded = (chargeAfter: ChargeDto = charge()) =>
  jsonResponse({ payment: payment(), charge: chargeAfter, replayed: false }, 201);

function open(pay: Handler, chargeToPay: ChargeDto = charge()) {
  const app = renderInRouter(<PaymentDialog charge={chargeToPay} onClose={() => undefined} />, {
    me: meFor(['reception']),
    boot: bootFor('Centro Médico Aillu'),
    routes: { [`POST /api/billing/charges/${chargeToPay.id}/payments`]: pay },
  });
  missing = app.missingKeys;
  return app;
}

const sent = (init: RequestInit) => jsonBody(init) as Record<string, unknown>;

describe('the payment dialog', () => {
  it('starts at what the patient owes, written the Argentine way, and says who owes it', async () => {
    open(() => recorded());

    expect(await screen.findByRole('dialog', { name: 'Registrar pago' })).toBeVisible();
    expect(screen.getByText('Lucía Fernández debe $ 10.000,00.')).toBeVisible();
    expect(screen.getByLabelText('Importe')).toHaveValue('10.000,00');
    expect(screen.getByText('Después de este pago quedan $ 0,00 por cobrar.')).toBeVisible();
  });

  it('sends a partial payment as whole cents with a key made for this submission', async () => {
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];
    open((_url, init) => {
      bodies.push(sent(init));
      return recorded();
    });

    const amount = await screen.findByLabelText('Importe');
    await user.clear(amount);
    await user.type(amount, '4000');
    expect(screen.getByText('Después de este pago quedan $ 6.000,00 por cobrar.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Registrar pago' }));

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    expect(bodies[0]).toMatchObject({ method: 'cash', amountCents: 400_000 });
    expect(bodies[0]?.['idempotencyKey']).toMatch(/^[0-9a-f-]{36}$/);
    expect(bodies[0]).not.toHaveProperty('confirmCredit');
    expect(bodies[0]).not.toHaveProperty('externalRef');
  });

  it('sends one request when the button is pressed twice in a row', async () => {
    const user = userEvent.setup();
    let calls = 0;
    open(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 150));
      return recorded();
    });

    const submit = await screen.findByRole('button', { name: 'Registrar pago' });
    await user.dblClick(submit);
    await user.click(submit);

    await waitFor(() => {
      expect(calls).toBe(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(calls).toBe(1);
  });

  it('sends the SAME key when the same payment is retried, and another key once something changes', async () => {
    const user = userEvent.setup();
    const keys: unknown[] = [];
    open((_url, init) => {
      keys.push(sent(init)['idempotencyKey']);
      return problemResponse(503, 'service_unavailable');
    });

    const submit = await screen.findByRole('button', { name: 'Registrar pago' });
    await user.click(submit);
    await waitFor(() => {
      expect(keys).toHaveLength(1);
    });
    await user.click(await screen.findByRole('button', { name: 'Registrar pago' }));
    await waitFor(() => {
      expect(keys).toHaveLength(2);
    });
    const amount = screen.getByLabelText('Importe');
    await user.clear(amount);
    await user.type(amount, '9000');
    await user.click(screen.getByRole('button', { name: 'Registrar pago' }));
    await waitFor(() => {
      expect(keys).toHaveLength(3);
    });

    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('asks to confirm a credit balance for more than is owed, and says how much', async () => {
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];
    open((_url, init) => {
      bodies.push(sent(init));
      return recorded();
    });

    const amount = await screen.findByLabelText('Importe');
    await user.clear(amount);
    await user.type(amount, '15000');
    expect(screen.getByText('Es $ 5.000,00 más de lo que se debe.')).toBeVisible();
    const submit = screen.getByRole('button', { name: 'Registrar pago' });
    expect(submit).toBeDisabled();
    await user.click(
      screen.getByRole('checkbox', { name: /\$ 5\.000,00 quedan como saldo a favor/ }),
    );
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    expect(bodies[0]).toMatchObject({ amountCents: 1_500_000, confirmCredit: true });
  });

  it('asks for a voucher number only for the methods that have one', async () => {
    const user = userEvent.setup();
    open(() => recorded());
    await screen.findByRole('dialog');

    expect(screen.queryByLabelText('Número de comprobante (opcional)')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Medio de pago'), 'debit');

    expect(screen.getByLabelText('Número de comprobante (opcional)')).toBeVisible();
  });

  it('asks for a reason when the voucher number was already recorded, and sends it', async () => {
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];
    open((_url, init) => {
      bodies.push(sent(init));
      return bodies.length === 1 ? problemResponse(409, 'payment_voucher_duplicate') : recorded();
    });

    await user.selectOptions(await screen.findByLabelText('Medio de pago'), 'debit');
    await user.type(screen.getByLabelText('Número de comprobante (opcional)'), '004512');
    await user.click(screen.getByRole('button', { name: 'Registrar pago' }));

    expect(await screen.findByText(/Ese número de comprobante ya se registró/)).toBeVisible();
    const submit = screen.getByRole('button', { name: 'Registrar pago' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('Motivo'), 'Dos cuotas con el mismo comprobante');
    await user.click(submit);

    await waitFor(() => {
      expect(bodies).toHaveLength(2);
    });
    expect(bodies[1]).toMatchObject({
      externalRef: '004512',
      overrideReason: 'Dos cuotas con el mismo comprobante',
    });
    expect(bodies[1]?.['idempotencyKey']).not.toBe(bodies[0]?.['idempotencyKey']);
  });

  it('explains that cash needs an open register, and offers to open it', async () => {
    const user = userEvent.setup();
    open(() => problemResponse(409, 'cash_register_required'));

    await user.click(await screen.findByRole('button', { name: 'Registrar pago' }));

    expect(await screen.findByText(/No hay una caja abierta en esta sede/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Abrir la caja de la sede' })).toHaveAttribute(
      'href',
      '/cash',
    );
  });

  it('has no accessibility violations', async () => {
    const user = userEvent.setup();
    open(() => recorded());
    await screen.findByRole('dialog', { name: 'Registrar pago' });
    await user.selectOptions(screen.getByLabelText('Medio de pago'), 'transfer');

    expect(await a11yViolations(document.body)).toEqual([]);
  });
});
