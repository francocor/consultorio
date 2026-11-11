import type { PasswordValidator } from '../../../modules/identity/domain/password-policy.js';
import type { PasswordHasher } from '../../../modules/identity/index.js';
import { DEFAULT_LOCATION_NAME } from '../../../modules/onboarding/domain/defaults.js';
import { createTenantLookup } from '../../../modules/tenancy/index.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Db } from '../../../platform/db/pool.js';
import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { uuidv7 } from '../../../platform/db/uuid.js';
import type { EmailSender } from '../../../platform/mail/email-sender.js';
import { membership, userAccount } from '../../schema/identity.js';
import { location, tenant } from '../../schema/tenant.js';

/** What the setup screen of Consulvia Desktop asks for. */
export interface LocalProvisionInput {
  organizationName: string;
  /** The slug the install is pinned to (`SINGLE_TENANT_SLUG`). */
  slug: string;
  ownerName: string;
  ownerEmail: string;
  /** The password the owner chose. Checked by the rules of the product, then hashed; never stored or logged. */
  ownerPassword: string;
  /** IANA name; the time zone of the first location. */
  timeZone: string;
}

export interface LocalProvisionDeps {
  db: Db;
  withTenant: WithTenant;
  hasher: PasswordHasher;
  keys: TenantKeys;
  validator: PasswordValidator;
  clock: () => Date;
  /** Where a notice to the owner goes (the outbox folder of the desktop profile). Without it, none is sent. */
  email?: EmailSender | undefined;
}

export type LocalProvisionResult =
  | { status: 'created'; tenantId: string; slug: string }
  | { status: 'exists'; tenantId: string; slug: string };

export type LocalProvisionErrorCode =
  | 'password_rejected'
  | 'demo_organization'
  | 'email_in_use'
  | 'owner_not_found'
  | 'owner_ambiguous';

/** The organization cannot be provisioned or changed. The message never carries the password. */
export class LocalProvisionError extends Error {
  constructor(
    readonly code: LocalProvisionErrorCode,
    /** For `password_rejected`: what is wrong with it, as the identity module names it. */
    readonly issues: readonly string[] = [],
  ) {
    super(code);
    this.name = 'LocalProvisionError';
  }
}

const UNIQUE_VIOLATION = '23505';

function violation(error: unknown): { code?: string; constraint?: string } {
  const source = (error as { cause?: unknown } | null)?.cause ?? error;
  const { code, constraint } = (source ?? {}) as { code?: unknown; constraint?: unknown };
  return {
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof constraint === 'string' ? { constraint } : {}),
  };
}

/** The email as it is stored and compared: no surrounding spaces, lower case. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/**
 * Creates the one organization of a desktop install: a real, active organization (never a demo one)
 * that the subscription does not bill, its data key, its first location and an owner who can sign in
 * with the password chosen on the setup screen. It is what the signup of the hosted product does, minus
 * the emailed link (nobody can sign up for a PC they are sitting at) and the trial.
 *
 * Idempotent: when an organization with this slug exists it changes NOTHING and says so. The creation is
 * one transaction, so it either exists whole or does not exist, and two installs racing for the same
 * slug end with one organization.
 */
export async function provisionLocalOrganization(
  deps: LocalProvisionDeps,
  input: LocalProvisionInput,
): Promise<LocalProvisionResult> {
  const lookup = createTenantLookup(deps.db);
  const existingResult = async (): Promise<LocalProvisionResult | null> => {
    const found = await lookup(input.slug);
    if (!found) return null;
    // The flag is fixed at creation: this must never turn a demo organization into a real one.
    if (found.isDemo) throw new LocalProvisionError('demo_organization');
    return { status: 'exists', tenantId: found.id, slug: input.slug };
  };
  const existing = await existingResult();
  if (existing) return existing;

  const email = normalizeEmail(input.ownerEmail);
  const verdict = await deps.validator.validate(input.ownerPassword, { email });
  if (!verdict.ok) throw new LocalProvisionError('password_rejected', verdict.issues);
  const passwordHash = await deps.hasher.hash(input.ownerPassword);

  const tenantId = uuidv7();
  const userId = uuidv7();
  const now = deps.clock();
  const owner: AuditActor = {
    userId,
    actingRole: 'owner',
    ip: null,
    userAgent: 'provision-local',
    requestId: null,
  };
  try {
    // The tenant is inserted under a context whose tenant id is its own, as the operator console does,
    // and the account under the context of its own user: the policies of both accept nothing else.
    await deps.withTenant({ tenantId, userId }, async (tx) => {
      await tx.insert(tenant).values({
        id: tenantId,
        slug: input.slug,
        status: 'active',
        isDemo: false,
        billingExempt: true,
        theme: { displayName: input.organizationName.trim() },
      });
      await deps.keys.ensureTenantKey(tx);
      await tx.insert(userAccount).values({
        id: userId,
        email,
        passwordHash,
        passwordChangedAt: now,
      });
      await tx.insert(membership).values({
        tenantId,
        userId,
        roles: ['owner'],
        displayName: input.ownerName.trim(),
      });
      const locationId = uuidv7();
      await tx.insert(location).values({
        id: locationId,
        tenantId,
        name: DEFAULT_LOCATION_NAME,
        timeZone: input.timeZone,
      });
      await audit(tx, {
        action: 'location.created',
        outcome: 'allow',
        actor: owner,
        resourceType: 'location',
        resourceId: locationId,
      });
    });
  } catch (error) {
    const failure = violation(error);
    if (failure.code === UNIQUE_VIOLATION) {
      if (failure.constraint === 'tenant_slug_key') {
        // Somebody else created it between the look and the insert: it exists, as far as we can tell.
        const raced = await existingResult();
        if (raced) return raced;
      }
      if (failure.constraint === 'user_account_email_key') {
        throw new LocalProvisionError('email_in_use');
      }
    }
    throw error;
  }
  return { status: 'created', tenantId, slug: input.slug };
}
