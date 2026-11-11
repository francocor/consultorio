import { and, eq, gt, ne, sql } from 'drizzle-orm';

import { otpChallenge } from '../../db/schema/booking-submission.js';

import type { Tx } from './tenant-context.js';

/**
 * The purpose of a decoy challenge of the portal: the answer for an address that must not get a code
 * (JD-S5 R1-A-T3). Nothing that serves a code reads it, and it counts for nothing among the sends of
 * an address (JD-S5 R2-1, R3-1).
 */
export const DECOY_PURPOSE = 'portal_decoy';

const HOUR_MS = 3_600_000;

/**
 * How many codes were REALLY sent to an address in the last hour, whatever they were for (booking,
 * waitlist or portal). The one count behind the three-sends-an-hour limit of every module that mails
 * a code: a decoy sends nothing, so it is never part of it (JD-S5 R3-1: a stranger must not be able
 * to use up the budget of a person who is booking or joining a waitlist).
 */
export async function realSendsInLastHour(tx: Tx, email: string, now: Date): Promise<number> {
  const rows = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(otpChallenge)
    .where(
      and(
        eq(otpChallenge.email, email),
        ne(otpChallenge.purpose, DECOY_PURPOSE),
        gt(otpChallenge.createdAt, new Date(now.getTime() - HOUR_MS)),
      ),
    );
  return rows[0]?.n ?? 0;
}

/** How many decoys were written for an address in the last hour (the cap of the decoys, apart). */
export async function decoysInLastHour(tx: Tx, email: string, now: Date): Promise<number> {
  const rows = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(otpChallenge)
    .where(
      and(
        eq(otpChallenge.email, email),
        eq(otpChallenge.purpose, DECOY_PURPOSE),
        gt(otpChallenge.createdAt, new Date(now.getTime() - HOUR_MS)),
      ),
    );
  return rows[0]?.n ?? 0;
}
