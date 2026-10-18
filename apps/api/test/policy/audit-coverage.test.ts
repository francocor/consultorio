import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { AUDIT_ACTIONS, type AuditAction } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { createRuntimeDb } from '../../src/platform/db/pool.js';
import { buildTestApplication } from '../support/app.js';

import { AUDIT_SCENARIOS } from './audit-scenarios.js';
import {
  NO_AUDIT_ON_PURPOSE,
  STAGE4_AUDIT_ACTIONS,
  WRITTEN_OUTSIDE_ROUTES,
  findStage4AuditProblems,
} from './stage4-audit.js';

/**
 * Audit coverage (audit-log, "Mandatory events"). Two rules keep the trail honest as the product
 * grows:
 *
 * 1. Every audit action has a scenario: an integration test that names it, or a pending note that
 *    says which stage will write it. A new action cannot ship unproven.
 * 2. Every route that changes something declares what it audits (`config.audits`), or says
 *    `'none'`. A new mutating endpoint cannot ship without a decision about its trail.
 */

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

type Declared = readonly AuditAction[] | 'none' | undefined;

/** Mutating routes that declare nothing about their audit trail. */
export function findUntaggedMutatingRoutes(routes: ReadonlyMap<string, Declared>): string[] {
  return [...routes]
    .filter(([route, declared]) => {
      const method = route.slice(0, route.indexOf(' '));
      return (
        MUTATING.has(method) &&
        (declared === undefined || (declared !== 'none' && declared.length === 0))
      );
    })
    .map(([route]) => route);
}

async function realRoutes() {
  const app = buildTestApplication(createRuntimeDb('postgres://nobody:nothing@127.0.0.1:1/none'));
  await app.ready();
  const routes = new Map(app.routeAudits);
  await app.close();
  return routes;
}

describe('every audit action has a scenario', () => {
  it('registers the whole catalogue (the guard is not silently empty)', () => {
    expect(Object.keys(AUDIT_SCENARIOS).sort()).toEqual([...AUDIT_ACTIONS].sort());
    expect(AUDIT_ACTIONS.length).toBeGreaterThan(40);
  });

  it.each(AUDIT_ACTIONS)(
    '%s is proven by a test that names it, or is pending a stage',
    (action) => {
      const scenario = AUDIT_SCENARIOS[action];

      if ('pending' in scenario) {
        expect(scenario.pending, action).toMatch(/Stage \d|S\d\.\d+/);
        return;
      }
      const path = `${REPO}${scenario.test}`;
      expect(existsSync(path), `${scenario.test} does not exist`).toBe(true);
      expect(readFileSync(path, 'utf8'), `${scenario.test} never names '${action}'`).toContain(
        `'${action}'`,
      );
    },
  );
});

describe('every mutating route declares what it audits', () => {
  it('enumerates the routes of the real application (the guard is not silently empty)', async () => {
    const routes = await realRoutes();

    expect(routes.size).toBeGreaterThan(60);
    expect(
      [...routes.keys()].filter((route) => MUTATING.has(route.split(' ')[0] ?? '')).length,
    ).toBeGreaterThan(40);
  });

  it('leaves no POST, PUT, PATCH or DELETE without an audit declaration', async () => {
    const routes = await realRoutes();

    expect(findUntaggedMutatingRoutes(routes)).toEqual([]);
  });

  it('only declares actions that exist and that have a scenario', async () => {
    const routes = await realRoutes();

    const unknown = [...routes].flatMap(([route, declared]) =>
      declared === undefined || declared === 'none'
        ? []
        : declared
            .filter((action) => !(action in AUDIT_SCENARIOS))
            .map((action) => `${route}: ${action}`),
    );

    expect(unknown).toEqual([]);
  });

  describe('the check itself', () => {
    it('flags a mutating route with no declaration, and an empty one', () => {
      const routes = new Map<string, Declared>([
        ['POST /things', undefined],
        ['PUT /things/:id', []],
        ['PATCH /things/:id', ['patient.updated']],
        ['DELETE /things/:id', 'none'],
        ['GET /things', undefined],
      ]);

      expect(findUntaggedMutatingRoutes(routes)).toEqual(['POST /things', 'PUT /things/:id']);
    });
  });
});

/**
 * Stage 4 (billing, invoicing, reports), tasks 4.62 (BIL-15, INV-12). The catalogue rule above is
 * the floor; money needs a stricter one, because the trail of a payment, a voucher or a cash
 * register is what an owner shows an accountant:
 *
 * - every action of Stage 4 is proven by a test (never "pending") that also reads the trail back;
 * - every action is written by a route, or says which other writer owns it;
 * - a route that changes money declares what it audits, and the two that audit nothing say why.
 */
describe('the audit trail of Stage 4', () => {
  it('has a scenario for every action of billing, invoicing and reports, none of them pending', () => {
    expect(STAGE4_AUDIT_ACTIONS.length).toBeGreaterThanOrEqual(21);
    for (const action of STAGE4_AUDIT_ACTIONS) {
      const scenario = AUDIT_SCENARIOS[action];

      expect('test' in scenario, `${action} is still pending`).toBe(true);
      if (!('test' in scenario)) continue;
      const text = readFileSync(`${REPO}${scenario.test}`, 'utf8');
      expect(text, `${scenario.test} does not read the audit trail back`).toMatch(
        /auditEvent|audit_event|auditRows/,
      );
    }
  });

  it('finds an author for every action: a route declares it, or the table names the other writer', async () => {
    const routes = await realRoutes();

    expect(findStage4AuditProblems(routes)).toEqual([]);
  });

  describe('the check itself', () => {
    const declared = (extra: Record<string, Declared> = {}) => {
      const routes = new Map<string, Declared>();
      for (const action of STAGE4_AUDIT_ACTIONS) {
        if (action in WRITTEN_OUTSIDE_ROUTES) continue;
        routes.set(`POST /billing/${action}`, [action]);
      }
      for (const route of Object.keys(NO_AUDIT_ON_PURPOSE)) routes.set(route, 'none');
      for (const [route, audits] of Object.entries(extra)) routes.set(route, audits);
      return routes;
    };

    it('accepts a complete picture', () => {
      expect(findStage4AuditProblems(declared())).toEqual([]);
    });

    it('flags a money route that declares nothing, one that audits nothing without saying why, and an action nobody writes', () => {
      const routes = declared({
        'POST /billing/new-thing': undefined,
        'POST /invoices/unexplained': 'none',
      });
      routes.delete('POST /billing/payment.recorded');

      expect(findStage4AuditProblems(routes)).toEqual([
        'POST /billing/new-thing declares nothing about its audit trail',
        'POST /invoices/unexplained audits nothing and the table does not say why',
        'payment.recorded is written by no route and no other writer is named for it',
      ]);
    });

    it('flags a table entry that went stale', () => {
      const routes = declared({ 'POST /billing/export.requested': ['export.requested'] });
      routes.set('POST /invoices/:id/void', ['invoice.rejected']);
      routes.set('POST /billing/more', ['charge.flagged']);

      expect(findStage4AuditProblems(routes)).toEqual([
        'POST /invoices/:id/void is listed as auditing nothing but it declares invoice.rejected',
        'charge.flagged is listed as written outside the routes but POST /billing/more declares it',
      ]);
    });
  });
});
