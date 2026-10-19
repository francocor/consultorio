/**
 * Public API of the portal module (the patient portal: identities, links, sign-in by emailed code,
 * read models and downloads). Other modules and the composition root import from here only.
 *
 * The module owns no clinical table: it reads consents, prescriptions, invoices and documents only
 * through the `index.ts` of the module that owns them, as the `PortalActor` of the session.
 */
import type { FastifyInstance } from 'fastify';

import type { AdapterResolver } from '../../main/adapter-resolver.js';
import type { PortalActor } from '../../platform/authz/actor.js';
import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { TenantKeys } from '../../platform/crypto/tenant-keys.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import { SYSTEM_USER_ID } from '../../platform/db/tenant-context.js';
import type { AppointmentEvents } from '../../platform/events/appointment-events.js';
import type { FileResourceRegistry } from '../../platform/files/file-resources.js';
import { registerPortalGuard } from '../../platform/http/portal-guard.js';
import type { PublicOrigins } from '../../platform/http/public-origin.js';
import type { RateLimitStore } from '../../platform/http/rate-limit.js';
import type { JobClient } from '../../platform/jobs/boss.js';
import type { EmailSender } from '../../platform/mail/email-sender.js';
import { registerTokenHandler } from '../../platform/public/token-router.js';
import type { ObjectStorage } from '../../platform/storage/object-storage.js';
import { createActionTokens } from '../../platform/tokens/index.js';
import type { VideoJoinRegistry } from '../notifications/index.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { createActivationHandler } from './application/activation-handler.js';
import { PORTAL_CODE_JOB } from './application/codes.js';
import { majorityAgeOf } from './application/country.js';
import { createPortalFileResource } from './application/downloads.js';
import { exportPortal } from './application/export-contributor.js';
import type { IdentityDeps } from './application/identities.js';
import type { PortalConsentPort, PortalPrescriptionPort } from './application/ports.js';
import { createPortalSessions } from './application/sessions.js';
import type { SignInDeps } from './application/sign-in.js';
import { createWithPortalSubject } from './application/subject.js';
import { documentRoutes } from './http/document-routes.js';
import { downloadRoutes } from './http/download-routes.js';
import { portalRoutes } from './http/portal-routes.js';
import { publicRoutes } from './http/public-routes.js';
import { sectionRoutes } from './http/section-routes.js';
import { sessionRoutes } from './http/session-routes.js';
import { staffRoutes } from './http/staff-routes.js';

export { createPortalCodeSendJob } from './application/code-job.js';
export { createMajorityReviewJob, MAJORITY_REVIEW_JOB } from './application/majority-job.js';
// The notices of the portal, rendered. The consent module sends "you have a document to sign" with
// `renderPortalNoticeEmail({ kind: 'consent_request' })`: email only, no title, a link to the portal.
export {
  renderPortalCodeEmail,
  renderPortalInvitationEmail,
  renderPortalNoticeEmail,
  renderPortalRequestNoticeEmail,
} from './application/mail.js';
export type { PortalNoticeKind } from './application/mail.js';
export { PORTAL_CODE_JOB };
export type {
  PortalCall,
  PortalConsentPort,
  PortalFile,
  PortalPrescriptionPort,
  PortalRenderedFile,
  PortalStoredFile,
} from './application/ports.js';
export { adaptConsentModule } from './application/consent-adapter.js';
export type { ConsentModulePortal } from './application/consent-adapter.js';
export { adaptPrescriptionModule } from './application/prescription-adapter.js';
export type { PrescriptionModulePortal } from './application/prescription-adapter.js';
export type { PortalSubject } from './application/subject.js';

/** Registers what the portal takes with an organization that leaves: identities and links. */
export function registerPortalExportContributors(registry: ExportRegistry): void {
  registry.registerExportContributor('administrative', 'portal', exportPortal);
}

export interface PortalOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  keys: TenantKeys;
  /** Sends the activation links and the sign-in codes (through the channel policy: email only). */
  email: EmailSender;
  /** Where emailed links point (never the Host header of a request). */
  origins: PublicOrigins;
  /** The counters of the sign-in throttles. */
  rateLimitStore: RateLimitStore;
  /** Queues the codes and the majority review. Absent when no module needs the queue. */
  jobs?: JobClient | undefined;
  adapters?: AdapterResolver | undefined;
  /**
   * What the portal's own door to files serves (patient downloads). It is not the staff registry:
   * its resources take the `PortalActor` of the session and authorize the subject again.
   */
  portalFileResources: FileResourceRegistry<PortalActor>;
  /** What scheduling publishes: a cancellation by the patient frees the slot and reaches the waitlist. */
  appointmentEvents?: AppointmentEvents | undefined;
  /** The address of a video appointment, from teleconsultation (through notifications' registry). */
  videoJoin?: VideoJoinRegistry['resolver'] | undefined;
  /** Where the files are. Absent when no bucket is configured: the downloads answer "unavailable". */
  storage?: ObjectStorage | undefined;
  /**
   * The consent module's door for the portal: list, read the text, sign, revoke and the signed
   * document. Absent until the integrator wires it (`main/wiring/portal.ts`): the section is then an
   * empty state.
   */
  consent?: PortalConsentPort | undefined;
  /** The e-prescription module's door for the portal: the issued prescriptions and their document. */
  prescriptions?: PortalPrescriptionPort | undefined;
  clock?: () => Date;
}

export interface Portal {
  /** What the module was built with; the track builds its services from it. */
  readonly options: PortalOptions;
  /** The HTTP routes of the module. */
  routes: (app: FastifyInstance) => void;
}

export function createPortal(options: PortalOptions): Portal {
  const clock = options.clock ?? (() => new Date());
  const tokens = createActionTokens({ clock });
  const identities: IdentityDeps = {
    tokens,
    sessions: createPortalSessions(),
    clock,
    majorityAge: majorityAgeOf,
  };
  registerTokenHandler(
    'portal_activation',
    createActivationHandler({ ...identities, origins: options.origins }),
  );
  const signIn: SignInDeps = {
    sessions: identities.sessions,
    tokens,
    jobs: options.jobs,
    store: options.rateLimitStore,
    clock,
    majorityAge: majorityAgeOf,
  };
  // Whether the deployment serves over https is one fact for all organizations: the cookie has the
  // same name everywhere.
  const cookieSecure = options.origins('probe').startsWith('https:');

  const staff = staffRoutes({
    withTenant: options.withTenant,
    identities,
    email: options.email,
    origins: options.origins,
  });
  const pages = publicRoutes({
    withTenant: options.withTenant,
    adapters: options.adapters,
    origins: options.origins,
    signIn,
  });
  const shares = documentRoutes({
    withTenant: options.withTenant,
    auditDeny: options.auditDeny,
    email: options.email,
    origins: options.origins,
    clock,
  });
  const withPortalSubject = createWithPortalSubject(options.withTenant, clock);
  const portal = portalRoutes({
    withTenant: options.withTenant,
    withPortalSubject,
    sessions: identities.sessions,
    auditDeny: options.auditDeny,
    identities,
    appointments: {
      keys: options.keys,
      events: options.appointmentEvents,
      videoJoin: options.videoJoin,
      clock,
    },
    capabilities: () => ({
      consents: options.consent !== undefined,
      prescriptions: options.prescriptions !== undefined,
    }),
  });
  // The portal's door to files: ONE resource for the kind `document_download`, which dispatches on
  // what the link was issued for (a shared document, an invoice, a prescription, a consent).
  const downloads = {
    tokens,
    consent: options.consent,
    prescriptions: options.prescriptions,
    clock,
  };
  options.portalFileResources.register(createPortalFileResource(downloads));
  const files = downloadRoutes({
    withTenant: options.withTenant,
    withPortalSubject,
    auditDeny: options.auditDeny,
    downloads,
    registry: options.portalFileResources,
    storage: options.storage,
  });
  const sections = sectionRoutes({
    withPortalSubject,
    auditDeny: options.auditDeny,
    clock,
    email: options.email,
    origins: options.origins,
    consent: options.consent,
    prescriptions: options.prescriptions,
  });
  const sessions = sessionRoutes({
    withTenant: options.withTenant,
    sessions: identities.sessions,
    clock,
    cookieSecure,
  });

  return {
    options,
    routes: (app) => {
      // The guard of the portal routes lives in this scope only; the staff routes next to them are
      // left to the staff guard.
      registerPortalGuard(app, {
        cookieSecure,
        auditDeny: options.auditDeny,
        authenticate: (token, tenantId) =>
          options.withTenant({ tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
            const resolved = await identities.sessions.resolve(tx, token, clock());
            return resolved === null
              ? null
              : {
                  sessionId: resolved.sessionId,
                  identityId: resolved.identityId,
                  tenantId: resolved.tenantId,
                  linkId: resolved.linkId,
                };
          }),
      });
      staff(app);
      shares(app);
      pages(app);
      sessions(app);
      portal(app);
      sections(app);
      files(app);
    },
  };
}
