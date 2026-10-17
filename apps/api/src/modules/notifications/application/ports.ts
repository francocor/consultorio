/**
 * Ports of the notifications module. The module asks for a WhatsApp message to be sent; which
 * provider delivers it is an adapter (`adapters/whatsapp-*`): the Meta Cloud API in production, a
 * local simulator while the owner has no WABA, an in-memory fake for tests and demo organizations.
 *
 * Only appointment messages (reminder, confirmation, waitlist offer) and only with a recorded
 * opt-in ever reach this port; the channel policy lives in the module, not in the adapter. A
 * message never carries clinical content.
 */

export interface WhatsAppSendRequest {
  /** An approved template of the provider, such as `appointment_reminder`. */
  templateKey: string;
  /** The recipient's number in E.164 form. */
  to: string;
  /** Template variables: first name, date, time, location, organization. Never clinical data. */
  vars: Readonly<Record<string, string>>;
  /** Sending twice with the same key never produces two messages. */
  idempotencyKey: string;
}

export type WhatsAppSendResult =
  /** The provider took the message and gave it an id; delivery receipts follow by webhook. */
  | { status: 'accepted'; providerMessageId: string }
  /** The provider will never deliver it: the number is not on WhatsApp, the template is unknown. */
  | { status: 'rejected'; reason: 'not_on_whatsapp' | 'template_rejected' | 'invalid_number' }
  /** A transient failure (outage, timeout): trying again later may work. */
  | { status: 'retryable'; message: string };

/** An event of the provider, normalized: what the notifications module understands. */
export type WhatsAppEvent =
  | {
      kind: 'status';
      /** Unique per event, so a replayed webhook is counted once. */
      eventId: string;
      providerMessageId: string;
      status: 'sent' | 'delivered' | 'read' | 'failed';
      occurredAt: Date;
      errorCode?: string;
    }
  | {
      kind: 'inbound';
      eventId: string;
      /** The sender's number in E.164 form. */
      from: string;
      text: string;
      occurredAt: Date;
    };

export type WebhookHeaders = Readonly<Record<string, string | string[] | undefined>>;

export interface WhatsAppSender {
  send(request: WhatsAppSendRequest): Promise<WhatsAppSendResult>;
  /** True only when the signature header matches the raw body (`X-Hub-Signature-256`). */
  verifyWebhook(rawBody: Buffer | string, headers: WebhookHeaders): boolean;
  /** The events in a webhook body; anything that is not an event is dropped, never thrown. */
  parseEvents(body: unknown): readonly WhatsAppEvent[];
}
