import { expect, test } from '@playwright/test';

import { openAs, originOf, urlOf } from './support/stack.js';

/** The service worker is the thing under test here, so it is allowed (the other specs block it). */
test.use({ serviceWorkers: 'allow' });

interface Manifest {
  name: string;
  short_name: string;
  start_url: string;
  display: string;
  lang: string;
  theme_color: string;
  icons: { src: string; sizes: string; type: string }[];
}

test('every organization serves its own valid manifest with icons that exist', async ({
  request,
}) => {
  const aillu = (await (
    await request.get(urlOf('aillu', '/manifest.webmanifest'))
  ).json()) as Manifest;
  const norte = (await (
    await request.get(urlOf('norte', '/manifest.webmanifest'))
  ).json()) as Manifest;

  expect(aillu).toMatchObject({
    name: 'Centro Médico Aillu',
    display: 'standalone',
    lang: 'es-AR',
    start_url: '/',
  });
  expect(norte).toMatchObject({ name: 'Clínica Norte', short_name: 'Norte' });
  expect(norte.theme_color).toBe('#1e40af');
  expect(aillu.theme_color).not.toBe(norte.theme_color);

  const sizes = aillu.icons.map((icon) => icon.sizes).sort();
  expect(sizes).toEqual(['192x192', '512x512']);
  for (const icon of aillu.icons) {
    const response = await request.get(new URL(icon.src, originOf('aillu')).toString());
    expect(response.status(), icon.src).toBe(200);
    expect(response.headers()['content-type']).toContain('image/png');
  }
});

test('the page links the manifest of its own host', async ({ page }) => {
  await page.goto(urlOf('norte', '/login'));

  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    '/manifest.webmanifest',
  );
});

test('a service worker is registered and the app opens offline with the banner, without cached data', async ({
  page,
  context,
}) => {
  await openAs(page, 'owner');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'Bienvenido a Centro Médico Aillu',
  );
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toContain('aillu.localhost');
  await expect
    .poll(() =>
      page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state ?? null),
    )
    .toBe('activated');
  // The first load is not controlled yet: load once more so the worker serves the page.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Bienvenido');

  await context.setOffline(true);
  await page.reload();

  await expect(page.getByText(/Sin conexión/)).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'No pudimos cargar esta información' }),
  ).toBeVisible();
  // The data of the signed-in area is NOT shown: the API is never answered from a cache.
  await expect(page.getByText('Bienvenido a Centro Médico Aillu')).toHaveCount(0);
  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) urls.push(new URL(request.url).pathname);
    }
    return urls;
  });
  expect(cached.length).toBeGreaterThan(0);
  expect(cached.filter((path) => /^\/(api|files|public)\//.test(path))).toEqual([]);

  await context.setOffline(false);
  await page.getByRole('button', { name: 'Reintentar' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'Bienvenido a Centro Médico Aillu',
  );
  await expect(page.getByText(/Sin conexión/)).toHaveCount(0);
});

test('signing out leaves nothing of the session in the caches or in storage', async ({ page }) => {
  await openAs(page, 'reception', '/patients');
  await page.getByRole('button', { name: 'Menú de la cuenta' }).click();
  await page.getByRole('menuitem', { name: 'Cerrar sesión' }).click();
  await expect(page).toHaveURL(/\/login$/);

  const leftovers = await page.evaluate(async () => {
    const cachePaths: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) cachePaths.push(new URL(request.url).pathname);
    }
    return {
      cachePaths: cachePaths.filter((path) => /^\/(api|files|public)\//.test(path)),
      storageKeys: Object.keys(localStorage).filter((key) => !key.startsWith('consultorio:theme:')),
      sessionStorage: Object.keys(sessionStorage),
    };
  });
  expect(leftovers).toEqual({ cachePaths: [], storageKeys: [], sessionStorage: [] });
});
