import type { Writable } from 'node:stream';

import { fail } from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';

import {
  createAccess,
  createGrants,
  createGrantsRepo,
  createLocationService,
} from '../modules/access/index.js';
import { createAudit } from '../modules/audit/index.js';
import { createClinical, type AppointmentLookup } from '../modules/clinical/index.js';
import { createDocuments } from '../modules/documents/index.js';
import type { LockoutPolicy } from '../modules/identity/application/lockout.js';
import type { PasswordValidator } from '../modules/identity/domain/password-policy.js';
import { createIdentity, type PasswordHasher } from '../modules/identity/index.js';
import { createVideoJoinRegistry } from '../modules/notifications/index.js';
import {
  createOnboarding,
  createWizardGate,
  type Capabilities,
} from '../modules/onboarding/index.js';
import {
  createOperatorConsole,
  type DemoResetPort,
  type OperatorSecrets,
} from '../modules/operator/index.js';
import { createPatients } from '../modules/patients/index.js';
import {
  createAppointmentTypeService,
  createScheduling,
  findCareSourceAppointment,
} from '../modules/scheduling/index.js';
import {
  createHoursService,
  createOwnerProfessionalService,
  createProfileService,
  createStaff,
  type MatriculaRules,
} from '../modules/staff/index.js';
import {
  createBranding,
  createSupportAccess,
  createTenantLookup,
  type DeploymentSettings,
} from '../modules/tenancy/index.js';
import { createAuditDeny } from '../platform/audit/deny.js';
import type { PortalActor } from '../platform/authz/actor.js';
import { createActorLoader } from '../platform/authz/guard.js';
import {
  type MatriculaValidator,
  type ProfessionalRepo,
} from '../platform/authz/professional-gate.js';
import { createCatalogReader } from '../platform/country/catalog-reader.js';
import { getCountryPack } from '../platform/country/country-pack.js';
import type { TenantKeys } from '../platform/crypto/tenant-keys.js';
import type { Db, DbHandle } from '../platform/db/pool.js';
import { createWithTenant } from '../platform/db/tenant-context.js';
import {
  createAppointmentEvents,
  type AppointmentEvents,
} from '../platform/events/appointment-events.js';
import { createFileResourceRegistry } from '../platform/files/file-resources.js';
import { fileRoutes } from '../platform/files/file-routes.js';
import type { HealthDeps } from '../platform/http/health.js';
import { createPublicOrigins } from '../platform/http/public-origin.js';
import { createMemoryRateLimitStore, type RateLimit } from '../platform/http/rate-limit.js';
import type { JobClient } from '../platform/jobs/boss.js';
import { createDevRoutes, type DevProvider } from '../platform/local-providers/dev-routes.js';
import type { EmailSender } from '../platform/mail/email-sender.js';
import { resetTokenHandlers } from '../platform/public/token-router.js';
import { createSettingsSectionRegistry } from '../platform/settings-sections.js';
import type { ObjectStorage } from '../platform/storage/object-storage.js';

import type { AdapterResolver } from './adapter-resolver.js';
import { buildServer, type FeatureRoutes } from './server.js';
import type { TrustProxySetting } from './trust-proxy.js';
import type { ModuleWiring } from './wiring/types.js';

export interface ApplicationOptions {
  /** The runtime database (connects as `app_rw`). */
  database: Pick<DbHandle, 'db'>;
  health: HealthDeps;
  deployment: DeploymentSettings;
  logLevel?: string;
  logStream?: Writable;
  trustProxy: TrustProxySetting;
  cookieSecure: boolean;
  /**
   * Single mode only (required there): the origin the deployment is served from, such as
   * `https://agenda.clinica.example`. Emailed links are built from it. Multi mode builds them from
   * the base domain and the organization's slug, so it ignores this.
   */
  publicUrl?: string;
  /** Multi mode, development only: the port of the web app in emailed links. */
  publicPort?: number;
  /** Per-tenant data keys: second-factor secrets are stored encrypted with them. */
  keys: TenantKeys;
  email: EmailSender;
  passwordValidator: PasswordValidator;
  /** Replaceable in tests; production uses the system clock. */
  clock?: () => Date;
  /**
   * The clock of scheduling alone (tests move it to just after an appointment starts without ending
   * the sessions, which run on `clock`). Defaults to `clock`.
   */
  schedulingClock?: () => Date;
  hasher?: PasswordHasher;
  lockout?: LockoutPolicy;
  /** Request limits; defaults protect a single instance. Tests raise them. */
  limits?: Partial<RequestLimits>;
  /** Professional profiles for the clinical gate. The staff module provides them (S1.19). */
  professionals?: ProfessionalRepo;
  /**
   * Object storage (logos, later documents). Absent when no bucket is configured: the features
   * that need it then answer "unavailable" instead of failing at startup.
   */
  storage?: ObjectStorage;
  /**
   * Enqueues background jobs from a request (the scan of an uploaded document). Absent in a
   * deployment without them: the features that need a job then answer "unavailable".
   */
  jobs?: JobClient;
  /**
   * The platform operator console. Absent when no operator database is configured (and always
   * absent in single-tenant mode, which has no platform host): `/operator/*` is then a 404.
   */
  operator?: {
    /** The connection of the `app_operator` role. */
    database: Pick<DbHandle, 'db'>;
    secrets: OperatorSecrets;
    /** The privileged reset of a demo organization; the demo module provides it. */
    demoReset?: DemoResetPort;
  };
  /** Clinical records: only a test lowers the search cap (default 2,000 entries). */
  clinical?: {
    searchCap?: number;
    /** Replaces the agenda lookup that checks the appointment an encounter is opened from (tests only). */
    appointments?: AppointmentLookup;
    /** The per-user allowance of the record search (default 30 a minute). */
    searchRateLimit?: RateLimit;
  };
  /**
   * The parts of the product this deployment has. The guided first run shows only the wizard steps
   * and checklist items of those. Defaults to patients, scheduling and branding (Stage 2).
   */
  onboardingCapabilities?: Capabilities;
  /** Routes of the capability modules, registered after identity. */
  modules?: readonly FeatureRoutes[];
  /**
   * The capability modules of the patient-engagement stages (`main/wiring`). `main` and the test
   * application pass the same list. Each module is built with the shared services and returns its
   * routes; it subscribes to the appointment events when it is built.
   */
  wiring?: readonly ModuleWiring[];
  /** Which adapter serves which organization. Modules resolve their providers through it. */
  adapters?: AdapterResolver;
  /**
   * The provider console (`LOCAL_PROVIDERS_CONSOLE`): with `console: false` no `/operator/dev`
   * route exists. It lives inside the operator console, so it needs one.
   */
  localProviders?: {
    console: boolean;
    providers: readonly DevProvider[];
    /** Which providers run on a simulator; the public boot payload tells the app. */
    simulated?: { afip: boolean; erx?: boolean };
  };
  /**
   * The appointment event bus. Defaults to a new one per application; a test passes its own to
   * listen to what scheduling publishes.
   */
  appointmentEvents?: AppointmentEvents;
}

export interface RequestLimits {
  perClient: RateLimit;
  perTenant: RateLimit;
  /** Sign-in attempts per client address and tenant. */
  login: { max: number; timeWindow: number };
}

const DEFAULT_LIMITS: RequestLimits = {
  perClient: { max: 300, windowMs: 60_000 },
  perTenant: { max: 6000, windowMs: 60_000 },
  login: { max: 20, timeWindow: 60_000 },
};

/**
 * Wires the application: the tenant host guard, authentication and the routes of every
 * capability that exists in all deployments. `main` and the integration tests both build the
 * server here, so a test exercises exactly the composition that production runs, and
 * authentication cannot be left out of it.
 */
export function createApplication(options: ApplicationOptions): FastifyInstance {
  const db: Db = options.database.db;
  // The server exists only after this function builds it, but a denial that cannot be recorded
  // must be reported through its logger.
  const built: { server?: FastifyInstance } = {};
  const limits: RequestLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const withTenant = createWithTenant(db);
  const rateLimitStore = createMemoryRateLimitStore();

  // Grants are read fresh on every request, so a revocation takes effect with the next call.
  const grants = createGrants();
  const grantsRepo = createGrantsRepo(withTenant, grants);

  // Every emailed link comes from here: configuration, never the Host header of a request.
  const origins = createPublicOrigins(options.deployment, {
    secure: options.cookieSecure,
    ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
    ...(options.publicPort === undefined ? {} : { port: options.publicPort }),
  });

  const wizardGate = createWizardGate();
  const identity = createIdentity({
    withTenant,
    grants: grantsRepo,
    needsWizard: wizardGate.needsWizard,
    keys: options.keys,
    email: options.email,
    passwordValidator: options.passwordValidator,
    rateLimitStore,
    cookieSecure: options.cookieSecure,
    origins,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.hasher ? { hasher: options.hasher } : {}),
    ...(options.lockout ? { lockout: options.lockout } : {}),
    loginRateLimit: limits.login,
  });

  // Format check of the matricula comes from the country pack. Only Argentina exists today; with
  // a second country the validator is chosen by the tenant's country.
  const pack = getCountryPack('AR', createCatalogReader(db));
  const validateMatricula: MatriculaValidator = (jurisdiction, value) =>
    pack.ok && pack.value.validateMatricula(jurisdiction, value).ok;
  const auditDeny = createAuditDeny({
    db,
    alert: (alert) => {
      built.server?.log.error(
        { alert: alert.kind, action: alert.action, code: alert.errorCode },
        'an access denial could not be recorded in the audit log',
      );
    },
  });

  const matriculaRules: MatriculaRules = (country, jurisdiction, value) => {
    const found = getCountryPack(country, createCatalogReader(db));
    return found.ok
      ? found.value.validateMatricula(jurisdiction, value)
      : fail('errors.unsupported_country');
  };
  const countryTimeZone = (country: string) => {
    const found = getCountryPack(country, createCatalogReader(db));
    return found.ok
      ? found.value.defaults.timeZone
      : pack.ok
        ? pack.value.defaults.timeZone
        : 'UTC';
  };

  // The sections of the organization settings that the modules own: registered once, here.
  const settingsSections = createSettingsSectionRegistry();
  for (const wiring of options.wiring ?? []) {
    for (const section of wiring.settingsSections ?? []) settingsSections.register(section);
  }

  const access = createAccess({
    withTenant,
    auditDeny,
    sessions: identity.sessions,
    grants,
    defaultTimeZone: countryTimeZone,
    settingsSections,
    email: options.email,
    origins,
  });

  const staff = createStaff({
    withTenant,
    auditDeny,
    invitations: identity.invitations,
    sessions: identity.sessions,
    email: options.email,
    origins,
    matriculaRules,
  });

  const patients = createPatients({
    withTenant,
    auditDeny,
    ...(options.clock ? { clock: options.clock } : {}),
    keys: options.keys,
    consentText: (country) => {
      const found = getCountryPack(country, createCatalogReader(db));
      const consent = found.ok ? found.value.personalData.dataProcessingConsent : undefined;
      return {
        textKey: consent?.textKey ?? 'consent.data_processing',
        version: consent?.version ?? '1',
      };
    },
    majorityAge: (country) => {
      const found = getCountryPack(country, createCatalogReader(db));
      return found.ok ? found.value.majorityAge : 18;
    },
    documents: (country, type, value) => {
      const found = getCountryPack(country, createCatalogReader(db));
      return found.ok
        ? found.value.validateDocument(type, value)
        : fail('errors.unsupported_country');
    },
  });

  const appointmentEvents = options.appointmentEvents ?? createAppointmentEvents();
  const schedulingClock = options.schedulingClock ?? options.clock;
  const scheduling = createScheduling({
    withTenant,
    auditDeny,
    keys: options.keys,
    events: appointmentEvents,
    ...(schedulingClock ? { clock: schedulingClock } : {}),
  });

  // What `/files/:token` serves: documents register their kind here, and so does any module that
  // hands out a file (billing exports, invoice PDFs). One registry per application.
  const fileResources = createFileResourceRegistry();
  // The portal's own door to files (Stage 5): a registry apart, with the portal actor.
  const portalFileResources = createFileResourceRegistry<PortalActor>();
  const documents = createDocuments({
    withTenant,
    auditDeny,
    storage: options.storage,
    jobs: options.jobs,
    fileResources,
    ...(options.clock ? { clock: options.clock } : {}),
  });

  const clinical = createClinical({
    withTenant,
    auditDeny,
    keys: options.keys,
    ...(options.clinical?.searchCap === undefined ? {} : { searchCap: options.clinical.searchCap }),
    // The agenda is part of every deployment: an encounter names a real appointment (D20).
    appointments: options.clinical?.appointments ?? findCareSourceAppointment,
    rateLimit: {
      store: rateLimitStore,
      ...(options.clinical?.searchRateLimit ? { search: options.clinical.searchRateLimit } : {}),
    },
  });

  const onboarding = createOnboarding({
    withTenant,
    auditDeny,
    ...(options.onboardingCapabilities ? { capabilities: options.onboardingCapabilities } : {}),
    locations: createLocationService(),
    hours: createHoursService(options.clock ? { clock: options.clock } : {}),
    ownerProfessional: createOwnerProfessionalService({
      profiles: createProfileService({ rules: matriculaRules }),
    }),
    types: createAppointmentTypeService(),
    defaultTimeZone: countryTimeZone,
    ...(options.clock ? { clock: options.clock } : {}),
  });

  // The links' registry belongs to one application: it starts empty, so a capability that claims
  // a kind another one already took fails here instead of silently replacing it.
  resetTokenHandlers();
  const videoJoin = createVideoJoinRegistry();
  const wired = (options.wiring ?? []).map((wiring) =>
    wiring.create({
      withTenant,
      auditDeny,
      keys: options.keys,
      email: options.email,
      origins,
      rateLimitStore,
      appointmentEvents,
      worklist: scheduling.worklist,
      videoJoin,
      fileResources,
      portalFileResources,
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.storage ? { storage: options.storage } : {}),
      ...(options.jobs ? { jobs: options.jobs } : {}),
      ...(options.adapters ? { adapters: options.adapters } : {}),
    }),
  );

  const auditViewer = createAudit({ withTenant });
  const supportAccess = createSupportAccess({ withTenant });
  const devRoutes = createDevRoutes({
    enabled: options.localProviders?.console ?? false,
    providers: options.localProviders?.providers ?? [],
  });
  const operatorConsole =
    options.operator && options.deployment.mode === 'multi'
      ? createOperatorConsole({
          db: options.operator.database.db,
          secrets: options.operator.secrets,
          keys: options.keys,
          hasher: identity.hasher,
          email: options.email,
          origins,
          secureLinks: options.cookieSecure,
          loginRateLimit: limits.login,
          ...(options.operator.demoReset ? { demoReset: options.operator.demoReset } : {}),
          ...(devRoutes ? { extensions: [devRoutes] } : {}),
          ...(options.clock ? { clock: options.clock } : {}),
        })
      : undefined;
  const branding = createBranding({
    withTenant,
    auditDeny,
    storage: options.storage,
    boot: {
      deploymentMode: options.deployment.mode,
      localProviders: options.localProviders?.simulated ?? { afip: false },
      locale: (country) => {
        const found = getCountryPack(country, createCatalogReader(db));
        return found.ok ? found.value.defaults.locale : 'es-AR';
      },
    },
  });

  const server = buildServer({
    ...(options.logLevel === undefined ? {} : { logLevel: options.logLevel }),
    ...(options.logStream ? { logStream: options.logStream } : {}),
    health: options.health,
    deployment: options.deployment,
    trustProxy: options.trustProxy,
    rateLimit: {
      store: rateLimitStore,
      perClient: limits.perClient,
      perTenant: limits.perTenant,
    },
    lookupTenant: createTenantLookup(db),
    auth: {
      authenticate: identity.authenticate,
      cookieSecure: options.cookieSecure,
      authz: {
        loadActor: createActorLoader({
          professionals: options.professionals ?? staff.professionals,
          grants: grantsRepo,
          validateMatricula,
        }),
        auditDeny,
      },
    },
    routes: [
      identity.routes,
      access.routes,
      staff.routes,
      patients.routes,
      scheduling.routes,
      documents.routes,
      clinical.routes,
      onboarding.routes,
      auditViewer.routes,
      branding.routes,
      supportAccess.routes,
      ...(operatorConsole ? [operatorConsole.routes] : []),
      ...wired.flatMap((module) => (module.routes ? [module.routes] : [])),
      ...(options.modules ?? []),
      // Last: the door declares the audit actions of every resource the modules registered.
      fileRoutes({
        registry: fileResources,
        withTenant,
        auditDeny,
        storage: options.storage,
      }),
    ],
  });
  built.server = server;
  return server;
}
