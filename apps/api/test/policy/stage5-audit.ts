import {
  CONSENT_AUDIT_ACTIONS,
  PORTAL_AUDIT_ACTIONS,
  PRESCRIPTION_AUDIT_ACTIONS,
  type AuditAction,
} from '@consultorio/contracts';

import { isStage5Route } from './stage5-routes.js';

/** What a route declares about its audit trail (`config.audits`). */
type Declared = readonly AuditAction[] | 'none' | undefined;

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Every audit action that consent, prescriptions and the portal added to the catalogue. */
export const STAGE5_AUDIT_ACTIONS: readonly AuditAction[] = [
  ...CONSENT_AUDIT_ACTIONS,
  ...PRESCRIPTION_AUDIT_ACTIONS,
  ...PORTAL_AUDIT_ACTIONS,
];

/**
 * Actions that no mutating route declares because something else writes them. A new action of
 * Stage 5 that no route declares has to be listed here with its writer, so "nobody writes it" is a
 * decision and not an oversight.
 */
export const STAGE5_WRITTEN_OUTSIDE_ROUTES: Readonly<Record<string, string>> = {
  'consent.read':
    'The door of the files and the portal entry point: opening a signed record writes it once, when the file is served (not when the link is asked for). The reads of the other modules declare theirs on the route.',
};

/**
 * Routes of Stage 5 that change something and audit nothing, with the reason.
 *
 * - declining a consent ends the request: the request keeps the decision and the date, and the
 *   catalogue has no action for it;
 * - the link of a prescription document only builds the address; the PDF is audited when served;
 * - the webhook of the provider only queues a check of the prescription; whatever the check settles
 *   (a cancellation on the provider's side) is audited by the check, as the system.
 */
export const STAGE5_NO_AUDIT_ON_PURPOSE: Readonly<Record<string, string>> = {
  'POST /consents/requests/:id/decline':
    'The request keeps the decision and the day it ended (status declined, closed_at); the catalogue has no action for it.',
  'POST /prescriptions/:id/document-link':
    'It only builds the link; the download is audited as prescription.downloaded by GET /files/:token.',
  'POST /webhooks/erx':
    'It only queues the check of the prescription; what the check settles is audited by the check (the system as actor).',
};

/**
 * What is wrong with the audit trail of Stage 5, in this order: for each route of these modules that
 * changes data (a route that declares nothing, one that audits nothing without a reason in the
 * table, a table entry that is stale), then for each action (one nobody writes, one listed as
 * written elsewhere that a route now declares).
 */
export function findStage5AuditProblems(routes: ReadonlyMap<string, Declared>): string[] {
  const problems: string[] = [];
  for (const [route, declared] of routes) {
    if (!isStage5Route(route) || !MUTATING.has(route.slice(0, route.indexOf(' ')))) continue;
    const listed = route in STAGE5_NO_AUDIT_ON_PURPOSE;
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
  for (const route of Object.keys(STAGE5_NO_AUDIT_ON_PURPOSE)) {
    if (!routes.has(route)) problems.push(`${route} is listed as auditing nothing but it is gone`);
  }

  for (const action of STAGE5_AUDIT_ACTIONS) {
    const writers = [...routes]
      .filter(([, declared]) => declared !== undefined && declared !== 'none')
      .filter(([, declared]) => (declared as readonly AuditAction[]).includes(action))
      .map(([route]) => route);
    const outside = action in STAGE5_WRITTEN_OUTSIDE_ROUTES;
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
