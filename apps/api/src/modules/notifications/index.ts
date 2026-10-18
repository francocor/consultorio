/**
 * Public API of the notifications module (reminders, confirmations and offers over email and WhatsApp).
 * Other modules and the composition root import from here only.
 *
 * This is the seam skeleton of Stage 3: the module is wired and registered, and does nothing yet.
 * The messaging track (track A, S3.01 to S3.06) adds files under this folder and edits this one.
 */
import type { FastifyInstance } from 'fastify';

import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { TenantKeys } from '../../platform/crypto/tenant-keys.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { AppointmentEvents } from '../../platform/events/appointment-events.js';
import type { PublicOrigins } from '../../platform/http/public-origin.js';
import type { JobClient } from '../../platform/jobs/boss.js';
import type { EmailSender } from '../../platform/mail/email-sender.js';
import { createTokenRoutes, registerTokenHandler } from '../../platform/public/token-router.js';
import { createActionTokens } from '../../platform/tokens/index.js';
import type { WorklistService } from '../scheduling/index.js';
import { readOrganizationName, type ExportRegistry } from '../tenancy/index.js';

import type { Channels, MessagingDeps, TenantRef } from './application/deps.js';
import { exportNotifications } from './application/export-contributor.js';
import { bindOfferDelivery } from './application/offer-delivery.js';
import { createReminderPlanner } from './application/plan-reminders.js';
import type { WhatsAppSender } from './application/ports.js';
import { createLinkRevoker } from './application/revoke-links.js';
import { UNLIMITED_QUOTA, type QuotaPolicy } from './application/usage.js';
import { queueVideoLinkFollowUp } from './application/video-follow-up.js';
import type { VideoJoinResolver, VideoLinkReadyListener } from './application/video-join.js';
import { createWorklist, createWorklistFromService } from './application/worklist.js';
import { channelRoutes } from './http/channel-routes.js';
import { messageRoutes } from './http/message-routes.js';
import {
  createCancelHandler,
  createConfirmHandler,
  createOptOutHandler,
  createWhatsappOptInHandler,
} from './http/token-handlers.js';
import { usageRoutes } from './http/usage-routes.js';
import { whatsappWebhookRoutes } from './http/whatsapp-webhook.js';

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
export { REMINDER_SWEEP_JOB } from './application/sweep.js';
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
  /** What scheduling publishes; reminders follow the appointments from it. */
  events: AppointmentEvents;
  /** Encrypts the detail of worklist items. */
  keys: TenantKeys;
  /** Enqueues the reminders. Absent in a deployment without a queue: nothing is planned. */
  jobs?: JobClient | undefined;
  /** False when no WhatsApp provider serves the organization (it then plans email). */
  whatsappAvailable?: ((tenant: TenantRef) => boolean) | undefined;
  /** The provider that signs the WhatsApp webhook. Absent when WhatsApp is off: no webhook. */
  whatsappWebhookSender?: WhatsAppSender | undefined;
  /** Which provider serves which organization (acknowledgments, fallbacks). */
  channels?: Channels | undefined;
  /** The reception worklist of scheduling: it keeps the detail of the replies reception reads. */
  worklist?: WorklistService | undefined;
  /** Where emailed links point. */
  origins?: PublicOrigins | undefined;
  /** Sends the emails the API itself sends (the WhatsApp opt-in request). */
  email?: EmailSender | undefined;
  /** The plan's WhatsApp quota (Stage 6 supplies it). Absent: no quota, everything counted. */
  quota?: QuotaPolicy | undefined;
  /** The join address of virtual appointments (teleconsultation registers it). */
  videoJoin?: VideoJoinResolver | undefined;
  /**
   * Where teleconsultation announces that the link of an appointment now exists: the follow-up
   * with the link is queued from it. Absent: no follow-up in this process.
   */
  onVideoLinkReady?: ((listener: VideoLinkReadyListener) => () => void) | undefined;
}

const NO_CHANNELS: Channels = { email: () => undefined, whatsapp: () => undefined };

export interface Notifications {
  /** What the module was built with; the track builds its services from it. */
  readonly options: NotificationsOptions;
  /** The HTTP routes of the module. */
  routes: (app: FastifyInstance) => void;
}

export function createNotifications(options: NotificationsOptions): Notifications {
  const clock = options.clock ?? (() => new Date());
  const tokens = createActionTokens({ clock });

  // The links of reminders: what each kind does, and the revocation of the old ones on a change.
  const handlerDeps = { keys: options.keys, events: options.events };
  registerTokenHandler('appointment_confirm', createConfirmHandler(handlerDeps));
  registerTokenHandler('appointment_cancel', createCancelHandler(handlerDeps));
  registerTokenHandler('notification_opt_out', createOptOutHandler());
  registerTokenHandler('whatsapp_opt_in', createWhatsappOptInHandler());
  const revoker = createLinkRevoker(tokens);
  options.events.subscribe((tx, event) => revoker.handle(tx, event));

  // The waitlist hands its offers to `deliverWaitlistOffer`, which queues them with these.
  bindOfferDelivery(
    options.jobs
      ? {
          jobs: options.jobs,
          clock,
          whatsappAvailable: options.whatsappAvailable ?? (() => true),
          quota: options.quota,
          keys: options.keys,
        }
      : undefined,
  );

  if (options.jobs) {
    const planner = createReminderPlanner({
      jobs: options.jobs,
      clock,
      worklist: createWorklist({ keys: options.keys }),
      whatsappAvailable: options.whatsappAvailable ?? (() => true),
    });
    // Synchronous and in the transaction of the appointment write (see the event bus).
    options.events.subscribe((tx, event) => planner.handle(tx, event));
  }
  const channels = options.channels ?? NO_CHANNELS;
  const worklist = options.worklist
    ? createWorklistFromService(options.worklist)
    : createWorklist({ keys: options.keys });
  // What a failure reported by the webhook needs to find the other channel: only with a queue.
  const reactions: MessagingDeps | undefined =
    options.jobs && options.origins
      ? {
          withTenant: options.withTenant,
          channels,
          jobs: options.jobs,
          clock,
          origins: options.origins,
          tokens,
          worklist,
          keys: options.keys,
          ...(options.quota ? { quota: options.quota } : {}),
          ...(options.videoJoin ? { videoJoin: options.videoJoin } : {}),
        }
      : undefined;

  // A reminder that promised the video link is followed by a message that carries it.
  if (options.jobs && options.onVideoLinkReady) {
    const followUp = {
      jobs: options.jobs,
      clock,
      whatsappAvailable: options.whatsappAvailable ?? (() => true),
      quota: options.quota,
      worklist,
    };
    options.onVideoLinkReady(async (tx, appointmentId) => {
      await queueVideoLinkFollowUp(followUp, tx, appointmentId);
    });
  }

  const tokenRoutes = createTokenRoutes({
    withTenant: options.withTenant,
    tokens,
    clock,
    organizationName: readOrganizationName,
  });
  const webhookRoutes = whatsappWebhookRoutes({
    withTenant: options.withTenant,
    sender: options.whatsappWebhookSender,
    inbound: { keys: options.keys, events: options.events, channels, worklist, clock },
    reactions,
  });
  const staffRoutes = [
    messageRoutes({
      withTenant: options.withTenant,
      jobs: options.jobs,
      clock,
      quota: options.quota,
      whatsappAvailable: options.whatsappAvailable ?? (() => true),
    }),
    usageRoutes({
      withTenant: options.withTenant,
      quota: options.quota ?? UNLIMITED_QUOTA,
      clock,
    }),
    ...(options.email && options.origins
      ? [
          channelRoutes({
            withTenant: options.withTenant,
            tokens,
            email: options.email,
            origins: options.origins,
          }),
        ]
      : []),
  ];
  return {
    options,
    routes: (app) => {
      tokenRoutes(app);
      webhookRoutes(app);
      for (const routes of staffRoutes) routes(app);
    },
  };
}

export { configureAddressHash } from './domain/address.js';
export { createWhatsappOptInRequests } from './application/whatsapp-opt-in.js';
export type { WhatsappOptInRequests, WhatsappOptInEmail } from './application/whatsapp-opt-in.js';
export { createBookingNotifier } from './application/booking-confirmation.js';
export type { BookingNotifierDeps } from './application/booking-confirmation.js';
export {
  bindOfferDelivery,
  boundDelivery,
  deliverWaitlistOffer,
  offerQuietHoursEnd,
} from './application/offer-delivery.js';
export type {
  OfferDeliveryDeps,
  WaitlistOfferDelivery,
  WaitlistOfferInput,
} from './application/offer-delivery.js';
export { createVideoJoinRegistry } from './application/video-join.js';
export type {
  VideoJoin,
  VideoJoinRegistry,
  VideoJoinResolver,
  VideoLinkReadyListener,
} from './application/video-join.js';
export { queueVideoLinkFollowUp } from './application/video-follow-up.js';
export type { VideoFollowUp, VideoFollowUpDeps } from './application/video-follow-up.js';
export { UNLIMITED_QUOTA } from './application/usage.js';
export type { QuotaPolicy } from './application/usage.js';
export { createReminderPlanner } from './application/plan-reminders.js';
export type { PlannerDeps, ReminderPlanner } from './application/plan-reminders.js';
