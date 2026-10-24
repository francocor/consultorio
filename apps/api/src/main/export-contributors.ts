import { registerAccessExportContributors } from '../modules/access/index.js';
import { registerAuditExportContributors } from '../modules/audit/index.js';
import { registerBillingExportContributors } from '../modules/billing/index.js';
import { registerClinicalExportContributors } from '../modules/clinical/index.js';
import { registerConsentExportContributors } from '../modules/consent/index.js';
import { registerDocumentsExportContributors } from '../modules/documents/index.js';
import { registerIdentityExportContributors } from '../modules/identity/index.js';
import { registerInvoicingExportContributors } from '../modules/invoicing/index.js';
import { registerNotificationsExportContributors } from '../modules/notifications/index.js';
import { registerOnboardingExportContributors } from '../modules/onboarding/index.js';
import { registerOnlineBookingExportContributors } from '../modules/online-booking/index.js';
import { registerPatientsExportContributors } from '../modules/patients/index.js';
import { registerPortalExportContributors } from '../modules/portal/index.js';
import { registerPrescriptionsExportContributors } from '../modules/prescriptions/index.js';
import { registerReportsExportContributors } from '../modules/reports/index.js';
import { registerSchedulingExportContributors } from '../modules/scheduling/index.js';
import { registerStaffExportContributors } from '../modules/staff/index.js';
import { registerTeleconsultationExportContributors } from '../modules/teleconsultation/index.js';
import {
  registerTenancyExportContributors,
  type ExportRegistry,
} from '../modules/tenancy/index.js';
import { registerWaitlistExportContributors } from '../modules/waitlist/index.js';
import type { TenantKeys } from '../platform/crypto/tenant-keys.js';

/**
 * Composition root for the export registry: every module that owns exportable data registers its
 * contributor here. `export-registry.test.ts` fails when a directory under `modules/` is missing.
 */
export function registerAllExportContributors(
  registry: ExportRegistry,
  deps: { keys?: TenantKeys } = {},
): void {
  registerTenancyExportContributors(registry);
  registerIdentityExportContributors(registry);
  registerAccessExportContributors(registry);
  registerStaffExportContributors(registry);
  registerPatientsExportContributors(registry);
  registerSchedulingExportContributors(registry);
  registerDocumentsExportContributors(registry);
  registerOnboardingExportContributors(registry);
  registerAuditExportContributors(registry);
  registerClinicalExportContributors(registry, deps);
  registerNotificationsExportContributors(registry);
  registerOnlineBookingExportContributors(registry);
  registerWaitlistExportContributors(registry);
  registerTeleconsultationExportContributors(registry);
  registerBillingExportContributors(registry);
  registerInvoicingExportContributors(registry);
  registerReportsExportContributors(registry);
  registerConsentExportContributors(registry, deps);
  registerPrescriptionsExportContributors(registry, deps);
  registerPortalExportContributors(registry);
}
