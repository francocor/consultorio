import { describe, expect, it, vi } from 'vitest';

import { createPasswordHasher, type Argon2Functions } from './argon2.js';

describe('password hashing', () => {
  it('produces a salted Argon2id hash that verifies only the right password', async () => {
    const hasher = createPasswordHasher();

    const first = await hasher.hash('una frase larga y propia');
    const second = await hasher.hash('una frase larga y propia');

    expect(first).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(second).not.toBe(first);
    expect(await hasher.verify(first, 'una frase larga y propia')).toBe(true);
    expect(await hasher.verify(first, 'otra frase distinta')).toBe(false);
  });

  it('answers false, without throwing, for a malformed stored hash', async () => {
    const hasher = createPasswordHasher();

    expect(await hasher.verify('not-a-hash', 'whatever')).toBe(false);
    expect(await hasher.verify('', 'whatever')).toBe(false);
  });
});

describe('verifyOrDummy: unknown users take the same path as known ones', () => {
  function spied() {
    const calls: { hash: string; password: string }[] = [];
    const hashSpy = vi.fn((password: string) =>
      Promise.resolve(`$argon2id$dummy$${password.length > 0 ? 'x' : 'y'}`),
    );
    const functions: Argon2Functions = {
      hash: hashSpy,
      verify: vi.fn((hash: string, password: string) => {
        calls.push({ hash, password });
        return Promise.resolve(hash === '$argon2id$real' && password === 'right');
      }),
    };
    return { functions, calls, hashSpy };
  }

  it('runs exactly one verification for a known user, with the stored hash', async () => {
    const { functions, calls } = spied();
    const hasher = createPasswordHasher({ functions });

    expect(await hasher.verifyOrDummy('$argon2id$real', 'right')).toBe(true);
    expect(await hasher.verifyOrDummy('$argon2id$real', 'wrong')).toBe(false);

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.hash)).toEqual(['$argon2id$real', '$argon2id$real']);
  });

  it('runs exactly one verification for an unknown user, against a dummy hash, and never succeeds', async () => {
    const { functions, calls } = spied();
    const hasher = createPasswordHasher({ functions });

    expect(await hasher.verifyOrDummy(null, 'right')).toBe(false);
    expect(await hasher.verifyOrDummy(undefined, 'right')).toBe(false);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.hash).toMatch(/^\$argon2id\$dummy\$/);
    expect(calls[0]?.hash).not.toBe('$argon2id$real');
    expect(calls[0]?.password).toBe('right');
  });

  it('builds the dummy hash once, so an unknown user does not cost an extra hashing', async () => {
    const { functions, hashSpy } = spied();
    const hasher = createPasswordHasher({ functions });

    await hasher.verifyOrDummy(null, 'a');
    await hasher.verifyOrDummy(null, 'b');
    await hasher.verifyOrDummy(null, 'c');

    expect(hashSpy).toHaveBeenCalledTimes(1);
  });

  it('with the real library, an unknown user and a wrong password both come back false', async () => {
    const hasher = createPasswordHasher();
    const stored = await hasher.hash('la contraseña correcta');

    expect(await hasher.verifyOrDummy(stored, 'la contraseña correcta')).toBe(true);
    expect(await hasher.verifyOrDummy(stored, 'la contraseña incorrecta')).toBe(false);
    expect(await hasher.verifyOrDummy(null, 'la contraseña correcta')).toBe(false);
  });
});
