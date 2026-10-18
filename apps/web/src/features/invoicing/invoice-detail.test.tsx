import type {
  CreateCreditNoteRequest,
  CreateManualInvoiceRequest,
  InvoiceDto,
} from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp, type RenderedApp } from '../../shared/test/render-app.js';
import { jsonBody, jsonResponse, type FetchHandler } from '../../shared/test/render.js';

import { IDS, invoice, pending, readyToIssue } from './test-fixtures.js';

/**
 * One invoice in full, and what is done with it (S4.13, tasks 4.55 and 4.56; spec "Credit notes",
 * "Manual invoice entry fallback", "Reception cannot issue credit notes"): the PDF, the credit note
 * for the owner and the administration only, the manual entry that stands in for a pending invoice.
 */

let current: RenderedApp | undefined;
const createObjectURL = vi.fn(() => 'blob:test');

beforeEach(() => {
  createObjectURL.mockClear();
  // jsdom has no object URLs: a download only needs to be handed to the browser.
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = vi.fn();
});

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
  tenantStatus?: 'active' | 'read_only';
  invoices: InvoiceDto[];
  notes?: InvoiceDto[];
  routes?: Record<string, FetchHandler | Response>;
}

async function open({
  roles = ['owner'],
  tenantStatus = 'active',
  invoices,
  notes = [],
  routes = {},
}: Setup) {
  current = renderApp({
    me: meFor(roles, { tenantStatus }),
    boot: bootFor('Centro Médico Aillu', { localProviders: { afip: true } }),
    path: '/invoices',
    routes: {
      'GET /api/worklist/count': () => jsonResponse({ open: 0 }),
      'GET /api/invoices': (url) => {
        const params = new URL(url, 'http://test').searchParams;
        if (params.get('creditNoteOfId') !== null) {
          return jsonResponse({ invoices: notes, outageThresholdHours: 24 });
        }
        const status = params.get('status');
        return jsonResponse({
          invoices:
            status === null ? invoices : invoices.filter((entry) => entry.status === status),
          outageThresholdHours: 24,
        });
      },
      'GET /api/invoicing/readiness': () => jsonResponse(readyToIssue),
      ...routes,
    },
  });
  await userEvent.click(await screen.findByRole('button', { name: /Ver detalle de/ }));
  return screen.findByRole('dialog', { name: /Factura C|Nota de crédito C/ });
}

describe('the detail of an issued invoice', () => {
  it('shows the fiscal data, the lines and the environment', async () => {
    const dialog = await open({ invoices: [invoice()] });

    expect(dialog).toHaveTextContent('Factura C 0001-00000077');
    expect(within(dialog).getByText('70123456789012')).toBeInTheDocument();
    expect(within(dialog).getByText('30/05/2031')).toBeInTheDocument();
    expect(within(dialog).getByText('Consulta profesional')).toBeInTheDocument();
    expect(within(dialog).getByText('Homologación (prueba)')).toBeInTheDocument();
    expect(within(dialog).getByText('Documento de prueba sin validez fiscal')).toBeInTheDocument();
    expect(within(dialog).getByText('Emitida')).toBeInTheDocument();
  });

  it('downloads the PDF through a link for this session', async () => {
    const dialog = await open({
      invoices: [invoice()],
      routes: {
        [`GET /api/invoices/${IDS.invoice}/pdf-link`]: () =>
          jsonResponse({
            url: `/files/${'a'.repeat(43)}`,
            expiresAt: '2031-05-20T13:05:00.000Z',
          }),
        [`GET /api/files/${'a'.repeat(43)}`]: () =>
          new Response('%PDF-1.7', {
            headers: {
              'content-type': 'application/pdf',
              'content-disposition': 'attachment; filename="factura-c-0001-00000077.pdf"',
            },
          }),
      },
    });

    await userEvent.click(within(dialog).getByRole('button', { name: 'Descargar PDF' }));

    await waitFor(() => {
      expect(current?.requests).toContain(`GET /api/files/${'a'.repeat(43)}`);
    });
    expect(current?.requests).toContain(`GET /api/invoices/${IDS.invoice}/pdf-link`);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('says the PDF is being prepared when it does not exist yet, and offers no download', async () => {
    const dialog = await open({ invoices: [invoice({ hasPdf: false })] });

    expect(within(dialog).getByText('El PDF se está preparando.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Descargar PDF' })).not.toBeInTheDocument();
  });

  it('lists the credit notes the invoice has', async () => {
    const dialog = await open({
      invoices: [invoice({ creditedCents: 500_000 })],
      notes: [
        invoice({
          id: '0190a000-0000-7000-8000-0000000000b9',
          kind: 'credit_note',
          type: 'NCC',
          number: 78,
          totalCents: 500_000,
          creditNoteOfId: IDS.invoice,
          reason: 'Error de importe',
        }),
      ],
    });

    const notes = await within(dialog).findByRole('region', { name: 'Notas de crédito' });
    expect(notes).toHaveTextContent('Nota de crédito C 0001-00000078');
    expect(notes).toHaveTextContent('$ 5.000,00');
  });

  it('has no accessibility violations', async () => {
    const dialog = await open({ invoices: [invoice()] });

    expect(await a11yViolations(dialog)).toEqual([]);
  });
});

describe('who can issue a credit note', () => {
  it.each([['owner'], ['admin']] as const)(
    'is offered to %s for an issued invoice',
    async (role) => {
      const dialog = await open({ roles: [role], invoices: [invoice()] });

      expect(
        within(dialog).getByRole('button', { name: 'Emitir nota de crédito' }),
      ).toBeInTheDocument();
    },
  );

  it('is not offered to reception', async () => {
    const dialog = await open({ roles: ['reception'], invoices: [invoice()] });

    expect(within(dialog).getByRole('button', { name: 'Descargar PDF' })).toBeInTheDocument();
    expect(
      within(dialog).queryByRole('button', { name: 'Emitir nota de crédito' }),
    ).not.toBeInTheDocument();
  });

  it('is not offered for what has nothing left to credit, a pending invoice or a credit note', async () => {
    const credited = await open({ invoices: [invoice({ creditedCents: 2_000_000 })] });
    expect(
      within(credited).queryByRole('button', { name: 'Emitir nota de crédito' }),
    ).not.toBeInTheDocument();
  });

  it('is not offered in a read-only organization, where the PDF is still there', async () => {
    const dialog = await open({ tenantStatus: 'read_only', invoices: [invoice()] });

    expect(within(dialog).getByRole('button', { name: 'Descargar PDF' })).toBeInTheDocument();
    expect(
      within(dialog).queryByRole('button', { name: 'Emitir nota de crédito' }),
    ).not.toBeInTheDocument();
  });
});

describe('the credit note dialog', () => {
  const openNote = async (invoices: InvoiceDto[], post?: FetchHandler) => {
    const bodies: CreateCreditNoteRequest[] = [];
    const detail = await open({
      invoices,
      routes: {
        [`POST /api/invoices/${IDS.invoice}/credit-notes`]: (url, init) => {
          bodies.push(jsonBody(init) as CreateCreditNoteRequest);
          return (
            post ?? (() => jsonResponse(pending(0, { kind: 'credit_note', type: 'NCC' }), 202))
          )(url, init);
        },
      },
    });
    await userEvent.click(within(detail).getByRole('button', { name: 'Emitir nota de crédito' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nota de crédito' });
    return { dialog, bodies };
  };

  it('needs a reason, and sends a total note with it and a key', async () => {
    const { dialog, bodies } = await openNote([invoice()]);
    const submit = within(dialog).getByRole('button', { name: 'Emitir nota de crédito' });
    expect(dialog).toHaveTextContent('Se puede acreditar hasta $ 20.000,00');
    expect(submit).toBeDisabled();

    await userEvent.type(within(dialog).getByLabelText('Motivo'), 'Error en el importe');
    expect(submit).toBeEnabled();
    await userEvent.click(submit);

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    const { idempotencyKey, ...asked } = bodies[0] ?? { idempotencyKey: '' };
    expect(idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(asked).toEqual({ reason: 'Error en el importe' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Nota de crédito' })).not.toBeInTheDocument();
    });
  });

  it('keeps a partial note within what earlier notes left of the invoice', async () => {
    const { dialog, bodies } = await openNote([invoice({ creditedCents: 1_500_000 })]);
    expect(dialog).toHaveTextContent('Se puede acreditar hasta $ 5.000,00');
    await userEvent.click(within(dialog).getByRole('radio', { name: /Una parte/ }));
    const amount = await within(dialog).findByLabelText('Importe a acreditar');
    await userEvent.type(within(dialog).getByLabelText('Motivo'), 'Descuento acordado');
    const submit = within(dialog).getByRole('button', { name: 'Emitir nota de crédito' });

    await userEvent.type(amount, '8000');
    expect(submit).toBeDisabled();
    await userEvent.clear(amount);
    await userEvent.type(amount, '5000');
    expect(submit).toBeEnabled();
    await userEvent.click(submit);

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    expect(bodies[0]).toMatchObject({ reason: 'Descuento acordado', amountCents: 500_000 });
  });

  it('names the letter of the note and says why a refusal happened', async () => {
    const { dialog } = await openNote([invoice()], () =>
      problem(409, 'invoice_credit_note_exceeds'),
    );
    expect(dialog).toHaveTextContent('Se emitirá una Nota de crédito C con su propio CAE.');
    await userEvent.type(within(dialog).getByLabelText('Motivo'), 'Error en el importe');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Emitir nota de crédito' }));

    expect(
      await within(dialog).findByText(
        'Las notas de crédito de una factura no pueden superar su importe.',
      ),
    ).toBeInTheDocument();
  });
});

describe('registering by hand the invoice a pending one stands in for (task 4.55)', () => {
  const waiting = pending(25 * 60);

  it('is offered to the owner and the administration, not to reception', async () => {
    const owner = await open({ roles: ['owner'], invoices: [waiting] });
    expect(
      within(owner).getByRole('button', { name: 'Registrar factura emitida por fuera' }),
    ).toBeInTheDocument();
  });

  it('is not offered to reception', async () => {
    const dialog = await open({ roles: ['reception'], invoices: [waiting] });

    expect(within(dialog).getByText(/Se emitirá cuando el servicio de ARCA/)).toBeInTheDocument();
    expect(
      within(dialog).queryByRole('button', { name: 'Registrar factura emitida por fuera' }),
    ).not.toBeInTheDocument();
  });

  it('tells the owner what to do about a prolonged outage', async () => {
    const dialog = await open({ roles: ['owner'], invoices: [waiting] });

    expect(dialog).toHaveTextContent('Hace más de 24 horas que está pendiente');
    expect(dialog).toHaveTextContent('registrar la factura emitida por fuera del sistema');
  });

  it('sends the voucher with its number and CAE and the invoice it replaces', async () => {
    const bodies: CreateManualInvoiceRequest[] = [];
    const detail = await open({
      roles: ['admin'],
      invoices: [waiting],
      routes: {
        'POST /api/invoices/manual': (_url, init) => {
          bodies.push(jsonBody(init) as CreateManualInvoiceRequest);
          return jsonResponse(invoice({ status: 'manual', number: 77 }), 201);
        },
      },
    });
    await userEvent.click(
      within(detail).getByRole('button', { name: 'Registrar factura emitida por fuera' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Registrar factura emitida por fuera',
    });
    const submit = within(dialog).getByRole('button', { name: 'Registrar factura' });
    expect(submit).toBeDisabled();
    expect(within(dialog).getByText('Consulta profesional')).toBeInTheDocument();

    await userEvent.type(within(dialog).getByLabelText('Punto de venta'), '5');
    await userEvent.type(within(dialog).getByLabelText('Número de comprobante'), '77');
    await userEvent.type(within(dialog).getByLabelText('CAE (14 dígitos)'), '1234567890123');
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('CAE (14 dígitos)'), '4');
    expect(submit).toBeEnabled();
    await userEvent.click(submit);

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    expect(bodies[0]).toMatchObject({
      type: 'FC',
      pointOfSale: 5,
      number: 77,
      cae: '12345678901234',
      totalCents: 2_000_000,
      lines: [{ chargeLineId: IDS.chargeLine, amountCents: 2_000_000 }],
      recipient: { kind: 'patient', taxCondition: 'consumidor_final', name: 'Lucía Fernández' },
      replacesInvoiceId: waiting.id,
    });
    expect(bodies[0]?.issueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('says when the number is already registered', async () => {
    const detail = await open({
      roles: ['owner'],
      invoices: [waiting],
      routes: { 'POST /api/invoices/manual': () => problem(409, 'invoice_number_taken') },
    });
    await userEvent.click(
      within(detail).getByRole('button', { name: 'Registrar factura emitida por fuera' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Registrar factura emitida por fuera',
    });
    await userEvent.type(within(dialog).getByLabelText('Punto de venta'), '5');
    await userEvent.type(within(dialog).getByLabelText('Número de comprobante'), '77');
    await userEvent.type(within(dialog).getByLabelText('CAE (14 dígitos)'), '12345678901234');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Registrar factura' }));

    expect(
      await within(dialog).findByText(
        'Ya hay un comprobante registrado con ese tipo, punto de venta y número.',
      ),
    ).toBeInTheDocument();
  });
});
