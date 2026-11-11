import { DEFAULT_SETTINGS_SECTIONS, type FiscalConfigResponse } from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp, type RenderedApp } from '../../shared/test/render-app.js';
import { jsonBody, jsonResponse } from '../../shared/test/render.js';

type Handler = (url: string, init: RequestInit) => Response;

const config = (overrides: Partial<FiscalConfigResponse> = {}): FiscalConfigResponse => ({
  enabled: false,
  profile: null,
  pointsOfSale: [],
  credential: null,
  readiness: {
    available: false,
    reasons: ['disabled', 'profile_missing', 'point_of_sale_missing'],
    simulated: false,
  },
  ...overrides,
});

const PROFILE = {
  cuit: '20123456786',
  taxCondition: 'monotributo',
  businessName: 'Consultorio Aillu',
  address: 'Av. Siempre Viva 123, CABA',
  activityStartedOn: '2020-03-01',
} as const;

const POINT = {
  id: '0190a000-0000-7000-8000-0000000000e1',
  number: 1,
  environment: 'homologation',
  effectiveEnvironment: 'homologation',
  active: true,
} as const;

const CREDENTIAL = {
  state: 'valid',
  notBefore: '2026-01-01T00:00:00.000Z',
  notAfter: '2027-06-30T12:00:00.000Z',
  subjectCuit: '20123456786',
  fingerprint: 'ab'.repeat(32),
  uploadedAt: '2026-10-01T12:00:00.000Z',
} as const;

const settings = (einvoicing: boolean) => ({
  receptionSeesClinicalMetadata: false,
  clinicalSharing: false,
  sharedTemplates: [],
  require2fa: false,
  quietHours: { start: '21:00', end: '08:00' },
  ...DEFAULT_SETTINGS_SECTIONS,
  integrations: { whatsapp: false, video: true, einvoicing },
});

let current: RenderedApp | undefined;

afterEach(() => {
  expect(current?.missingKeys ?? []).toEqual([]);
  current = undefined;
});

function open(
  loaded: FiscalConfigResponse,
  routes: Record<string, Handler | Response> = {},
  options: { roles?: Parameters<typeof meFor>[0]; afipSimulated?: boolean } = {},
) {
  current = renderApp({
    me: meFor(options.roles ?? ['owner']),
    path: '/settings/invoicing',
    boot: bootFor('Centro Médico Aillu', {
      localProviders: { afip: options.afipSimulated ?? false },
    }),
    routes: {
      'GET /api/invoicing/config': () => jsonResponse(loaded),
      'GET /api/settings': () => jsonResponse(settings(loaded.enabled)),
      ...routes,
    },
  });
  return current;
}

const fieldProblem = (path: string, i18nKey: string) =>
  new Response(
    JSON.stringify({
      type: 'about:blank',
      title: 'validation_failed',
      status: 400,
      code: 'validation_failed',
      i18nKey: 'errors.validation_failed',
      requestId: 'req-test',
      errors: [{ path, i18nKey }],
    }),
    { status: 400, headers: { 'content-type': 'application/problem+json' } },
  );

const pem = (text: string, name: string) =>
  new File([text], name, { type: 'application/x-pem-file' });

describe('Settings > Facturacion', () => {
  it('shows up as a section of Settings for the owner and not for reception', async () => {
    open(config());
    const nav = await screen.findByRole('navigation', { name: /Secciones/i });
    expect(within(nav).getByRole('link', { name: 'Facturación' })).toBeInTheDocument();
  });

  it('is not reachable by reception, which holds no invoicing.configure', async () => {
    open(config(), {}, { roles: ['reception'] });

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Datos fiscales' })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('link', { name: 'Facturación' })).not.toBeInTheDocument();
  });

  it('lists what keeps invoicing from running, one reason per line', async () => {
    open(config());

    const status = await screen.findByRole('region', { name: 'Estado de la facturación' });
    expect(within(status).getByText('Todavía no se pueden emitir facturas:')).toBeInTheDocument();
    const reasons = within(status)
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(reasons).toEqual([
      'La facturación electrónica está desactivada.',
      'Faltan los datos fiscales.',
      'Falta un punto de venta activo.',
    ]);
  });

  it('says invoicing is ready when nothing is missing', async () => {
    open(
      config({
        enabled: true,
        profile: PROFILE,
        pointsOfSale: [POINT],
        readiness: { available: true, reasons: [], simulated: false },
      }),
    );

    expect(
      await screen.findByText('La facturación está lista: ya se pueden emitir facturas.'),
    ).toBeInTheDocument();
  });

  it('says the invoices are test documents when the deployment runs the AFIP simulator', async () => {
    open(config(), {}, { afipSimulated: true });

    expect(await screen.findByText(/Facturación de prueba/)).toBeInTheDocument();
  });

  it('switches e-invoicing on through the organization settings', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open(config(), {
      'PATCH /api/settings': (_url, init) => {
        body = jsonBody(init);
        return jsonResponse(settings(true));
      },
    });

    await user.click(await screen.findByRole('switch', { name: 'Emitir facturas electrónicas' }));

    await waitFor(() => {
      expect(body).toEqual({ integrations: { einvoicing: true } });
    });
  });

  it('reflects that it is already on', async () => {
    open(config({ enabled: true }));

    expect(
      await screen.findByRole('switch', { name: 'Emitir facturas electrónicas' }),
    ).toBeChecked();
  });
});

describe('the fiscal profile form', () => {
  it('saves the identity the owner typed', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open(config(), {
      'PUT /api/invoicing/profile': (_url, init) => {
        body = jsonBody(init);
        return jsonResponse(PROFILE);
      },
    });

    await user.type(await screen.findByLabelText('CUIT'), '20-12345678-6');
    await user.selectOptions(screen.getByLabelText('Condición frente al IVA'), 'monotributo');
    await user.type(screen.getByLabelText('Razón social'), 'Consultorio Aillu');
    await user.type(screen.getByLabelText('Domicilio fiscal'), 'Av. Siempre Viva 123, CABA');
    await user.type(screen.getByLabelText('Inicio de actividades'), '2020-03-01');
    await user.click(screen.getByRole('button', { name: 'Guardar datos fiscales' }));

    await waitFor(() => {
      expect(body).toEqual({
        cuit: '20-12345678-6',
        taxCondition: 'monotributo',
        businessName: 'Consultorio Aillu',
        address: 'Av. Siempre Viva 123, CABA',
        activityStartedOn: '2020-03-01',
      });
    });
  });

  it('shows the saved identity and keeps Save off until something changes', async () => {
    const user = userEvent.setup();
    open(config({ profile: PROFILE }));

    expect(await screen.findByLabelText('CUIT')).toHaveValue('20123456786');
    expect(screen.getByLabelText('Razón social')).toHaveValue('Consultorio Aillu');
    const save = screen.getByRole('button', { name: 'Guardar datos fiscales' });
    expect(save).toBeDisabled();

    await user.type(screen.getByLabelText('Razón social'), ' SRL');
    expect(save).toBeEnabled();
  });

  it('asks for every field before sending, and names the ones that are missing', async () => {
    const user = userEvent.setup();
    let sent = false;
    open(config(), {
      'PUT /api/invoicing/profile': () => {
        sent = true;
        return jsonResponse(PROFILE);
      },
    });

    await user.type(await screen.findByLabelText('CUIT'), '20-12345678-6');
    await user.click(screen.getByRole('button', { name: 'Guardar datos fiscales' }));

    expect(await screen.findAllByText('Este dato es obligatorio.')).toHaveLength(4);
    expect(sent).toBe(false);
  });

  it('puts the answer of the server about the CUIT next to the CUIT', async () => {
    const user = userEvent.setup();
    open(config({ profile: PROFILE }), {
      'PUT /api/invoicing/profile': () => fieldProblem('cuit', 'country.ar.tax_id.invalid'),
    });

    await user.type(await screen.findByLabelText('CUIT'), '9');
    await user.click(screen.getByRole('button', { name: 'Guardar datos fiscales' }));

    const message = await screen.findByText(/El CUIT\/CUIL no es válido/);
    expect(screen.getByLabelText('CUIT')).toHaveAccessibleDescription(/El CUIT\/CUIL no es válido/);
    expect(message).toBeInTheDocument();
  });
});

describe('points of sale', () => {
  it('says there are none yet', async () => {
    open(config());

    expect(await screen.findByText('Todavía no hay puntos de venta.')).toBeInTheDocument();
  });

  it('lists each with its environment as text, so it is not told by color alone', async () => {
    open(
      config({
        profile: PROFILE,
        pointsOfSale: [
          POINT,
          {
            ...POINT,
            id: '0190a000-0000-7000-8000-0000000000e2',
            number: 2,
            environment: 'production',
            effectiveEnvironment: 'production',
          },
        ],
      }),
    );

    const list = await screen.findByRole('list', { name: 'Puntos de venta' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Punto de venta 1');
    expect(items[0]).toHaveTextContent('Homologación (prueba)');
    expect(items[1]).toHaveTextContent('Punto de venta 2');
    expect(items[1]).toHaveTextContent('Producción');
  });

  it('explains that the simulator forces homologation and shows what is used', async () => {
    open(
      config({
        pointsOfSale: [
          { ...POINT, environment: 'production', effectiveEnvironment: 'homologation' },
        ],
        readiness: { available: false, reasons: [], simulated: true },
      }),
    );

    expect(
      await screen.findByText(/Con el simulador, todos los puntos de venta usan homologación/),
    ).toBeInTheDocument();
    expect(screen.getByText('Se usa Homologación (prueba)')).toBeInTheDocument();
  });

  it('adds a point of sale with its environment', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open(config({ profile: PROFILE }), {
      'POST /api/invoicing/points-of-sale': (_url, init) => {
        body = jsonBody(init);
        return jsonResponse(POINT, 201);
      },
    });

    await user.type(await screen.findByLabelText('Número'), '3');
    await user.selectOptions(screen.getByLabelText('Ambiente'), 'production');
    await user.click(screen.getByRole('button', { name: 'Agregar punto de venta' }));

    await waitFor(() => {
      expect(body).toEqual({ number: 3, environment: 'production' });
    });
  });

  it('refuses a number out of range before sending', async () => {
    const user = userEvent.setup();
    let sent = false;
    open(config({ profile: PROFILE }), {
      'POST /api/invoicing/points-of-sale': () => {
        sent = true;
        return jsonResponse(POINT, 201);
      },
    });

    await user.type(await screen.findByLabelText('Número'), '100000');
    await user.click(screen.getByRole('button', { name: 'Agregar punto de venta' }));

    expect(await screen.findByText('Ingrese un número entre 1 y 99999.')).toBeInTheDocument();
    expect(sent).toBe(false);
  });

  it('deactivates a point of sale and changes its environment', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open(config({ profile: PROFILE, pointsOfSale: [POINT] }), {
      [`PATCH /api/invoicing/points-of-sale/${POINT.id}`]: (_url, init) => {
        bodies.push(jsonBody(init));
        return jsonResponse(POINT);
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Desactivar el punto de venta 1' }));
    await user.selectOptions(screen.getByLabelText('Ambiente del punto de venta 1'), 'production');

    await waitFor(() => {
      expect(bodies).toEqual([{ active: false }, { environment: 'production' }]);
    });
  });
});

describe('the certificate', () => {
  it('asks for the fiscal profile first', async () => {
    open(config());

    expect(
      await screen.findByText(
        'Guarde primero los datos fiscales: el certificado se verifica contra el CUIT.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Certificado (.crt o .pem)')).not.toBeInTheDocument();
  });

  it('says there is none, and offers the upload', async () => {
    open(config({ profile: PROFILE }));

    expect(await screen.findByText('Todavía no hay un certificado cargado.')).toBeInTheDocument();
    expect(screen.getByLabelText('Certificado (.crt o .pem)')).toBeInTheDocument();
    expect(
      screen.getByLabelText('Clave privada (.key o .pem, sin contraseña)'),
    ).toBeInTheDocument();
  });

  it('shows the state with an icon and a word, the expiry and the fingerprint, never the certificate', async () => {
    open(config({ profile: PROFILE, credential: CREDENTIAL }));

    const section = await screen.findByRole('region', { name: 'Certificado digital' });
    expect(within(section).getByText('Vigente')).toBeInTheDocument();
    expect(within(section).getByText(/Vence el 30\/06\/2027/)).toBeInTheDocument();
    expect(within(section).getByText(/CUIT del certificado: 20123456786/)).toBeInTheDocument();
    expect(within(section).getByText(/Huella: abab/)).toBeInTheDocument();
    expect(within(section).queryByText(/BEGIN/)).not.toBeInTheDocument();
  });

  it.each([
    ['expiring', 'Por vencer', /vence el 30\/06\/2027. Cargue uno nuevo antes de esa fecha/],
    ['expired', 'Vencido', /El certificado venció\. Mientras no cargue uno nuevo/],
    ['invalid', 'No válido', /no corresponde al CUIT actual/],
  ] as const)('warns when the certificate is %s', async (state, word, warning) => {
    open(config({ profile: PROFILE, credential: { ...CREDENTIAL, state } }));

    const section = await screen.findByRole('region', { name: 'Certificado digital' });
    expect(within(section).getByText(word)).toBeInTheDocument();
    expect(within(section).getByText(warning)).toBeInTheDocument();
  });

  it('uploads the two files as text and clears them afterwards', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open(config({ profile: PROFILE }), {
      'PUT /api/invoicing/credentials': (_url, init) => {
        body = jsonBody(init);
        return jsonResponse(CREDENTIAL);
      },
    });

    const certificate = await screen.findByLabelText('Certificado (.crt o .pem)');
    await user.upload(certificate, pem('CERTIFICATE-TEXT', 'cert.crt.pem'));
    await user.upload(
      screen.getByLabelText('Clave privada (.key o .pem, sin contraseña)'),
      pem('KEY-TEXT', 'cert.key.pem'),
    );
    expect(await screen.findByText('Archivo elegido: cert.crt.pem')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cargar certificado' }));

    await waitFor(() => {
      expect(body).toEqual({ certificate: 'CERTIFICATE-TEXT', privateKey: 'KEY-TEXT' });
    });
    await waitFor(() => {
      expect(screen.queryByText('Archivo elegido: cert.crt.pem')).not.toBeInTheDocument();
    });
  });

  it('does not send until both files are chosen', async () => {
    const user = userEvent.setup();
    let sent = false;
    open(config({ profile: PROFILE }), {
      'PUT /api/invoicing/credentials': () => {
        sent = true;
        return jsonResponse(CREDENTIAL);
      },
    });

    await user.upload(
      await screen.findByLabelText('Certificado (.crt o .pem)'),
      pem('CERTIFICATE-TEXT', 'cert.crt.pem'),
    );
    await user.click(screen.getByRole('button', { name: 'Cargar certificado' }));

    expect(await screen.findByText('Elija el certificado y la clave privada.')).toBeInTheDocument();
    expect(sent).toBe(false);
  });

  it('shows why the server refused a file next to that file', async () => {
    const user = userEvent.setup();
    open(config({ profile: PROFILE }), {
      'PUT /api/invoicing/credentials': () =>
        fieldProblem('privateKey', 'invoicing.credential.key_mismatch'),
    });

    await user.upload(
      await screen.findByLabelText('Certificado (.crt o .pem)'),
      pem('C', 'cert.crt.pem'),
    );
    await user.upload(
      screen.getByLabelText('Clave privada (.key o .pem, sin contraseña)'),
      pem('K', 'cert.key.pem'),
    );
    await user.click(screen.getByRole('button', { name: 'Cargar certificado' }));

    expect(
      await screen.findByText('La clave privada no corresponde al certificado.'),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText('Clave privada (.key o .pem, sin contraseña)'),
    ).toHaveAccessibleDescription(/no corresponde al certificado/);
  });

  it('tells a developer how to make a test certificate when the simulator serves the deployment', async () => {
    open(
      config({
        profile: PROFILE,
        readiness: { available: false, reasons: [], simulated: true },
      }),
    );

    expect(await screen.findByText(/pnpm dev:afip-cert/)).toBeInTheDocument();
  });
});

describe('the screen as a whole', () => {
  it('has no accessibility violations with everything configured', async () => {
    const view = open(
      config({
        enabled: true,
        profile: PROFILE,
        pointsOfSale: [POINT],
        credential: { ...CREDENTIAL, state: 'expiring' },
        readiness: { available: true, reasons: [], simulated: true },
      }),
      {},
      { afipSimulated: true },
    );
    await screen.findByRole('region', { name: 'Certificado digital' });

    expect(await a11yViolations(view.container)).toEqual([]);
  });

  it('has no accessibility violations when nothing is configured', async () => {
    const view = open(config());
    await screen.findByRole('region', { name: 'Certificado digital' });

    expect(await a11yViolations(view.container)).toEqual([]);
  });
});
