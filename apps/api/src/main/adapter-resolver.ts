import type { InvoiceIssuer } from '@consultorio/contracts';

import type { WhatsAppSender } from '../modules/notifications/application/ports.js';
import type { VideoLinkProvider } from '../modules/teleconsultation/application/ports.js';
import type { BotChallenge } from '../platform/bot-challenge/bot-challenge.js';
import type { KeyManagement } from '../platform/crypto/key-management.js';
import type { EmailMessage, EmailSender } from '../platform/mail/email-sender.js';
import type { ObjectStorage } from '../platform/storage/object-storage.js';

/**
 * Which adapter serves which organization (demo, "Demo organizations never reach real services").
 * Every external port has a REAL adapter, used by customers, and a FAKE one for demo
 * organizations. The resolver hands a demo organization the fake and REFUSES, loudly and when the
 * application starts, a registry whose "demo" slot holds anything that is not marked as a fake:
 * a demo organization can never send a real email or store a real document by a configuration
 * mistake.
 */

/** What each port looks like. Adding a port means adding it here, to the registry and to the test. */
export interface AdapterPorts {
  email: EmailSender;
  objectStorage: ObjectStorage;
  keyManagement: KeyManagement;
  /** WhatsApp messages (Stage 3): the Meta Cloud API, a local simulator, an in-memory fake. */
  whatsapp: WhatsAppSender;
  /** Video rooms of teleconsultations (Stage 3). */
  videoLink: VideoLinkProvider;
  /** The bot challenge of the public forms (Stage 3). */
  botChallenge: BotChallenge;
  /** Electronic invoices (Stage 4): ARCA/AFIP WSFE, a local simulator, an in-memory fake. */
  invoiceIssuer: InvoiceIssuer;
}
export type AdapterPort = keyof AdapterPorts;

/** Every port, as a value, so a test (and the registry type) can iterate them. */
export const ADAPTER_PORTS = [
  'email',
  'objectStorage',
  'keyManagement',
  'whatsapp',
  'videoLink',
  'botChallenge',
  'invoiceIssuer',
] as const satisfies readonly AdapterPort[];

export interface Marked<A> {
  adapter: A;
  kind: 'real' | 'fake';
}

/** Marks an adapter as the real one. */
export function real<A>(adapter: A): Marked<A> {
  return { adapter, kind: 'real' };
}

/** Marks an adapter as a fake: in memory, local, or otherwise without effect outside the process. */
export function fake<A>(adapter: A): Marked<A> {
  return { adapter, kind: 'fake' };
}

export type AdapterRegistry = {
  [P in AdapterPort]: {
    /** Absent when the deployment does not configure it (no bucket, no mail server). */
    real: Marked<AdapterPorts[P]> | undefined;
    demo: Marked<AdapterPorts[P]>;
  };
};

/**
 * Joins the slots that the composition root and each module register into one registry. Every
 * port must be registered exactly once: a port nobody registered, or one that two modules both
 * claim, stops the application at startup instead of failing at the first request.
 */
export function assembleAdapterRegistry(
  parts: readonly Partial<AdapterRegistry>[],
): AdapterRegistry {
  const slots = new Map<AdapterPort, AdapterRegistry[AdapterPort]>();
  for (const part of parts) {
    for (const port of ADAPTER_PORTS) {
      const slot = part[port];
      if (slot === undefined) continue;
      if (slots.has(port)) throw new Error(`The "${port}" adapter is registered twice.`);
      slots.set(port, slot);
    }
  }
  const missing = ADAPTER_PORTS.filter((port) => !slots.has(port));
  if (missing.length > 0) {
    throw new Error(`No adapter is registered for: ${missing.join(', ')}.`);
  }
  // Every port is present, which the checks above just proved; the map cannot say so by type.
  return Object.fromEntries(slots) as unknown as AdapterRegistry;
}

export interface TenantRef {
  id: string;
  isDemo: boolean;
}

/** A demo organization was about to be served by an adapter that is not a fake. */
export class DemoAdapterError extends Error {
  constructor(port: AdapterPort) {
    super(`The "${port}" adapter registered for demo organizations is not a fake.`);
    this.name = 'DemoAdapterError';
  }
}

export interface AdapterResolver {
  /** The adapter for this organization, or `undefined` when the port is not configured for it. */
  forTenant<P extends AdapterPort>(tenant: TenantRef, port: P): AdapterPorts[P] | undefined;
}

export function createAdapterResolver(registry: AdapterRegistry): AdapterResolver {
  // A mistake in the registry fails when the application starts, not at the first demo request.
  for (const port of ADAPTER_PORTS) {
    if (registry[port].demo.kind !== 'fake') throw new DemoAdapterError(port);
  }
  return {
    forTenant(tenant, port) {
      const slot = tenant.isDemo ? registry[port].demo : registry[port].real;
      if (tenant.isDemo && slot?.kind !== 'fake') throw new DemoAdapterError(port);
      return slot?.adapter;
    },
  };
}

/**
 * An email sender that picks the adapter by the organization the message is about. A message that
 * does not say so is refused: guessing "customer" could send a demo's email for real, and guessing
 * "demo" could swallow a customer's.
 */
export function createTenantRoutedEmail(resolver: AdapterResolver): EmailSender {
  return {
    send(message: EmailMessage) {
      if (!message.tenant) {
        return Promise.reject(new Error('An email must say which organization it is about.'));
      }
      const sender = resolver.forTenant(message.tenant, 'email');
      if (!sender) return Promise.reject(new Error('Email is not configured.'));
      return sender.send(message);
    },
  };
}
