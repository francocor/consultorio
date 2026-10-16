import { resolve } from 'node:path';

import type { Page } from '@playwright/test';

import { stack, totpCode, urlOf } from './stack.js';

/** Where the signed-in operator session is kept for the console specs (git-ignored). */
export const OPERATOR_STATE = resolve(import.meta.dirname, '../.stack/operator-state.json');

/** Opens the console on the platform host and signs in with the form, as a person would. */
export async function signInOperator(page: Page): Promise<void> {
  await page.goto(urlOf('platform', '/'));
  await page.getByLabel('Correo electrónico').fill(stack.operator.email);
  await page.getByLabel('Contraseña', { exact: true }).fill(stack.operator.password);
  await page.getByLabel('Código de verificación').fill(totpCode(stack.operator.totpSecret));
  await page.getByRole('button', { name: 'Ingresar' }).click();
}
