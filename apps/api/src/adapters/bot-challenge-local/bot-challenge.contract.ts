import { describe, expect, it } from 'vitest';

import type {
  BotChallenge,
  BotChallengeToken,
} from '../../platform/bot-challenge/bot-challenge.js';

/**
 * The contract every bot challenge adapter must satisfy: the fake, the local proof of work and,
 * later, Cloudflare Turnstile. The shared part holds for all of them; the strict part holds for
 * every adapter that really challenges (the fake passes everything by design).
 */
export interface BotChallengeContractCase {
  /** A fresh adapter. */
  create(): { challenge: BotChallenge; advance?: (ms: number) => void };
  /** Solves what `issue()` returned the way the browser would. Absent for the fake. */
  solve?: (token: BotChallengeToken) => Promise<string>;
  /** True when a wrong, expired or replayed proof must be refused. */
  strict: boolean;
  /** How long a challenge lives, when the adapter can move its clock. */
  lifetimeMs?: number;
}

const IP = '203.0.113.7';

export function runBotChallengeContract(name: string, subject: BotChallengeContractCase): void {
  describe(`bot challenge contract: ${name}`, () => {
    it('issues a challenge made of a kind and a payload that survive JSON', async () => {
      const { challenge } = subject.create();

      const token = await challenge.issue(IP);

      expect(typeof token.kind).toBe('string');
      expect(token.kind.length).toBeGreaterThan(0);
      expect(JSON.parse(JSON.stringify(token))).toEqual(token);
    });

    it('answers a garbage proof with a boolean and never throws', async () => {
      const { challenge } = subject.create();

      for (const proof of ['', 'nope', '1.2.3', 'x'.repeat(10_000), '\u0000\u0001']) {
        await expect(challenge.verify(proof, IP)).resolves.toEqual(expect.any(Boolean));
      }
    });

    if (!subject.strict || !subject.solve) return;
    const solve = subject.solve;

    describe('strict adapters', () => {
      it('accepts the solution of a challenge it issued', async () => {
        const { challenge } = subject.create();

        const proof = await solve(await challenge.issue(IP));

        expect(await challenge.verify(proof, IP)).toBe(true);
      });

      it('refuses garbage and a proof of nothing', async () => {
        const { challenge } = subject.create();

        expect(await challenge.verify('', IP)).toBe(false);
        expect(await challenge.verify('nope', IP)).toBe(false);
      });

      it('refuses a solution that was already used (replay)', async () => {
        const { challenge } = subject.create();
        const proof = await solve(await challenge.issue(IP));

        expect(await challenge.verify(proof, IP)).toBe(true);
        expect(await challenge.verify(proof, IP)).toBe(false);
        expect(await challenge.verify(proof, '198.51.100.9')).toBe(false);
      });

      it('refuses a solution presented from another address than the one it was issued to', async () => {
        const { challenge } = subject.create();
        const proof = await solve(await challenge.issue(IP));

        expect(await challenge.verify(proof, '198.51.100.9')).toBe(false);
        // The refusal did not spend it: the address it was issued to can still use it.
        expect(await challenge.verify(proof, IP)).toBe(true);
      });

      it('refuses a solution that was altered', async () => {
        const { challenge } = subject.create();
        const proof = await solve(await challenge.issue(IP));
        const altered = `${proof.slice(0, -1)}${proof.endsWith('a') ? 'b' : 'a'}`;

        expect(await challenge.verify(altered, IP)).toBe(false);
      });

      it('refuses a solution of a challenge another instance issued', async () => {
        const first = subject.create().challenge;
        const second = subject.create().challenge;
        const proof = await solve(await first.issue(IP));

        expect(await second.verify(proof, IP)).toBe(false);
      });

      it('refuses a solution that arrives after the challenge expired', async () => {
        const { challenge, advance } = subject.create();
        if (!advance || subject.lifetimeMs === undefined) return;
        const proof = await solve(await challenge.issue(IP));

        advance(subject.lifetimeMs + 1);

        expect(await challenge.verify(proof, IP)).toBe(false);
      });
    });
  });
}
