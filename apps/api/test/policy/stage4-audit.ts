import {
  BILLING_AUDIT_ACTIONS,
  INVOICING_AUDIT_ACTIONS,
  REPORTS_AUDIT_ACTIONS,
  type AuditAction,
} from '@consultorio/contracts';

import { isStage4Route } from './stage4-routes.js';

/** What a route declares about its audit trail (`config.audits`). */
type Declared = readonly AuditAction[] | 'none' | undefined;

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Every audit action that billing, invoicing and reports added to the catalogue. */
export const STAGE4_AUDIT_ACTIONS: readonly AuditAction[] = [
  ...BILLING_AUDIT_ACTIONS,
  ...INVOICING_AUDIT_ACTIONS,
  ...REPORTS_AUDIT_ACTIONS,
];

/**
 * Actions that no route declares because something else writes them. A new action of Stage 4 that
 * no route declares has to be listed here with its writer, so "nobody writes it" is a decision and
 * not an oversight.
 */
export const WRITTEN_OUTSIDE_ROUTES: Readonly<Record<string, string>> = {
  'charge.flagged':
    'The listener of billing on the appointment events (a no-show or a late cancellation flags the charge; it never voids it).',
  'invoice.issued':
    'The afip.issue job: the voucher is issued by the worker, not by the request that asked for it.',
};

/**
 * Routes of Stage 4 that change something and audit nothing, with the reason. Both only hand out
 * access or refuse; the file that is served is audited by the door of the files, and the void of an
 * invoice is always refused (an issued invoice is never voided, the way back is a credit note).
 */
export const NO_AUDIT_ON_PURPOSE: Readonly<Record<string, string>> = {
  'POST /billing/exports/:id/download':
    'It only builds the link; the download is audited as document.downloaded by GET /files/:token.',
  'POST /invoices/:id/void':
    'It always answers 409: an issued invoice is never voided, so nothing happens that could be audited.',
};

/**
 * What is wrong with the audit trail of Stage 4, in this order: for each route of billing, invoicing
 * or reports that changes data (a route that declares nothing, one that audits nothing without a
 * reason in the table, a table entry that is stale), then for each action (one nobody writes, one
 * listed as written elsewhere that a route now declares).
 */
export function findStage4AuditProblems(routes: ReadonlyMap<string, Declared>): string[] {
  const problems: string[] = [];

  for (const [route, declared] of routes) {
    if (!isStage4Route(route) || !MUTATING.has(route.slice(0, route.indexOf(' ')))) continue;
    const listed = route in NO_AUDIT_ON_PURPOSE;
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
  for (const route of Object.keys(NO_AUDIT_ON_PURPOSE)) {
    if (!routes.has(route)) problems.push(`${route} is listed as auditing nothing but it is gone`);
  }

  for (const action of STAGE4_AUDIT_ACTIONS) {
    const writers = [...routes]
      .filter(([, declared]) => declared !== undefined && declared !== 'none')
      .filter(([, declared]) => (declared as readonly AuditAction[]).includes(action))
      .map(([route]) => route);
    const outside = action in WRITTEN_OUTSIDE_ROUTES;
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
