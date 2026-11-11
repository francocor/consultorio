/**
 * Public API of the consent module (informed consent: versioned templates, requests, signatures and
 * revocations). Other modules and the composition root import from here only.
 *
 * Track A2 (S5.02, S5.03 and S5.11). What the portal and the patient record use, and the only way
 * another module reads a consent (docs/stage5-tracks.md):
 *
 * - `listConsentsForPatient(tx, { actor, patientId })`: the consents of a patient for staff or for
 *   a `PortalActor`, with the label rules of the role applied inside.
 * - `hasValidConsent(tx, patientId, templateId)` and `consentStateFor`: where a patient stands with
 *   a template (the warning on appointments).
 * - `createConsentPortal({ keys, clock })`: the portal entry points that take a `PortalActor` to list,
 *   open the text, sign, revoke and render the signed record as a PDF.
 */
import type { FastifyInstance } from 'fastify';

import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { TenantKeys } from '../../platform/crypto/tenant-keys.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { PublicOrigins } from '../../platform/http/public-origin.js';
import type { JobClient } from '../../platform/jobs/boss.js';
import type { EmailSender } from '../../platform/mail/email-sender.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { createAppointmentConsentService } from './application/appointment-consent.js';
import { exportConsentTemplates, exportSignedConsents } from './application/export-contributor.js';
import { createConsentNotice } from './application/notice.js';
import { createRequestService } from './application/request-consent.js';
import { createRevocationService } from './application/revoke-consent.js';
import { createSigningService } from './application/sign-consent.js';
import { createTemplateService } from './application/templates.js';
import { patientRoutes } from './http/patient-routes.js';
import { requestRoutes } from './http/request-routes.js';
import { templateRoutes } from './http/template-routes.js';

export {
  consentStateFor,
  hasValidConsent,
  listConsentsForPatient,
} from './application/read-model.js';
export type { ConsentReader, ConsentTemplateState } from './application/read-model.js';
export { createConsentPortal } from './application/portal.js';
export type { ConsentPortal } from './application/portal.js';
export type { SignedDocument } from './application/documents.js';
export { CONSENT_EXPIRE_JOB, createConsentExpireJob } from './application/expire-job.js';

/**
 * Registers what consent takes with an organization that leaves: the templates for the owner, and
 * the signed consents of each professional's patients.
 */
export function registerConsentExportContributors(
  registry: ExportRegistry,
  deps: { keys?: TenantKeys } = {},
): void {
  registry.registerExportContributor('administrative', 'consent', exportConsentTemplates);
  registry.registerExportContributor('clinical', 'consent', exportSignedConsents(deps.keys));
}

export interface ConsentOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  keys: TenantKeys;
  /** Sends the notice that a consent waits for a signature in the portal. */
  email: EmailSender;
  /** Where the emailed links point (never the Host header of a request). */
  origins: PublicOrigins;
  /** Queues the expiry of the requests nobody signed. Absent when no module needs the queue. */
  jobs?: JobClient | undefined;
  clock?: () => Date;
}

export interface Consent {
  /** What the module was built with; the track builds its services from it. */
  readonly options: ConsentOptions;
  /** The HTTP routes of the module. */
  routes: (app: FastifyInstance) => void;
}

export function createConsent(options: ConsentOptions): Consent {
  const clock = options.clock ?? (() => new Date());
  const common = { withTenant: options.withTenant, auditDeny: options.auditDeny };
  const templates = templateRoutes({ ...common, templates: createTemplateService({ clock }) });
  const patients = patientRoutes({ ...common, clock });
  const requests = requestRoutes({
    ...common,
    keys: options.keys,
    clock,
    requests: createRequestService({ clock }),
    signing: createSigningService({ keys: options.keys, clock }),
    revocation: createRevocationService({ keys: options.keys, clock }),
    appointments: createAppointmentConsentService(),
    notice: createConsentNotice({
      withTenant: options.withTenant,
      email: options.email,
      origins: options.origins,
    }),
  });

  return {
    options,
    routes: (app) => {
      templates(app);
      patients(app);
      requests(app);
    },
  };
}
