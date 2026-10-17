import { describe, expect, it } from 'vitest';

import { createFakeBotChallenge } from './index.js';

describe('fake bot challenge', () => {
  it('issues a challenge that needs no solver', async () => {
    const challenge = createFakeBotChallenge();

    expect(await challenge.issue('203.0.113.7')).toEqual({ kind: 'fake', payload: {} });
  });

  it('always passes, whatever the proof and the address', async () => {
    const challenge = createFakeBotChallenge();

    expect(await challenge.verify('anything', '203.0.113.7')).toBe(true);
    expect(await challenge.verify('', '2001:db8::1')).toBe(true);
  });
});
