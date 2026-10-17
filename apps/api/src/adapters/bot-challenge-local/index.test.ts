import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createFakeBotChallenge } from '../bot-challenge-fake/index.js';

import { runBotChallengeContract } from './bot-challenge.contract.js';

import {
  createLocalBotChallenge,
  leadingZeroBits,
  LOCAL_CHALLENGE_LIFETIME_MS,
  solveProofOfWork,
} from './index.js';

function local(options: { difficulty?: number } = {}) {
  let now = 1_700_000_000_000;
  const challenge = createLocalBotChallenge({
    secret: randomBytes(32),
    difficulty: options.difficulty ?? 8,
    now: () => now,
  });
  return {
    challenge,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

runBotChallengeContract('fake', {
  create: () => ({ challenge: createFakeBotChallenge() }),
  strict: false,
});

runBotChallengeContract('local proof of work', {
  create: () => local(),
  solve: (token) => Promise.resolve(solveProofOfWork(token)),
  strict: true,
  lifetimeMs: LOCAL_CHALLENGE_LIFETIME_MS,
});

describe('leadingZeroBits', () => {
  it.each([
    [Buffer.from([0x80]), 0],
    [Buffer.from([0x40]), 1],
    [Buffer.from([0x01]), 7],
    [Buffer.from([0x00, 0x80]), 8],
    [Buffer.from([0x00, 0x00, 0x0f]), 20],
    [Buffer.from([0x00, 0x00]), 16],
  ])('counts the zero bits at the start of %j', (bytes, expected) => {
    expect(leadingZeroBits(bytes)).toBe(expected);
  });
});

describe('local proof of work', () => {
  it('asks for the configured difficulty and signs it', async () => {
    const { challenge } = local({ difficulty: 10 });

    const token = await challenge.issue();

    expect(token.kind).toBe('pow');
    expect(token.payload).toMatchObject({
      algorithm: 'sha256-leading-zero-bits',
      difficulty: 10,
    });
    expect(typeof token.payload['id']).toBe('string');
    expect(typeof token.payload['signature']).toBe('string');
  });

  it('refuses a solution whose hash does not reach the difficulty', async () => {
    const { challenge } = local({ difficulty: 12 });
    const token = await challenge.issue();
    const proof = solveProofOfWork(token);
    // A nonce that was not searched for: almost surely fails 12 zero bits.
    const parts = proof.split('.');
    parts[parts.length - 1] = 'not-a-solution';

    expect(await challenge.verify(parts.join('.'), '203.0.113.7')).toBe(false);
  });

  it('refuses a puzzle whose difficulty was lowered by the client', async () => {
    const { challenge } = local({ difficulty: 14 });
    const token = await challenge.issue();
    const proof = solveProofOfWork({
      ...token,
      payload: { ...token.payload, difficulty: 1 },
    });

    expect(await challenge.verify(proof, '203.0.113.7')).toBe(false);
  });

  it('stops answering an address that keeps sending wrong proofs', async () => {
    const { challenge } = local();
    const ip = '198.51.100.20';
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await challenge.verify('wrong', ip);
    }
    const proof = solveProofOfWork(await challenge.issue());

    expect(await challenge.verify(proof, ip)).toBe(false);
    // Another address is not affected.
    expect(await challenge.verify(solveProofOfWork(await challenge.issue()), '198.51.100.21')).toBe(
      true,
    );
  });

  it('forgets used challenges once they could no longer be replayed', async () => {
    const { challenge, advance } = local();
    for (let index = 0; index < 5; index += 1) {
      await challenge.verify(solveProofOfWork(await challenge.issue()), '203.0.113.7');
    }
    advance(LOCAL_CHALLENGE_LIFETIME_MS * 3);

    expect(challenge.usedCount()).toBe(0);
  });
});
