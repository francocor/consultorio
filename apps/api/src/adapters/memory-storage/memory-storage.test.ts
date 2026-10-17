import { describe, expect, it } from 'vitest';

import { describeObjectStorage } from '../../../test/support/storage-contract.js';

import { createMemoryObjectStorage } from './index.js';

describeObjectStorage('in-memory fake', () => {
  const storage = createMemoryObjectStorage();
  return Promise.resolve({
    storage,
    upload: (post, body, contentType) =>
      Promise.resolve(storage.acceptUpload(post, body, contentType)),
    close: () => Promise.resolve(),
  });
});

describe('the fake', () => {
  it('lists the keys it holds, sorted', async () => {
    const storage = createMemoryObjectStorage();
    const tenant = '0190a000-0000-7000-8000-0000000000a1';
    await storage.put(tenant, `t/${tenant}/b`, {
      body: Buffer.from('1'),
      contentType: 'text/plain',
    });
    await storage.put(tenant, `t/${tenant}/a`, {
      body: Buffer.from('1'),
      contentType: 'text/plain',
    });

    expect(storage.keys()).toEqual([`t/${tenant}/a`, `t/${tenant}/b`]);
  });

  it('refuses an upload after the link expired', async () => {
    let now = new Date('2026-10-16T10:00:00Z');
    const storage = createMemoryObjectStorage({ clock: () => now });
    const tenant = '0190a000-0000-7000-8000-0000000000a1';
    const post = await storage.presignedPost(tenant, `t/${tenant}/docs/a`, {
      contentType: 'image/png',
      maxBytes: 100,
      expiresInSeconds: 60,
    });

    now = new Date('2026-10-16T10:01:01Z');

    expect(storage.acceptUpload(post, Buffer.alloc(1), 'image/png')).toBe(403);
  });
});
