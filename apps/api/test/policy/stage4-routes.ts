import type { RouteCategory } from '@consultorio/contracts';

/**
 * The read-only category of every route of Stage 4 (billing, invoicing, reports), decided once and
 * written down (tenancy, "Read-only tenant and its allowlist"; billing-payments, invoicing and
 * reports have a read-only requirement each).
 *
 * - `read`: a screen or a list. It keeps working when the organization is read-only.
 * - `export`: a request for a file, or the link to one. It keeps working too, so the last month can
 *   still be taken out of an organization that stopped paying.
 * - `write`: it creates or changes money, a price, a voucher or the fiscal settings. A read-only
 *   organization is refused with 402.
 *
 * A route of these modules that is not in this table fails `route-categories.test.ts`; that is the
 * point: the person who adds it has to decide, here, whether it may run in a read-only
 * organization. HEAD routes are derived from the GET ones and are not listed.
 */
export const STAGE4_ROUTES: Readonly<Record<string, RouteCategory>> = {
  // Billing: prices and payers.
  'GET /billing/payers': 'read',
  'POST /billing/payers': 'write',
  'PATCH /billing/payers/:id': 'write',
  'GET /billing/prices': 'read',
  'POST /billing/prices': 'write',
  'PATCH /billing/prices/:id': 'write',
  'GET /billing/price-quote': 'read',
  'POST /billing/payer-prices': 'write',
  'PATCH /billing/payer-prices/:id': 'write',
  // Billing: charges, payments and refunds.
  'POST /billing/charges': 'write',
  'GET /billing/charges': 'read',
  'GET /billing/charges/:id': 'read',
  'POST /billing/charges/:id/void': 'write',
  'POST /billing/charges/:id/lines': 'write',
  'POST /billing/charges/:id/payments': 'write',
  'POST /billing/payments/:id/refund': 'write',
  'POST /billing/payments/:id/correct': 'write',
  'GET /billing/receivables': 'read',
  // Billing: the cash register.
  'POST /billing/cash/sessions': 'write',
  'GET /billing/cash/sessions': 'read',
  'GET /billing/cash/current': 'read',
  'GET /billing/cash/sessions/:id': 'read',
  'POST /billing/cash/sessions/:id/close': 'write',
  // Billing: exports.
  'POST /billing/exports': 'export',
  'GET /billing/exports': 'read',
  'GET /billing/exports/:id': 'read',
  'POST /billing/exports/:id/download': 'export',
  // Invoicing: fiscal settings.
  'GET /invoicing/config': 'read',
  'GET /invoicing/readiness': 'read',
  'GET /invoicing/options': 'read',
  'PUT /invoicing/profile': 'write',
  'POST /invoicing/points-of-sale': 'write',
  'PATCH /invoicing/points-of-sale/:id': 'write',
  'PUT /invoicing/credentials': 'write',
  // Invoicing: vouchers. Issuing and credit notes are writes; the queued ones are sent by a job of
  // the `afip_submission` class, which is not a route.
  'POST /invoices': 'write',
  'POST /invoices/manual': 'write',
  'GET /invoices': 'read',
  'GET /invoices/:id': 'read',
  'GET /invoices/:id/pdf-link': 'read',
  'POST /invoices/:id/credit-notes': 'write',
  'POST /invoices/:id/void': 'write',
  // Reports: only reads.
  'GET /reports/options': 'read',
  'GET /reports/operational': 'read',
  'GET /reports/operational/records': 'read',
  'GET /reports/financial': 'read',
  'GET /reports/financial/records': 'read',
  'GET /reports/cash': 'read',
};

const PREFIXES = ['/billing', '/invoicing', '/invoices', '/reports'] as const;

/** True for a route key ("METHOD /url") that belongs to billing, invoicing or reports. */
export function isStage4Route(key: string): boolean {
  const path = key.slice(key.indexOf(' ') + 1);
  return PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function methodOf(key: string): string {
  return key.slice(0, key.indexOf(' '));
}

/**
 * What is wrong with the Stage 4 routes the application registered, in this order: routes missing
 * from the table, routes of the table that are not registered, routes filed in another category
 * than the table says, and routes that change data but sit in the `read` category (a read-only
 * organization could call them).
 */
export function findStage4RouteProblems(registered: ReadonlyMap<string, RouteCategory>): string[] {
  const unknown: string[] = [];
  const missing: string[] = [];
  const wrong: string[] = [];
  const writesFiledAsReads: string[] = [];

  for (const [key, category] of registered) {
    if (!isStage4Route(key)) continue;
    const method = methodOf(key);
    const derived = method === 'HEAD';
    if (derived) {
      if (category !== 'read') {
        wrong.push(`${key} is filed as "${category}" but a HEAD request only reads`);
      }
      continue;
    }
    const expected = STAGE4_ROUTES[key];
    if (expected === undefined) {
      unknown.push(`${key} is registered but not in the table of Stage 4 routes`);
    } else if (expected !== category) {
      wrong.push(`${key} is filed as "${category}" but the table says "${expected}"`);
    }
    if (method !== 'GET' && category === 'read') {
      writesFiledAsReads.push(
        `${key} changes data and is filed as "read", which a read-only organization may call`,
      );
    }
  }
  for (const key of Object.keys(STAGE4_ROUTES)) {
    if (!registered.has(key)) missing.push(`${key} is in the table but not registered`);
  }
  return [...unknown, ...missing, ...wrong, ...writesFiledAsReads];
}
