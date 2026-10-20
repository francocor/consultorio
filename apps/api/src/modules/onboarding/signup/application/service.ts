import { randomBytes } from 'node:crypto';

import type { SignupRequest, SignupVerifyRequest } from '@consultorio/contracts';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { membership, userAccount } from '../../../../db/schema/identity.js';
import { signupPending, termsAcceptance, termsVersion } from '../../../../db/schema/signup.js';
import { tenant } from '../../../../db/schema/tenant.js';
import { audit, type AuditActor } from '../../../../platform/audit/writer.js';
import type { TenantKeys } from '../../../../platform/crypto/tenant-keys.js';
import { evenOut } from '../../../../platform/db/even-work.js';
import {
  SYSTEM_USER_ID,
  type Tx,
  type WithTenant,
} from '../../../../platform/db/tenant-context.js';
import { uuidv7 } from '../../../../platform/db/uuid.js';
import { AppError } from '../../../../platform/http/problem.js';
import type { RateLimitStore } from '../../../../platform/http/rate-limit.js';
import type { EmailSender } from '../../../../platform/mail/email-sender.js';
import type { ActionTokens } from '../../../../platform/tokens/index.js';
import type {
  IssuedSession,
  PasswordHasher,
  PasswordValidator,
  SessionService,
} from '../../../identity/index.js';
import type { TrialStarter } from '../../../subscriptions/index.js';
import {
  LINKS_PER_CLIENT,
  OVERALL_COUNTER,
  SIGNUPS_OVERALL,
  SIGNUPS_PER_CLIENT,
  SIGNUP_EMAILS_PER_ADDRESS,
  addressCounter,
  clientCounter,
  type SignupLimit,
} from '../domain/limits.js';
import { signupSlugBase, slugWithSuffix } from '../domain/slug.js';

import { renderExistingAccountEmail } from './mail.js';
import type { VerificationMailer } from './mailer.js';
import { passwordFieldErrors } from './password-errors.js';

/** Work to do after the answer has gone: send an email. A failure never reaches the visitor. */
export type Delivery = () => Promise<void>;

/** Where a request came from, as the audit trail and the counters need it. */
export interface Origin {
  actor: AuditActor;
  /** Where the failure of the store of the counters is told (a code, never a key or an address). */
  warn?: (event: 'counters_store_failed_open' | 'counters_store_failed_closed') => void;
}

export interface SignupServiceDeps {
  withTenant: WithTenant;
  hasher: PasswordHasher;
  validator: PasswordValidator;
  tokens: ActionTokens;
  keys: TenantKeys;
  store: RateLimitStore;
  email: EmailSender;
  mailer: VerificationMailer;
  trial: TrialStarter;
  sessions: SessionService;
  clock: () => Date;
  /** The id of a new organization; replaceable in tests. */
  newTenantId?: () => string;
  /** The random part of an address that collided; replaceable in tests. */
  slugSuffix?: () => string;
}

export interface SignupService {
  /**
   * A visitor asks for an organization. Whatever the name or the address were, the answer is the
   * same and the work done before it is the same: see `core`. Returns the delivery of the email, to
   * be run after the answer.
   */
  signUp(input: SignupRequest, origin: Origin): Promise<Delivery>;
  /** A new link, asked with the address of the signup (from the platform host). */
  resend(email: string, origin: Origin): Promise<Delivery>;
  /** A new link, asked from the host of the unverified organization itself. */
  renew(tenantId: string, origin: Origin): Promise<Delivery>;
  /**
   * Follows the link: the person who owns the address chooses the password and accepts the terms,
   * and only then the organization is activated, the account made, the acceptance recorded, the
   * trial started and the owner signed in. Nothing the signup form carried is trusted for any of it
   * (JD-S6 R1-S6-3).
   */
  verify(
    host: { id: string; status: string },
    input: SignupVerifyRequest,
    origin: Origin,
  ): Promise<IssuedSession>;
}

/**
 * How many cheap reads a branch that does not create the organization sends, to cost Postgres what
 * the branch that does create it costs (the pattern of the portal, `evenOut`). The counts are pinned
 * by `test/security/signup-nondisclosure.test.ts`: change what a branch writes and that test fails
 * until the number is adjusted.
 */
export const EVEN_WORK = {
  /** The request path: after the lookup of the address, what creating an organization writes. */
  request: 4,
  /** The delivery of a verification link (`VerificationMailer.issueAndSend`), first transaction. */
  prepare: 5,
  /** The same, last transaction (the mark that the email was sent). */
  mark: 1,
} as const;

/** The unique violation of Postgres. */
const UNIQUE_VIOLATION = '23505';

function databaseCodeOf(error: unknown): string | undefined {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.cause?.code ?? e?.code;
  return typeof code === 'string' ? code : undefined;
}

/** What the address of a signup is, for the branch the request takes. */
type AddressState = { kind: 'account' } | { kind: 'pending'; tenantId: string } | { kind: 'free' };

async function stateOf(tx: Tx, email: string): Promise<AddressState> {
  const found = await tx.execute<{ state: string; tenant_id: string | null }>(
    sql`select state, tenant_id from app.signup_email_state(${email})`,
  );
  const row = found.rows[0];
  if (row?.state === 'account') return { kind: 'account' };
  if (row?.state === 'pending' && row.tenant_id)
    return { kind: 'pending', tenantId: row.tenant_id };
  return { kind: 'free' };
}

/** A private signal that the address got a pending signup between the lookup and the insert. */
class LostTheRace extends Error {}

export function createSignupService(deps: SignupServiceDeps): SignupService {
  const { withTenant, tokens } = deps;
  const newTenantId = deps.newTenantId ?? uuidv7;
  const slugSuffix = deps.slugSuffix ?? (() => randomBytes(3).toString('hex').slice(0, 4));

  /**
   * Counts one try in a window. A store that fails does not close the form for a client or an
   * address (the bot challenge bounds those), but it does for the overall ceiling: a store that is
   * down is exactly when a flood is not being counted. The failure is told, with no key in it.
   */
  async function hit(
    origin: Origin,
    key: string,
    limit: SignupLimit,
    options: { failClosed?: boolean } = {},
  ): Promise<boolean> {
    try {
      const state = await deps.store.hit(key, limit.windowMs);
      return state.count <= limit.max;
    } catch {
      origin.warn?.(
        options.failClosed === true ? 'counters_store_failed_closed' : 'counters_store_failed_open',
      );
      return options.failClosed !== true;
    }
  }

  /**
   * Every counter is hit on every try (no short circuit), so being refused tells nothing about
   * which of them ran out, and an address that has an account counts like one that has none.
   */
  async function withinLimits(
    origin: Origin,
    email: string | null,
    options: { creating: boolean },
  ): Promise<void> {
    const allowed = [
      options.creating
        ? await hit(origin, clientCounter(origin.actor.ip), SIGNUPS_PER_CLIENT)
        : await hit(origin, clientCounter(origin.actor.ip, 'link'), LINKS_PER_CLIENT),
      email === null ? true : await hit(origin, addressCounter(email), SIGNUP_EMAILS_PER_ADDRESS),
      options.creating
        ? await hit(origin, OVERALL_COUNTER, SIGNUPS_OVERALL, { failClosed: true })
        : true,
    ];
    if (allowed.includes(false)) throw new AppError('rate_limited');
  }

  /** The email to the holder of an account that somebody tried to open an organization with. */
  function noticeDelivery(email: string, decoy: string): Delivery {
    return async () => {
      // The same statements as sending a verification link, so the two cannot be told apart.
      await withTenant({ tenantId: decoy, userId: SYSTEM_USER_ID }, (tx) =>
        evenOut(tx, EVEN_WORK.prepare),
      );
      await deps.email.send({
        to: email,
        tenant: { id: '00000000-0000-0000-0000-000000000000', isDemo: false },
        ...renderExistingAccountEmail(),
      });
      await withTenant({ tenantId: decoy, userId: SYSTEM_USER_ID }, (tx) =>
        evenOut(tx, EVEN_WORK.mark),
      );
    };
  }

  /** The link of a signup that is waiting for it (a new one, or the one asked for again). */
  const linkDelivery =
    (tenantId: string, manual: boolean): Delivery =>
    () =>
      deps.mailer.issueAndSend(tenantId, { manual });

  /** Nothing to send: the work of a delivery is done on a decoy organization and no email goes out. */
  function silentDelivery(decoy: string): Delivery {
    return async () => {
      await withTenant({ tenantId: decoy, userId: SYSTEM_USER_ID }, (tx) =>
        evenOut(tx, EVEN_WORK.prepare),
      );
      await withTenant({ tenantId: decoy, userId: SYSTEM_USER_ID }, (tx) =>
        evenOut(tx, EVEN_WORK.mark),
      );
    };
  }

  /**
   * Creates the unverified organization of a free address: the organization (its address generated
   * from the name, with a random suffix only when the plain one is taken), the pending signup and
   * the audit entry. Two statements for the address whatever happens: the plain one and, if it was
   * taken, the suffixed one; when the plain one is free the second is a cheap read. No password and
   * no acceptance are stored: the owner gives both at the link (JD-S6 R1-S6-3).
   */
  async function create(tx: Tx, id: string, input: SignupRequest, origin: Origin): Promise<void> {
    const base = signupSlugBase(input.organizationName);
    const insertWith = async (slug: string) => {
      const [created] = await tx
        .insert(tenant)
        .values({
          id,
          slug,
          status: 'unverified',
          theme: { displayName: input.organizationName },
          settings: {},
        })
        .onConflictDoNothing({ target: tenant.slug })
        .returning({ id: tenant.id });
      return created !== undefined;
    };
    let placed = await insertWith(base);
    if (placed) await evenOut(tx, 1);
    for (let attempt = 0; !placed && attempt < 8; attempt += 1) {
      placed = await insertWith(slugWithSuffix(base, slugSuffix()));
    }
    if (!placed) throw new Error('No free address for the organization');

    const stored = await tx
      .insert(signupPending)
      .values({ tenantId: id, ownerEmail: input.email, ownerName: input.ownerName })
      .onConflictDoNothing()
      .returning({ id: signupPending.id });
    if (stored.length === 0) throw new LostTheRace();

    await audit(tx, {
      action: 'signup.created',
      outcome: 'allow',
      actor: { ...origin.actor, userId: null, actingRole: null },
      resourceType: 'tenant',
      resourceId: id,
    });
  }

  return {
    async signUp(input, origin) {
      await withinLimits(origin, input.email, { creating: true });

      const id = newTenantId();
      let plan: Delivery;
      try {
        plan = await withTenant({ tenantId: id, userId: SYSTEM_USER_ID }, async (tx) => {
          const state = await stateOf(tx, input.email);
          if (state.kind === 'account') {
            await evenOut(tx, EVEN_WORK.request);
            return noticeDelivery(input.email, id);
          }
          if (state.kind === 'pending') {
            // A repeated signup for an address that is waiting for its link sends nothing and
            // touches nothing: the link in the mailbox is the owner's, and a stranger who types the
            // same address must not be able to replace it or spend it. The owner who lost the email
            // asks for a new one by the address (`resend`), which has its own limits. The delivery
            // does the same work as sending one (`silentDelivery`), so nothing tells it apart.
            await evenOut(tx, EVEN_WORK.request);
            return silentDelivery(id);
          }
          await create(tx, id, input, origin);
          return linkDelivery(id, false);
        });
      } catch (error) {
        // Somebody else's signup for this address landed first: the same answer, no second mail.
        if (error instanceof LostTheRace || databaseCodeOf(error) === UNIQUE_VIOLATION) {
          return silentDelivery(id);
        }
        throw error;
      }
      return plan;
    },

    async resend(email, origin) {
      await withinLimits(origin, email, { creating: false });
      const decoy = newTenantId();
      const state = await withTenant({ tenantId: decoy, userId: SYSTEM_USER_ID }, async (tx) => {
        const found = await stateOf(tx, email);
        await evenOut(tx, EVEN_WORK.request);
        return found;
      });
      if (state.kind === 'account') return noticeDelivery(email, decoy);
      if (state.kind === 'pending') return linkDelivery(state.tenantId, true);
      return silentDelivery(decoy);
    },

    async renew(tenantId, origin) {
      const address = await withTenant({ tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
        const [row] = await tx
          .select({ email: signupPending.ownerEmail })
          .from(signupPending)
          .where(isNull(signupPending.verifiedAt));
        await evenOut(tx, EVEN_WORK.request);
        return row?.email ?? null;
      });
      await withinLimits(origin, address, { creating: false });
      if (address === null) return silentDelivery(tenantId);
      return linkDelivery(tenantId, true);
    },

    async verify(host, input, origin) {
      const invalid = () => new AppError('signup_link_invalid');
      if (host.status !== 'unverified') throw invalid();
      // Both acceptances are the owner's, given now. Refusing costs nothing: the link is not spent.
      if (!input.acceptTerms || !input.acceptDataProcessing) {
        throw new AppError('signup_terms_required');
      }
      const token = input.token;

      // 1. Look at the link without spending it, and at the address: an account that appeared since
      // the signup (an invitation accepted) means the link must not create a second one.
      const looked = await withTenant({ tenantId: host.id, userId: SYSTEM_USER_ID }, async (tx) => {
        const seen = await tokens.inspect(tx, 'signup_verification', token);
        if (!seen) return null;
        const [pending] = await tx
          .select({ id: signupPending.id, email: signupPending.ownerEmail })
          .from(signupPending)
          .where(and(eq(signupPending.id, seen.subjectId), isNull(signupPending.verifiedAt)));
        if (!pending) return null;
        const state = await stateOf(tx, pending.email);
        return state.kind === 'pending' && state.tenantId === host.id ? pending : null;
      });
      if (looked === null) throw invalid();

      // 2. The password is the owner's choice, checked by the rules of identity against their own
      // address. A refusal says why and does not spend the link.
      const verdict = await deps.validator.validate(input.password, { email: looked.email });
      if (!verdict.ok) throw new AppError('validation_failed', passwordFieldErrors(verdict.issues));
      const passwordHash = await deps.hasher.hash(input.password);

      // 3. Spend the link and create everything in one transaction, acting as the new owner. If the
      // trial cannot start, nothing of this happened.
      const userId = uuidv7();
      try {
        return await withTenant({ tenantId: host.id, userId }, async (tx) => {
          const redeemed = await tokens.redeem(tx, 'signup_verification', token);
          if (!redeemed || redeemed.subjectId !== looked.id) throw invalid();
          const [pending] = await tx
            .select()
            .from(signupPending)
            .where(eq(signupPending.id, looked.id))
            .for('update');
          if (!pending || pending.verifiedAt !== null) throw invalid();
          const now = deps.clock();

          const terms = await tx
            .select({ kind: termsVersion.kind, version: termsVersion.version })
            .from(termsVersion)
            .where(eq(termsVersion.isCurrent, true));
          const termsCurrent = terms.find((row) => row.kind === 'terms')?.version;
          const processingCurrent = terms.find((row) => row.kind === 'data_processing')?.version;
          if (termsCurrent === undefined || processingCurrent === undefined) {
            throw new Error('There is no current version of the terms');
          }

          const activated = await tx
            .update(tenant)
            .set({ status: 'active' })
            .where(and(eq(tenant.id, host.id), eq(tenant.status, 'unverified')))
            .returning({ id: tenant.id });
          if (activated.length === 0) throw invalid();
          await deps.keys.ensureTenantKey(tx);

          // The account exists only now, with the password its owner chose at the link. The owner
          // has had no sign-in yet: the grace period of the second factor starts with it.
          await tx.insert(userAccount).values({
            id: userId,
            email: pending.ownerEmail,
            passwordHash,
            passwordChangedAt: now,
            firstSignInAt: now,
          });
          const [member] = await tx
            .insert(membership)
            .values({
              tenantId: host.id,
              userId,
              roles: ['owner'],
              displayName: pending.ownerName,
            })
            .returning({ id: membership.id });
          if (!member) throw new Error('membership insert returned no row');
          // The acceptance is recorded at the moment the owner gives it, with the versions in force.
          await tx.insert(termsAcceptance).values({
            tenantId: host.id,
            userId,
            termsVersion: termsCurrent,
            dataProcessingVersion: processingCurrent,
            acceptedAt: now,
          });
          await tx
            .update(signupPending)
            .set({ verifiedAt: now })
            .where(eq(signupPending.id, pending.id));

          // The trial of the plan starts with the organization. A refusal rolls everything back.
          await deps.trial.startTrial(tx, { tenantId: host.id });

          const issued = await deps.sessions.issue(tx, {
            tenantId: host.id,
            userId,
            membershipId: member.id,
            scope: 'full',
            ip: origin.actor.ip,
            userAgent: origin.actor.userAgent,
          });
          const actor = { ...origin.actor, userId, actingRole: 'owner' as const };
          await audit(tx, {
            action: 'terms.accepted',
            outcome: 'allow',
            actor,
            resourceType: 'tenant',
            resourceId: host.id,
            metadata: { terms: termsCurrent, dataProcessing: processingCurrent },
          });
          await audit(tx, {
            action: 'signup.verified',
            outcome: 'allow',
            actor,
            resourceType: 'tenant',
            resourceId: host.id,
          });
          return issued;
        });
      } catch (error) {
        // An account with this address was created while the link was in the mailbox.
        if (databaseCodeOf(error) === UNIQUE_VIOLATION) throw invalid();
        throw error;
      }
    },
  };
}
