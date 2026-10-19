/**
 * Public API of the consent module (informed consent: versioned templates, requests, signatures and
 * revocations). Other modules and the composition root import from here only.
 *
 * Track A2 (S5.02, S5.03 and S5.11). It exports `listConsentsForPatient` (task 5.10) for the portal
 * and for the patient record, which is the only way another module reads a consent.
 */
import type { FastifyInstance } from 'fastify';

import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { TenantKeys } from '../../platform/crypto/tenant-keys.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { JobClient } from '../../platform/jobs/boss.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { exportConsentTemplates, exportSignedConsents } from './application/export-contributor.js';
import { createTemplateService } from './application/templates.js';
import { templateRoutes } from './http/template-routes.js';

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

  return {
    options,
    routes: (app) => {
      templates(app);
    },
  };
}
