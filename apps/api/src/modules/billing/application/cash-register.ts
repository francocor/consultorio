import {
  CASH_SESSION_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_REVERSAL_KINDS,
  money,
  type CashCloseRequest,
  type CashEntryDto,
  type CashOpenRequest,
  type CashSessionDetailResponse,
  type CashSessionDto,
  type CashSessionListQuery,
} from '@consultorio/contracts';
import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';

import { charge } from '../../../db/schema/billing-charges.js';
import { cashSession, payment, paymentReversal } from '../../../db/schema/billing-payments.js';
import { patient } from '../../../db/schema/patients.js';
import { location } from '../../../db/schema/tenant.js';
import { audit } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { visibleLocationIds, type LocationViewer } from '../../access/index.js';
import { differenceOf, summarizeSession, type CashMovement } from '../domain/cash-summary.js';

import { CURRENT_TENANT, UNIQUE_VIOLATION, sqlState, type BillingActor } from './common.js';

function oneOf<T extends string>(values: readonly T[], value: string): T {
  const found = values.find((candidate) => candidate === value);
  if (found === undefined) throw new Error(`unexpected value "${value}" in a cash register`);
  return found;
}

/**
 * The locations whose register a viewer may operate (authorization, "Membership in locations"):
 * owners and administrators every one, everybody else the ones they are assigned to. A professional
 * who was granted `cash.operate` is held to the same rule.
 */
async function operableLocations(tx: Tx, viewer: LocationViewer): Promise<string[] | 'all'> {
  return visibleLocationIds(tx, viewer);
}

async function assertMayOperate(tx: Tx, viewer: LocationViewer, locationId: string): Promise<void> {
  const allowed = await operableLocations(tx, viewer);
  const [place] = await tx
    .select({ id: location.id })
    .from(location)
    .where(eq(location.id, locationId));
  // A place the viewer does not work at answers like one that does not exist.
  if (!place || (allowed !== 'all' && !allowed.includes(locationId)))
    throw new AppError('not_found');
}

/** The id of the register that is open at a location, if there is one. */
export async function findOpenSession(tx: Tx, locationId: string): Promise<string | undefined> {
  const [open] = await tx
    .select({ id: cashSession.id })
    .from(cashSession)
    .where(and(eq(cashSession.locationId, locationId), eq(cashSession.status, 'open')));
  return open?.id;
}

interface SessionEntries {
  movements: CashMovement[];
  entries: CashEntryDto[];
}

/** What went into and out of some registers, as arithmetic and as the lines the screen lists. */
async function entriesOf(
  tx: Tx,
  sessionIds: readonly string[],
): Promise<Map<string, SessionEntries>> {
  const result = new Map<string, SessionEntries>(
    sessionIds.map((id) => [id, { movements: [], entries: [] }]),
  );
  if (sessionIds.length === 0) return result;
  const ids = [...sessionIds];

  const [payments, reversals] = await Promise.all([
    tx
      .select({
        id: payment.id,
        sessionId: payment.cashSessionId,
        chargeId: payment.chargeId,
        method: payment.method,
        amountCents: payment.amountCents,
        at: payment.paidAt,
        givenNames: patient.givenNames,
        familyName: patient.familyName,
      })
      .from(payment)
      .innerJoin(charge, eq(charge.id, payment.chargeId))
      .innerJoin(patient, eq(patient.id, charge.patientId))
      .where(inArray(payment.cashSessionId, ids))
      .orderBy(asc(payment.paidAt), asc(payment.id)),
    tx
      .select({
        id: paymentReversal.id,
        sessionId: paymentReversal.cashSessionId,
        paymentId: paymentReversal.paymentId,
        chargeId: paymentReversal.chargeId,
        method: payment.method,
        amountCents: paymentReversal.amountCents,
        kind: paymentReversal.kind,
        reason: paymentReversal.reason,
        at: paymentReversal.reversedAt,
        givenNames: patient.givenNames,
        familyName: patient.familyName,
      })
      .from(paymentReversal)
      .innerJoin(payment, eq(payment.id, paymentReversal.paymentId))
      .innerJoin(charge, eq(charge.id, paymentReversal.chargeId))
      .innerJoin(patient, eq(patient.id, charge.patientId))
      .where(inArray(paymentReversal.cashSessionId, ids))
      .orderBy(asc(paymentReversal.reversedAt), asc(paymentReversal.id)),
  ]);

  for (const row of payments) {
    const bucket = row.sessionId ? result.get(row.sessionId) : undefined;
    if (!bucket) continue;
    const method = oneOf(PAYMENT_METHODS, row.method);
    bucket.movements.push({ direction: 'in', method, amountCents: row.amountCents });
    bucket.entries.push({
      kind: 'payment',
      id: row.id,
      paymentId: row.id,
      chargeId: row.chargeId,
      patientName: `${row.givenNames} ${row.familyName}`.trim(),
      method,
      amountCents: money(row.amountCents),
      reason: null,
      at: row.at.toISOString(),
    });
  }
  for (const row of reversals) {
    const bucket = row.sessionId ? result.get(row.sessionId) : undefined;
    if (!bucket) continue;
    const method = oneOf(PAYMENT_METHODS, row.method);
    bucket.movements.push({ direction: 'out', method, amountCents: row.amountCents });
    bucket.entries.push({
      kind: oneOf(PAYMENT_REVERSAL_KINDS, row.kind),
      id: row.id,
      paymentId: row.paymentId,
      chargeId: row.chargeId,
      patientName: `${row.givenNames} ${row.familyName}`.trim(),
      method,
      amountCents: money(row.amountCents),
      reason: row.reason,
      at: row.at.toISOString(),
    });
  }
  for (const bucket of result.values()) {
    bucket.entries.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  }
  return result;
}

const sessionColumns = { row: cashSession, locationName: location.name };

function sessionQuery(tx: Tx) {
  return tx
    .select(sessionColumns)
    .from(cashSession)
    .innerJoin(location, eq(location.id, cashSession.locationId));
}

type SessionView = Awaited<ReturnType<typeof sessionQuery>>[number];

function toSessionDto(view: SessionView, entries: SessionEntries): CashSessionDto {
  const { row } = view;
  const summary = summarizeSession(row.openingCents, entries.movements);
  const closed = row.status === 'closed';
  return {
    id: row.id,
    locationId: row.locationId,
    locationName: view.locationName,
    status: oneOf(CASH_SESSION_STATUSES, row.status),
    openedAt: row.openedAt.toISOString(),
    openedBy: row.openedBy,
    openingCents: money(row.openingCents),
    closedAt: row.closedAt?.toISOString() ?? null,
    closedBy: row.closedBy,
    // A closed register shows what was written when it closed; an open one, what it holds now.
    expectedCents: money(
      closed ? (row.expectedCents ?? summary.expectedCents) : summary.expectedCents,
    ),
    countedCents: row.countedCents === null ? null : money(row.countedCents),
    differenceCents: row.differenceCents === null ? null : money(row.differenceCents),
    differenceReason: row.differenceReason,
    cashInCents: money(summary.cashInCents),
    cashOutCents: money(summary.cashOutCents),
    byMethod: summary.byMethod.map((total) => ({
      method: total.method,
      count: total.count,
      paymentsCents: money(total.paymentsCents),
      refundsCents: money(total.refundsCents),
      netCents: money(total.netCents),
    })),
  };
}

async function loadSessionViews(
  tx: Tx,
  conditions: readonly (SQL | undefined)[],
  limit = 200,
): Promise<{ sessions: CashSessionDto[]; entries: Map<string, SessionEntries> }> {
  const views = await sessionQuery(tx)
    .where(and(...conditions))
    .orderBy(desc(cashSession.openedAt), desc(cashSession.id))
    .limit(limit);
  const entries = await entriesOf(
    tx,
    views.map((view) => view.row.id),
  );
  return {
    sessions: views.map((view) =>
      toSessionDto(view, entries.get(view.row.id) ?? { movements: [], entries: [] }),
    ),
    entries,
  };
}

/** The registers a viewer may see, newest first. */
export async function listSessions(
  tx: Tx,
  input: { query: CashSessionListQuery; viewer: LocationViewer },
): Promise<CashSessionDto[]> {
  const allowed = await operableLocations(tx, input.viewer);
  const day = sql`(${cashSession.openedAt} at time zone ${location.timeZone})::date`;
  const { query } = input;
  const { sessions } = await loadSessionViews(tx, [
    allowed === 'all'
      ? undefined
      : allowed.length === 0
        ? sql`false`
        : inArray(cashSession.locationId, allowed),
    query.locationId ? eq(cashSession.locationId, query.locationId) : undefined,
    query.status ? eq(cashSession.status, query.status) : undefined,
    query.from ? gte(day, query.from) : undefined,
    query.to ? lte(day, query.to) : undefined,
  ]);
  return sessions;
}

/** One register with its entries, if the viewer may see it. */
export async function sessionDetail(
  tx: Tx,
  input: { id: string; viewer: LocationViewer },
): Promise<CashSessionDetailResponse> {
  const allowed = await operableLocations(tx, input.viewer);
  const { sessions, entries } = await loadSessionViews(tx, [eq(cashSession.id, input.id)], 1);
  const session = sessions[0];
  if (!session || (allowed !== 'all' && !allowed.includes(session.locationId))) {
    throw new AppError('not_found');
  }
  return { session, entries: entries.get(session.id)?.entries ?? [] };
}

/** The register that is open at a location, or null: the desk offers to open one. */
export async function currentSession(
  tx: Tx,
  input: { locationId: string; viewer: LocationViewer },
): Promise<CashSessionDto | null> {
  await assertMayOperate(tx, input.viewer, input.locationId);
  const { sessions } = await loadSessionViews(
    tx,
    [eq(cashSession.locationId, input.locationId), eq(cashSession.status, 'open')],
    1,
  );
  return sessions[0] ?? null;
}

export type OpenOutcome =
  { opened: true; session: CashSessionDto } | { opened: false; existingSessionId: string };

/** Opens the register of a location with the cash it starts with. One at a time per location. */
export async function openSession(
  tx: Tx,
  input: { request: CashOpenRequest; actor: BillingActor; viewer: LocationViewer; now: Date },
): Promise<OpenOutcome> {
  const { request } = input;
  await assertMayOperate(tx, input.viewer, request.locationId);

  const existing = await findOpenSession(tx, request.locationId);
  if (existing) return { opened: false, existingSessionId: existing };

  let id: string;
  try {
    id = await tx.transaction(async (inner) => {
      const [row] = await inner
        .insert(cashSession)
        .values({
          tenantId: CURRENT_TENANT,
          locationId: request.locationId,
          openedBy: input.actor.userId,
          openedAt: input.now,
          openingCents: request.openingCents,
        })
        .returning({ id: cashSession.id });
      if (!row) throw new Error('cash session insert returned no row');
      return row.id;
    });
  } catch (error) {
    if (sqlState(error) === UNIQUE_VIOLATION) {
      const winner = await findOpenSession(tx, request.locationId);
      if (winner) return { opened: false, existingSessionId: winner };
    }
    throw error;
  }

  await audit(tx, {
    action: 'cash.opened',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'cash_session',
    resourceId: id,
    metadata: { locationId: request.locationId, openingCents: request.openingCents },
  });
  const { sessions } = await loadSessionViews(tx, [eq(cashSession.id, id)], 1);
  const session = sessions[0];
  if (!session) throw new Error('the register just opened cannot be read');
  return { opened: true, session };
}

/**
 * Closes a register with the cash that was counted. The expected cash is computed here from the
 * entries, never taken from the client; a difference needs a reason; the closed register and its
 * entries never change again.
 */
export async function closeSession(
  tx: Tx,
  input: {
    id: string;
    request: CashCloseRequest;
    actor: BillingActor;
    viewer: LocationViewer;
    now: Date;
  },
): Promise<CashSessionDto> {
  const [row] = await tx
    .select({
      status: cashSession.status,
      locationId: cashSession.locationId,
      openingCents: cashSession.openingCents,
    })
    .from(cashSession)
    .where(eq(cashSession.id, input.id))
    .for('update');
  if (!row) throw new AppError('not_found');
  await assertMayOperate(tx, input.viewer, row.locationId);
  if (row.status === 'closed') throw new AppError('cash_register_closed');

  const entries = (await entriesOf(tx, [input.id])).get(input.id);
  const { expectedCents } = summarizeSession(row.openingCents, entries?.movements ?? []);
  const difference = differenceOf(expectedCents, input.request.countedCents);
  const reason = input.request.differenceReason;
  if (difference !== 0 && reason === undefined) {
    throw new AppError('cash_difference_reason_required', [
      { path: 'differenceReason', i18nKey: 'cash.close.reason_required' },
    ]);
  }

  await tx
    .update(cashSession)
    .set({
      status: 'closed',
      closedAt: input.now,
      closedBy: input.actor.userId,
      expectedCents,
      countedCents: input.request.countedCents,
      differenceCents: difference,
      differenceReason: difference === 0 ? null : (reason ?? null),
    })
    .where(eq(cashSession.id, input.id));
  await audit(tx, {
    action: 'cash.closed',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'cash_session',
    resourceId: input.id,
    metadata: {
      locationId: row.locationId,
      expectedCents,
      countedCents: input.request.countedCents,
      differenceCents: difference,
      ...(difference === 0 || reason === undefined ? {} : { reason }),
    },
  });

  const { sessions } = await loadSessionViews(tx, [eq(cashSession.id, input.id)], 1);
  const closed = sessions[0];
  if (!closed) throw new Error('the register just closed cannot be read');
  return closed;
}
