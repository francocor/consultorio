import type { RouteCategory } from '@consultorio/contracts';

/**
 * The read-only category of every route of Stage 5 (matricula verification, consent, prescriptions,
 * the patient portal), decided once and written down (tenancy, "Read-only tenant and its allowlist";
 * informed consent, e-prescription and the portal have a read-only requirement each).
 *
 * - `read`: a screen, a list, or the link to a file (the file itself is served and audited by the
 *   door of the files). It keeps working when the organization is read-only.
 * - `patient_protective`: the patient's own protection. A patient can still cancel an appointment,
 *   revoke a consent, and ask for a copy or a rectification of their data in a read-only
 *   organization. These four are the only changes that stay open.
 * - `auth`: signing in and out of the portal, and ending one's own sessions.
 * - `webhook`: the notice of the provider, signed with the secret of the deployment.
 * - `write`: everything else that changes data. A read-only organization is refused with 402.
 *
 * A route of these modules that is not in this table fails `route-categories.test.ts`; that is the
 * point: the person who adds it has to decide, here, whether it may run in a read-only organization.
 * HEAD routes are derived from the GET ones and are not listed.
 */
export const STAGE5_ROUTES: Readonly<Record<string, RouteCategory>> = {
  // Matricula verification (the platform operator's console; only the operator calls them).
  'GET /operator/matricula-queue': 'read',
  'POST /operator/tenants/:tenantId/professionals/:id/matricula/verify': 'write',
  'POST /operator/tenants/:tenantId/professionals/:id/matricula/unverify': 'write',
  'PUT /operator/tenants/:tenantId/professionals/:id/matricula/note': 'write',
  // Consent: templates.
  'GET /consent/starters': 'read',
  'GET /consent/templates': 'read',
  'GET /consent/templates/:id': 'read',
  'GET /consent/offered-templates': 'read',
  'GET /consent/appointment-types': 'read',
  'POST /consent/templates': 'write',
  'PATCH /consent/templates/:id': 'write',
  'POST /consent/templates/:id/publish': 'write',
  'POST /consent/templates/:id/retire': 'write',
  'PUT /consent/appointment-types/:id': 'write',
  // Consent: requests, signatures and revocations (revoking protects the patient).
  'GET /consents/requests/:id': 'read',
  'GET /consents/requests/:id/signing': 'read',
  'GET /consents/requests/:id/document': 'read',
  'GET /patients/:id/consents': 'read',
  'GET /appointments/:id/consent-status': 'read',
  'POST /consents/requests': 'write',
  'POST /consents/requests/:id/sign': 'write',
  'POST /consents/requests/:id/decline': 'write',
  'POST /consents/requests/:id/revoke': 'patient_protective',
  // The consent to process personal data (Stage 1), shown beside the consents of Stage 5.
  'GET /patients/:id/consent': 'read',
  'POST /patients/:id/consent': 'write',
  'POST /patients/:id/consent/revoke': 'patient_protective',
  // Prescriptions.
  'GET /prescriptions': 'read',
  'GET /prescriptions/:id': 'read',
  'GET /prescriptions/capability': 'read',
  'GET /prescriptions/catalog': 'read',
  'GET /prescriptions/connection': 'read',
  'GET /patients/:patientId/prescriptions': 'read',
  'GET /patients/:patientId/prescriptions/existence': 'read',
  'POST /prescriptions': 'write',
  'PUT /prescriptions/:id': 'write',
  'POST /prescriptions/:id/cancel': 'write',
  'POST /prescriptions/:id/retry': 'write',
  'POST /prescriptions/:id/register-manual': 'write',
  'POST /prescriptions/:id/document-link': 'read',
  'PUT /prescriptions/connection': 'write',
  'POST /webhooks/erx': 'webhook',
  // The portal, staff side: invite, link, deactivate and share (permission `portal.manage`).
  'GET /patients/:id/portal': 'read',
  'GET /documents/:id/portal-share': 'read',
  'POST /patients/:id/portal-invitation': 'write',
  'POST /portal-identities/:id/deactivate': 'write',
  'POST /portal-identities/:id/email': 'write',
  'POST /portal-identities/:id/links': 'write',
  'POST /portal-identities/:id/sessions/revoke': 'write',
  'POST /portal-links/:id/authorize': 'write',
  'POST /portal-links/:id/revoke': 'write',
  'POST /documents/:id/portal-share': 'write',
  'DELETE /documents/:id/portal-share': 'write',
  // The portal, public side: asking for a code and registering.
  'POST /public/:slug/portal/otp': 'auth',
  'POST /public/:slug/portal/otp/verify': 'auth',
  'POST /public/:slug/portal/register': 'auth',
  'POST /public/:slug/portal/register/verify': 'auth',
  // The portal, patient side.
  'GET /portal/me': 'read',
  'GET /portal/appointments': 'read',
  'GET /portal/consents': 'read',
  'GET /portal/consents/:id': 'read',
  'GET /portal/documents': 'read',
  'GET /portal/files/:token': 'read',
  'GET /portal/invoices': 'read',
  'GET /portal/prescriptions': 'read',
  'GET /portal/profile': 'read',
  'GET /portal/representatives': 'read',
  'GET /portal/sessions': 'read',
  'POST /portal/subject': 'auth',
  'POST /portal/logout': 'auth',
  'DELETE /portal/sessions/:id': 'auth',
  'POST /portal/consents/:id/download-link': 'read',
  'POST /portal/documents/:id/download-link': 'read',
  'POST /portal/invoices/:id/download-link': 'read',
  'POST /portal/prescriptions/:id/download-link': 'read',
  'POST /portal/appointments/:id/confirm': 'write',
  'POST /portal/appointments/:id/cancel': 'patient_protective',
  'POST /portal/consents/:id/sign': 'write',
  'POST /portal/consents/:id/revoke': 'patient_protective',
  'POST /portal/copy-requests': 'patient_protective',
  'POST /portal/rectification-requests': 'patient_protective',
  'POST /portal/links/:id/authorize': 'write',
  // Ending the access of a representative protects the person, in a read-only organization too.
  'POST /portal/links/:id/revoke': 'patient_protective',
  'PATCH /portal/profile': 'write',
};

/**
 * The routes that are not a GET and are filed as `read`: they hand out the address of a file and
 * change nothing (the download is audited by the door of the files, as `*.downloaded`).
 */
export const LINK_ONLY_ROUTES: readonly string[] = [
  'POST /portal/consents/:id/download-link',
  'POST /portal/documents/:id/download-link',
  'POST /portal/invoices/:id/download-link',
  'POST /portal/prescriptions/:id/download-link',
  'POST /prescriptions/:id/document-link',
];

const EXACT = [
  /^\/consents?(\/|$)/,
  /^\/prescriptions(\/|$)/,
  /^\/portal(\/|-|$)/,
  /^\/public\/:slug\/portal(\/|$)/,
  /^\/webhooks\/erx$/,
  /^\/operator\/matricula-queue$/,
  /^\/operator\/tenants\/:tenantId\/professionals\/:id\/matricula(\/|$)/,
  /^\/patients\/:(id|patientId)\/(consents?|portal|prescriptions)(\/|$)/,
  /^\/appointments\/:id\/consent-status$/,
  /^\/documents\/:id\/portal-share$/,
];

/** True for a route key ("METHOD /url") that belongs to Stage 5. */
export function isStage5Route(key: string): boolean {
  const path = key.slice(key.indexOf(' ') + 1);
  return EXACT.some((pattern) => pattern.test(path));
}

function methodOf(key: string): string {
  return key.slice(0, key.indexOf(' '));
}

/**
 * What is wrong with the Stage 5 routes the application registered, in this order: routes missing
 * from the table, routes of the table that are not registered, routes filed in another category
 * than the table says, and routes that change data but sit in the `read` category (a read-only
 * organization could call them), except the ones that only hand out a link.
 */
export function findStage5RouteProblems(registered: ReadonlyMap<string, RouteCategory>): string[] {
  const unknown: string[] = [];
  const missing: string[] = [];
  const wrong: string[] = [];
  const writesFiledAsReads: string[] = [];

  for (const [key, category] of registered) {
    if (!isStage5Route(key)) continue;
    const method = methodOf(key);
    if (method === 'HEAD') {
      if (category !== 'read') {
        wrong.push(`${key} is filed as "${category}" but a HEAD request only reads`);
      }
      continue;
    }
    const expected = STAGE5_ROUTES[key];
    if (expected === undefined) {
      unknown.push(`${key} is registered but not in the table of Stage 5 routes`);
    } else if (expected !== category) {
      wrong.push(`${key} is filed as "${category}" but the table says "${expected}"`);
    }
    if (method !== 'GET' && category === 'read' && !LINK_ONLY_ROUTES.includes(key)) {
      writesFiledAsReads.push(
        `${key} changes data and is filed as "read", which a read-only organization may call`,
      );
    }
  }
  for (const key of Object.keys(STAGE5_ROUTES)) {
    if (!registered.has(key)) missing.push(`${key} is in the table but not registered`);
  }
  return [...unknown, ...missing, ...wrong, ...writesFiledAsReads];
}
