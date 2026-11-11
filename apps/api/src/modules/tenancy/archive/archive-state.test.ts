import { describe, expect, it } from 'vitest';

import { isUnderErased } from './archive-state.js';

describe('the folders a legal erasure removed (JD-S6 R2)', () => {
  it('match by folder: a prefix without its slash never takes a neighbour with it', () => {
    const archive = { erasedPrefixes: ['tenants/t1/clinical-1', 'tenants/t1/admin/'] };

    expect(isUnderErased(archive, 'tenants/t1/clinical-1/000001.enc')).toBe(true);
    expect(isUnderErased(archive, 'tenants/t1/clinical-10/000001.enc')).toBe(false);
    expect(isUnderErased(archive, 'tenants/t1/admin/000001.enc')).toBe(true);
    expect(isUnderErased(archive, 'tenants/t1/administrative/000001.enc')).toBe(false);
    // An object erased on its own is the prefix.
    expect(
      isUnderErased({ erasedPrefixes: ['tenants/t1/a/000001.enc'] }, 'tenants/t1/a/000001.enc'),
    ).toBe(true);
  });
});
