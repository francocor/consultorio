import type { FastifyInstance } from 'fastify';

import type {
  PasswordHasher,
  PasswordValidator,
  SessionService,
} from '../../modules/identity/index.js';
import type { VideoJoinRegistry } from '../../modules/notifications/index.js';
import type { OperatorRun } from '../../modules/operator/index.js';
import type { WorklistService } from '../../modules/scheduling/index.js';
import type { TenantCancelledPort, TenantLifecycle } from '../../modules/tenancy/index.js';
import type { PortalActor } from '../../platform/authz/actor.js';
import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { TenantKeys } from '../../platform/crypto/tenant-keys.js';
import type { Db } from '../../platform/db/pool.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { AppointmentEvents } from '../../platform/events/appointment-events.js';
import type { FeatureKey } from '../../platform/features.js';
import type { FileResourceRegistry } from '../../platform/files/file-resources.js';
import type { PublicOrigins } from '../../platform/http/public-origin.js';
import type { RateLimitStore } from '../../platform/http/rate-limit.js';
import type { JobClient } from '../../platform/jobs/boss.js';
import type { WorkerOptions } from '../../platform/jobs/worker.js';
import type { DevProvider } from '../../platform/local-providers/dev-routes.js';
import type { EmailSender } from '../../platform/mail/email-sender.js';
import type { SettingsSection } from '../../platform/settings-sections.js';
import type { ObjectStorage } from '../../platform/storage/object-storage.js';
import type { AdapterRegistry, AdapterResolver } from '../adapter-resolver.js';
import type { Config } from '../config.js';
import type { FeatureRoutes } from '../server.js';

/**
 * The composition root's contract with a capability module. Every shared registration a module
 * needs (its adapters, its routes, its subscriptions to the event bus, its worker jobs, its
 * sections of the organization settings) is declared in ONE file per module, `main/wiring/<module>.ts`,
 * so the track that owns the module changes that file and nothing shared.
 */

/** What the module can use when the application is built. */
export interface WiringContext {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  keys: TenantKeys;
  email: EmailSender;
  /** Where emailed links point (never the Host header of a request). */
  origins: PublicOrigins;
  rateLimitStore: RateLimitStore;
  clock?: () => Date;
  /** Absent when no bucket is configured. */
  storage?: ObjectStorage;
  /** Enqueues jobs from a request, in its transaction. Absent when no module needs the queue. */
  jobs?: JobClient;
  /** Which adapter serves which organization. */
  adapters?: AdapterResolver;
  /** What scheduling publishes; a module subscribes here, in `create`. */
  appointmentEvents: AppointmentEvents;
  /** The reception worklist of scheduling (`openItem`). */
  worklist: WorklistService;
  /**
   * Where teleconsultation hands notifications the resolver of the join address that reminders of
   * a virtual appointment carry. One per application.
   */
  videoJoin: VideoJoinRegistry;
  /**
   * What `GET /files/:token` serves. A module that hands out files (billing exports, invoice PDFs)
   * registers the resource of its token kind here, in `create`; the route is not its own.
   */
  fileResources: FileResourceRegistry;
  /**
   * What the patient portal's own door serves (Stage 5). A separate registry from `fileResources`:
   * its resources redeem for the `PortalActor` of the session, and a staff resource never opens a
   * patient's link or the other way round. Only the portal module registers here.
   */
  portalFileResources: FileResourceRegistry<PortalActor>;
  /**
   * What happens to an organization when it ends (Stage 6). Retention subscribes (`onCancelled`) in
   * `create`; the writers (the subscription reaching `cancelled`, the operator action) publish.
   */
  tenantLifecycle: TenantLifecycle;
  /**
   * What a module that creates accounts needs from identity (Stage 6: the signup creates the first
   * owner of an organization): the password rules, the hasher and the session service, the same
   * instances sign-in uses.
   */
  accounts: AccountPieces;
}

/** The pieces of identity that a module creating accounts may use. */
export interface AccountPieces {
  passwordValidator: PasswordValidator;
  hasher: PasswordHasher;
  sessions: SessionService;
  /** True when the session cookie carries `Secure` (the deployment is served over https). */
  cookieSecure: boolean;
}

/** What a module's routes in the operator console can use (Stage 6). */
export interface OperatorWiringContext {
  /** Runs a callback in one transaction of the operator connection (the `app_operator` role). */
  run: OperatorRun;
  /** The door that says an organization was cancelled; the operator action publishes through it. */
  tenantCancelled: TenantCancelledPort;
  email: EmailSender;
  /** Where an organization's emailed links point. */
  origins: PublicOrigins;
  clock?: () => Date;
}

/** What the module needs to fill its slots of the adapter registry. */
export interface AdapterWiringContext {
  config: Config;
  /** The runtime connection, for a local adapter that keeps its state in Postgres. */
  db: Db;
}

/** What a module needs to describe its providers in the simulator console. */
export interface DevWiringContext {
  config: Config;
}

/** What the worker's part of a module can use. */
export interface WorkerWiringContext {
  config: Config;
  adapters: AdapterResolver;
  email: EmailSender;
  clock?: () => Date;
  /** The same registry for every module of this worker process. */
  videoJoin: VideoJoinRegistry;
}

/** Jobs, scheduled tasks and per-organization ticks a module adds to the worker process. */
export type WorkerContribution = Pick<WorkerOptions, 'tenantJobs' | 'jobs' | 'schedules'>;

export interface ModuleWiring {
  /** The directory of the module under `modules/`. */
  name: string;
  /**
   * The slots of the adapter registry this module owns. A demo slot is always a fake; the customer
   * slot stays empty until the module's local or real adapter exists.
   */
  adapters?: (context: AdapterWiringContext) => Partial<AdapterRegistry>;
  /** The sections of the organization settings this module owns (merged into /settings). */
  settingsSections?: readonly SettingsSection[];
  /**
   * The entries of this module's providers in the simulator console (`LOCAL_PROVIDERS_CONSOLE`):
   * what is listed, and the controls of the simulator under `/operator/dev/<id>/`.
   */
  devProviders?: (context: DevWiringContext) => readonly DevProvider[];
  /** True when the module enqueues jobs from a request, so the API process holds a queue client. */
  needsJobs?: boolean;
  /**
   * Builds the module: returns its routes and subscribes to the event bus. `featureRoutes` are the
   * routes that exist only where the deployment has the capability (`signup` and `subscriptions`
   * only in multi mode, `operator_console` only with the console): the composition root registers
   * them behind the feature registry, so a single-tenant deployment never serves them.
   */
  create(context: WiringContext): {
    routes?: FeatureRoutes;
    featureRoutes?: Partial<Record<FeatureKey, FeatureRoutes>>;
  };
  /**
   * Routes this module adds INSIDE the operator console (Stage 6: the subscription support view, the
   * cancellation, the archive releases). They are registered after the console's guard, so they
   * answer only on the platform host behind the operator session, and each one declares
   * `config.operatorAuth: 'session'`. Read the operator with `operatorOf(request)`.
   */
  operatorRoutes?: (context: OperatorWiringContext) => (app: FastifyInstance) => void;
  /** The module's part of the worker process. */
  worker?: (context: WorkerWiringContext) => WorkerContribution;
}
