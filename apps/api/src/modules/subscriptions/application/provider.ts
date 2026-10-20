import type { AdapterResolver } from '../../../main/adapter-resolver.js';
import type { WithTenant } from '../../../platform/db/tenant-context.js';
import type { PublicOrigins } from '../../../platform/http/public-origin.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import type { EmailSender } from '../../../platform/mail/email-sender.js';
import type { TenantCancelledPort } from '../../tenancy/index.js';

import type { PaymentsGateway } from './ports.js';

/** Where the failures nobody is waiting for are written (the log of the worker). No payer, no amount. */
export interface AttemptLog {
  error(object: Record<string, unknown>, message: string): void;
}

/** What the services of the module are built with. */
export interface SubscriptionDeps {
  withTenant: WithTenant;
  adapters?: AdapterResolver | undefined;
  jobs?: JobClient | undefined;
  /** Sends the notices to the owner. Absent: the notices are not sent (they stay recorded). */
  email?: EmailSender | undefined;
  /** Where emailed links point (never the Host header of a request). */
  origins?: PublicOrigins | undefined;
  /** Says an organization was cancelled (the subscription reaching its end publishes through it). */
  tenantCancelled?: TenantCancelledPort | undefined;
  clock: () => Date;
  /** How long a call to the provider is waited for before its outcome counts as unknown (20 s). */
  providerTimeoutMs?: number | undefined;
  log?: AttemptLog | undefined;
}

/** Who the gateway belongs to: nobody. The resolver only needs to know it is not a demo. */
const PLATFORM = { id: '00000000-0000-0000-0000-000000000000', isDemo: false } as const;

/** The gateway that serves the platform's subscriptions, or undefined (`PAYMENTS_PROVIDER=off`). */
export function gatewayOf(deps: Pick<SubscriptionDeps, 'adapters'>): PaymentsGateway | undefined {
  return deps.adapters?.forTenant(PLATFORM, 'paymentsGateway');
}

/** The provider is a simulator: the screens and the emails say so. */
export function isSimulated(gateway: PaymentsGateway | undefined): boolean {
  return (gateway as { simulated?: unknown } | undefined)?.simulated === true;
}

/** How long the provider is waited for before the outcome of a call counts as unknown. */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 20_000;

/** The answer of a call to the provider and whether the caller gave up waiting for it. */
export interface Timed<T> {
  value: T;
  /** The call did not come back in time: it may still be running at the provider. */
  timedOut: boolean;
  /** The call threw (the transport failed, or the signal fired): the outcome is not known. */
  threw: boolean;
}

/**
 * A call to the provider that cannot hang whoever makes it: when the provider does not answer in time,
 * or the call fails, the value is `fallback`, which says "unreachable, outcome unknown" and is handled
 * like a lost answer (the caller searches by reference before it believes anything).
 *
 * The call receives an `AbortSignal` that fires when the time is up, and adapters give the request up
 * with it. A transport that cannot be cancelled keeps running anyway, which is why a timeout is
 * reported (`timedOut`): the caller must not assume that nothing is in flight. No database
 * transaction is open while this waits: that is the rule of the module.
 */
export async function callWithin<T>(
  deps: Pick<SubscriptionDeps, 'providerTimeoutMs'>,
  call: (signal: AbortSignal) => Promise<T>,
  fallback: T,
): Promise<Timed<T>> {
  const limit = deps.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<Timed<T>>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ value: fallback, timedOut: true, threw: false });
    }, limit);
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => call(controller.signal))
        .then((value): Timed<T> => ({ value, timedOut: false, threw: false }))
        .catch((): Timed<T> => ({ value: fallback, timedOut: false, threw: true })),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The answer of a read, or `'unavailable'` when the provider could not be asked. */
export type Read<T> = T | 'unavailable';

/** A write whose outcome is not known: the caller searches before anything else. */
export const UNKNOWN_OUTCOME = {
  status: 'retryable' as const,
  message: 'unreachable',
  outcomeUnknown: true,
};
