import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { THEME_STORAGE_PREFIX } from '../../shared/lib/theme-boot.js';
import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp, type RenderedApp } from '../../shared/test/render-app.js';
import { jsonBody, jsonResponse, problemResponse } from '../../shared/test/render.js';

type Handler = (url: string, init: RequestInit) => Response;

const branding = (overrides: Record<string, unknown> = {}) => ({
  displayName: 'Centro Médico Aillu',
  shortName: 'Aillu',
  primaryRequested: '#03a550',
  primaryEffective: '#03a550',
  primaryForeground: '#000000',
  radius: 'lg',
  headingFont: 'poppins',
  logoUrl: null,
  ...overrides,
});

const contrast = (overrides: Record<string, unknown> = {}) => ({
  requested: '#03a550',
  effective: '#03a550',
  foreground: '#000000',
  adjusted: false,
  ratio: 7.4,
  warning: null,
  ...overrides,
});

let current: RenderedApp | undefined;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  expect(current?.missingKeys ?? []).toEqual([]);
  current = undefined;
});

function open(routes: Record<string, Handler> = {}, me = meFor(['owner'])) {
  current = renderApp({
    me,
    path: '/settings/branding',
    boot: bootFor('Centro Médico Aillu'),
    routes: {
      'GET /api/branding': () => jsonResponse({ branding: branding(), contrast: contrast() }),
      ...routes,
    },
  });
  return current;
}

describe('Settings > Identidad visual', () => {
  it('shows the current identity of the organization', async () => {
    open();

    expect(await screen.findByLabelText('Nombre de la organización')).toHaveValue(
      'Centro Médico Aillu',
    );
    expect(screen.getByLabelText('Nombre corto')).toHaveValue('Aillu');
    expect(screen.getByLabelText('Color principal')).toHaveValue('#03a550');
    expect(screen.getByLabelText('Esquinas')).toHaveValue('lg');
    expect(screen.getByLabelText('Tipografía de los títulos')).toHaveValue('poppins');
  });

  it('warns, with both colors, when the color chosen is too light to read', async () => {
    const user = userEvent.setup();
    let asked: unknown;
    open({
      'POST /api/branding/preview': (_url, init) => {
        asked = jsonBody(init);
        return jsonResponse(
          contrast({
            requested: '#ffeb3b',
            effective: '#8a7a00',
            adjusted: true,
            ratio: 4.6,
            warning: 'branding.contrast_adjusted',
          }),
        );
      },
    });
    const color = await screen.findByLabelText('Color principal');
    await user.clear(color);
    await user.type(color, '#ffeb3b');

    expect(await screen.findByText(/no tiene contraste suficiente/)).toBeInTheDocument();
    expect(screen.getByText('#ffeb3b')).toBeInTheDocument();
    expect(screen.getByText('#8a7a00')).toBeInTheDocument();
    expect(asked).toEqual({ primaryColor: '#ffeb3b' });
  });

  it('says so when the color reads well', async () => {
    const user = userEvent.setup();
    open({ 'POST /api/branding/preview': () => jsonResponse(contrast({ ratio: 8.2 })) });
    const color = await screen.findByLabelText('Color principal');
    await user.clear(color);
    await user.type(color, '#0f766e');

    expect(await screen.findByText(/se lee bien/)).toBeInTheDocument();
  });

  it('does not ask the server about a color that is not complete yet', async () => {
    const user = userEvent.setup();
    const app = open();
    const color = await screen.findByLabelText('Color principal');
    await user.clear(color);
    await user.type(color, '#0f76');
    await new Promise((resolve) => setTimeout(resolve, 450));

    expect(app.requests).not.toContain('POST /api/branding/preview');
  });

  it('a ready-made style fills the whole identity', async () => {
    const user = userEvent.setup();
    open({ 'POST /api/branding/preview': () => jsonResponse(contrast({ requested: '#1e40af' })) });
    await screen.findByLabelText('Nombre de la organización');

    await user.click(screen.getByRole('button', { name: 'Aplicar el estilo Clínica Norte' }));

    expect(screen.getByLabelText('Nombre de la organización')).toHaveValue('Clínica Norte');
    expect(screen.getByLabelText('Color principal')).toHaveValue('#1e40af');
    expect(screen.getByLabelText('Esquinas')).toHaveValue('sm');
    expect(screen.getByLabelText('Tipografía de los títulos')).toHaveValue('source_sans');
  });

  it('saves, applies the new look at once and remembers it for the next load', async () => {
    const user = userEvent.setup();
    let body: unknown;
    const app = open({
      'POST /api/branding/preview': () => jsonResponse(contrast({ requested: '#1e40af' })),
      'PUT /api/branding': (_url, init) => {
        body = jsonBody(init);
        return jsonResponse({
          branding: branding({
            displayName: 'Clínica Norte',
            shortName: 'Norte',
            primaryRequested: '#1e40af',
            primaryEffective: '#1e40af',
            primaryForeground: '#ffffff',
            radius: 'sm',
            headingFont: 'source_sans',
          }),
          contrast: contrast({ requested: '#1e40af', effective: '#1e40af' }),
        });
      },
    });
    await screen.findByLabelText('Nombre de la organización');
    await user.click(screen.getByRole('button', { name: 'Aplicar el estilo Clínica Norte' }));

    await user.click(screen.getByRole('button', { name: 'Guardar identidad' }));

    await waitFor(() => {
      expect(body).toEqual({
        displayName: 'Clínica Norte',
        shortName: 'Norte',
        primaryColor: '#1e40af',
        radius: 'sm',
        headingFont: 'source_sans',
      });
    });
    expect(await screen.findByText('Identidad guardada.')).toBeInTheDocument();
    const stored = localStorage.getItem(`${THEME_STORAGE_PREFIX}${window.location.host}`);
    expect(JSON.parse(stored ?? 'null')).toEqual({
      primary: '#1e40af',
      primaryForeground: '#ffffff',
      radius: 'sm',
      headingFont: 'source_sans',
    });
    await waitFor(() => {
      expect(app.requests.filter((request) => request === 'GET /api/public/boot')).toHaveLength(2);
    });
  });

  it('refuses a name or a color that cannot be saved, next to the field', async () => {
    const user = userEvent.setup();
    const app = open();
    const name = await screen.findByLabelText('Nombre de la organización');
    await user.clear(name);
    const color = screen.getByLabelText('Color principal');
    await user.clear(color);
    await user.type(color, 'rojo');
    await user.click(screen.getByRole('button', { name: 'Guardar identidad' }));

    expect(await screen.findByText('Ingrese un color en formato #RRGGBB.')).toBeInTheDocument();
    expect(app.requests.filter((request) => request.startsWith('PUT'))).toEqual([]);
  });

  it('shows what the server refused', async () => {
    const user = userEvent.setup();
    open({ 'PUT /api/branding': () => problemResponse(500, 'internal') });
    await screen.findByLabelText('Nombre de la organización');

    await user.click(screen.getByRole('button', { name: 'Guardar identidad' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

describe('the logo', () => {
  const logoFile = (type = 'image/png', size = 1024) =>
    new File([new Uint8Array(size)], 'logo.png', { type });

  it('uploads an image as it is', async () => {
    const user = userEvent.setup();
    let contentType = '';
    open({
      'PUT /api/branding/logo': (_url, init) => {
        contentType = new Headers(init.headers).get('content-type') ?? '';
        return jsonResponse({
          branding: branding({ logoUrl: '/public/branding/logo' }),
          contrast: contrast(),
        });
      },
    });
    await screen.findByLabelText('Nombre de la organización');

    await user.upload(screen.getByLabelText('Subir un logo'), logoFile());

    expect(await screen.findByText('Logo actualizado.')).toBeInTheDocument();
    expect(contentType).toBe('image/png');
  });

  it('refuses a file that is not an accepted image before sending it', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const app = open();
    await screen.findByLabelText('Nombre de la organización');

    await user.upload(screen.getByLabelText('Subir un logo'), logoFile('image/svg+xml'));

    expect(
      await screen.findByText('El logo debe ser una imagen PNG, JPG o WebP.'),
    ).toBeInTheDocument();
    expect(app.requests.filter((request) => request.startsWith('PUT'))).toEqual([]);
  });

  it('refuses a file over the size limit before sending it', async () => {
    const user = userEvent.setup();
    const app = open();
    await screen.findByLabelText('Nombre de la organización');

    await user.upload(screen.getByLabelText('Subir un logo'), logoFile('image/png', 600 * 1024));

    expect(await screen.findByText('El logo pesa más de 512 KB.')).toBeInTheDocument();
    expect(app.requests.filter((request) => request.startsWith('PUT'))).toEqual([]);
  });

  it('removes the current logo', async () => {
    const user = userEvent.setup();
    let removed = false;
    open({
      'GET /api/branding': () =>
        jsonResponse({
          branding: branding({ logoUrl: removed ? null : '/public/branding/logo' }),
          contrast: contrast(),
        }),
      'DELETE /api/branding/logo': () => {
        removed = true;
        return jsonResponse({ branding: branding(), contrast: contrast() });
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Quitar el logo' }));

    expect(await screen.findByText('Logo quitado.')).toBeInTheDocument();
  });
});

describe('access and accessibility', () => {
  it('a person without the permission cannot open it', async () => {
    const app = open({}, meFor(['reception']));

    expect(
      await screen.findByRole('heading', { name: 'No tiene acceso a esta sección' }),
    ).toBeInTheDocument();
    expect(app.requests).not.toContain('GET /api/branding');
  });

  it('has no accessibility violations', async () => {
    const app = open();
    await screen.findByLabelText('Nombre de la organización');

    expect(await a11yViolations(app.container)).toEqual([]);
  });
});
