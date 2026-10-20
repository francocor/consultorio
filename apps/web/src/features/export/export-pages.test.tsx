import type { ExportPackageDto } from '@consultorio/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';
import { jsonResponse, problemResponse } from '../../shared/test/render.js';

const saved = vi.hoisted(() => ({ calls: [] as { name: string; size: number }[] }));
vi.mock('../../shared/lib/download.js', () => ({
  downloadBlob: (blob: Blob, name: string) => {
    saved.calls.push({ name, size: blob.size });
  },
  downloadJson: () => undefined,
}));

const boot = bootFor('Centro Médico Aillu');
const TOKEN = 'A'.repeat(43);

const ready = (kind: 'administrative' | 'clinical'): ExportPackageDto => ({
  id: '0190a000-0000-7000-8000-000000000001',
  kind,
  status: 'ready',
  fileName: `exportacion-${kind === 'clinical' ? 'clinica' : 'administrativa'}-20310531.zip`,
  sizeBytes: 2_621_440,
  builtAt: '2031-05-31T18:00:00.000Z',
  failureCode: null,
});

function serve(kind: 'administrative' | 'clinical', entry: ExportPackageDto | null) {
  return {
    'GET /api/worklist/count': () => jsonResponse({ open: 0 }),
    [`GET /api/cancellation/export/${kind}`]: () => jsonResponse({ package: entry }),
    [`POST /api/cancellation/export/${kind}/download`]: () =>
      jsonResponse({ url: `/files/${TOKEN}`, expiresAt: '2031-05-31T18:05:00.000Z' }),
    [`GET /api/files/${TOKEN}`]: () =>
      new Response('zip-bytes', {
        status: 200,
        headers: {
          'content-type': 'application/zip',
          'content-disposition': 'attachment; filename="exportacion-del-servidor.zip"',
        },
      }),
  };
}

beforeEach(() => {
  saved.calls.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('the administrative package, for the owner', () => {
  it('shows the file that is ready, its size and day, and downloads it with the name the server gave', async () => {
    const user = userEvent.setup();
    const app = renderApp({
      me: meFor(['owner']),
      boot,
      path: '/export',
      routes: serve('administrative', ready('administrative')),
    });

    expect(await screen.findByText('Paquete administrativo')).toBeInTheDocument();
    expect(screen.getByText('exportacion-administrativa-20310531.zip')).toBeInTheDocument();
    expect(screen.getByText('2,5 MB')).toBeInTheDocument();
    expect(screen.getByText(/Este paquete no incluye información clínica/)).toBeInTheDocument();
    expect(await a11yViolations(app.container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Descargar el paquete administrativo' }));

    await waitFor(() => {
      expect(saved.calls).toEqual([{ name: 'exportacion-del-servidor.zip', size: 9 }]);
    });
    expect(app.requests).toContain('POST /api/cancellation/export/administrative/download');
  });

  it('says it is being prepared while the package is queued', async () => {
    renderApp({
      me: meFor(['owner']),
      boot,
      path: '/export',
      routes: serve('administrative', {
        ...ready('administrative'),
        status: 'queued',
        fileName: null,
        sizeBytes: null,
        builtAt: null,
      }),
    });

    expect(await screen.findByText('Preparando el paquete')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Descargar/ })).not.toBeInTheDocument();
  });

  it('says there is nothing yet before the organization is cancelled', async () => {
    renderApp({
      me: meFor(['owner']),
      boot,
      path: '/export',
      routes: serve('administrative', null),
    });

    expect(await screen.findByText('Todavía no hay una exportación')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Descargar/ })).not.toBeInTheDocument();
  });

  it.each([
    ['package_too_large', /supera el tamaño/],
    ['clinical_key_in_administrative_part', /información clínica en la parte administrativa/],
    ['build_failed', /problema al armar el paquete/],
  ])(
    'explains a package that could not be made (%s) and offers no download',
    async (code, message) => {
      renderApp({
        me: meFor(['owner']),
        boot,
        path: '/export',
        routes: serve('administrative', {
          ...ready('administrative'),
          status: 'failed',
          fileName: null,
          sizeBytes: null,
          builtAt: null,
          failureCode: code,
        }),
      });

      expect(await screen.findByText('No se pudo preparar el paquete')).toBeInTheDocument();
      expect(screen.getByText(message)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Descargar/ })).not.toBeInTheDocument();
    },
  );

  it('shows the reason when the download is refused', async () => {
    const user = userEvent.setup();
    renderApp({
      me: meFor(['owner']),
      boot,
      path: '/export',
      routes: {
        ...serve('administrative', ready('administrative')),
        'POST /api/cancellation/export/administrative/download': () =>
          problemResponse(409, 'export_package_not_ready'),
      },
    });

    await user.click(
      await screen.findByRole('button', { name: 'Descargar el paquete administrativo' }),
    );

    expect(
      await screen.findByText(
        'El paquete de exportación todavía no está listo. Vuelva a intentarlo en unos minutos.',
      ),
    ).toBeInTheDocument();
    expect(saved.calls).toEqual([]);
  });
});

describe('the clinical package, for a professional', () => {
  it('says whose it is, shows the file and downloads it', async () => {
    const user = userEvent.setup();
    const app = renderApp({
      me: meFor(['professional']),
      boot,
      path: '/export/clinical',
      routes: serve('clinical', ready('clinical')),
    });

    expect(await screen.findByText('Paquete clínico')).toBeInTheDocument();
    expect(screen.getByText(/Este paquete es personal/)).toBeInTheDocument();
    expect(screen.getByText('exportacion-clinica-20310531.zip')).toBeInTheDocument();
    expect(await a11yViolations(app.container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Descargar el paquete clínico' }));

    await waitFor(() => {
      expect(saved.calls).toHaveLength(1);
    });
    expect(app.requests).toContain('POST /api/cancellation/export/clinical/download');
    // The professional's page never asks for the owner's package.
    expect(app.requests).not.toContain('GET /api/cancellation/export/administrative');
  });

  it('says there is nothing yet when the package was not asked for', async () => {
    renderApp({
      me: meFor(['professional']),
      boot,
      path: '/export/clinical',
      routes: serve('clinical', null),
    });

    expect(await screen.findByText('Todavía no hay una exportación clínica')).toBeInTheDocument();
  });
});
