import type { PublicAvailabilityResponse, PublicBookingPageDto } from '@consultorio/contracts';
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

/** Days one screen of the time picker covers (the same as the page's own). */
const PICKER_PAGE_DAYS = 14;
/** How many screens of the picker to look through for a time. */
const PICKER_MAX_PAGES = 6;
const DAY_MS = 86_400_000;

/** Where a time sits in the picker: how many times "Ver más fechas" to press, which day, which time. */
export interface TimeChoice {
  pages: number;
  dayIndex: number;
  /** The wall-clock time the button shows, such as `17:30`. */
  label: string;
  startsAt: string;
}

const plusDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/**
 * The first free time a visitor can pick that starts at or after `notBefore`, found the way the
 * page finds it: the public availability of the professional's link. A patient can change or cancel
 * by link only until `rescheduleDeadlineHours` before the start, so a spec that goes on to change or
 * cancel must not book the first free time of the day (it may already be inside that window, and
 * which one it is depends on the hour the spec runs). `notBefore` makes the choice depend on the
 * deadline and not on the clock.
 */
export async function firstTimeFrom(
  request: APIRequestContext,
  origin: string,
  bookingPath: string,
  notBefore: Date,
): Promise<TimeChoice> {
  const match = /^\/book\/([^/]+)\/p\/([^/]+)$/.exec(bookingPath);
  const [, organizationSlug, professionalSlug] = match ?? [];
  if (!organizationSlug || !professionalSlug) {
    throw new Error(`Not the address of a professional's link: ${bookingPath}`);
  }
  const api = apiOf(request, origin);
  const page = await api.call<PublicBookingPageDto>(
    'GET',
    `/public/${organizationSlug}/p/${professionalSlug}`,
  );
  expect(page.status).toBe(200);
  // What the page chooses before the visitor touches anything: the first type and the first place.
  const professional = page.body.professionals[0];
  const type = professional?.types[0];
  const place = professional?.locations[0];
  if (!type || !place) throw new Error('The link offers no type of visit or no place');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: place.timeZone }).format(new Date());
  const clock = new Intl.DateTimeFormat('es-AR', {
    timeZone: place.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

  for (let pages = 0; pages < PICKER_MAX_PAGES; pages += 1) {
    const from = plusDays(today, pages * PICKER_PAGE_DAYS);
    const query = new URLSearchParams({
      professional: professionalSlug,
      typeId: type.id,
      locationId: place.id,
      from,
      to: plusDays(from, PICKER_PAGE_DAYS - 1),
    });
    const answer = await api.call<PublicAvailabilityResponse>(
      'GET',
      `/public/${organizationSlug}/booking/availability?${query.toString()}`,
    );
    expect(answer.status).toBe(200);
    const slot = answer.body.slots.find(
      (entry) => Date.parse(entry.startsAt) >= notBefore.getTime(),
    );
    if (!slot) continue;
    const dates = [...new Set(answer.body.slots.map((entry) => entry.date))];
    return {
      pages,
      dayIndex: dates.indexOf(slot.date),
      label: clock.format(new Date(slot.startsAt)),
      startsAt: slot.startsAt,
    };
  }
  throw new Error(
    `No free time from ${notBefore.toISOString()} in ${String(PICKER_MAX_PAGES)} pages`,
  );
}

/** The button of a time the picker shows, after moving to the screen and the day it is on. */
async function timeButton(page: Page, choice: TimeChoice | undefined) {
  if (!choice) return page.getByRole('button', { name: /a las \d\d:\d\d$/ }).first();
  for (let step = 0; step < choice.pages; step += 1) {
    await page.getByRole('button', { name: 'Ver más fechas' }).click();
  }
  if (choice.dayIndex > 0) {
    await page
      .getByRole('list', { name: 'Días con turnos disponibles' })
      .getByRole('button')
      .nth(choice.dayIndex)
      .click();
  }
  // Only the times of the chosen day are on the screen, so the clock time names one button.
  return page.getByRole('button', { name: new RegExp(`a las ${choice.label}$`) });
}

/**
 * Books through the screens, the way a patient does. Returns the seconds it took, from opening the
 * page to the confirmation. Without `choice` it takes the first free time the page offers.
 */
export async function bookAsPatient(
  page: Page,
  url: string,
  email: string,
  choice?: TimeChoice,
): Promise<number> {
  const started = Date.now();
  await page.goto(url);
  await expect(page.getByRole('heading', { level: 1, name: /Reserve su turno/ })).toBeVisible();
  const time = await timeButton(page, choice);
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
