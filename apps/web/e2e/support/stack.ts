import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, type APIRequestContext, type Page } from '@playwright/test';

/** What the end-to-end stack wrote when it was ready (`apps/api/scripts/stack`). */
interface StackInfo {
  apiUrl: string;
  mailpitUrl: string;
  baseDomain: string;
  platformHost: string;
  demoPassword: string;
  tenants: Record<string, { id: string; slug: string; name: string; emailSuffix: string }>;
  operator: { email: string; password: string; totpSecret: string };
  operatorTwo: { email: string; password: string; totpSecret: string };
  /** The billed organizations of the platform demo, by state of their subscription (Stage 6). */
  platformDemo: Record<
    'trial' | 'active' | 'past_due' | 'read_only',
    {
      slug: string;
      name: string;
      ownerEmail: string;
      receptionEmail: string;
      professionalEmail: string | null;
    }
  >;
}

/** The port of the preview server; `E2E_WEB_PORT` moves it when another run holds 4173. */
export const WEB_PORT = Number(process.env['E2E_WEB_PORT'] ?? '4173');

export const stack: StackInfo = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../.stack/info.json'), 'utf8'),
) as StackInfo;

export type Organization = 'aillu' | 'norte';

/** The origin of an organization's web app: each one has its own host, as in production. */
export const originOf = (slug: Organization | 'platform') =>
  `http://${slug === 'platform' ? stack.platformHost : `${slug}.${stack.baseDomain}`}:${String(WEB_PORT)}`;

export const urlOf = (slug: Organization | 'platform', path = '/') => `${originOf(slug)}${path}`;

const LOCAL_PART = {
  owner: 'propietaria',
  admin: 'administracion',
  reception: 'recepcion',
  'reception-north': 'recepcion.norte',
  cardiology: 'cardiologia',
  pediatrics: 'pediatria',
  psychology: 'psicologia',
} as const;

export type AccountKey = keyof typeof LOCAL_PART;

/** The sign-in address of a demo account in an organization. */
export function emailOf(account: AccountKey, organization: Organization = 'aillu'): string {
  const suffix = stack.tenants[organization]?.emailSuffix ?? '';
  return `${LOCAL_PART[account]}${suffix}@demo.invalid`;
}

/** Signs in through the web app's own proxy, so the browser holds the session cookie. */
export async function signInWithApi(
  request: APIRequestContext,
  organization: Organization,
  email: string,
  password = stack.demoPassword,
): Promise<void> {
  const response = await request.post(urlOf(organization, '/api/auth/login'), {
    data: { email, password },
    headers: { origin: originOf(organization) },
  });
  expect(response.ok(), `sign in as ${email}`).toBe(true);
}

/** Signs in with the form, the way a person does. */
export async function signInWithForm(
  page: Page,
  organization: Organization,
  email: string,
  password = stack.demoPassword,
): Promise<void> {
  await page.goto(urlOf(organization, '/login'));
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
}

/** Opens a page already signed in as a demo account. */
export async function openAs(
  page: Page,
  account: AccountKey,
  path = '/',
  organization: Organization = 'aillu',
): Promise<void> {
  await signInWithApi(page.request, organization, emailOf(account, organization));
  await page.goto(urlOf(organization, path));
}

/** A 6-digit TOTP code (RFC 6238, SHA-1, 30 s) for a base32 secret. */
export function totpCode(secretBase32: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secretBase32.replace(/=+$/, '').toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  }
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const value =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    ((hmac[offset + 1] ?? 0) << 16) |
    ((hmac[offset + 2] ?? 0) << 8) |
    (hmac[offset + 3] ?? 0);
  return String(value % 1_000_000).padStart(6, '0');
}

interface MailpitMessage {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

/** Waits for an email to an address and returns its text body (Mailpit's API). */
export async function emailTo(address: string, subject?: RegExp): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const list = (await (await fetch(`${stack.mailpitUrl}/api/v1/messages`)).json()) as {
      messages: MailpitMessage[];
    };
    const found = list.messages.find(
      (message) =>
        message.To.some((to) => to.Address.toLowerCase() === address.toLowerCase()) &&
        (subject === undefined || subject.test(message.Subject)),
    );
    if (found) {
      const full = (await (
        await fetch(`${stack.mailpitUrl}/api/v1/message/${found.ID}`)
      ).json()) as {
        Text: string;
      };
      return full.Text;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`No email to ${address} arrived`);
}

/** The first link of a given path in an email body. */
export function linkIn(body: string, path: string): string {
  const match = new RegExp(`https?://[^\\s]*${path}[^\\s]*`).exec(body);
  if (!match) throw new Error(`No ${path} link in the email`);
  return match[0];
}

/** The email links point at the organization's host without our dev port; rewrite to the preview. */
export function localLink(link: string): string {
  const url = new URL(link);
  return `http://${url.hostname}:${String(WEB_PORT)}${url.pathname}${url.search}`;
}

/**
 * Waits until every confirmation toast on screen has stopped moving. A toast slides in and its
 * content fades in, and a toast pushed behind a newer one fades its content out: all of it CSS
 * transitions on the toast AND on its children (`[data-sonner-toast] > *`), so the opacity of the
 * toast itself says nothing about the text inside it. Axe reading the colors of a title that is
 * half faded reports a contrast failure that is not there once it settles. A toast counts as
 * settled when it is mounted and none of the animations of its subtree is still running.
 */
export async function settleToasts(page: Page) {
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-sonner-toast]')].every(
      (toast) =>
        toast.getAttribute('data-mounted') === 'true' &&
        toast
          .getAnimations({ subtree: true })
          .every(
            (animation) => animation.playState === 'finished' || animation.playState === 'idle',
          ),
    ),
  );
}

/** Checks WCAG 2.2 AA with axe on the current page and returns the violations. */
export async function axeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map((node) => node.target.join(' ')).slice(0, 4),
  }));
}

/** No horizontal scroll: the page fits the viewport. */
export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}
