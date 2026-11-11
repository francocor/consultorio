import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';

import { membership, userAccount } from '../../../db/schema/identity.js';
import {
  statement,
  subscription,
  subscriptionNotice,
  type NoticeKind,
  type StatementRow,
  type SubscriptionNoticeRow,
} from '../../../db/schema/subscriptions.js';
import { tenant } from '../../../db/schema/tenant.js';
import { SYSTEM_USER_ID, type Tx } from '../../../platform/db/tenant-context.js';
import { readOrganizationName } from '../../tenancy/index.js';
import {
  renderAmountChangeRefusedEmail,
  renderDunningEmail,
  renderPastDueEmail,
  renderQuotaReachedEmail,
  renderReadOnlyEmail,
  renderReauthorizationEmail,
  renderRecoveredEmail,
  renderStatementEmail,
  type BillingEmail,
  type StatementFacts,
} from '../assets/es-AR/billing-emails.js';

import { gatewayOf, isSimulated, type SubscriptionDeps } from './provider.js';
import { CURRENT_TENANT, countActiveProfessionalsNow, findPlan } from './store.js';

/**
 * The emails the owner receives about the subscription. A notice is CLAIMED in the transaction that
 * changed the state (`claimNotice`: the row is the "already told", unique by kind and moment), and
 * sent after that commits (`sendPendingNotices`), in no transaction at all: the mail server is slow
 * and must not hold a connection. A notice the mail server did not accept stays unsent and is tried
 * again a few minutes later, a few times; one that was accepted is never sent again.
 */

const MAX_ATTEMPTS = 5;
/** The notices whose key is the id of a statement. */
const STATEMENT_NOTICES: ReadonlySet<string> = new Set([
  'statement_published',
  'amount_change_refused',
  'reauthorization_needed',
]);
/** A claim holds the notice for this long: a worker that died after claiming does not block it for ever. */
const CLAIM_MS = 5 * 60_000;
const BATCH = 10;

/** Records that the owner is to be told something. True when this call made the record (it was new). */
export async function claimNotice(
  tx: Tx,
  subscriptionId: string,
  kind: NoticeKind,
  key: string,
): Promise<boolean> {
  const inserted = await tx
    .insert(subscriptionNotice)
    .values({
      tenantId: sql`current_setting('app.tenant_id')::uuid`,
      subscriptionId,
      kind,
      key,
    })
    .onConflictDoNothing()
    .returning({ id: subscriptionNotice.id });
  return inserted.length > 0;
}

/** The people who own the organization: they are the ones the billing emails go to. */
export async function ownerEmails(tx: Tx): Promise<string[]> {
  const rows = await tx
    .select({ email: userAccount.email })
    .from(membership)
    .innerJoin(userAccount, eq(userAccount.id, membership.userId))
    .where(and(eq(membership.status, 'active'), sql`'owner' = any(${membership.roles})`));
  return rows.map((row) => row.email);
}

interface Claimed {
  notice: SubscriptionNoticeRow;
  organizationName: string;
  slug: string;
  isDemo: boolean;
  owners: string[];
  graceEndsAt: Date | null;
  amountCents: number | null;
  /** The statement a statement notice is about (its key is the id of the statement). */
  statement: StatementRow | null;
}

const factsOf = (row: StatementRow): StatementFacts => ({
  period: row.period,
  totalCents: row.totalCents,
  professionalsCounted: row.professionalsCounted,
  overageUnits: row.overageUnits,
  collectAfter: row.collectAfter,
});

/** What a notice says, from its kind and the moment it is about. */
function render(
  claimed: Claimed,
  common: { organizationName: string; link: string; simulated: boolean },
): BillingEmail | null {
  const { notice } = claimed;
  const grace = claimed.graceEndsAt ?? new Date(notice.key.split(':')[0] ?? '');
  switch (notice.kind) {
    case 'past_due_started':
      return renderPastDueEmail({
        ...common,
        cause: notice.key.endsWith(':trial_ended') ? 'trial_ended' : 'payment_failed',
        graceEndsAt: grace,
        amountCents: claimed.amountCents,
      });
    case 'dunning_1':
    case 'dunning_3':
    case 'dunning_5':
      return renderDunningEmail({
        ...common,
        day: Number(notice.kind.slice('dunning_'.length)) as 1 | 3 | 5,
        graceEndsAt: grace,
        amountCents: claimed.amountCents,
      });
    case 'read_only_started':
      return renderReadOnlyEmail(common);
    case 'recovered':
      return renderRecoveredEmail(common);
    case 'statement_published':
      return claimed.statement
        ? renderStatementEmail({ ...common, statement: factsOf(claimed.statement) })
        : null;
    case 'amount_change_refused':
      return claimed.statement
        ? renderAmountChangeRefusedEmail({ ...common, statement: factsOf(claimed.statement) })
        : null;
    case 'reauthorization_needed':
      return claimed.statement
        ? renderReauthorizationEmail({ ...common, statement: factsOf(claimed.statement) })
        : null;
    case 'overage_cap_reached':
      return renderQuotaReachedEmail({ ...common, period: notice.key });
    default:
      return null;
  }
}

/**
 * Sends the notices that are owed, in this order: claim a few (a short transaction that also reads who
 * to write to), send them with no transaction, and mark the ones the mail server accepted. Returns how
 * many were sent. It sends nothing where there is no mail sender, and an email that fails changes no
 * state: the notice stays and is tried again.
 */
export async function sendPendingNotices(
  deps: SubscriptionDeps,
  tenantId: string,
): Promise<number> {
  const { email, origins } = deps;
  if (!email || !origins) return 0;
  const as = <T>(work: (tx: Tx) => Promise<T>) =>
    deps.withTenant({ tenantId, userId: SYSTEM_USER_ID }, work);
  const simulated = isSimulated(gatewayOf(deps));

  const batch = await as(async (tx): Promise<Claimed[]> => {
    const now = deps.clock();
    const due = await tx
      .select()
      .from(subscriptionNotice)
      .where(
        and(
          isNull(subscriptionNotice.sentAt),
          lt(subscriptionNotice.attempts, MAX_ATTEMPTS),
          or(
            isNull(subscriptionNotice.lastAttemptAt),
            lt(subscriptionNotice.lastAttemptAt, new Date(now.getTime() - CLAIM_MS)),
          ),
        ),
      )
      .orderBy(asc(subscriptionNotice.createdAt), asc(subscriptionNotice.id))
      .limit(BATCH)
      .for('update', { skipLocked: true });
    if (due.length === 0) return [];
    await tx
      .update(subscriptionNotice)
      .set({ attempts: sql`${subscriptionNotice.attempts} + 1`, lastAttemptAt: now })
      .where(
        inArray(
          subscriptionNotice.id,
          due.map((notice) => notice.id),
        ),
      );

    const [org] = await tx
      .select({ slug: tenant.slug, isDemo: tenant.isDemo })
      .from(tenant)
      .where(eq(tenant.id, CURRENT_TENANT));
    const [sub] = await tx
      .select()
      .from(subscription)
      .where(eq(subscription.tenantId, CURRENT_TENANT));
    if (!org || !sub) return [];
    const plan = await findPlan(tx, sub.planId);
    const amountCents =
      sub.authorizedAmountCents ??
      Math.max(1, await countActiveProfessionalsNow(tx)) * plan.pricePerProfessionalCents;
    const organizationName = await readOrganizationName(tx);
    const owners = await ownerEmails(tx);
    const statementIds = due
      .filter((notice) => STATEMENT_NOTICES.has(notice.kind))
      .map((notice) => notice.key);
    const statements = new Map<string, StatementRow>(
      statementIds.length === 0
        ? []
        : (await tx.select().from(statement).where(inArray(statement.id, statementIds))).map(
            (row) => [row.id, row],
          ),
    );
    return due.map((notice) => ({
      notice,
      organizationName,
      slug: org.slug,
      isDemo: org.isDemo,
      owners,
      graceEndsAt: sub.graceEndsAt,
      amountCents,
      statement: STATEMENT_NOTICES.has(notice.kind) ? (statements.get(notice.key) ?? null) : null,
    }));
  });
  if (batch.length === 0) return 0;

  const sent: string[] = [];
  for (const claimed of batch) {
    const message = render(claimed, {
      organizationName: claimed.organizationName,
      link: `${origins(claimed.slug)}/subscription`,
      simulated,
    });
    if (message === null || claimed.owners.length === 0) continue;
    let delivered = false;
    for (const to of claimed.owners) {
      try {
        await email.send({
          to,
          ...message,
          tenant: { id: tenantId, isDemo: claimed.isDemo },
        });
        delivered = true;
      } catch {
        // The notice stays unsent and is tried again; the address is never logged.
      }
    }
    if (delivered) sent.push(claimed.notice.id);
  }
  if (sent.length > 0) {
    const now = deps.clock();
    await as((tx) =>
      tx
        .update(subscriptionNotice)
        .set({ sentAt: now })
        .where(inArray(subscriptionNotice.id, sent)),
    );
  }
  return sent.length;
}
