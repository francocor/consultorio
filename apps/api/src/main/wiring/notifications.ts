import { randomBytes } from 'node:crypto';

import { DEFAULT_NOTIFICATION_SETTINGS, NotificationSettings } from '@consultorio/contracts';

import { createFakeWhatsAppSender } from '../../adapters/whatsapp-fake/index.js';
import { whatsappDevRoutes } from '../../adapters/whatsapp-local/dev-routes.js';
import {
  createLocalWhatsAppControls,
  createLocalWhatsAppSender,
} from '../../adapters/whatsapp-local/index.js';
import {
  REMINDER_SWEEP_JOB,
  bindOfferDelivery,
  createNotificationJobs,
  createNotifications,
  createWorklist,
} from '../../modules/notifications/index.js';
import { createTenantKeys } from '../../platform/crypto/tenant-keys.js';
import { createRuntimeDb } from '../../platform/db/pool.js';
import { createWithTenant } from '../../platform/db/tenant-context.js';
import { fanOut } from '../../platform/jobs/worker.js';
import type { WorkerJobContext } from '../../platform/jobs/worker.js';
import { adapterOfSetting } from '../../platform/local-providers/dev-routes.js';
import { createActionTokens } from '../../platform/tokens/index.js';
import { fake } from '../adapter-resolver.js';
import type { Config } from '../config.js';
import { createKeyManagement } from '../key-management.js';

import { originsFromConfig } from './origins.js';
import type { ModuleWiring } from './types.js';

/**
 * The secret that signs the simulator's webhook when none is configured. The API process both
 * verifies the webhook and signs the simulated events, so one secret per process is enough; the
 * worker never verifies anything. It is not a default anyone could know.
 */
const PROCESS_SECRET = randomBytes(24).toString('hex');
const appSecretOf = (config: Config) => config.providers.whatsappAppSecret ?? PROCESS_SECRET;

/**
 * Whether WhatsApp runs on the local simulator. A wiring context built by hand (the wiring tests)
 * may carry no provider settings at all: that is "no simulator".
 */
const usesSimulator = (config: Config) =>
  (config as { providers?: Config['providers'] }).providers?.whatsapp === 'local';

/** Who the webhook belongs to: nobody. The resolver only needs to know it is not a demo. */
const PLATFORM = { id: '00000000-0000-0000-0000-000000000000', isDemo: false } as const;

/** How often every organization's reminders are swept (hourly). */
const SWEEP_EVERY_MS = 3_600_000;

/**
 * Everything the notifications module registers with the composition root (track A). The track
 * edits this file, `modules/notifications/` and nothing shared: it fills the customer slot of the
 * `whatsapp` port when its local simulator exists, subscribes to the appointment events, and adds
 * its jobs to the worker.
 */
export const notificationsWiring: ModuleWiring = {
  settingsSections: [
    {
      key: 'notifications',
      schema: NotificationSettings,
      defaults: DEFAULT_NOTIFICATION_SETTINGS,
    },
  ],
  name: 'notifications',
  // Reminders are enqueued from the request that books, moves or cancels an appointment.
  needsJobs: true,
  // Customers get the local simulator while `WHATSAPP_PROVIDER=local` (it has no effect outside the
  // process, so it is registered as a fake); the Meta adapter is a deferred task. Demo organizations
  // always get the in-memory fake.
  adapters: ({ config, db }) => ({
    whatsapp: {
      real: usesSimulator(config)
        ? fake(createLocalWhatsAppSender({ db, appSecret: appSecretOf(config) }))
        : undefined,
      demo: fake(createFakeWhatsAppSender()),
    },
  }),
  devProviders: ({ config }) => {
    const local = usesSimulator(config);
    // The simulator keeps its state in Postgres; the console reads it through a connection of its own.
    const database = local ? createRuntimeDb(config.databaseUrl) : undefined;
    const controls = database ? createLocalWhatsAppControls(database.db) : undefined;
    return [
      {
        id: 'whatsapp',
        label: 'WhatsApp',
        status: async () => ({
          adapter: adapterOfSetting(config.providers.whatsapp),
          // The console lists the providers even when the database is not reachable.
          mode: controls ? await controls.mode().catch(() => null) : null,
        }),
        ...(database && controls
          ? {
              routes: whatsappDevRoutes({
                controls,
                sender: createLocalWhatsAppSender({
                  db: database.db,
                  appSecret: appSecretOf(config),
                }),
              }),
            }
          : {}),
      },
    ];
  },
  create: (context) =>
    createNotifications({
      withTenant: context.withTenant,
      auditDeny: context.auditDeny,
      events: context.appointmentEvents,
      keys: context.keys,
      jobs: context.jobs,
      origins: context.origins,
      email: context.email,
      worklist: context.worklist,
      // The webhook is verified by the customer provider; the resolver hands it out for any
      // organization that is not a demo.
      whatsappWebhookSender: context.adapters?.forTenant(PLATFORM, 'whatsapp'),
      channels: context.adapters
        ? {
            email: (tenant) => context.adapters?.forTenant(tenant, 'email'),
            whatsapp: (tenant) => context.adapters?.forTenant(tenant, 'whatsapp'),
          }
        : undefined,
      // Without a resolver (some tests) WhatsApp is assumed to exist; the send job checks again.
      whatsappAvailable: (tenant) =>
        context.adapters ? context.adapters.forTenant(tenant, 'whatsapp') !== undefined : true,
      videoJoin: context.videoJoin.resolver,
      ...(context.clock ? { clock: context.clock } : {}),
    }),
  worker: ({ config, adapters, clock, videoJoin }) => {
    const now = clock ?? (() => new Date());
    const origins = originsFromConfig(config);
    const keys = createTenantKeys({ kms: createKeyManagement(config.kms) });
    const jobsOf = ({ client, db }: Pick<WorkerJobContext, 'client' | 'db'>) => {
      // The waitlist also delivers its offers from the worker (an offer that expired passes to the
      // next patient), through the same entry point.
      bindOfferDelivery({
        jobs: client,
        clock: now,
        whatsappAvailable: (tenant) => adapters.forTenant(tenant, 'whatsapp') !== undefined,
      });
      return createNotificationJobs({
        withTenant: createWithTenant(db),
        // Each organization gets the provider the resolver picks for it: a demo organization only
        // ever the fakes. A channel nobody configured is `undefined` and counts as unavailable.
        channels: {
          email: (tenant) => adapters.forTenant(tenant, 'email'),
          whatsapp: (tenant) => adapters.forTenant(tenant, 'whatsapp'),
        },
        jobs: client,
        clock: now,
        origins,
        tokens: createActionTokens({ clock: now }),
        worklist: createWorklist({ keys }),
        // Reminders of a virtual appointment carry the join address teleconsultation registered.
        videoJoin: videoJoin.resolver,
      });
    };
    return {
      jobs: (context) => jobsOf(context).all,
      schedules: ({ client, db }) => [
        {
          name: 'reminder.sweep tick',
          intervalMs: SWEEP_EVERY_MS,
          // One sweep per organization and per hour at most, even with several workers.
          run: async () => {
            await fanOut(db, client, REMINDER_SWEEP_JOB, { singletonSeconds: 1800 });
          },
        },
      ],
    };
  },
};
