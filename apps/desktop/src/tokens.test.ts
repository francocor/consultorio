import { describe, expect, it } from 'vitest';

import { TokenVault } from './tokens.js';

describe('the tokens of the shell pages', () => {
  it('accept the token issued for a purpose and nothing else', () => {
    const vault = new TokenVault();
    const token = vault.issue('setup');

    expect(vault.verify('setup', token)).toBe(true);
    expect(vault.verify('reset', token)).toBe(false);
    expect(vault.verify('setup', `${token}x`)).toBe(false);
    expect(vault.verify('setup', token.slice(0, -1))).toBe(false);
    expect(vault.verify('setup', '')).toBe(false);
    expect(vault.verify('setup', null)).toBe(false);
    expect(vault.verify('setup', undefined)).toBe(false);
  });

  it('are long and different every time', () => {
    const vault = new TokenVault();
    const first = vault.issue('setup');
    const second = vault.issue('setup');

    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(first).not.toBe(second);
  });

  it('replace the old token of a purpose when a new one is issued', () => {
    const vault = new TokenVault();
    const first = vault.issue('reset');
    const second = vault.issue('reset');

    expect(vault.verify('reset', first)).toBe(false);
    expect(vault.verify('reset', second)).toBe(true);
  });

  it('expire when they have a lifetime', () => {
    let now = 1_000;
    const vault = new TokenVault(() => now);
    const token = vault.issue('reset', 60_000);

    now += 59_999;
    expect(vault.verify('reset', token)).toBe(true);
    now += 2;
    expect(vault.verify('reset', token)).toBe(false);
  });

  it('can be revoked', () => {
    const vault = new TokenVault();
    const token = vault.issue('setup');

    vault.revoke('setup');

    expect(vault.verify('setup', token)).toBe(false);
  });
});
