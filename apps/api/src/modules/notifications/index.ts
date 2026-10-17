/**
 * Public API of the notifications module (reminders, confirmations and offers over email and WhatsApp).
 * Other modules and the composition root import from here only.
 *
 * This is the seam skeleton of Stage 3: the module is wired and registered, and does nothing yet.
 * The messaging track (track A, S3.01 to S3.06) adds files under this folder and edits this one.
 */
import type { FastifyInstance } from 'fastify';

import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { exportNotifications } from './application/export-contributor.js';

export type {
  WebhookHeaders,
  WhatsAppEvent,
  WhatsAppSender,
  WhatsAppSendRequest,
  WhatsAppSendResult,
} from './application/ports.js';

// Sending: the jobs the worker registers, and what they are built from.
export { createNotificationJobs, createReminderSendJob } from './application/jobs.js';
export type { NotificationJobs } from './application/jobs.js';
export type {
  Channels,
  MessagingDeps,
  TenantRef,
  Worklist,
  WorklistItem,
} from './application/deps.js';
export { REMINDER_SEND_JOB } from './application/queue.js';
export { createWorklist } from './application/worklist.js';
export {
  isApprovedTemplate,
  whatsappBody,
  WHATSAPP_TEMPLATE_KEYS,
} from './assets/es-AR/whatsapp.js';
export type { WhatsAppTemplateKey } from './assets/es-AR/whatsapp.js';

/** Registers what notifications takes with an organization that leaves (the cancellation export). */
export function registerNotificationsExportContributors(registry: ExportRegistry): void {
  registry.registerExportContributor('administrative', 'notifications', exportNotifications);
}

export interface NotificationsOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  clock?: () => Date;
}

export interface Notifications {
  /** What the module was built with; the track builds its services from it. */
  readonly options: NotificationsOptions;
  /** The HTTP routes of the module. */
  routes: (app: FastifyInstance) => void;
}

export function createNotifications(options: NotificationsOptions): Notifications {
  return { options, routes: () => undefined };
}
