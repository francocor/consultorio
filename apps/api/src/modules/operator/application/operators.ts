import { operatorUser } from '../../../db/schema/operator.js';
import { buildOtpauthUri, generateTotpSecret } from '../../../platform/crypto/totp.js';
import { uuidv7 } from '../../../platform/db/uuid.js';
import type { PasswordHasher } from '../../identity/index.js';
import type { OperatorSecrets } from '../infrastructure/secrets.js';

import type { OperatorRun } from './context.js';

/** Operator passwords are long: there are few operators and each one is a master key. */
export const OPERATOR_PASSWORD_MIN_LENGTH = 14;

export interface CreatedOperator {
  id: string;
  /** Shown once so the operator can enroll an authenticator app. It is never stored in clear. */
  totpSecretBase32: string;
  otpauthUri: string;
}

export interface OperatorAdmin {
  /**
   * Creates an operator with their second factor already in place: there is no grace period, so
   * an operator never exists without TOTP. Used by the bootstrap command; there is no endpoint.
   */
  create(input: { email: string; displayName: string; password: string }): Promise<CreatedOperator>;
}

export function createOperatorAdmin(deps: {
  run: OperatorRun;
  hasher: PasswordHasher;
  secrets: OperatorSecrets;
}): OperatorAdmin {
  return {
    async create(input) {
      if (input.password.length < OPERATOR_PASSWORD_MIN_LENGTH) {
        throw new Error(
          `The operator password must have at least ${String(OPERATOR_PASSWORD_MIN_LENGTH)} characters`,
        );
      }
      const id = uuidv7();
      const totp = generateTotpSecret();
      const sealed = await deps.secrets.seal(id, totp.bytes);
      const passwordHash = await deps.hasher.hash(input.password);
      await deps.run({ operatorId: id }, (tx) =>
        tx.insert(operatorUser).values({
          id,
          email: input.email.trim().toLowerCase(),
          displayName: input.displayName.trim(),
          passwordHash,
          totpDekWrapped: sealed.dekWrapped,
          totpSecretEnc: sealed.encrypted,
        }),
      );
      return {
        id,
        totpSecretBase32: totp.base32,
        otpauthUri: buildOtpauthUri({
          issuer: 'Consulvia Platform',
          account: input.email.trim().toLowerCase(),
          secretBase32: totp.base32,
        }),
      };
    },
  };
}
