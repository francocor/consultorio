import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  createPasswordPolicy,
  createPasswordValidator,
  describePasswordIssues,
  loadCommonPasswords,
  parseCommonPasswords,
} from './password-policy.js';

const here = dirname(fileURLToPath(import.meta.url));
const ASSET = resolve(here, '../../../../assets/common-passwords-100k.txt');

const policy = createPasswordPolicy(
  parseCommonPasswords('password123\nQwerty123456\n  letmein2024  \n'),
);

describe('password length', () => {
  it('rejects a password shorter than the minimum, accepts exactly the minimum', () => {
    const atLimit = 'x7Kq-2mPz9'.slice(0, PASSWORD_MIN_LENGTH);
    expect(atLimit).toHaveLength(PASSWORD_MIN_LENGTH);

    expect(policy.check(atLimit.slice(0, -1))).toEqual({ ok: false, issues: ['too_short'] });
    expect(policy.check(atLimit)).toEqual({ ok: true });
  });

  it('rejects a password longer than the maximum, accepts exactly the maximum', () => {
    const atLimit = 'aB3-'.repeat(PASSWORD_MAX_LENGTH / 4);
    expect(atLimit).toHaveLength(PASSWORD_MAX_LENGTH);

    expect(policy.check(atLimit)).toEqual({ ok: true });
    expect(policy.check(`${atLimit}z`)).toEqual({ ok: false, issues: ['too_long'] });
  });

  it('counts characters, not UTF-16 units (an emoji is one character)', () => {
    const keys = '🔑🔒'.repeat(PASSWORD_MIN_LENGTH / 2);
    expect(Array.from(keys)).toHaveLength(PASSWORD_MIN_LENGTH);

    expect(policy.check(keys)).toEqual({ ok: true });
    expect(policy.check(keys.slice(0, -2))).toEqual({ ok: false, issues: ['too_short'] });
  });
});

describe('common passwords', () => {
  it('rejects a listed password whatever its case and surrounding spaces', () => {
    expect(policy.check('PASSWORD123')).toEqual({ ok: false, issues: ['common'] });
    expect(policy.check('qwerty123456')).toEqual({ ok: false, issues: ['common'] });
    expect(policy.check('letmein2024')).toEqual({ ok: false, issues: ['common'] });
  });

  it('accepts a passphrase that is not on the list', () => {
    expect(policy.check('correct horse battery staple')).toEqual({ ok: true });
    expect(policy.check('la-vaca-vuela-sobre-la-luna-42')).toEqual({ ok: true });
  });

  it('rejects "1234" and its longer cousins, as the spec requires', () => {
    expect(policy.check('1234')).toEqual({ ok: false, issues: ['too_short'] });
    expect(policy.check('1111111111')).toEqual({ ok: false, issues: ['repeated_character'] });
  });

  it('reports a single repeated character, and a too-short password by its length alone', () => {
    expect(policy.check('abc')).toEqual({ ok: false, issues: ['too_short'] });
    expect(policy.check('aaaaaaaaaaaa')).toEqual({ ok: false, issues: ['repeated_character'] });
  });
});

describe('personal data', () => {
  it('rejects a password that contains the local part of the email', () => {
    expect(policy.check('maria.gomez-2024!', { email: 'maria.gomez@clinica.example' })).toEqual({
      ok: false,
      issues: ['contains_email'],
    });
  });

  it('ignores a very short email local part and accepts unrelated passwords', () => {
    expect(policy.check('abcdefgh-ij-kl', { email: 'ab@clinica.example' })).toEqual({ ok: true });
    expect(policy.check('sol-y-luna-y-mar-7', { email: 'maria.gomez@clinica.example' })).toEqual({
      ok: true,
    });
  });
});

describe('messages', () => {
  it('describes every issue with an actionable es-AR message and a translation key', () => {
    const described = describePasswordIssues(['too_short', 'common']);

    expect(described).toEqual([
      {
        code: 'too_short',
        i18nKey: 'auth.password.too_short',
        message: expect.stringContaining('al menos 10 caracteres') as string,
      },
      {
        code: 'common',
        i18nKey: 'auth.password.common',
        message: expect.stringContaining('muy común') as string,
      },
    ]);
  });
});

describe('the bundled list', () => {
  it('parses text into a normalized set', () => {
    const set = parseCommonPasswords('Hello1234\r\n\r\n  Mundo  \nhello1234\n');

    expect([...set].sort()).toEqual(['hello1234', 'mundo']);
  });

  it('is loaded from the asset file: about 100k entries including well-known passwords', async () => {
    const list = await loadCommonPasswords(ASSET);

    expect(list.size).toBeGreaterThan(90_000);
    expect(list.has('password')).toBe(true);
    expect(list.has('123456')).toBe(true);
    expect(list.has('this-is-not-a-common-passphrase-7391')).toBe(false);
  });

  it('rejects a well-known long password through the real list', async () => {
    const real = createPasswordPolicy(await loadCommonPasswords(ASSET));

    expect(real.check('passw0rd12345')).toEqual({ ok: true });
    expect(real.check('1234567890')).toEqual({ ok: false, issues: ['common'] });
    expect(real.check('qwertyuiop')).toEqual({ ok: false, issues: ['common'] });
  });
});

describe('the validator with the optional breached-password check', () => {
  const local = createPasswordPolicy(parseCommonPasswords('password123'));

  it('is the local policy alone when no breach check is configured', async () => {
    const validator = createPasswordValidator(local);

    expect(await validator.validate('correct horse battery staple')).toEqual({ ok: true });
    expect(await validator.validate('PASSWORD123')).toEqual({ ok: false, issues: ['common'] });
  });

  it('asks the breach check only about passwords the local policy accepted', async () => {
    const asked: string[] = [];
    const validator = createPasswordValidator(local, {
      isBreached: (password) => {
        asked.push(password);
        return Promise.resolve(password === 'leaked-passphrase-2020');
      },
    });

    expect(await validator.validate('leaked-passphrase-2020')).toEqual({
      ok: false,
      issues: ['breached'],
    });
    expect(await validator.validate('a-fresh-unleaked-phrase')).toEqual({ ok: true });
    expect(await validator.validate('password123')).toEqual({ ok: false, issues: ['common'] });
    expect(await validator.validate('short')).toEqual({ ok: false, issues: ['too_short'] });
    expect(asked).toEqual(['leaked-passphrase-2020', 'a-fresh-unleaked-phrase']);
  });

  it('describes a breached password in es-AR', () => {
    expect(describePasswordIssues(['breached'])).toEqual([
      {
        code: 'breached',
        i18nKey: 'auth.password.breached',
        message: expect.stringContaining('filtraciones') as string,
      },
    ]);
  });
});
