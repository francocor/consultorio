import type { StatementDto, StatementLineDto } from '@consultorio/contracts';
import { formatArs, money } from '@consultorio/contracts';
import { and, desc, eq, inArray } from 'drizzle-orm';

import {
  statement,
  subscriptionAttempt,
  subscriptionPayment,
  type StatementRow,
} from '../../../db/schema/subscriptions.js';
import { SYSTEM_USER_ID, type Tx } from '../../../platform/db/tenant-context.js';
import type { PdfBlock, RenderPdfInput } from '../../../platform/pdf/render.js';
import { readOrganizationName } from '../../tenancy/index.js';
import { describeDate } from '../assets/es-AR/billing-emails.js';
import { dayOf, nextPeriod, periodOf, previousPeriod } from '../domain/periods.js';
import { buildStatement, collectAfter } from '../domain/statement.js';

import { DAY_MS } from './common.js';
import { claimNotice, sendPendingNotices } from './notices.js';
import type { SubscriptionDeps } from './provider.js';
import { CURRENT_TENANT, findPlan, lockSubscription, readTenantBilling } from './store.js';
import { acceptedEventIds, professionalNames, recordedDays } from './usage.js';

/**
 * The statements (SUB-08): what the organization is billed for a period that closed, written once and
 * published to the owner before anything is collected. Generating is safe to repeat: a period has one
 * statement, however many times the job runs, and the owner is told once per statement.
 */

/** Never write more than this many periods in one pass: a subscription that is years old catches up over a few runs. */
const MAX_PERIODS_PER_PASS = 12;

/**
 * `statement.generate`: writes the statement of every period that has closed and has none, from the
 * first period the subscription was billed. It holds no connection while it waits for anything (it
 * asks no provider). Returns the statements it wrote.
 */
export async function generateStatements(
  deps: SubscriptionDeps,
  tenantId: string,
): Promise<{ generated: number }> {
  const generated = await deps.withTenant({ tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
    const billing = await readTenantBilling(tx);
    if (billing.exempt) return 0;
    const sub = await lockSubscription(tx);
    if (!sub) return 0;
    const now = deps.clock();
    const plan = await findPlan(tx, sub.planId);
    const existing = new Set(
      (
        await tx
          .select({ period: statement.period })
          .from(statement)
          .where(eq(statement.subscriptionId, sub.id))
      ).map((row) => row.period),
    );

    const closing = previousPeriod(periodOf(now));
    let period = periodOf(sub.trialEndsAt);
    let written = 0;
    let looked = 0;
    while (period <= closing && looked < MAX_PERIODS_PER_PASS + existing.size) {
      looked += 1;
      if (!existing.has(period)) {
        const [days, events] = await Promise.all([
          recordedDays(tx, period),
          acceptedEventIds(tx, period),
        ]);
        const ids = [...new Set([...days.keys(), ...events.keys()])];
        const names = await professionalNames(tx, ids);
        const content = buildStatement({
          period,
          plan: {
            pricePerProfessionalCents: plan.pricePerProfessionalCents,
            whatsappQuotaPerProfessional: plan.whatsappQuotaPerProfessional,
            overageUnitPriceCents: plan.overageUnitPriceCents,
          },
          billingStartDay: dayOf(sub.trialEndsAt),
          overageCapMessages: sub.overageCapMessages,
          professionals: ids.map((id) => ({
            id,
            name: names.get(id) ?? null,
            days: days.get(id) ?? [],
            eventIds: events.get(id) ?? [],
          })),
        });
        if (content !== null) {
          const [inserted] = await tx
            .insert(statement)
            .values({
              tenantId: CURRENT_TENANT,
              subscriptionId: sub.id,
              period,
              planId: plan.id,
              professionalsCounted: content.professionalsCounted,
              baseCents: content.baseCents,
              overageUnits: content.overageUnits,
              overageCents: content.overageCents,
              totalCents: content.totalCents,
              overageCapMessages: sub.overageCapMessages,
              lines: content.lines,
              publishedAt: now,
              collectAfter: collectAfter(now),
            })
            .onConflictDoNothing()
            .returning({ id: statement.id });
          if (inserted) {
            written += 1;
            await claimNotice(tx, sub.id, 'statement_published', inserted.id);
          }
        }
      }
      period = nextPeriod(period);
    }
    return written;
  });
  // The owner is told after the commit, outside any transaction.
  if (generated > 0) await sendPendingNotices(deps, tenantId).catch(() => 0);
  return { generated };
}

// What the owner sees --------------------------------------------------------------------------------

const LINK_LIFETIME_MS = 7 * DAY_MS;

function lineDto(
  line: StatementRow['lines'][number],
  options: { events: boolean },
): StatementLineDto {
  if (line.kind === 'professional') return { ...line };
  const { eventIds, ...rest } = line;
  return options.events ? { ...rest, eventIds: [...eventIds] } : rest;
}

/** The links the owner may follow for the statements: the difference to pay, the new amount to authorize. */
async function linksOf(
  tx: Tx,
  rows: readonly StatementRow[],
  now: Date,
): Promise<Map<string, { paymentUrl: string | null; reauthorizationUrl: string | null }>> {
  const links = new Map<string, { paymentUrl: string | null; reauthorizationUrl: string | null }>();
  if (rows.length === 0) return links;
  const attempts = await tx
    .select()
    .from(subscriptionAttempt)
    .where(
      and(
        inArray(
          subscriptionAttempt.statementId,
          rows.map((row) => row.id),
        ),
        eq(subscriptionAttempt.state, 'confirmed'),
      ),
    )
    .orderBy(desc(subscriptionAttempt.markedAt));
  const payments = await tx
    .select({ reference: subscriptionPayment.reference })
    .from(subscriptionPayment)
    .where(
      and(
        inArray(
          subscriptionPayment.statementId,
          rows.map((row) => row.id),
        ),
        eq(subscriptionPayment.status, 'approved'),
      ),
    );
  const paid = new Set(payments.map((payment) => payment.reference));
  const rejected = await tx
    .select()
    .from(subscriptionAttempt)
    .where(
      and(
        inArray(
          subscriptionAttempt.statementId,
          rows.map((row) => row.id),
        ),
        eq(subscriptionAttempt.state, 'rejected'),
        eq(subscriptionAttempt.kind, 'amount_change'),
      ),
    )
    .orderBy(desc(subscriptionAttempt.markedAt));
  for (const attempt of attempts) {
    if (attempt.statementId === null || attempt.kind !== 'payment_link') continue;
    const entry = links.get(attempt.statementId) ?? { paymentUrl: null, reauthorizationUrl: null };
    const alive = now.getTime() < attempt.markedAt.getTime() + LINK_LIFETIME_MS;
    if (
      entry.paymentUrl === null &&
      alive &&
      attempt.resourceUrl &&
      !paid.has(attempt.externalReference)
    ) {
      entry.paymentUrl = attempt.resourceUrl;
    }
    links.set(attempt.statementId, entry);
  }
  for (const attempt of rejected) {
    if (attempt.statementId === null || attempt.message !== REAUTHORIZATION_REQUIRED) continue;
    const entry = links.get(attempt.statementId) ?? { paymentUrl: null, reauthorizationUrl: null };
    if (entry.reauthorizationUrl === null && attempt.resourceUrl) {
      entry.reauthorizationUrl = attempt.resourceUrl;
    }
    links.set(attempt.statementId, entry);
  }
  return links;
}

/** The message a rejected change of amount keeps when the provider asked for a fresh authorization. */
export const REAUTHORIZATION_REQUIRED = 'reauthorization_required';
/** The message a rejected change of amount keeps when the provider would not change the amount. */
export const AMOUNT_CHANGE_REFUSED = 'amount_change_refused';

function dtoOf(
  row: StatementRow,
  links: { paymentUrl: string | null; reauthorizationUrl: string | null } | undefined,
  options: { events: boolean },
): StatementDto {
  return {
    id: row.id,
    period: row.period,
    publishedAt: row.publishedAt.toISOString(),
    collectAfter: row.collectAfter.toISOString(),
    professionalsCounted: row.professionalsCounted,
    baseCents: row.baseCents,
    overageUnits: row.overageUnits,
    overageCents: row.overageCents,
    totalCents: row.totalCents,
    collectedCents: row.collectedCents,
    lines: row.lines.map((line) => lineDto(line, options)),
    paymentUrl: links?.paymentUrl ?? null,
    reauthorizationUrl: links?.reauthorizationUrl ?? null,
  };
}

/** `GET /subscription/statements`, the newest first. Overage lines carry no event ids here. */
export async function listStatements(tx: Tx, now: Date): Promise<StatementDto[]> {
  const rows = await tx.select().from(statement).orderBy(desc(statement.period));
  const links = await linksOf(tx, rows, now);
  return rows.map((row) => dtoOf(row, links.get(row.id), { events: false }));
}

/** `GET /subscription/statements/:id`: the statement with the counted events each overage line bills. */
export async function readStatement(tx: Tx, id: string, now: Date): Promise<StatementDto | null> {
  const [row] = await tx.select().from(statement).where(eq(statement.id, id));
  if (!row) return null;
  const links = await linksOf(tx, [row], now);
  return dtoOf(row, links.get(row.id), { events: true });
}

// The document ---------------------------------------------------------------------------------------

const monthName = (period: string): string => {
  const [year, month] = period.split('-');
  const label = new Intl.DateTimeFormat('es-AR', { month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(Number(year), Number(month) - 1, 1)),
  );
  return `${label} de ${year ?? ''}`;
};

/**
 * The statement as a document the owner can keep (SUB-08): the professionals counted, the price, the
 * prorations, the overage and the total, in ARS. It carries no patient and no clinical data.
 */
export async function statementPdfInput(
  tx: Tx,
  id: string,
  options: { simulated: boolean },
): Promise<{ input: RenderPdfInput; fileName: string } | null> {
  const [row] = await tx.select().from(statement).where(eq(statement.id, id));
  if (!row) return null;
  const organizationName = await readOrganizationName(tx);
  const title = `Resumen de ${monthName(row.period)}`;
  const professionalLines = row.lines.filter((line) => line.kind === 'professional');
  const overageLines = row.lines.filter((line) => line.kind === 'overage');
  const cents = (value: number) => formatArs(money(value));

  const blocks: PdfBlock[] = [
    {
      kind: 'fields',
      rows: [
        { label: 'Período', value: monthName(row.period) },
        { label: 'Publicado', value: describeDate(row.publishedAt) },
        { label: 'Se cobra a partir del', value: describeDate(row.collectAfter) },
        { label: 'Profesionales contados', value: String(row.professionalsCounted) },
      ],
    },
    { kind: 'heading', text: 'Profesionales activos' },
    {
      kind: 'table',
      columns: [
        { header: 'Profesional', width: 5 },
        { header: 'Días', width: 2, align: 'right' },
        { header: 'Importe', width: 3, align: 'right' },
      ],
      rows: professionalLines.map((line) => [
        line.name ?? 'Sin nombre',
        `${String(line.days)} de ${String(line.daysInPeriod)}`,
        cents(line.amountCents),
      ]),
    },
  ];
  if (overageLines.length > 0) {
    blocks.push(
      { kind: 'heading', text: 'Mensajes de WhatsApp excedentes' },
      {
        kind: 'table',
        columns: [
          { header: 'Profesional', width: 4 },
          { header: 'Enviados', width: 2, align: 'right' },
          { header: 'Cuota', width: 2, align: 'right' },
          { header: 'Excedentes', width: 2, align: 'right' },
          { header: 'Importe', width: 3, align: 'right' },
        ],
        rows: overageLines.map((line) => [
          line.name ?? 'Sin nombre',
          String(line.used),
          String(line.quota),
          String(line.units),
          cents(line.amountCents),
        ]),
      },
    );
  }
  blocks.push(
    { kind: 'heading', text: 'Total' },
    {
      kind: 'fields',
      rows: [
        { label: 'Suscripción', value: cents(row.baseCents) },
        { label: 'Excedentes', value: cents(row.overageCents) },
        { label: 'Total a cobrar', value: cents(row.totalCents) },
      ],
    },
    {
      kind: 'paragraph',
      muted: true,
      text: 'Este resumen no contiene datos de pacientes. Solo se cobra el monto que figura aquí, y no antes de la fecha indicada.',
    },
  );
  return {
    fileName: `resumen-${row.period}.pdf`,
    input: {
      title,
      subject: title,
      branding: { organizationName },
      createdAt: row.publishedAt,
      blocks,
      ...(options.simulated ? { watermark: 'Pago simulado: documento de prueba' } : {}),
      footer: `${organizationName} - ${title}`,
    },
  };
}
