import {
  expect,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

import { axeViolations, emailTo, horizontalOverflow } from './stack.js';

/** The pieces the specs of public booking share: a visitor on a phone, and the whole booking. */

export const PHONE = {
  viewport: { width: 360, height: 740 },
  isMobile: true,
  hasTouch: true,
  locale: 'es-AR',
  timezoneId: 'America/Argentina/Buenos_Aires',
  serviceWorkers: 'block' as const,
};

export async function visitor(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(PHONE);
  return { context, page: await context.newPage() };
}

export async function expectFitsAndAccessible(page: Page) {
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
}

export interface Api {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller states the shape it expects
  call<T>(method: string, path: string, data?: unknown): Promise<{ status: number; body: T }>;
}

export function apiOf(request: APIRequestContext, origin: string): Api {
  return {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- see Api.call
    async call<T>(method: string, path: string, data?: unknown) {
      const response = await request.fetch(`${origin}/api${path}`, {
        method,
        headers: { origin },
        ...(data === undefined ? {} : { data }),
      });
      const text = await response.text();
      return { status: response.status(), body: (text ? JSON.parse(text) : undefined) as T };
    },
  };
}

/** A document number nobody else uses in this run. */
export const uniqueDocument = () => `95${String(Date.now()).slice(-6)}`;

/**
 * Books through the screens, the way a patient does. Returns the seconds it took, from opening the
 * page to the confirmation.
 */
export async function bookAsPatient(page: Page, url: string, email: string): Promise<number> {
  const started = Date.now();
  await page.goto(url);
  await expect(page.getByRole('heading', { level: 1, name: /Reserve su turno/ })).toBeVisible();
  const time = page.getByRole('button', { name: /a las \d\d:\d\d$/ }).first();
  await expect(time).toBeVisible();
  await expectFitsAndAccessible(page);
  await time.click();

  await expect(page.getByRole('heading', { name: 'Sus datos' })).toBeVisible();
  await expectFitsAndAccessible(page);
  await page.getByLabel('Nombres').fill('Lucía');
  await page.getByLabel('Apellido').fill(`Visita${String(Date.now()).slice(-5)}`);
  await page.getByLabel('DNI').fill(uniqueDocument());
  await page.getByLabel('Fecha de nacimiento').fill('1990-04-02');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByRole('checkbox', { name: /Acepto que el consultorio trate/ }).click();
  await page.getByRole('button', { name: 'Continuar' }).click();

  await expect(page.getByRole('heading', { name: 'Confirme su correo' })).toBeVisible();
  await expectFitsAndAccessible(page);
  const message = await emailTo(email, /código/i);
  // The code is alone on its line; the organization's name may well contain six digits.
  const code = /^\s*(\d{6})\s*$/m.exec(message)?.[1];
  expect(code, 'the email carries a six digit code').toBeDefined();
  await page.getByLabel('Código de 6 dígitos').fill(code ?? '');
  await page.getByRole('button', { name: 'Confirmar el turno' }).click();

  await expect(
    page.getByRole('heading', { level: 1, name: 'Su turno está reservado' }),
  ).toBeVisible();
  await expectFitsAndAccessible(page);
  return (Date.now() - started) / 1000;
}
