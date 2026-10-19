import { sql } from 'drizzle-orm';

import { SYSTEM_USER_ID, type WithTenant } from '../../../../platform/db/tenant-context.js';

/**
 * The figures the reports must show for the data the Stage 4 seed left (tasks 4.64), read straight
 * from the tables with plain SQL, by a path that shares nothing with the report read models. A test
 * compares them with `GET /reports/financial` and `GET /reports/cash`: if the seed and the reports
 * ever disagree about a total, one of the two is wrong.
 *
 * The reports have no tables of their own, so this is what "the reports have demo data" means: the
 * money of the seed, and the numbers that it adds up to.
 */
export interface SeededTotals {
  charged: { count: number; totalCents: number; patientCents: number; payerCents: number };
  voided: { count: number; totalCents: number };
  payments: { count: number; cents: number };
  /** Refunds and corrections: both reduce what was collected. */
  refunds: { count: number; cents: number };
  collectedCents: number;
  /** What patients still owe on the charges that are not voided (never below zero per charge). */
  outstanding: { chargeCount: number; cents: number };
  invoiced: { invoicedCents: number; creditedCents: number; netCents: number; documents: number };
  cash: {
    sessions: number;
    openSessions: number;
    closedSessions: number;
    openingCents: number;
    countedCents: number;
    differenceCents: number;
    sessionsWithDifference: number;
  };
}

const num = (value: unknown) => Number(value ?? 0);

export async function readSeededTotals(
  withTenant: WithTenant,
  tenantId: string,
): Promise<SeededTotals> {
  return withTenant({ tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
    const one = async (query: ReturnType<typeof sql>) => (await tx.execute(query)).rows[0] ?? {};
    const charged = await one(sql`
      SELECT count(DISTINCT c.id) AS n,
             coalesce(sum(l.amount_cents), 0) AS total,
             coalesce(sum(l.amount_cents) FILTER (WHERE l.portion = 'patient'), 0) AS patient,
             coalesce(sum(l.amount_cents) FILTER (WHERE l.portion = 'payer'), 0) AS payer
        FROM charge c JOIN charge_line l ON l.charge_id = c.id
       WHERE c.status <> 'voided'`);
    const voided = await one(sql`
      SELECT count(DISTINCT c.id) AS n, coalesce(sum(l.amount_cents), 0) AS total
        FROM charge c JOIN charge_line l ON l.charge_id = c.id
       WHERE c.status = 'voided'`);
    const payments = await one(
      sql`SELECT count(*) AS n, coalesce(sum(amount_cents), 0) AS cents FROM payment`,
    );
    const refunds = await one(
      sql`SELECT count(*) AS n, coalesce(sum(amount_cents), 0) AS cents FROM payment_reversal`,
    );
    const outstanding = await one(sql`
      SELECT count(*) FILTER (WHERE owed > 0) AS n, coalesce(sum(owed), 0) AS cents
        FROM (
          SELECT greatest(0,
                   coalesce((SELECT sum(l.amount_cents) FROM charge_line l
                              WHERE l.charge_id = c.id AND l.portion = 'patient'), 0)
                   - (coalesce((SELECT sum(p.amount_cents) FROM payment p WHERE p.charge_id = c.id), 0)
                      - coalesce((SELECT sum(r.amount_cents) FROM payment_reversal r
                                   WHERE r.charge_id = c.id), 0))) AS owed
            FROM charge c WHERE c.status <> 'voided') owed_by_charge`);
    const invoiced = await one(sql`
      SELECT coalesce(sum(total_cents) FILTER (WHERE credit_note_of_id IS NULL), 0) AS invoiced,
             coalesce(sum(total_cents) FILTER (WHERE credit_note_of_id IS NOT NULL), 0) AS credited,
             count(*) AS documents
        FROM invoice WHERE status IN ('issued', 'manual')`);
    const cash = await one(sql`
      SELECT count(*) AS sessions,
             count(*) FILTER (WHERE status = 'open') AS open,
             count(*) FILTER (WHERE status = 'closed') AS closed,
             coalesce(sum(opening_cents), 0) AS opening,
             coalesce(sum(counted_cents), 0) AS counted,
             coalesce(sum(difference_cents), 0) AS difference,
             count(*) FILTER (WHERE difference_cents <> 0) AS with_difference
        FROM cash_session`);

    const collectedCents = num(payments['cents']) - num(refunds['cents']);
    return {
      charged: {
        count: num(charged['n']),
        totalCents: num(charged['total']),
        patientCents: num(charged['patient']),
        payerCents: num(charged['payer']),
      },
      voided: { count: num(voided['n']), totalCents: num(voided['total']) },
      payments: { count: num(payments['n']), cents: num(payments['cents']) },
      refunds: { count: num(refunds['n']), cents: num(refunds['cents']) },
      collectedCents,
      outstanding: { chargeCount: num(outstanding['n']), cents: num(outstanding['cents']) },
      invoiced: {
        invoicedCents: num(invoiced['invoiced']),
        creditedCents: num(invoiced['credited']),
        netCents: num(invoiced['invoiced']) - num(invoiced['credited']),
        documents: num(invoiced['documents']),
      },
      cash: {
        sessions: num(cash['sessions']),
        openSessions: num(cash['open']),
        closedSessions: num(cash['closed']),
        openingCents: num(cash['opening']),
        countedCents: num(cash['counted']),
        differenceCents: num(cash['difference']),
        sessionsWithDifference: num(cash['with_difference']),
      },
    };
  });
}
