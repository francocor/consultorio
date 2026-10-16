import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { findAsset } from './assets.js';

function scratch() {
  return mkdtempSync(join(tmpdir(), 'assets-'));
}

describe('finding a data asset', () => {
  it('finds it under assets/ of the first candidate root that has it', () => {
    const near = scratch();
    const far = scratch();
    mkdirSync(join(far, 'assets'));
    writeFileSync(join(far, 'assets', 'list.txt'), 'x');

    expect(findAsset('list.txt', [near, far])).toBe(join(far, 'assets', 'list.txt'));
  });

  it('prefers the earlier root when several have it', () => {
    const first = scratch();
    const second = scratch();
    for (const root of [first, second]) {
      mkdirSync(join(root, 'assets'));
      writeFileSync(join(root, 'assets', 'list.txt'), 'x');
    }

    expect(findAsset('list.txt', [first, second])).toBe(join(first, 'assets', 'list.txt'));
  });

  it('fails with a message that names the asset and where it looked, not a bare ENOENT', () => {
    const root = scratch();

    expect(() => findAsset('missing.txt', [root])).toThrow(/missing\.txt/);
    expect(() => findAsset('missing.txt', [root])).toThrow(/assets/);
  });

  it('finds the bundled common-password list from the real locations', () => {
    expect(findAsset('common-passwords-100k.txt')).toMatch(/common-passwords-100k\.txt$/);
  });
});
