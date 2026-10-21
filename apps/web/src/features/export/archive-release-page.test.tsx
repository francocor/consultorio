import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor } from '../../shared/test/fixtures.js';
import { renderApp, type RenderedApp } from '../../shared/test/render-app.js';
import { jsonResponse, problemResponse } from '../../shared/test/render.js';

const saved = vi.hoisted(() => ({ calls: [] as { name: string; size: number }[] }));
vi.mock('../../shared/lib/download.js', () => ({
  downloadBlob: (blob: Blob, name: string) => {
    saved.calls.push({ name, size: blob.size });
  },
  downloadJson: () => undefined,
}));

const boot = bootFor('Centro Médico Aillu');
const TOKEN = 'B'.repeat(43);
const LINK = `/api/public/_/archive-release/${TOKEN}`;

let current: RenderedApp | undefined;

beforeEach(() => {
  saved.calls.length = 0;
});
afterEach(() => {
  expect(current?.missingKeys ?? []).toEqual([]);
  current = undefined;
  vi.restoreAllMocks();
});

function open(routes: Record<string, () => Response>) {
  current = renderApp({ me: null, boot, path: `/archive-release/${TOKEN}`, routes });
  return current;
}

const zip = () =>
  new Response('zip-bytes', {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': 'attachment; filename="historia-clinica-20310610.zip"',
    },
  });

describe('the page of the release link', () => {
  it('opens the link without spending it and offers the single download', async () => {
    const app = open({
      [`GET ${LINK}`]: () => jsonResponse({ expiresAt: '2031-06-13T12:00:00.000Z' }),
    });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sus registros están listos' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/una sola descarga y vence el/)).toBeInTheDocument();
    expect(app.requests).toContain(`GET ${LINK}`);
    expect(app.requests).not.toContain(`POST ${LINK}`);
    expect(await a11yViolations(document.body)).toEqual([]);
  });

  it('downloads the package with the name the server gave, and says the link is spent', async () => {
    const user = userEvent.setup();
    open({
      [`GET ${LINK}`]: () => jsonResponse({ expiresAt: '2031-06-13T12:00:00.000Z' }),
      [`POST ${LINK}`]: zip,
    });

    await user.click(await screen.findByRole('button', { name: 'Descargar los registros' }));

    expect(await screen.findByRole('heading', { name: 'Descarga completa' })).toBeInTheDocument();
    expect(saved.calls).toEqual([{ name: 'historia-clinica-20310610.zip', size: 9 }]);
  });

  it('answers the same for a link that does not exist, expired or was already used', async () => {
    open({ [`GET ${LINK}`]: () => problemResponse(404, 'not_found') });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Este enlace no está disponible' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Descargar los registros' }),
    ).not.toBeInTheDocument();
  });

  it('shows the unavailable page when the download is refused, as when another tab spent the link', async () => {
    const user = userEvent.setup();
    open({
      [`GET ${LINK}`]: () => jsonResponse({ expiresAt: '2031-06-13T12:00:00.000Z' }),
      [`POST ${LINK}`]: () => problemResponse(404, 'not_found'),
    });

    await user.click(await screen.findByRole('button', { name: 'Descargar los registros' }));

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Este enlace no está disponible' }),
      ).toBeInTheDocument();
    });
    expect(saved.calls).toEqual([]);
  });
});
