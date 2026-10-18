import type { TenantPayerDto } from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderInRouter } from '../../shared/test/render-app.js';
import { jsonBody, jsonResponse, type FetchHandler } from '../../shared/test/render.js';

import { PayersSection } from './components/PayersSection.js';
import { IDS } from './test-fixtures.js';

let missing: string[] | undefined;
afterEach(() => {
  expect(missing ?? []).toEqual([]);
  missing = undefined;
});

const payer = (overrides: Partial<TenantPayerDto> = {}): TenantPayerDto => ({
  id: IDS.payer,
  payerId: null,
  name: 'OSDE',
  kind: 'prepaga',
  cuit: null,
  active: true,
  deactivatedAt: null,
  ...overrides,
});

function open(
  payers: TenantPayerDto[],
  routes: Record<string, FetchHandler | Response> = {},
  available: { payerId: string; name: string; kind: 'prepaga' }[] = [],
) {
  const app = renderInRouter(<PayersSection />, {
    me: meFor(['admin']),
    boot: bootFor('Centro Médico Aillu'),
    routes: { 'GET /api/billing/payers': () => jsonResponse({ payers, available }), ...routes },
  });
  missing = app.missingKeys;
  return app;
}

describe('the payers of the organization', () => {
  it('lists each payer with its CUIT written with hyphens, or says it is missing', async () => {
    open([
      payer({ cuit: '30708578335' }),
      payer({ id: '0190a000-0000-7000-8000-0000000000ab', name: 'Swiss Medical' }),
    ]);

    const list = await screen.findByRole('list', {
      name: 'Obras sociales y prepagas de la organización',
    });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('CUIT 30-70857833-5');
    expect(items[1]).toHaveTextContent('Sin CUIT: hace falta para facturarle (Factura A).');
  });

  it('saves the CUIT as typed, for the server to check with the country rules', async () => {
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];
    open([payer()], {
      [`PATCH /api/billing/payers/${IDS.payer}`]: (_url, init) => {
        bodies.push(jsonBody(init) as Record<string, unknown>);
        return jsonResponse(payer({ cuit: '30708578335' }));
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Cargar CUIT de OSDE' }));
    const dialog = await screen.findByRole('dialog', { name: 'CUIT de OSDE' });
    await user.type(within(dialog).getByLabelText('CUIT'), '30-70857833-5');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar CUIT' }));

    await waitFor(() => {
      expect(bodies).toEqual([{ cuit: '30-70857833-5' }]);
    });
  });

  it('removes the CUIT when the field is emptied', async () => {
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];
    open([payer({ cuit: '30708578335' })], {
      [`PATCH /api/billing/payers/${IDS.payer}`]: (_url, init) => {
        bodies.push(jsonBody(init) as Record<string, unknown>);
        return jsonResponse(payer());
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Cargar CUIT de OSDE' }));
    const dialog = await screen.findByRole('dialog', { name: 'CUIT de OSDE' });
    const field = within(dialog).getByLabelText('CUIT');
    expect(field).toHaveValue('30-70857833-5');
    await user.clear(field);
    await user.click(within(dialog).getByRole('button', { name: 'Guardar CUIT' }));

    await waitFor(() => {
      expect(bodies).toEqual([{ cuit: null }]);
    });
  });

  it('shows the error of a CUIT the server refuses and keeps the dialog open', async () => {
    const user = userEvent.setup();
    open([payer()], {
      [`PATCH /api/billing/payers/${IDS.payer}`]: () =>
        new Response(
          JSON.stringify({
            type: 'about:blank',
            title: 'x',
            status: 400,
            code: 'validation_failed',
            i18nKey: 'errors.validation_failed',
            requestId: 'r1',
            errors: [{ path: 'cuit', i18nKey: 'country.ar.tax_id.invalid' }],
          }),
          { status: 400, headers: { 'content-type': 'application/problem+json' } },
        ),
    });

    await user.click(await screen.findByRole('button', { name: 'Cargar CUIT de OSDE' }));
    const dialog = await screen.findByRole('dialog', { name: 'CUIT de OSDE' });
    await user.type(within(dialog).getByLabelText('CUIT'), '30-70857833-4');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar CUIT' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'El CUIT/CUIL no es válido. Revise los dígitos y el dígito verificador.',
    );
    expect(screen.getByRole('dialog', { name: 'CUIT de OSDE' })).toBeVisible();
  });

  it('adds a payer of the catalog with its CUIT', async () => {
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];
    const catalogId = '0190a000-0000-7000-8000-0000000000bb';
    open(
      [],
      {
        'POST /api/billing/payers': (_url, init) => {
          bodies.push(jsonBody(init) as Record<string, unknown>);
          return jsonResponse(payer(), 201);
        },
      },
      [{ payerId: catalogId, name: 'OSDE', kind: 'prepaga' }],
    );

    expect(await screen.findByText('Todavía no hay obras sociales')).toBeVisible();
    await user.selectOptions(
      screen.getByLabelText('Del listado de obras sociales y prepagas'),
      catalogId,
    );
    await user.type(screen.getByLabelText('CUIT'), '30708578335');
    await user.click(screen.getByRole('button', { name: 'Agregar' }));

    await waitFor(() => {
      expect(bodies).toEqual([{ payerId: catalogId, cuit: '30708578335' }]);
    });
  });

  it('switches a payer off and on', async () => {
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];
    open([payer()], {
      [`PATCH /api/billing/payers/${IDS.payer}`]: (_url, init) => {
        bodies.push(jsonBody(init) as Record<string, unknown>);
        return jsonResponse(payer({ active: false }));
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Desactivar OSDE' }));

    await waitFor(() => {
      expect(bodies).toEqual([{ active: false }]);
    });
  });

  it('has no accessibility violations, also with the CUIT dialog open', async () => {
    const user = userEvent.setup();
    open([payer({ cuit: '30708578335' })]);

    await user.click(await screen.findByRole('button', { name: 'Cargar CUIT de OSDE' }));
    await screen.findByRole('dialog', { name: 'CUIT de OSDE' });

    expect(await a11yViolations(document.body)).toEqual([]);
  });
});
