import { DEFAULT_NOTIFICATION_SETTINGS, NotificationSettings } from '@consultorio/contracts';

import { createFakeWhatsAppSender } from '../../adapters/whatsapp-fake/index.js';
import {
  REMINDER_SWEEP_JOB,
  createNotificationJobs,
  createNotifications,
  createWorklist,
} from '../../modules/notifications/index.js';
import { createTenantKeys } from '../../platform/crypto/tenant-keys.js';
import { createWithTenant } from '../../platform/db/tenant-context.js';
import { createPublicOrigins } from '../../platform/http/public-origin.js';
import { fanOut } from '../../platform/jobs/worker.js';
import type { WorkerJobContext } from '../../platform/jobs/worker.js';
import { adapterOfSetting } from '../../platform/local-providers/dev-routes.js';
import { createActionTokens } from '../../platform/tokens/index.js';
import { fake } from '../adapter-resolver.js';
import { deploymentFromConfig } from '../deployment.js';
import { createKeyManagement } from '../key-management.js';

import type { ModuleWiring } from './types.js';

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
  // No customer adapter yet: WhatsApp stays unavailable for customers; demo organizations get the fake.
  adapters: () => ({ whatsapp: { real: undefined, demo: fake(createFakeWhatsAppSender()) } }),
  devProviders: ({ config }) => [
    {
      id: 'whatsapp',
      label: 'WhatsApp',
      // The simulators add their mode (an outage, rejected templates) when they exist.
      status: () =>
        Promise.resolve({ adapter: adapterOfSetting(config.providers.whatsapp), mode: null }),
    },
  ],
  create: (context) =>
    createNotifications({
      withTenant: context.withTenant,
      auditDeny: context.auditDeny,
      events: context.appointmentEvents,
      keys: context.keys,
      jobs: context.jobs,
      // Without a resolver (some tests) WhatsApp is assumed to exist; the send job checks again.
      whatsappAvailable: (tenant) =>
        context.adapters ? context.adapters.forTenant(tenant, 'whatsapp') !== undefined : true,
      ...(context.clock ? { clock: context.clock } : {}),
    }),
  worker: ({ config, adapters, clock }) => {
    const now = clock ?? (() => new Date());
    const origins = createPublicOrigins(deploymentFromConfig(config), {
      secure: config.cookieSecure,
      ...(config.publicUrl === undefined ? {} : { publicUrl: config.publicUrl }),
      ...(config.publicPort === undefined ? {} : { port: config.publicPort }),
    });
    const keys = createTenantKeys({ kms: createKeyManagement(config.kms) });
    const jobsOf = ({ client, db }: Pick<WorkerJobContext, 'client' | 'db'>) =>
      createNotificationJobs({
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
      });
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
