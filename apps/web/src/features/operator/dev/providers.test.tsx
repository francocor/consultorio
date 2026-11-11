import type { DevProviderDto } from '@consultorio/contracts';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';

import { createI18n } from '../../../app/i18n.js';
import { LOCALE_RESOURCES } from '../../../shared/lib/locale-all.js';
import { a11yViolations } from '../../../shared/test/a11y.js';
import { renderApp } from '../../../shared/test/render-app.js';
import { jsonResponse, problemResponse } from '../../../shared/test/render.js';

import { ProvidersPage } from './ProvidersPage.js';
import { collectTabs, type DevTab } from './tabs.js';

const PROVIDERS: DevProviderDto[] = [
  { id: 'whatsapp', label: 'WhatsApp', adapter: 'local', mode: 'ok' },
  { id: 'video', label: 'Video', adapter: 'off', mode: null },
  { id: 'bot-challenge', label: 'Bot challenge', adapter: 'real', mode: null },
];

/** The item at a position, or a failure that names it (the tests index lists they just checked). */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at ${String(index)}`);
  return item;
}

const tab = (id: string, text: string): DevTab => ({
  id,
  labelKey: 'operator:providers.overview',
  Component: () => <p>{text}</p>,
});

function open(tabs: readonly DevTab[]) {
  const i18n = createI18n({ resources: LOCALE_RESOURCES });
  return render(
    <I18nextProvider i18n={i18n}>
      <ProvidersPage providers={PROVIDERS} tabs={tabs} />
    </I18nextProvider>,
  );
}

describe('collecting the tabs that features add to the provider console', () => {
  it('takes the tab of each module and keeps them in order of id', () => {
    const tabs = collectTabs({
      './whatsapp/tab.tsx': { tab: tab('whatsapp', 'WhatsApp controls') },
      './video/tab.tsx': { tab: tab('video', 'Video controls') },
    });

    expect(tabs.map((entry) => entry.id)).toEqual(['video', 'whatsapp']);
  });

  it('refuses two tabs with the same id: one would hide the other', () => {
    expect(() =>
      collectTabs({
        './one/tab.tsx': { tab: tab('same', 'a') },
        './two/tab.tsx': { tab: tab('same', 'b') },
      }),
    ).toThrow(/same/);
  });

  it('is empty when no feature added one', () => {
    expect(collectTabs({})).toEqual([]);
  });
});

describe('provider console page', () => {
  it('lists every provider with the adapter that serves customers and its mode', () => {
    open([]);

    const table = screen.getByRole('table', { name: 'Proveedores externos' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(within(at(rows, 0)).getByText('WhatsApp')).toBeInTheDocument();
    expect(within(at(rows, 0)).getByText('Simulador local')).toBeInTheDocument();
    expect(within(at(rows, 0)).getByText('ok')).toBeInTheDocument();
    expect(within(at(rows, 1)).getByText('Apagado')).toBeInTheDocument();
    expect(within(at(rows, 2)).getByText('Proveedor real')).toBeInTheDocument();
    // A provider with no mode says so, in words.
    expect(within(at(rows, 1)).getByText('Sin modos')).toBeInTheDocument();
  });

  it('shows the overview and one tab for each tab a feature registered', async () => {
    const user = userEvent.setup();
    open([tab('whatsapp', 'WhatsApp controls'), tab('video', 'Video controls')]);

    const list = screen.getByRole('tablist', { name: 'Controles de los simuladores' });
    const labels = within(list).getAllByRole('tab');
    expect(labels).toHaveLength(3);
    expect(screen.getByRole('table', { name: 'Proveedores externos' })).toBeInTheDocument();

    await user.click(at(labels, 1));
    expect(screen.getByText('WhatsApp controls')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Proveedores externos' })).not.toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = open([tab('whatsapp', 'WhatsApp controls')]);

    expect(await a11yViolations(container)).toEqual([]);
  });
});

describe('the console shows the providers tab only when the server has the dev routes', () => {
  const OPERATOR = {
    id: '0190a000-0000-7000-8000-0000000000c1',
    email: 'operador@demo.invalid',
    displayName: 'Operador de la plataforma',
  };
  const base = {
    'GET /api/operator/me': () => jsonResponse(OPERATOR),
    'GET /api/operator/tenants': () => jsonResponse({ tenants: [] }),
  };

  it('adds a "Proveedores" tab when GET /operator/dev/providers answers', async () => {
    const app = renderApp({
      platform: true,
      me: null,
      path: '/',
      routes: {
        ...base,
        'GET /api/operator/dev/providers': () => jsonResponse({ providers: PROVIDERS }),
      },
    });

    expect(await screen.findByRole('tab', { name: 'Proveedores' })).toBeInTheDocument();
    expect(app.missingKeys).toEqual([]);
  });

  it('shows no such tab when the server answers 404, which is what a deployment without the console does', async () => {
    renderApp({
      platform: true,
      me: null,
      path: '/',
      routes: {
        ...base,
        'GET /api/operator/dev/providers': () => problemResponse(404, 'not_found'),
      },
    });

    expect(await screen.findByRole('tab', { name: 'Organizaciones' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Proveedores' })).not.toBeInTheDocument();
  });
});
