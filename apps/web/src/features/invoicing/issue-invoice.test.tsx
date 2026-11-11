import type {
  ChargeDto,
  CreateInvoiceRequest,
  InvoiceDto,
  InvoicingOptionsDto,
} from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp, type RenderedApp } from '../../shared/test/render-app.js';
import { jsonBody, jsonResponse, type FetchHandler } from '../../shared/test/render.js';

import {
  charge,
  coveredCharge,
  fullyInvoiced,
  IDS,
  inscriptoOptions,
  invoice,
  monotributoOptions,
  pending,
  readyToIssue,
} from './test-fixtures.js';

/**
 * Issuing an invoice from a charge (S4.13, task 4.55; spec "Issuing an invoice with CAE", "Invoice
 * type selection", "Recipient identification"): the lines to cover, in whole or in parts, the type
 * the rules give (shown, never chosen), the recipient form for a Factura A, the payer as recipient,
 * and a key that makes the request idempotent.
 */

let current: RenderedApp | undefined;

afterEach(() => {
  expect(current?.missingKeys ?? []).toEqual([]);
  current = undefined;
});

const problem = (status: number, code: string) =>
  new Response(
    JSON.stringify({
      type: 'about:blank',
      title: code,
      status,
      code,
      i18nKey: `errors.${code}`,
      requestId: 'req-test',
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

interface Setup {
  roles?: Parameters<typeof meFor>[0];
  charges?: ChargeDto[];
  options?: InvoicingOptionsDto;
  readiness?: Record<string, unknown>;
  post?: FetchHandler | undefined;
  routes?: Record<string, FetchHandler | Response>;
}

/** The invoices screen on the tab of the charges to invoice. */
async function open({
  roles = ['reception'],
  charges = [charge()],
  options = monotributoOptions,
  readiness = readyToIssue,
  post,
  routes = {},
}: Setup = {}) {
  const bodies: CreateInvoiceRequest[] = [];
  current = renderApp({
    me: meFor(roles),
    boot: bootFor('Centro Médico Aillu', { localProviders: { afip: true } }),
    path: '/invoices',
    routes: {
      'GET /api/worklist/count': () => jsonResponse({ open: 0 }),
      'GET /api/invoices': () => jsonResponse({ invoices: [], outageThresholdHours: 24 }),
      'GET /api/invoicing/readiness': () => jsonResponse(readiness),
      'GET /api/invoicing/options': () => jsonResponse(options),
      'GET /api/billing/charges': () => jsonResponse({ charges }),
      'POST /api/invoices': (url, init) => {
        bodies.push(jsonBody(init) as CreateInvoiceRequest);
        return (post ?? (() => jsonResponse(pending(0), 202)))(url, init);
      },
      ...routes,
    },
  });
  await userEvent.click(await screen.findByRole('tab', { name: 'Cobros por facturar' }));
  return { app: current, bodies };
}

const openDialog = async (patient = 'Lucía Fernández') => {
  await userEvent.click(
    await screen.findByRole('button', { name: `Facturar el cobro de ${patient}` }),
  );
  return screen.findByRole('dialog', { name: 'Facturar' });
};

describe('the charges that can be invoiced', () => {
  it('lists the charges with something left to invoice and leaves out the voided and the invoiced', async () => {
    await open({
      charges: [
        charge({ patientName: 'Lucía Fernández' }),
        charge({
          id: '0190a000-0000-7000-8000-0000000000c9',
          patientName: 'Pedro Voided',
          status: 'voided',
        }),
        {
          ...fullyInvoiced(),
          id: '0190a000-0000-7000-8000-0000000000c8',
          patientName: 'Ana Facturada',
        },
      ],
    });

    const listed = await screen.findByRole('list', { name: 'Cobros por facturar' });

    expect(within(listed).getByText('Lucía Fernández')).toBeInTheDocument();
    expect(within(listed).queryByText('Pedro Voided')).not.toBeInTheDocument();
    expect(within(listed).queryByText('Ana Facturada')).not.toBeInTheDocument();
    expect(within(listed).getByText('$ 20.000,00')).toBeInTheDocument();
  });

  it('says there is nothing to invoice when everything is invoiced', async () => {
    await open({ charges: [] });

    expect(await screen.findByText('No hay cobros por facturar')).toBeInTheDocument();
  });

  it('offers the manual entry only to who may register a CAE', async () => {
    await open({ roles: ['reception'] });
    await screen.findByRole('button', { name: 'Facturar el cobro de Lucía Fernández' });
    expect(screen.queryByRole('button', { name: /emitida por fuera/ })).not.toBeInTheDocument();
  });
});

describe('the invoice dialog', () => {
  it('shows the lines of the charge selected, what is left of each, and the type the rules give', async () => {
    await open();

    const dialog = await openDialog();

    expect(within(dialog).getByRole('checkbox', { name: /Consulta/ })).toBeChecked();
    expect(within(dialog).getByText('Queda por facturar $ 20.000,00')).toBeInTheDocument();
    expect(await within(dialog).findByText('Se emitirá una Factura C.')).toBeInTheDocument();
    expect(within(dialog).getByText('Total de la factura')).toBeInTheDocument();
  });

  it('asks for the invoice with the whole line, the patient as recipient and a key, and never sends a type', async () => {
    const { bodies } = await open();
    const dialog = await openDialog();
    await within(dialog).findByText('Se emitirá una Factura C.');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Pedir la factura' }));

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    const { idempotencyKey, ...asked } = bodies[0] ?? { idempotencyKey: '' };
    expect(idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(asked).toEqual({
      lines: [{ chargeLineId: IDS.chargeLine, amountCents: 2_000_000 }],
      recipient: { kind: 'patient', taxCondition: 'consumidor_final' },
    });
    expect(bodies[0]).not.toHaveProperty('type');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Facturar' })).not.toBeInTheDocument();
    });
  });

  it('invoices a line in a part when an amount below what is left is typed', async () => {
    const { bodies } = await open();
    const dialog = await openDialog();
    const amount = await within(dialog).findByLabelText('Importe a facturar de Consulta');

    await userEvent.clear(amount);
    await userEvent.type(amount, '12000');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Pedir la factura' }));

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    expect(bodies[0]?.lines).toEqual([{ chargeLineId: IDS.chargeLine, amountCents: 1_200_000 }]);
  });

  it('does not let the amount go above what is left, or the form be sent with nothing selected', async () => {
    const { bodies } = await open();
    const dialog = await openDialog();
    const amount = await within(dialog).findByLabelText('Importe a facturar de Consulta');
    const submit = within(dialog).getByRole('button', { name: 'Pedir la factura' });

    await userEvent.clear(amount);
    await userEvent.type(amount, '20000,01');
    expect(submit).toBeDisabled();

    await userEvent.clear(amount);
    await userEvent.type(amount, '20000');
    expect(submit).toBeEnabled();

    await userEvent.click(within(dialog).getByRole('checkbox', { name: /Consulta/ }));
    expect(submit).toBeDisabled();
    expect(bodies).toHaveLength(0);
  });

  it('shows Factura C whatever the recipient is, for a monotributista: no type beyond the rules', async () => {
    await open({ options: monotributoOptions });
    const dialog = await openDialog();

    await userEvent.selectOptions(
      within(dialog).getByLabelText('Condición frente al IVA del receptor'),
      'Responsable inscripto',
    );

    expect(await within(dialog).findByText('Se emitirá una Factura C.')).toBeInTheDocument();
    expect(within(dialog).queryByText('Se emitirá una Factura A.')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('combobox', { name: /Tipo/ })).not.toBeInTheDocument();
  });

  it('asks for the CUIT when the rules give a Factura A, and sends it with the condition', async () => {
    const { bodies } = await open({ options: inscriptoOptions });
    const dialog = await openDialog();
    expect(await within(dialog).findByText('Se emitirá una Factura B.')).toBeInTheDocument();

    await userEvent.selectOptions(
      within(dialog).getByLabelText('Condición frente al IVA del receptor'),
      'Responsable inscripto',
    );

    expect(await within(dialog).findByText('Se emitirá una Factura A.')).toBeInTheDocument();
    expect(
      within(dialog).getByText('La Factura A necesita el CUIT del receptor.'),
    ).toBeInTheDocument();
    const submit = within(dialog).getByRole('button', { name: 'Pedir la factura' });
    expect(within(dialog).getByLabelText('Documento')).toHaveValue('cuit');
    expect(within(dialog).getByLabelText('Documento')).toBeDisabled();

    await userEvent.type(
      within(dialog).getByLabelText('CUIT del receptor (obligatorio)'),
      '30-71234567-1',
    );
    await userEvent.type(
      within(dialog).getByLabelText('Nombre y apellido o razón social (opcional)'),
      'Clínica del Sur S.A.',
    );
    await userEvent.click(submit);

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    expect(bodies[0]?.recipient).toEqual({
      kind: 'patient',
      taxCondition: 'responsable_inscripto',
      name: 'Clínica del Sur S.A.',
      document: { type: 'cuit', number: '30-71234567-1' },
    });
  });

  it('keeps the same key when the same request is sent again after a failure, and another when it changes', async () => {
    let attempts = 0;
    const { bodies } = await open({
      post: () => {
        attempts += 1;
        return attempts === 1 ? problem(503, 'service_unavailable') : jsonResponse(pending(0), 202);
      },
    });
    const dialog = await openDialog();
    await within(dialog).findByText('Se emitirá una Factura C.');
    const submit = within(dialog).getByRole('button', { name: 'Pedir la factura' });

    await userEvent.click(submit);
    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    await within(dialog).findByRole('alert');
    await userEvent.click(submit);
    await waitFor(() => {
      expect(bodies).toHaveLength(2);
    });

    expect(bodies[1]?.idempotencyKey).toBe(bodies[0]?.idempotencyKey);
  });

  it('shows what the server refused in words', async () => {
    await open({ post: () => problem(409, 'invoice_line_over_invoiced') });
    const dialog = await openDialog();
    await within(dialog).findByText('Se emitirá una Factura C.');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Pedir la factura' }));

    expect(
      await within(dialog).findByText(
        'El importe supera lo que todavía no está facturado de esa línea.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Facturar' })).toBeInTheDocument();
  });

  it('says why invoicing is blocked and does not let the request be sent', async () => {
    const { bodies } = await open({
      readiness: { available: false, reasons: ['credential_expired'], simulated: true },
    });
    const dialog = await openDialog();

    expect(await within(dialog).findByText('Todavía no se puede facturar:')).toBeInTheDocument();
    expect(
      within(dialog).getByText(/El certificado venció\. Cargue uno nuevo o registre las facturas/),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Pedir la factura' })).toBeDisabled();
    expect(bodies).toHaveLength(0);
  });

  it('has no accessibility violations', async () => {
    await open({ options: inscriptoOptions });
    const dialog = await openDialog();
    await within(dialog).findByText('Se emitirá una Factura B.');

    expect(await a11yViolations(dialog)).toEqual([]);
  });
});

describe('a payer as the recipient of its portion', () => {
  it('offers the patient and the payer apart, and invoices the payer portion to the payer without asking for its data', async () => {
    const { bodies } = await open({ charges: [coveredCharge()] });
    const dialog = await openDialog();

    expect(within(dialog).getByRole('radio', { name: /Al paciente/ })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: /Copago/ })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('radio', { name: /A OSDE/ }));

    expect(await within(dialog).findByRole('checkbox', { name: /Consulta/ })).toBeChecked();
    expect(within(dialog).queryByRole('checkbox', { name: /Copago/ })).not.toBeInTheDocument();
    expect(within(dialog).getByText(/Se factura a OSDE con el CUIT cargado/)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Número de documento')).not.toBeInTheDocument();
    expect(within(dialog).getByText('Total de la factura').closest('p')).toHaveTextContent(
      '$ 15.000,00',
    );

    await userEvent.click(within(dialog).getByRole('button', { name: 'Pedir la factura' }));
    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    expect(bodies[0]).toMatchObject({
      lines: [{ chargeLineId: IDS.payerLine, amountCents: 1_500_000 }],
      recipient: { kind: 'payer', taxCondition: 'responsable_inscripto' },
    });
    expect(bodies[0]?.recipient).not.toHaveProperty('document');
  });
});

describe('retrying a rejected attempt', () => {
  it('keeps the lines, corrects the recipient and sends the attempt it replaces', async () => {
    const rejected: InvoiceDto = invoice({
      status: 'rejected',
      number: null,
      cae: null,
      rejectionMessage: 'El CUIT del receptor no es válido',
      recipient: {
        kind: 'patient',
        patientId: IDS.patient,
        tenantPayerId: null,
        name: 'Marta Gómez',
        taxCondition: 'consumidor_final',
        document: { type: 'dni', number: '12345678' },
      },
    });
    const bodies: CreateInvoiceRequest[] = [];
    current = renderApp({
      me: meFor(['reception']),
      boot: bootFor('Centro Médico Aillu', { localProviders: { afip: true } }),
      path: '/invoices',
      routes: {
        'GET /api/worklist/count': () => jsonResponse({ open: 0 }),
        'GET /api/invoices': () => jsonResponse({ invoices: [rejected], outageThresholdHours: 24 }),
        'GET /api/invoicing/readiness': () => jsonResponse(readyToIssue),
        'GET /api/invoicing/options': () => jsonResponse(monotributoOptions),
        'POST /api/invoices': (_url, init) => {
          bodies.push(jsonBody(init) as CreateInvoiceRequest);
          return jsonResponse(pending(0), 202);
        },
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: /Ver detalle de/ }));
    const detail = await screen.findByRole('dialog', { name: /Factura C/ });
    expect(within(detail).getByText(/ARCA rechazó la factura: El CUIT/)).toBeInTheDocument();
    await userEvent.click(within(detail).getByRole('button', { name: 'Corregir y reintentar' }));

    const dialog = await screen.findByRole('dialog', { name: 'Corregir y reintentar' });
    expect(
      within(dialog).getByLabelText('Nombre y apellido o razón social (opcional)'),
    ).toHaveValue('Marta Gómez');
    const number = within(dialog).getByLabelText('Número de documento');
    await userEvent.clear(number);
    await userEvent.type(number, '30111222');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Pedir la factura' }));

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    expect(bodies[0]).toMatchObject({
      previousAttemptId: rejected.id,
      lines: [{ chargeLineId: IDS.chargeLine, amountCents: 2_000_000 }],
      recipient: {
        kind: 'patient',
        name: 'Marta Gómez',
        document: { type: 'dni', number: '30111222' },
      },
    });
  });
});
