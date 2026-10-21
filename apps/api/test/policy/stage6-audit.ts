import {
  CANCELLATION_AUDIT_ACTIONS,
  SIGNUP_AUDIT_ACTIONS,
  SUBSCRIPTION_AUDIT_ACTIONS,
  type AuditAction,
} from '@consultorio/contracts';

import { isStage6Route } from './stage6-routes.js';

/** What a route declares about its audit trail (`config.audits`). */
type Declared = readonly AuditAction[] | 'none' | undefined;

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Every audit action of the tenant trail that the subscription, the signup and the cancellation of
 * an organization added to the catalogue. The platform trail (`archive.*`, `signup.purged`, the
 * operator's `tenant.cancelled`) is proven by the archive and purge tests against
 * `platform_audit_event`: those actions are not in `AUDIT_ACTIONS`.
 */
export const STAGE6_AUDIT_ACTIONS: readonly AuditAction[] = [
  ...SUBSCRIPTION_AUDIT_ACTIONS,
  ...SIGNUP_AUDIT_ACTIONS,
  ...CANCELLATION_AUDIT_ACTIONS,
];

/**
 * Actions that no mutating route declares because something else writes them. A new action of
 * Stage 6 that no route declares has to be listed here with its writer, so "nobody writes it" is a
 * decision and not an oversight.
 */
export const STAGE6_WRITTEN_OUTSIDE_ROUTES: Readonly<Record<string, string>> = {
  'subscription.surplus_flagged':
    'Written by the settlement of the payments (a job, as the system) when a second approved payment arrives for a period already paid: it is recorded as surplus and flagged for the operator.',
  'export.cancellation.removed':
    'Written by the worker pass that removes the plain export of a cancelled organization once the download window is over and the archive that replaces it was verified (removeSpentExports, as the system), one entry per package.',
  'subscription.refunded':
    'Written by the refund of a payment: the operator asks through the console (`POST /operator/tenants/:id/subscription/payments/:paymentId/refund`, whose routes live in the operator console and not in the tenant application), or the platform gives back a duplicate of an overdue link by itself; the service refunds through the gateway and writes the entry in the tenant trail, and the console writes the same one in the platform trail with the operator id.',
  'subscription.preapproval_cancelled':
    'Written by the job that reconciles the subscription, or by the checkout, when a preapproval that was superseded or that charged next to the one the subscription holds is cancelled at the provider (as the system).',
  'subscription.parked_resolved':
    'Written by the operator console (`POST /operator/tenants/:id/subscription/resolve-parked`): the operator looked at a subscription parked for a person and let it go, with a reason. The console is not part of the tenant application, so no tenant route declares it.',
  'subscription.surplus_reviewed':
    'Written by the operator console (`POST /operator/tenants/:id/subscription/payments/:paymentId/review`): the operator looked at a payment flagged as a surplus and decided. The console is not part of the tenant application, so no tenant route declares it.',
};

/**
 * Routes of Stage 6 that change something and audit nothing, with the reason.
 *
 * - the notice of Mercado Pago only queues a check of the subscription; whatever the check settles
 *   is audited by the check, as the system;
 * - resending or renewing the verification link changes no organization data and sends the same
 *   kind of message again (the signup itself is audited when it is made);
 * - the release link of the archive belongs to an organization that is gone: the download is
 *   audited in the platform trail (`archive.released`, phase `downloaded`).
 */
export const STAGE6_NO_AUDIT_ON_PURPOSE: Readonly<Record<string, string>> = {
  'POST /webhooks/mercadopago':
    'It only verifies the signature and queues the check of the subscription; what the check settles is audited by the check (the system as actor).',
  'POST /public/signup/resend':
    'It sends the verification link again to an organization that exists unverified; nothing of it changes, and the signup is audited as signup.created.',
  'POST /public/signup/renew':
    'It issues a new verification link for an expired one; nothing of the organization changes, and the signup is audited as signup.created and signup.verified.',
  'POST /public/:slug/archive-release/:token':
    'The organization is gone: the download of a release is audited in the platform trail (archive.released, phase downloaded).',
};

/**
 * What is wrong with the audit trail of Stage 6, in this order: for each route of these modules that
 * changes data (a route that declares nothing, one that audits nothing without a reason in the table,
 * a table entry that is stale), then for each action (one nobody writes, one listed as written
 * elsewhere that a route now declares).
 */
export function findStage6AuditProblems(routes: ReadonlyMap<string, Declared>): string[] {
  const problems: string[] = [];
  for (const [route, declared] of routes) {
    if (!isStage6Route(route) || !MUTATING.has(route.slice(0, route.indexOf(' ')))) continue;
    const listed = route in STAGE6_NO_AUDIT_ON_PURPOSE;
    if (declared === undefined || (declared !== 'none' && declared.length === 0)) {
      problems.push(`${route} declares nothing about its audit trail`);
    } else if (declared === 'none' && !listed) {
      problems.push(`${route} audits nothing and the table does not say why`);
    } else if (declared !== 'none' && listed) {
      problems.push(
        `${route} is listed as auditing nothing but it declares ${declared.join(', ')}`,
      );
    }
  }
  for (const route of Object.keys(STAGE6_NO_AUDIT_ON_PURPOSE)) {
    if (!routes.has(route)) problems.push(`${route} is listed as auditing nothing but it is gone`);
  }

  for (const action of STAGE6_AUDIT_ACTIONS) {
    const writers = [...routes]
      .filter(([, declared]) => declared !== undefined && declared !== 'none')
      .filter(([, declared]) => (declared as readonly AuditAction[]).includes(action))
      .map(([route]) => route);
    const outside = action in STAGE6_WRITTEN_OUTSIDE_ROUTES;
    if (writers.length === 0 && !outside) {
      problems.push(`${action} is written by no route and no other writer is named for it`);
    }
    if (writers.length > 0 && outside) {
      problems.push(
        `${action} is listed as written outside the routes but ${writers[0] ?? ''} declares it`,
      );
    }
  }
  return problems;
}
