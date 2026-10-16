import { createHash, randomBytes } from 'node:crypto';

import type { CreateTenantRequest, OperatorTenantDto } from '@consultorio/contracts';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { actionToken } from '../../../db/schema/action-token.js';
import { tenant } from '../../../db/schema/tenant.js';
import {
  writePlatformAudit,
  type PlatformAuditActor,
} from '../../../platform/audit/platform-audit.js';
import { audit } from '../../../platform/audit/writer.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { uuidv7 } from '../../../platform/db/uuid.js';
import { AppError } from '../../../platform/http/problem.js';
import { createActionTokens } from '../../../platform/tokens/index.js';
import { slugBase, slugWithSuffix } from '../domain/slug.js';

import type { OperatorIdentity, OperatorRun } from './context.js';

/** The seam where the demo module plugs in the privileged reset (Stage 1, task 1.124). */
export interface DemoResetPort {
  reset(input: { tenantId: string; operatorId: string }): Promise<void>;
}

/** Until the demo module exists, a reset answers "unavailable" instead of pretending. */
export const unavailableDemoReset: DemoResetPort = {
  reset: () => Promise.reject(new AppError('service_unavailable')),
};

/** What the console needs to send the owner their invitation once the tenant is safely stored. */
export interface OwnerInvitation {
  token: string;
  expiresAt: Date;
  email: string;
  slug: string;
  organizationName: string;
}

export interface OperatorTenants {
  /**
   * Creates an organization with its owner: the tenant row (slug generated, `is_demo` fixed here
   * and never changeable), its data key, default settings and the owner's single-use invitation.
   * Nobody gets a password from the operator. The link is returned to the caller to be emailed.
   */
  create(
    input: CreateTenantRequest,
    operator: OperatorIdentity,
    meta: Omit<PlatformAuditActor, 'operatorId'>,
  ): Promise<{ tenant: OperatorTenantDto; invitation: OwnerInvitation }>;
  list(): Promise<OperatorTenantDto[]>;
  /** A new owner invitation, only while nobody has joined the organization. */
  reissueOwnerInvitation(
    tenantId: string,
    ownerEmail: string,
    operator: OperatorIdentity,
    meta: Omit<PlatformAuditActor, 'operatorId'>,
  ): Promise<OwnerInvitation>;
  demoReset(
    tenantId: string,
    operator: OperatorIdentity,
    meta: Omit<PlatformAuditActor, 'operatorId'>,
  ): Promise<void>;
}

export interface OperatorTenantsDeps {
  run: OperatorRun;
  keys: TenantKeys;
  demoReset?: DemoResetPort;
  clock?: () => Date;
  /** Random part of a slug that collided; replaceable in tests. */
  slugSuffix?: () => string;
}

const SLUG_ATTEMPTS = 8;

type TenantRow = {
  id: string;
  slug: string;
  status: string;
  isDemo: boolean;
  country: string;
  theme: Record<string, unknown>;
  createdAt: Date;
};

const TENANT_COLUMNS = {
  id: tenant.id,
  slug: tenant.slug,
  status: tenant.status,
  isDemo: tenant.isDemo,
  country: tenant.country,
  theme: tenant.theme,
  createdAt: tenant.createdAt,
};

function toDto(row: TenantRow): OperatorTenantDto {
  const name = row.theme['displayName'];
  return {
    id: row.id,
    slug: row.slug,
    name: typeof name === 'string' && name.trim() !== '' ? name : row.slug,
    status: row.status as OperatorTenantDto['status'],
    isDemo: row.isDemo,
    country: row.country,
    createdAt: row.createdAt.toISOString(),
  };
}

/** One stable id per (organization, address), so a newer invitation cancels the older one. */
function subjectForAddress(address: string): string {
  const hex = createHash('sha256')
    .update(`invitation|${address.toLowerCase()}`)
    .digest()
    .subarray(0, 16)
    .toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function createOperatorTenants(deps: OperatorTenantsDeps): OperatorTenants {
  const tokens = createActionTokens(deps.clock ? { clock: deps.clock } : {});
  const suffix = deps.slugSuffix ?? (() => randomBytes(3).toString('hex').slice(0, 4));
  const demoReset = deps.demoReset ?? unavailableDemoReset;

  async function issueOwnerInvitation(
    tx: Tx,
    input: { operatorId: string; email: string; slug: string; organizationName: string },
  ): Promise<OwnerInvitation> {
    const email = input.email.trim().toLowerCase();
    const issued = await tokens.issue(tx, {
      kind: 'staff_invitation',
      subjectId: subjectForAddress(email),
      // `origin: operator` is the only invitation that needs no inviting member: the organization
      // has no members yet. The acceptance accepts it for the owner role and nothing else.
      payload: { email, roles: ['owner'], invitedBy: input.operatorId, origin: 'operator' },
    });
    return {
      token: issued.token,
      expiresAt: issued.expiresAt,
      email,
      slug: input.slug,
      organizationName: input.organizationName,
    };
  }

  return {
    async create(input, operator, meta) {
      const id = uuidv7();
      const base = slugBase(input.name);

      return deps.run({ tenantId: id, operatorId: operator.id }, async (tx) => {
        // The slug is the platform's choice: on a collision a random suffix is added and the caller
        // never learns the plain name was taken.
        let created: TenantRow | undefined;
        for (let attempt = 0; attempt < SLUG_ATTEMPTS && !created; attempt += 1) {
          const slug = attempt === 0 ? base : slugWithSuffix(base, suffix());
          [created] = await tx
            .insert(tenant)
            .values({
              id,
              slug,
              isDemo: input.isDemo,
              theme: { displayName: input.name },
              settings: {},
            })
            .onConflictDoNothing({ target: tenant.slug })
            .returning(TENANT_COLUMNS);
        }
        if (!created) throw new AppError('conflict');

        await deps.keys.ensureTenantKey(tx);
        const invitation = await issueOwnerInvitation(tx, {
          operatorId: operator.id,
          email: input.ownerEmail,
          slug: created.slug,
          organizationName: input.name,
        });

        // Both trails: the organization's own (its first entry) and the platform's.
        await audit(tx, {
          action: 'tenant.created',
          outcome: 'allow',
          actor: { ...meta, userId: operator.id, actingRole: null },
          resourceType: 'tenant',
          resourceId: id,
          metadata: { isDemo: input.isDemo },
        });
        await writePlatformAudit(tx, {
          action: 'tenant.created',
          outcome: 'allow',
          actor: { ...meta, operatorId: operator.id },
          targetTenantId: id,
          resourceType: 'tenant',
          resourceId: id,
          metadata: { isDemo: input.isDemo, slug: created.slug },
        });
        return { tenant: toDto(created), invitation };
      });
    },

    async list() {
      const rows = await deps.run({}, (tx) =>
        tx.select(TENANT_COLUMNS).from(tenant).orderBy(desc(tenant.createdAt)).limit(500),
      );
      return rows.map(toDto);
    },

    async reissueOwnerInvitation(tenantId, ownerEmail, operator, meta) {
      return deps.run({ tenantId, operatorId: operator.id }, async (tx) => {
        const [row] = await tx
          .select({ slug: tenant.slug, theme: tenant.theme })
          .from(tenant)
          .where(eq(tenant.id, tenantId));
        if (!row) throw new AppError('not_found');
        const name = row.theme['displayName'];
        let invitation: OwnerInvitation;
        try {
          await tx
            .update(actionToken)
            .set({ revokedAt: sql`now()` })
            .where(
              and(
                eq(actionToken.kind, 'staff_invitation'),
                isNull(actionToken.revokedAt),
                sql`${actionToken.uses} < ${actionToken.maxUses}`,
              ),
            );
          // The database only lets the operator do this while the organization has no member.
          invitation = await issueOwnerInvitation(tx, {
            operatorId: operator.id,
            email: ownerEmail,
            slug: row.slug,
            organizationName: typeof name === 'string' && name !== '' ? name : row.slug,
          });
        } catch {
          throw new AppError('conflict');
        }
        await writePlatformAudit(tx, {
          action: 'tenant.owner_invited',
          outcome: 'allow',
          actor: { ...meta, operatorId: operator.id },
          targetTenantId: tenantId,
          resourceType: 'tenant',
          resourceId: tenantId,
        });
        return invitation;
      });
    },

    async demoReset(tenantId, operator, meta) {
      const actor = { ...meta, operatorId: operator.id };
      const verdict = await deps.run({ tenantId, operatorId: operator.id }, async (tx) => {
        const [row] = await tx
          .select({ isDemo: tenant.isDemo })
          .from(tenant)
          .where(eq(tenant.id, tenantId));
        if (!row) return 'missing' as const;
        if (!row.isDemo) {
          // The refusal is recorded even though the request fails: it is a platform event.
          await writePlatformAudit(tx, {
            action: 'tenant.demo_reset',
            outcome: 'deny',
            actor,
            targetTenantId: tenantId,
            reason: 'not_a_demo_tenant',
            resourceType: 'tenant',
            resourceId: tenantId,
          });
          return 'not_demo' as const;
        }
        return 'ok' as const;
      });
      if (verdict === 'missing') throw new AppError('not_found');
      if (verdict === 'not_demo') throw new AppError('demo_tenant_required');

      await demoReset.reset({ tenantId, operatorId: operator.id });
      await deps.run({ tenantId, operatorId: operator.id }, (tx) =>
        writePlatformAudit(tx, {
          action: 'tenant.demo_reset',
          outcome: 'allow',
          actor,
          targetTenantId: tenantId,
          resourceType: 'tenant',
          resourceId: tenantId,
        }),
      );
    },
  };
}
