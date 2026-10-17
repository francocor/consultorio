import type { WorklistService } from '../../modules/scheduling/index.js';
import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { TenantKeys } from '../../platform/crypto/tenant-keys.js';
import type { Db } from '../../platform/db/pool.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { AppointmentEvents } from '../../platform/events/appointment-events.js';
import type { PublicOrigins } from '../../platform/http/public-origin.js';
import type { RateLimitStore } from '../../platform/http/rate-limit.js';
import type { JobClient } from '../../platform/jobs/boss.js';
import type { WorkerOptions } from '../../platform/jobs/worker.js';
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
}

/** What the module needs to fill its slots of the adapter registry. */
export interface AdapterWiringContext {
  config: Config;
  /** The runtime connection, for a local adapter that keeps its state in Postgres. */
  db: Db;
}

/** What the worker's part of a module can use. */
export interface WorkerWiringContext {
  config: Config;
  adapters: AdapterResolver;
  email: EmailSender;
  clock?: () => Date;
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
  /** True when the module enqueues jobs from a request, so the API process holds a queue client. */
  needsJobs?: boolean;
  /** Builds the module: returns its routes and subscribes to the event bus. */
  create(context: WiringContext): { routes?: FeatureRoutes };
  /** The module's part of the worker process. */
  worker?: (context: WorkerWiringContext) => WorkerContribution;
}
