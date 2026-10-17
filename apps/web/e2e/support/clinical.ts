import { expect, type Page } from '@playwright/test';

import { originOf, urlOf, type Organization } from './stack.js';

/** The patient id behind a demo document number (the list API of the signed-in session). */
export async function patientIdByDocument(
  page: Page,
  documentNumber: string,
  organization: Organization = 'aillu',
): Promise<string> {
  const response = await page.request.get(urlOf(organization, '/api/patients'), {
    params: { q: documentNumber },
  });
  expect(response.ok(), 'patient search').toBe(true);
  const body = (await response.json()) as { patients: { id: string }[] };
  const first = body.patients[0];
  if (!first) throw new Error(`No demo patient with document ${documentNumber}`);
  return first.id;
}

/**
 * A call to the API with the browser's own session (same origin, as the web app makes it). `T` is
 * the shape the caller expects of the body; the specs check the values they read.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export async function apiCall<T = unknown>(
  page: Page,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  data?: unknown,
  organization: Organization = 'aillu',
): Promise<{ status: number; body: T }> {
  const response = await page.request.fetch(urlOf(organization, `/api${path}`), {
    method,
    headers: { origin: originOf(organization) },
    ...(data === undefined ? {} : { data }),
  });
  const text = await response.text();
  return { status: response.status(), body: (text ? JSON.parse(text) : undefined) as T };
}

/** A signed general note on a patient, written through the API as the signed-in professional. */
export async function signedNoteVia(
  page: Page,
  patientId: string,
  content: Record<string, unknown>,
): Promise<{ id: string; encounterId: string }> {
  const opened = await apiCall<{ id: string; encounterId: string }>(page, 'POST', '/encounters', {
    patientId,
    templateKind: 'general',
  });
  expect(opened.status).toBe(201);
  const saved = await apiCall(page, 'PUT', `/encounters/${opened.body.encounterId}/note/draft`, {
    content,
    baseRevision: 0,
  });
  expect(saved.status).toBe(200);
  const signed = await apiCall(page, 'POST', `/notes/${opened.body.id}/sign`, {
    expectedRevision: 1,
  });
  expect(signed.status).toBe(200);
  return opened.body;
}
