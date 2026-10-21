import { and, eq } from 'drizzle-orm';

import { userAccount } from '../../../db/schema/identity.js';
import {
  subscription,
  subscriptionAttempt,
  type PlanRow,
  type SubscriptionAttemptRow,
  type SubscriptionRow,
} from '../../../db/schema/subscriptions.js';
import { tenant } from '../../../db/schema/tenant.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { preapprovalMatches } from '../domain/attempt-decisions.js';

import {
  blocksProvider,
  lockAttempt,
  markAttempt,
  nextAttemptNumber,
  noteUnknownOutcome,
  openAttempts,
  parkSubscription,
  resolveAttempt,
} from './attempts.js';
import type { CreatePreapprovalResult, PaymentsGateway, PreapprovalRequest } from './ports.js';
import { cancelLivePreapprovals } from './preapprovals.js';
import {
  UNKNOWN_OUTCOME,
  callWithin,
  gatewayOf,
  settleWindowOf,
  type SubscriptionDeps,
} from './provider.js';
import { reconcileSubscription } from './reconcile.js';
import {
  CURRENT_TENANT,
  countActiveProfessionalsNow,
  findPlan,
  lockSubscription,
  readTenantBilling,
} from './store.js';
import { createTrialStarter } from './trial.js';

export type CheckoutResult =
  | { status: 'ready'; checkoutUrl: string }
  /** The provider is down, did not answer, or none is configured: nothing changed, try again. */
  | { status: 'unavailable' }
  /** A request is in flight, or its outcome is not known yet: wait, do not send another. */
  | { status: 'in_progress' }
  /** The subscription is parked for a person. */
  | { status: 'attention' }
  /** The provider refused the request for good. */
  | { status: 'rejected' }
  | { status: 'not_allowed'; reason: 'exempt' | 'cancelled' | 'already_subscribed' };

export interface CheckoutInput {
  tenantId: string;
  /** The owner who asked. */
  userId: string;
  actor: AuditActor;
}

type Step =
  | { kind: 'done'; result: CheckoutResult }
  | { kind: 'reconcile' }
  /** An earlier preapproval may be alive: it is stopped before another one is asked for. */
  | { kind: 'supersede' }
  | { kind: 'reuse'; preapprovalId: string; url: string | null }
  | {
      kind: 'send';
      attempt: SubscriptionAttemptRow;
      request: PreapprovalRequest;
      payerEmail: string;
    };

const done = (result: CheckoutResult): Step => ({ kind: 'done', result });

/** Where the payer lands after the hosted page: the subscription screen of the organization. */
async function backUrlOf(tx: Tx, deps: SubscriptionDeps): Promise<string> {
  const [row] = await tx
    .select({ slug: tenant.slug })
    .from(tenant)
    .where(eq(tenant.id, CURRENT_TENANT));
  if (!row || !deps.origins) throw new Error('the address of the organization is not known');
  return `${deps.origins(row.slug)}/subscription`;
}

/**
 * Step 1 of a checkout, in a short transaction that commits BEFORE the provider is called. It decides
 * what to do from what is recorded, and, when a request has to be sent, writes the intent first (the
 * write-ahead mark): the reference the server derived, the key, what is asked and when it is sent.
 * Nothing here talks to the provider.
 */
async function begin(
  tx: Tx,
  deps: SubscriptionDeps,
  gateway: PaymentsGateway,
  input: CheckoutInput,
  earlierStopped: boolean,
): Promise<Step> {
  const billing = await readTenantBilling(tx);
  if (billing.exempt) return done({ status: 'not_allowed', reason: 'exempt' });

  let row: SubscriptionRow | null = await lockSubscription(tx);
  if (!row) {
    // An organization created by the operator has no trial yet: it starts when its owner subscribes.
    await createTrialStarter({ clock: deps.clock }).startTrial(tx, { tenantId: input.tenantId });
    row = await lockSubscription(tx);
  }
  if (!row) throw new Error('the subscription could not be created');
  if (row.status === 'cancelled') return done({ status: 'not_allowed', reason: 'cancelled' });
  if (blocksProvider(row)) return done({ status: 'attention' });
  if (row.authorizationState === 'authorized') {
    return done({ status: 'not_allowed', reason: 'already_subscribed' });
  }

  const now = deps.clock();
  const open = (await openAttempts(tx, row.id)).filter((attempt) => attempt.kind === 'preapproval');
  for (const attempt of open) {
    if (attempt.state === 'parked') return done({ status: 'attention' });
    // A request that may still be running at the provider: no other one is sent. After the window
    // the provider is asked what it holds, and only then is anything decided.
    if (now.getTime() < attempt.settleUntil.getTime()) return done({ status: 'in_progress' });
    return { kind: 'reconcile' };
  }

  if (row.authorizationState === 'pending' && row.providerPreapprovalId !== null) {
    const [confirmed] = await tx
      .select()
      .from(subscriptionAttempt)
      .where(
        and(
          eq(subscriptionAttempt.kind, 'preapproval'),
          eq(subscriptionAttempt.resourceId, row.providerPreapprovalId),
        ),
      );
    return {
      kind: 'reuse',
      preapprovalId: row.providerPreapprovalId,
      url: confirmed?.resourceUrl ?? null,
    };
  }

  // A preapproval the platform asked for before, or that it still holds, may be alive at the provider
  // (paused, lost, or landed late). A second authorization next to it charges the payer twice, so
  // nothing new is asked for until every earlier one is provably not alive (JD-S6 R1, C2).
  if (!earlierStopped) {
    const [earlier] = await tx
      .select({ id: subscriptionAttempt.id })
      .from(subscriptionAttempt)
      .where(
        and(
          eq(subscriptionAttempt.subscriptionId, row.id),
          eq(subscriptionAttempt.kind, 'preapproval'),
        ),
      )
      .limit(1);
    if (earlier || row.providerPreapprovalId !== null) return { kind: 'supersede' };
  }

  const plan = await findPlan(tx, row.planId);
  const professionals = Math.max(1, await countActiveProfessionalsNow(tx));
  const amountCents = professionals * plan.pricePerProfessionalCents;
  const [account] = await tx
    .select({ email: userAccount.email })
    .from(userAccount)
    .where(eq(userAccount.id, input.userId));
  if (!account) throw new Error('the owner who subscribes has no account');

  const number = await nextAttemptNumber(tx, row.id, 'preapproval');
  const externalReference = `sub:${row.id}:${String(number)}`;
  const attempt = await markAttempt(tx, {
    subscriptionId: row.id,
    kind: 'preapproval',
    externalReference,
    amountCents,
    payerEmail: account.email,
    clock: deps.clock,
    settleWindowMs: gateway.settleWindowMs + (deps.providerTimeoutMs ?? 20_000),
  });
  return {
    kind: 'send',
    attempt,
    payerEmail: account.email,
    request: {
      externalReference,
      payerEmail: account.email,
      reason: reasonOf(plan, professionals),
      amountCents,
      currency: 'ARS',
      backUrl: await backUrlOf(tx, deps),
    },
  };
}

function reasonOf(plan: Pick<PlanRow, 'name'>, professionals: number): string {
  return `${plan.name} - ${String(professionals)} ${professionals === 1 ? 'profesional' : 'profesionales'}`;
}

/**
 * Step 3: writes what the provider answered, in another short transaction, locking the subscription
 * only now. The answer is trusted only as far as it can be checked: a preapproval that does not carry
 * every identifying field of what was asked is parked, never adopted.
 */
async function finish(
  tx: Tx,
  deps: SubscriptionDeps,
  input: CheckoutInput,
  sent: Extract<Step, { kind: 'send' }>,
  answer: CreatePreapprovalResult,
  timedOut: boolean,
): Promise<CheckoutResult> {
  const now = deps.clock();
  const row = await lockSubscription(tx);
  const attempt = await lockAttempt(tx, sent.attempt.id);
  if (!row || !attempt) throw new Error('the subscription disappeared during the checkout');
  // Somebody (the reconcile of a notice) settled this attempt while the provider was being waited for.
  if (attempt.state !== 'marked') {
    if (attempt.state === 'confirmed' && attempt.resourceUrl !== null) {
      return { status: 'ready', checkoutUrl: attempt.resourceUrl };
    }
    return { status: attempt.state === 'parked' ? 'attention' : 'unavailable' };
  }

  if (answer.status === 'created') {
    const found = answer.preapproval;
    const asked = {
      externalReference: sent.request.externalReference,
      payerEmail: sent.request.payerEmail,
      amountCents: sent.request.amountCents,
    };
    if (!preapprovalMatches(asked, found) || found.checkoutUrl === undefined) {
      await resolveAttempt(tx, attempt, { state: 'parked', now, message: 'identity_mismatch' });
      await parkSubscription(tx, row, 'identity_mismatch', now);
      return { status: 'attention' };
    }
    await resolveAttempt(tx, attempt, {
      state: 'confirmed',
      resourceId: found.preapprovalId,
      resourceUrl: found.checkoutUrl,
      now,
    });
    await tx
      .update(subscription)
      .set({
        providerPreapprovalId: found.preapprovalId,
        externalReference: sent.request.externalReference,
        authorizationState: 'pending',
        authorizedAmountCents: found.amountCents,
        paymentMethodLabel: null,
        version: row.version + 1,
      })
      .where(eq(subscription.id, row.id));
    await audit(tx, {
      action: 'subscription.created',
      outcome: 'allow',
      actor: input.actor,
      resourceType: 'subscription',
      resourceId: row.id,
      metadata: { step: 'checkout_started', reference: sent.request.externalReference },
    });
    return { status: 'ready', checkoutUrl: found.checkoutUrl };
  }

  if (answer.status === 'rejected') {
    await resolveAttempt(tx, attempt, { state: 'rejected', now, message: answer.message });
    return { status: 'rejected' };
  }

  // Retryable. Only an adapter that says the request never left lets the pin go; a timeout, an abort
  // and an answer that did not come all leave it, and the next step searches by reference.
  if (!answer.outcomeUnknown && !timedOut) {
    await resolveAttempt(tx, attempt, { state: 'released', now, message: answer.message });
  } else {
    await noteUnknownOutcome(tx, attempt.id, answer.message, {
      now,
      settleWindowMs: settleWindowOf(deps),
    });
  }
  return { status: 'unavailable' };
}

/**
 * `POST /subscription/checkout`: the owner starts the authorization of the monthly payment. It
 * answers with the hosted page of the provider; the subscription becomes active only when the
 * provider CONFIRMS the authorization (the reconcile that a notice queues), never because the owner
 * came back, so an abandoned checkout leaves the state as it was.
 *
 * The three steps of every write to the provider: the mark (a short transaction, committed before the
 * call), the call (no transaction, no lock, bounded and abortable), and the answer (another short
 * transaction). A second click while a request is in flight, or while its outcome is unknown, sends
 * nothing: it is told to wait.
 */
export async function startCheckout(
  deps: SubscriptionDeps,
  input: CheckoutInput,
): Promise<CheckoutResult> {
  const gateway = gatewayOf(deps);
  if (!gateway) return { status: 'unavailable' };
  const as = <T>(work: (tx: Tx) => Promise<T>) =>
    deps.withTenant({ tenantId: input.tenantId, userId: input.userId }, work);

  let earlierStopped = false;
  for (let pass = 0; pass < 4; pass += 1) {
    const step = await as((tx) => begin(tx, deps, gateway, input, earlierStopped));
    switch (step.kind) {
      case 'done':
        return step.result;

      case 'supersede': {
        const swept = await cancelLivePreapprovals(deps, input.tenantId, {
          why: 'superseded',
          includeParked: false,
          waitForCreation: false,
          settle: async () => {
            await reconcileSubscription(deps, input.tenantId);
          },
        });
        if (swept.status === 'clear') {
          earlierStopped = true;
          continue;
        }
        if (swept.status === 'attention') return { status: 'attention' };
        return { status: swept.status === 'in_progress' ? 'in_progress' : 'unavailable' };
      }

      case 'reconcile':
        // The window of an unknown request passed: ask the provider what it holds, then decide.
        await reconcileSubscription(deps, input.tenantId);
        continue;

      case 'reuse': {
        const lookup = await callWithin(
          deps,
          (signal) => gateway.getPreapproval(step.preapprovalId, signal),
          undefined,
        );
        const found = lookup.value;
        if (found?.status === 'found' && found.preapproval.status === 'pending') {
          const url = found.preapproval.checkoutUrl ?? step.url;
          if (url !== null) return { status: 'ready', checkoutUrl: url };
        }
        // The provider cannot be asked: the page it gave before is the same page.
        if ((found === undefined || found.status === 'retryable') && step.url !== null) {
          return { status: 'ready', checkoutUrl: step.url };
        }
        await reconcileSubscription(deps, input.tenantId);
        continue;
      }

      case 'send': {
        const sent = await callWithin(
          deps,
          (signal) => gateway.createPreapproval(step.request, step.attempt.idempotencyKey, signal),
          UNKNOWN_OUTCOME,
        );
        const timedOut = sent.timedOut || sent.threw;
        return as((tx) => finish(tx, deps, input, step, sent.value, timedOut));
      }
    }
  }
  return { status: 'in_progress' };
}
