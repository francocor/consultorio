import { eq } from 'drizzle-orm';

import {
  createLocalPaymentsControls,
  createLocalPaymentsGateway,
} from '../../../../adapters/mercadopago-local/index.js';
import type { AdapterResolver } from '../../../../main/adapter-resolver.js';
import type { PasswordHasher } from '../../../../modules/identity/index.js';
import {
  createTrialStarter,
  generateStatements,
  periodBounds,
  periodOf,
  reconcileSubscription,
  runDunningStep,
  runUsageSnapshot,
  startCheckout,
  type SubscriptionDeps,
} from '../../../../modules/subscriptions/index.js';
import { createTenantLifecycle, createTenantLookup } from '../../../../modules/tenancy/index.js';
import type { AuditActor } from '../../../../platform/audit/writer.js';
import type { Db } from '../../../../platform/db/pool.js';
import { SYSTEM_USER_ID, type WithTenant } from '../../../../platform/db/tenant-context.js';
import { uuidv7 } from '../../../../platform/db/uuid.js';
import type { PublicOrigins } from '../../../../platform/http/public-origin.js';
import { membership, userAccount } from '../../../schema/identity.js';
import { professional } from '../../../schema/staff.js';
import { subscription } from '../../../schema/subscriptions.js';
import { tenant } from '../../../schema/tenant.js';
import { DEMO_EMAIL_DOMAIN, DEMO_PASSWORD } from '../credentials.js';
import { DemoSeedError } from '../seed.js';

/**
 * The platform demo of Stage 6 (task 6.47, `pnpm demo:platform`): four fictional organizations that
 * are NOT demonstration ones, one in each state a subscription can be in, so the operator's views of
 * the subscriptions have something to show: a trial in its fifth day, an active subscription paid
 * through the end of the month, a charge that failed three days ago (past due, two reminders sent)
 * and an organization whose grace ended (read-only).
 *
 * Nothing is faked on the way. Each organization goes through the services of the subscription
 * module (`createTrialStarter`, `startCheckout`, `reconcileSubscription`, `runDunningStep`) against
 * the local Mercado Pago, which keeps its preapprovals and payments in Postgres, so the screens of
 * the provider console and the next billing cycle know them. The clock of the services moves back
 * and forward on a clock of the seed: the dates are the ones the product would have written. No email
 * is sent (the notices are recorded) and no provider is reached beyond the simulator.
 *
 * Development only. The organizations are billed, so they are the opposite of the demonstration
 * organization, which is exempt and has no subscription: that is the point of showing both.
 */

export type PlatformDemoState = 'trial' | 'active' | 'past_due' | 'read_only';

export interface PlatformDemoTenant {
  state: PlatformDemoState;
  slug: string;
  displayName: string;
  ownerEmail: string;
  ownerName: string;
  /** The reception of the organization: it never sees the billing, and in a read-only one it is refused a write. */
  receptionEmail: string;
  receptionName: string;
  /** A professional with an active seat (the one the statement counts), only where the story needs one. */
  professionalEmail?: string;
  professionalName?: string;
}

export const PLATFORM_DEMO_TENANTS: readonly PlatformDemoTenant[] = [
  {
    state: 'trial',
    slug: 'prueba-trial',
    displayName: 'Consultorio Prueba Trial',
    ownerEmail: `propietaria.trial@${DEMO_EMAIL_DOMAIN}`,
    ownerName: 'Ana Prueba',
    receptionEmail: `recepcion.trial@${DEMO_EMAIL_DOMAIN}`,
    receptionName: 'Ernesto Ruiz',
  },
  {
    state: 'active',
    slug: 'prueba-activa',
    displayName: 'Consultorio Prueba Activa',
    ownerEmail: `propietaria.activa@${DEMO_EMAIL_DOMAIN}`,
    ownerName: 'Beatriz Prueba',
    receptionEmail: `recepcion.activa@${DEMO_EMAIL_DOMAIN}`,
    receptionName: 'Facundo Ruiz',
    professionalEmail: `profesional.activa@${DEMO_EMAIL_DOMAIN}`,
    professionalName: 'Dr. Ignacio Prueba',
  },
  {
    state: 'past_due',
    slug: 'prueba-atrasada',
    displayName: 'Consultorio Prueba Atrasada',
    ownerEmail: `propietaria.atrasada@${DEMO_EMAIL_DOMAIN}`,
    ownerName: 'Carla Prueba',
    receptionEmail: `recepcion.atrasada@${DEMO_EMAIL_DOMAIN}`,
    receptionName: 'Gabriela Ruiz',
  },
  {
    state: 'read_only',
    slug: 'prueba-vencida',
    displayName: 'Consultorio Prueba Vencida',
    ownerEmail: `propietaria.vencida@${DEMO_EMAIL_DOMAIN}`,
    ownerName: 'Delia Prueba',
    receptionEmail: `recepcion.vencida@${DEMO_EMAIL_DOMAIN}`,
    receptionName: 'Hernán Ruiz',
  },
];

export interface PlatformDemoDeps {
  db: Db;
  withTenant: WithTenant;
  hasher: PasswordHasher;
  /** Where the emailed links of the services point; the checkout needs the address of the organization. */
  origins: PublicOrigins;
  /** Signs the notices of the local Mercado Pago. A process secret is enough: no notice is posted. */
  webhookSecret: string;
  /** Where the hosted pages of the local Mercado Pago are reached from outside. */
  publicBaseUrl: string;
  /** `production` refuses to run. */
  environment: string;
  /** The instant "now" of the seed; the timelines are laid out backwards from it. */
  now?: () => Date;
}

export interface PlatformDemoResult {
  slug: string;
  state: PlatformDemoState;
  /** False when the organization was already there and was left as it is. */
  created: boolean;
}

const DAY_MS = 86_400_000;

/**
 * Brings the four organizations to their states. An organization that exists is left alone (the
 * seed never rewrites a subscription), so it is safe to run twice.
 */
export async function seedPlatformDemo(deps: PlatformDemoDeps): Promise<PlatformDemoResult[]> {
  if (deps.environment === 'production') {
    throw new DemoSeedError(
      'The platform demo never runs in production: its organizations use the public demo password.',
    );
  }
  const now = (deps.now ?? (() => new Date()))();
  const clock = { at: now };
  const gateway = createLocalPaymentsGateway({
    db: deps.db,
    webhookSecret: deps.webhookSecret,
    publicBaseUrl: deps.publicBaseUrl,
    idempotent: false,
    hostedCheckout: false,
    clock: () => clock.at,
  });
  const controls = createLocalPaymentsControls(deps.db, { clock: () => clock.at });
  const adapters: AdapterResolver = {
    forTenant: (_tenant, port) => (port === 'paymentsGateway' ? gateway : undefined) as never,
  };
  const services: SubscriptionDeps = {
    withTenant: deps.withTenant,
    adapters,
    origins: deps.origins,
    tenantCancelled: createTenantLifecycle(),
    clock: () => clock.at,
  };
  const lookup = createTenantLookup(deps.db);
  const moveTo = (daysAgo: number, seconds = 0) => {
    clock.at = new Date(now.getTime() - daysAgo * DAY_MS + seconds * 1000);
  };
  const setClock = (at: Date) => {
    clock.at = at;
  };

  // A mode left on by hand ("down", "refuse_amount_change") would make the walk fail or lie.
  const previousMode = await controls.mode();
  await controls.setMode('ok');
  const results: PlatformDemoResult[] = [];
  try {
    for (const entry of PLATFORM_DEMO_TENANTS) {
      const existing = await lookup(entry.slug);
      if (existing) {
        results.push({ slug: entry.slug, state: entry.state, created: false });
        continue;
      }
      const organization = await createOrganization(deps, entry, now);
      await walkTo(entry.state, {
        ...organization,
        services,
        controls,
        now,
        moveTo,
        setClock,
        deps,
      });
      moveTo(0);
      results.push({ slug: entry.slug, state: entry.state, created: true });
    }
  } finally {
    await controls.setMode(previousMode);
  }
  return results;
}

interface Organization {
  tenantId: string;
  ownerId: string;
}

interface Person {
  email: string;
  name: string;
  roles: ('owner' | 'reception' | 'professional')[];
}

/** One account and its membership; the identity policies only let a transaction insert the account it acts as. */
async function addMember(
  deps: PlatformDemoDeps,
  tenantId: string,
  person: Person,
  passwordHash: string,
  now: Date,
): Promise<{ userId: string; membershipId: string }> {
  const userId = uuidv7();
  const membershipId = uuidv7();
  await deps.withTenant({ tenantId, userId }, async (tx) => {
    await tx.insert(userAccount).values({
      id: userId,
      email: person.email,
      passwordHash,
      passwordChangedAt: now,
    });
    await tx.insert(membership).values({
      id: membershipId,
      tenantId,
      userId,
      roles: person.roles,
      displayName: person.name,
    });
  });
  return { userId, membershipId };
}

async function createOrganization(
  deps: PlatformDemoDeps,
  entry: PlatformDemoTenant,
  now: Date,
): Promise<Organization> {
  const tenantId = uuidv7();
  // Inserted under a context whose tenant id is the new row's own id, as the operator console does.
  await deps.withTenant({ tenantId, userId: SYSTEM_USER_ID }, (tx) =>
    tx.insert(tenant).values({
      id: tenantId,
      slug: entry.slug,
      isDemo: false,
      billingExempt: false,
      theme: { displayName: entry.displayName },
    }),
  );
  const passwordHash = await deps.hasher.hash(DEMO_PASSWORD);
  const owner = await addMember(
    deps,
    tenantId,
    { email: entry.ownerEmail, name: entry.ownerName, roles: ['owner'] },
    passwordHash,
    now,
  );
  await addMember(
    deps,
    tenantId,
    { email: entry.receptionEmail, name: entry.receptionName, roles: ['reception'] },
    passwordHash,
    now,
  );
  if (entry.professionalEmail !== undefined) {
    const person = await addMember(
      deps,
      tenantId,
      {
        email: entry.professionalEmail,
        name: entry.professionalName ?? 'Profesional',
        roles: ['professional'],
      },
      passwordHash,
      now,
    );
    await deps.withTenant({ tenantId, userId: owner.userId }, (tx) =>
      tx.insert(professional).values({
        tenantId,
        membershipId: person.membershipId,
        specialties: ['Medicina general'],
        matricula: '910001',
        matriculaJurisdiction: 'AR-B',
      }),
    );
  }
  return { tenantId, ownerId: owner.userId };
}

interface Walk extends Organization {
  services: SubscriptionDeps;
  controls: ReturnType<typeof createLocalPaymentsControls>;
  /** The instant "now" of the seed. */
  now: Date;
  /** Puts the clock of the services N days (and some seconds) before "now". */
  moveTo(daysAgo: number, seconds?: number): void;
  /** Puts the clock of the services at an instant. */
  setClock(at: Date): void;
  deps: PlatformDemoDeps;
}

const ownerActor = (userId: string): AuditActor => ({
  userId,
  actingRole: 'owner',
  ip: null,
  userAgent: 'demo-platform',
  requestId: null,
});

async function startTrial(walk: Walk): Promise<void> {
  const starter = createTrialStarter({ clock: walk.services.clock });
  await walk.deps.withTenant({ tenantId: walk.tenantId, userId: walk.ownerId }, (tx) =>
    starter.startTrial(tx, { tenantId: walk.tenantId }),
  );
}

async function subscriptionRow(walk: Walk) {
  const [row] = await walk.deps.withTenant(
    { tenantId: walk.tenantId, userId: SYSTEM_USER_ID },
    (tx) => tx.select().from(subscription).where(eq(subscription.tenantId, walk.tenantId)),
  );
  if (!row) throw new DemoSeedError('The organization of the platform demo has no subscription.');
  return row;
}

async function preapprovalOf(walk: Walk): Promise<string> {
  const row = await subscriptionRow(walk);
  if (!row.providerPreapprovalId) {
    throw new DemoSeedError('The checkout of the platform demo made no preapproval.');
  }
  return row.providerPreapprovalId;
}

/** The owner subscribes, authorizes on the hosted page, and the provider charges the first month. */
async function subscribeAndPay(walk: Walk): Promise<string> {
  const started = await startCheckout(walk.services, {
    tenantId: walk.tenantId,
    userId: walk.ownerId,
    actor: ownerActor(walk.ownerId),
  });
  if (started.status !== 'ready') {
    throw new DemoSeedError(`The checkout of the platform demo answered "${started.status}".`);
  }
  const preapprovalId = await preapprovalOf(walk);
  await walk.controls.decidePreapproval(preapprovalId, 'approve');
  await reconcileSubscription(walk.services, walk.tenantId);
  await walk.controls.charge(preapprovalId, 'approved');
  await reconcileSubscription(walk.services, walk.tenantId);
  return preapprovalId;
}

/** The provider rejects the next charge; the subscription learns it and the grace begins. */
async function failTheCharge(walk: Walk, preapprovalId: string): Promise<void> {
  await walk.controls.charge(preapprovalId, 'rejected');
  await reconcileSubscription(walk.services, walk.tenantId);
}

/** The reminders and the end of the grace that are due at this instant (one step per pass). */
async function runClock(walk: Walk): Promise<void> {
  for (let pass = 0; pass < 4; pass += 1) {
    const outcome = await runDunningStep(walk.services, walk.tenantId);
    if (outcome !== 'done') return;
  }
}

/**
 * The months of an active subscription that has been going on: each time the paid time ends, the
 * provider charges the next month, until the paid time reaches beyond "now".
 */
async function renewUntilNow(walk: Walk, preapprovalId: string): Promise<void> {
  for (let renewal = 0; renewal < 4; renewal += 1) {
    const paidThrough = (await subscriptionRow(walk)).paidThrough;
    if (paidThrough === null || paidThrough.getTime() > walk.now.getTime()) return;
    walk.setClock(paidThrough);
    await walk.controls.charge(preapprovalId, 'approved');
    await reconcileSubscription(walk.services, walk.tenantId);
  }
}

/** The days the professionals were active, one snapshot a day as the clock of the metering takes it. */
async function meterDays(walk: Walk, from: Date): Promise<void> {
  const noon = (day: Date) => new Date(day.getTime() + 12 * 3_600_000);
  for (
    let day = new Date(from.getTime());
    day.getTime() < walk.now.getTime() - DAY_MS;
    day = new Date(day.getTime() + DAY_MS)
  ) {
    walk.setClock(noon(day));
    await runUsageSnapshot(walk.services, walk.tenantId);
  }
}

async function walkTo(state: PlatformDemoState, walk: Walk): Promise<void> {
  switch (state) {
    case 'trial': {
      // Day 5 of 14.
      walk.moveTo(5);
      await startTrial(walk);
      return;
    }
    case 'active': {
      // Laid out on the calendar of the billing, not "so many days ago", so that a month has always
      // closed with the professional's days in it, whatever the day of the month the seed runs: the
      // trial began twenty days before the month started and ended six days before it, the owner
      // subscribed the day after, and the provider charged every month since.
      const monthStart = periodBounds(periodOf(walk.now)).start;
      const at = (days: number) => new Date(monthStart.getTime() + days * DAY_MS);
      walk.setClock(at(-20));
      await startTrial(walk);
      walk.setClock(at(-5));
      const preapprovalId = await subscribeAndPay(walk);
      await renewUntilNow(walk, preapprovalId);
      // The professional worked every day since the trial ended; the month that closed has its statement.
      await meterDays(walk, at(-6));
      walk.setClock(walk.now);
      await generateStatements(walk.services, walk.tenantId);
      return;
    }
    case 'past_due': {
      walk.moveTo(40);
      await startTrial(walk);
      walk.moveTo(33);
      const preapprovalId = await subscribeAndPay(walk);
      // The month ended three days ago and the renewal was rejected: past due, a week of grace.
      walk.moveTo(3);
      await failTheCharge(walk, preapprovalId);
      // The reminders of day 1 and day 3.
      walk.moveTo(2, 1);
      await runClock(walk);
      walk.moveTo(0, 1);
      await runClock(walk);
      return;
    }
    case 'read_only': {
      walk.moveTo(50);
      await startTrial(walk);
      walk.moveTo(45);
      const preapprovalId = await subscribeAndPay(walk);
      // The renewal was rejected fifteen days ago: reminders on days 1, 3 and 5, and the grace of a
      // week ended eight days ago.
      walk.moveTo(15);
      await failTheCharge(walk, preapprovalId);
      for (const day of [14, 12, 10]) {
        walk.moveTo(day, 1);
        await runClock(walk);
      }
      walk.moveTo(8, 1);
      await runClock(walk);
      return;
    }
  }
}
