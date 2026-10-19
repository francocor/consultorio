import { and, eq, sql } from 'drizzle-orm';

import { portalIdentity, portalLink } from '../../../db/schema/portal.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import type { RateLimitStore } from '../../../platform/http/rate-limit.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import type { ActionTokens } from '../../../platform/tokens/index.js';
import { findPatientByDocument } from '../../patients/index.js';
import { PORTAL_VERIFY_ATTEMPTS, PORTAL_VERIFY_WINDOW_MS, addressKey } from '../domain/code.js';

import { checkCode, openChallenge, type PortalCodePurpose } from './codes.js';
import { normalizeDocument } from './country.js';
import { liveSelfLink, patientAuditActor } from './identities.js';
import type { PortalSessions } from './sessions.js';

export interface SignInDeps {
  sessions: PortalSessions;
  tokens: ActionTokens;
  /** Queues the email with the code. Absent: the portal cannot send codes at all. */
  jobs: JobClient | undefined;
  /** The counters of the tries per address. Best effort: a store that fails does not close the portal. */
  store: RateLimitStore;
  clock: () => Date;
}

/** Who is asking and for which organization, as the route knows them. */
export interface SignInContext {
  tenant: { id: string; country: string };
  actor: AuditActor;
  ip: string | null;
  userAgent: string | null;
}

export type VerifyOutcome =
  | { outcome: 'signed_in'; token: string; expiresAt: Date }
  | { outcome: 'invalid' }
  | { outcome: 'locked' };

// Asking for a code ------------------------------------------------------------------------------

/**
 * The patient this registration is for, when the document AND the email match one record that is
 * active, has no account of its own and whose address is not taken by another account. Anything
 * else is null, and the caller says nothing different in that case (patient-portal "Portal account
 * activation and identity linking": a mismatch reveals nothing).
 */
async function registrationCandidate(
  tx: Tx,
  ctx: SignInContext,
  input: { nationalId: string; email: string },
): Promise<{ patientId: string; invitedIdentityId: string | null } | null> {
  const document = normalizeDocument(ctx.tenant.country, 'dni', input.nationalId);
  if (!document?.ok) return null;
  const match = await findPatientByDocument(tx, document.value);
  if (match?.status !== 'active') return null;
  if (match.email === null || match.email.trim().toLowerCase() !== input.email) return null;
  if (await liveSelfLink(tx, match.id)) return null;

  const [identity] = await tx
    .select({
      id: portalIdentity.id,
      status: portalIdentity.status,
      invited: portalIdentity.invitedPatientId,
    })
    .from(portalIdentity)
    .where(eq(portalIdentity.email, input.email));
  if (!identity) return { patientId: match.id, invitedIdentityId: null };
  // An invitation for this very patient that was not followed: the registration finishes it.
  if (identity.status === 'invited' && identity.invited === match.id) {
    return { patientId: match.id, invitedIdentityId: identity.id };
  }
  return null;
}

/** Sends the registration code when the data match, and does nothing visible when they do not. */
export async function requestRegistrationCode(
  tx: Tx,
  deps: SignInDeps & { jobs: JobClient },
  ctx: SignInContext,
  input: { nationalId: string; email: string },
): Promise<void> {
  const candidate = await registrationCandidate(tx, ctx, input);
  if (!candidate) return;
  await openChallenge(tx, {
    tenantId: ctx.tenant.id,
    purpose: 'portal_registration',
    email: input.email,
    now: deps.clock(),
    jobs: deps.jobs,
  });
}

/** Sends the sign-in code to an active account, and does nothing visible for any other address. */
export async function requestSignInCode(
  tx: Tx,
  deps: SignInDeps & { jobs: JobClient },
  ctx: SignInContext,
  input: { email: string },
): Promise<void> {
  const [identity] = await tx
    .select({ id: portalIdentity.id })
    .from(portalIdentity)
    .where(and(eq(portalIdentity.email, input.email), eq(portalIdentity.status, 'active')));
  if (!identity) return;
  await openChallenge(tx, {
    tenantId: ctx.tenant.id,
    purpose: 'portal_sign_in',
    email: input.email,
    now: deps.clock(),
    jobs: deps.jobs,
  });
}

// Using the code ---------------------------------------------------------------------------------

/**
 * Counts one try for an address and says whether the portal still answers for it. The key holds a
 * hash of the address and counts the existing and the unknown addresses alike, so being locked out
 * tells nothing about the account.
 */
async function withinTries(
  deps: SignInDeps,
  ctx: SignInContext,
  flow: 'sign_in' | 'registration',
  email: string,
): Promise<boolean> {
  try {
    const state = await deps.store.hit(
      `portal|${flow}|${addressKey(ctx.tenant.id, email)}`,
      PORTAL_VERIFY_WINDOW_MS,
    );
    return state.count <= PORTAL_VERIFY_ATTEMPTS;
  } catch {
    return true;
  }
}

async function failure(
  tx: Tx,
  ctx: SignInContext,
  identityId: string | null,
  reason: 'wrong_code' | 'locked',
): Promise<void> {
  // Only an account that exists has a trail to write on: what happens to an unknown address is not
  // an event of anybody's.
  if (identityId === null) return;
  await audit(tx, {
    action: 'portal.signin.failure',
    outcome: 'deny',
    actor: patientAuditActor(ctx.actor),
    resourceType: 'portal_identity',
    resourceId: identityId,
    reason,
    metadata: { method: 'email_code' },
  });
}

async function startSession(
  tx: Tx,
  deps: SignInDeps,
  ctx: SignInContext,
  identityId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const links = await tx
    .select({ id: portalLink.id })
    .from(portalLink)
    .where(and(eq(portalLink.portalIdentityId, identityId), eq(portalLink.status, 'active')));
  const issued = await deps.sessions.issue(tx, {
    identityId,
    // One record to read: it is the subject at once. With several the person picks.
    selectedLinkId: links.length === 1 ? (links[0]?.id ?? null) : null,
    now: deps.clock(),
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
  await audit(tx, {
    action: 'portal.signin.success',
    outcome: 'allow',
    actor: patientAuditActor(ctx.actor),
    resourceType: 'portal_identity',
    resourceId: identityId,
    metadata: { method: 'email_code' },
  });
  return { token: issued.token, expiresAt: issued.expiresAt };
}

/** The sign-in code of an active account. */
export async function verifySignInCode(
  tx: Tx,
  deps: SignInDeps,
  ctx: SignInContext,
  input: { email: string; code: string },
): Promise<VerifyOutcome> {
  const [identity] = await tx
    .select({ id: portalIdentity.id, status: portalIdentity.status })
    .from(portalIdentity)
    .where(eq(portalIdentity.email, input.email));
  const accountId = identity?.status === 'active' ? identity.id : null;

  if (!(await withinTries(deps, ctx, 'sign_in', input.email))) {
    await failure(tx, ctx, accountId, 'locked');
    return { outcome: 'locked' };
  }
  const checked = await checkCode(tx, {
    purpose: 'portal_sign_in',
    email: input.email,
    code: input.code,
    now: deps.clock(),
  });
  // A deactivated account has no sign-in even with a code asked for before it was deactivated.
  if (checked !== 'ok' || accountId === null) {
    await failure(tx, ctx, accountId, 'wrong_code');
    return { outcome: 'invalid' };
  }
  return { outcome: 'signed_in', ...(await startSession(tx, deps, ctx, accountId)) };
}

/** The code of a registration: the account is made and the first session starts. */
export async function verifyRegistrationCode(
  tx: Tx,
  deps: SignInDeps,
  ctx: SignInContext,
  input: { nationalId: string; email: string; code: string },
): Promise<VerifyOutcome> {
  if (!(await withinTries(deps, ctx, 'registration', input.email))) return { outcome: 'locked' };
  // Without a record that matches there is no challenge to try: a stranger's guess at somebody
  // else's document must not use up the code that person was sent.
  const candidate = await registrationCandidate(tx, ctx, input);
  if (!candidate) return { outcome: 'invalid' };
  const checked = await checkCode(tx, {
    purpose: 'portal_registration',
    email: input.email,
    code: input.code,
    now: deps.clock(),
  });
  if (checked !== 'ok') return { outcome: 'invalid' };

  const now = deps.clock();
  let identityId: string;
  try {
    identityId = await tx.transaction(async (inner) => {
      let id = candidate.invitedIdentityId;
      if (id === null) {
        const [row] = await inner
          .insert(portalIdentity)
          .values({
            tenantId: sql`current_setting('app.tenant_id')::uuid`,
            email: input.email,
            status: 'active',
            activatedAt: now,
          })
          .returning({ id: portalIdentity.id });
        if (!row) throw new Error('portal identity insert returned no row');
        id = row.id;
      } else {
        await inner
          .update(portalIdentity)
          .set({ status: 'active', activatedAt: now })
          .where(eq(portalIdentity.id, id));
      }
      await inner.insert(portalLink).values({
        tenantId: sql`current_setting('app.tenant_id')::uuid`,
        portalIdentityId: id,
        patientId: candidate.patientId,
        relationship: 'self',
      });
      return id;
    });
  } catch (error) {
    const code =
      (error as { cause?: { code?: string }; code?: string } | null)?.cause?.code ??
      (error as { code?: string } | null)?.code;
    // Somebody took the address or the patient in the meantime.
    if (code === '23505') return { outcome: 'invalid' };
    throw error;
  }
  if (candidate.invitedIdentityId !== null) {
    await deps.tokens.revokeForSubject(tx, 'portal_activation', identityId);
  }
  const actor = patientAuditActor(ctx.actor);
  if (candidate.invitedIdentityId === null) {
    await audit(tx, {
      action: 'portal.identity.created',
      outcome: 'allow',
      actor,
      resourceType: 'portal_identity',
      resourceId: identityId,
      patientId: candidate.patientId,
      metadata: { status: 'active', relationship: 'self', via: 'registration' },
    });
  }
  await audit(tx, {
    action: 'portal.identity.linked',
    outcome: 'allow',
    actor,
    resourceType: 'portal_identity',
    resourceId: identityId,
    patientId: candidate.patientId,
    metadata: { relationship: 'self', via: 'registration' },
  });
  return { outcome: 'signed_in', ...(await startSession(tx, deps, ctx, identityId)) };
}

export type { PortalCodePurpose };
