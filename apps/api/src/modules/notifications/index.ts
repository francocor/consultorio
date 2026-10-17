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
