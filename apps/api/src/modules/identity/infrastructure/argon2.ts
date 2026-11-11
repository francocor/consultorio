import { randomBytes } from 'node:crypto';

import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';

/** The two library calls the hasher needs, replaceable in tests. */
export interface Argon2Functions {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  /** True only when the password matches. A malformed stored hash is simply `false`. */
  verify(storedHash: string, password: string): Promise<boolean>;
  /**
   * Verifies against the stored hash, or against a dummy hash when there is no account. Both
   * branches run exactly one Argon2 verification, so an unknown identifier costs the same time as
   * a known one and takes the same code path (identity-access, "Wrong password and unknown
   * identifier look the same"). The dummy can never succeed.
   */
  verifyOrDummy(storedHash: string | null | undefined, password: string): Promise<boolean>;
}

/** OWASP's Argon2id baseline (Argon2id is the library default): 19 MiB of memory, 2 passes, 1 lane. */
const PARAMETERS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

const libraryFunctions: Argon2Functions = {
  hash: (password) => argon2Hash(password, PARAMETERS),
  verify: (storedHash, password) => argon2Verify(storedHash, password),
};

export function createPasswordHasher(
  options: { functions?: Argon2Functions } = {},
): PasswordHasher {
  const functions = options.functions ?? libraryFunctions;
  // Built once, with the same parameters as real hashes, from a random password nobody knows.
  let dummy: Promise<string> | undefined;
  const dummyHash = () => (dummy ??= functions.hash(randomBytes(24).toString('base64')));

  const verify = async (storedHash: string, password: string): Promise<boolean> => {
    try {
      return await functions.verify(storedHash, password);
    } catch {
      // A malformed hash is a failed verification, not a server error.
      return false;
    }
  };

  return {
    hash: (password) => functions.hash(password),
    verify,
    async verifyOrDummy(storedHash, password) {
      if (storedHash === null || storedHash === undefined || storedHash === '') {
        await verify(await dummyHash(), password);
        return false;
      }
      return verify(storedHash, password);
    },
  };
}
