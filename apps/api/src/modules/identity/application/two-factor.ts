import { and, eq, isNull, sql } from 'drizzle-orm';

import { recoveryCode, userAccount } from '../../../db/schema/identity.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import {
  buildOtpauthUri,
  decodeBase32Secret,
  generateTotpSecret,
  verifyTotp,
} from '../../../platform/crypto/totp.js';
import type { Tx, WithTenant } from '../../../platform/db/tenant-context.js';

import {
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
} from './recovery-codes.js';

export interface TwoFactorStatus {
  /** A confirmed factor exists: sign-in asks for a code. */
  enrolled: boolean;
  /** A secret was generated but not yet proven with a code. */
  pending: boolean;
}

export interface BeginEnrollmentInput {
  tenantId: string;
  userId: string;
  /** The account label shown by the authenticator app (the email). */
  account: string;
  /** The issuer shown by the authenticator app (the organization name). */
  issuer: string;
}

export interface TwoFactor {
  status(tx: Tx, userId: string): Promise<TwoFactorStatus>;
  /**
   * Generates a secret and stores it encrypted as PENDING. An already enrolled user keeps the
   * working factor until the new one is confirmed, so abandoning a replacement locks nobody out.
   */
  beginEnrollment(
    tx: Tx,
    input: BeginEnrollmentInput,
  ): Promise<{ secretBase32: string; otpauthUri: string }>;
  /** Proves the pending secret with a code, activates it and issues a fresh set of recovery codes. */
  confirmEnrollment(
    tx: Tx,
    input: { tenantId: string; userId: string; code: string },
  ): Promise<{ ok: true; recoveryCodes: string[] } | { ok: false }>;
  /** Checks a code against the active factor and blocks replay, atomically. */
  verifyCode(
    tx: Tx,
    input: { tenantId: string; userId: string; code: string },
  ): Promise<{ ok: true } | { ok: false; reason: 'invalid' | 'replay' }>;
  /** Consumes a recovery code. True only the first time a valid code is used. */
  useRecoveryCode(tx: Tx, userId: string, input: string): Promise<boolean>;
  /** Invalidates every recovery code and issues a new set. */
  regenerateRecoveryCodes(tx: Tx, userId: string): Promise<string[]>;
  /** Removes the factor and the recovery codes. Callers decide whether the role allows it. */
  disable(tx: Tx, userId: string): Promise<void>;
}

export interface TwoFactorDeps {
  keys: TenantKeys;
  /** Opens a transaction on another tenant, to read a secret enrolled there. */
  withTenant: WithTenant;
  clock?: () => Date;
}

const ACTIVE = 'totp_secret_enc';
const PENDING = 'totp_pending_enc';

export function createTwoFactor(deps: TwoFactorDeps): TwoFactor {
  const clock = deps.clock ?? (() => new Date());
  const ref = (userId: string, column: string) => ({
    table: 'user_account',
    column,
    rowId: userId,
  });

  async function insertRecoveryCodes(tx: Tx, userId: string): Promise<string[]> {
    const codes = generateRecoveryCodes();
    await tx.delete(recoveryCode).where(eq(recoveryCode.userId, userId));
    await tx.insert(recoveryCode).values(
      codes.map((code) => ({
        userId,
        codeHash: hashRecoveryCode(normalizeRecoveryCode(code) ?? code),
      })),
    );
    return codes;
  }

  /** The active secret, decrypted with the key of the tenant it was enrolled on. */
  async function activeSecret(
    tx: Tx,
    tenantId: string,
    userId: string,
    row: { totpSecretEnc: Buffer; totpTenantId: string | null },
  ): Promise<Uint8Array> {
    const decrypt = async (inTx: Tx) =>
      new Uint8Array(await deps.keys.decryptField(inTx, ref(userId, ACTIVE), row.totpSecretEnc));
    if (row.totpTenantId === null || row.totpTenantId === tenantId) return decrypt(tx);
    return deps.withTenant({ tenantId: row.totpTenantId, userId }, decrypt);
  }

  return {
    async status(tx, userId) {
      const [row] = await tx
        .select({
          secret: userAccount.totpSecretEnc,
          confirmedAt: userAccount.totpConfirmedAt,
          pending: userAccount.totpPendingEnc,
        })
        .from(userAccount)
        .where(eq(userAccount.id, userId));
      return {
        enrolled: row?.secret != null && row.confirmedAt != null,
        pending: row?.pending != null,
      };
    },

    async beginEnrollment(tx, input) {
      const secret = generateTotpSecret();
      const encrypted = await deps.keys.encryptField(
        tx,
        ref(input.userId, PENDING),
        Buffer.from(secret.bytes),
      );
      await tx
        .update(userAccount)
        .set({ totpPendingEnc: encrypted })
        .where(eq(userAccount.id, input.userId));
      return {
        secretBase32: secret.base32,
        otpauthUri: buildOtpauthUri({
          issuer: input.issuer,
          account: input.account,
          secretBase32: secret.base32,
        }),
      };
    },

    async confirmEnrollment(tx, input) {
      const [row] = await tx
        .select({ pending: userAccount.totpPendingEnc })
        .from(userAccount)
        .where(eq(userAccount.id, input.userId));
      if (!row?.pending) return { ok: false };

      let secret: Uint8Array;
      try {
        secret = new Uint8Array(
          await deps.keys.decryptField(tx, ref(input.userId, PENDING), row.pending),
        );
      } catch {
        // Started on another organization, or damaged: it has to be started again.
        return { ok: false };
      }
      const verdict = verifyTotp(secret, input.code, clock(), null);
      if (!verdict.ok) return { ok: false };

      const active = await deps.keys.encryptField(
        tx,
        ref(input.userId, ACTIVE),
        Buffer.from(secret),
      );
      await tx
        .update(userAccount)
        .set({
          totpSecretEnc: active,
          totpTenantId: input.tenantId,
          totpConfirmedAt: clock(),
          // The code that proved the enrollment is spent: it cannot be used to sign in.
          totpLastStep: verdict.step,
          totpPendingEnc: null,
        })
        .where(eq(userAccount.id, input.userId));
      return { ok: true, recoveryCodes: await insertRecoveryCodes(tx, input.userId) };
    },

    async verifyCode(tx, input) {
      const [row] = await tx
        .select({
          secret: userAccount.totpSecretEnc,
          tenantId: userAccount.totpTenantId,
          confirmedAt: userAccount.totpConfirmedAt,
          lastStep: userAccount.totpLastStep,
        })
        .from(userAccount)
        .where(eq(userAccount.id, input.userId));
      if (!row?.secret || row.confirmedAt === null) return { ok: false, reason: 'invalid' };

      const secret = await activeSecret(tx, input.tenantId, input.userId, {
        totpSecretEnc: row.secret,
        totpTenantId: row.tenantId,
      });
      const verdict = verifyTotp(secret, input.code, clock(), row.lastStep);
      secret.fill(0);
      if (!verdict.ok) return verdict;

      // Atomic: of two simultaneous submissions of one code, only one moves the step forward.
      const claimed = await tx
        .update(userAccount)
        .set({ totpLastStep: verdict.step })
        .where(
          and(
            eq(userAccount.id, input.userId),
            sql`(${userAccount.totpLastStep} is null or ${userAccount.totpLastStep} < ${verdict.step})`,
          ),
        )
        .returning({ id: userAccount.id });
      return claimed.length > 0 ? { ok: true } : { ok: false, reason: 'replay' };
    },

    async useRecoveryCode(tx, userId, input) {
      const normalized = normalizeRecoveryCode(input);
      if (normalized === null) return false;
      const used = await tx
        .update(recoveryCode)
        .set({ usedAt: clock() })
        .where(
          and(
            eq(recoveryCode.userId, userId),
            eq(recoveryCode.codeHash, hashRecoveryCode(normalized)),
            isNull(recoveryCode.usedAt),
          ),
        )
        .returning({ id: recoveryCode.id });
      return used.length > 0;
    },

    regenerateRecoveryCodes: (tx, userId) => insertRecoveryCodes(tx, userId),

    async disable(tx, userId) {
      await tx
        .update(userAccount)
        .set({
          totpSecretEnc: null,
          totpPendingEnc: null,
          totpTenantId: null,
          totpConfirmedAt: null,
          totpLastStep: null,
        })
        .where(eq(userAccount.id, userId));
      await tx.delete(recoveryCode).where(eq(recoveryCode.userId, userId));
    },
  };
}

export { decodeBase32Secret };
