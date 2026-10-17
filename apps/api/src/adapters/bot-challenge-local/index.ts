import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type {
  BotChallenge,
  BotChallengeToken,
} from '../../platform/bot-challenge/bot-challenge.js';

/** How long a puzzle can be solved after it was issued. */
export const LOCAL_CHALLENGE_LIFETIME_MS = 5 * 60_000;

/** Leading zero bits the hash of a solution needs. About 65 thousand hashes on average: under a second. */
export const DEFAULT_DIFFICULTY = 16;

/** Wrong proofs one address may send in a window before the adapter stops answering it. */
const MAX_FAILURES = 30;
const FAILURE_WINDOW_MS = 60_000;
const MAX_TRACKED = 20_000;

const ALGORITHM = 'sha256-leading-zero-bits';

export interface LocalBotChallengeOptions {
  /**
   * Signs the puzzles. A fresh random key per process is fine for one API instance (a restart
   * invalidates the puzzles in flight, which live minutes); several instances need a shared one.
   */
  secret?: Buffer;
  difficulty?: number;
  now?: () => number;
}

export interface LocalBotChallenge extends BotChallenge {
  /** How many solved puzzles are remembered to refuse a replay (tests). */
  usedCount(): number;
}

/** Number of zero bits a byte string starts with. */
export function leadingZeroBits(bytes: Uint8Array): number {
  let bits = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

function sign(secret: Buffer, id: string, difficulty: number, expiresAt: number): string {
  return createHmac('sha256', secret)
    .update(`${id}.${String(difficulty)}.${String(expiresAt)}`)
    .digest('base64url');
}

function hashOf(id: string, nonce: string): Buffer {
  return createHash('sha256').update(`${id}.${nonce}`).digest();
}

/** Compares two strings in constant time, whatever their lengths. */
function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface PuzzlePayload {
  id: string;
  difficulty: number;
  expiresAt: number;
  signature: string;
}

function puzzleOf(token: BotChallengeToken): PuzzlePayload {
  const { id, difficulty, expiresAt, signature } = token.payload;
  if (
    typeof id !== 'string' ||
    typeof difficulty !== 'number' ||
    typeof expiresAt !== 'number' ||
    typeof signature !== 'string'
  ) {
    throw new Error('Not a proof-of-work puzzle');
  }
  return { id, difficulty, expiresAt, signature };
}

/**
 * Finds the nonce for a puzzle and returns the proof the browser would post. The web app runs the
 * same search in a Web Worker; this is the reference for tests and for the contract suite.
 */
export function solveProofOfWork(token: BotChallengeToken): string {
  const puzzle = puzzleOf(token);
  for (let nonce = 0; ; nonce += 1) {
    if (leadingZeroBits(hashOf(puzzle.id, String(nonce))) >= puzzle.difficulty) {
      return [
        puzzle.id,
        String(puzzle.difficulty),
        String(puzzle.expiresAt),
        puzzle.signature,
        String(nonce),
      ].join('.');
    }
  }
}

/**
 * Bot challenge for customer organizations when no external service is configured (design 4.5,
 * "Turnstile on hold and submission"): a signed proof-of-work puzzle. The server signs
 * `(id, difficulty, expiry)`, the browser searches a nonce whose hash starts with enough zero bits,
 * and the server checks the signature, the time, the hash and that the puzzle was never used
 * before. It makes a script pay for every form it submits; it does not tell people from patient
 * machines, which is what Cloudflare Turnstile will add behind the same port.
 *
 * Used puzzles live in memory until they would have expired anyway, so a replay is refused for as
 * long as it could have been valid. State is per process (see `secret`).
 */
export function createLocalBotChallenge(options: LocalBotChallengeOptions = {}): LocalBotChallenge {
  const secret = options.secret ?? randomBytes(32);
  const difficulty = options.difficulty ?? DEFAULT_DIFFICULTY;
  const now = options.now ?? Date.now;
  const used = new Map<string, number>();
  const failures = new Map<string, { count: number; since: number }>();

  function prune(at: number): void {
    for (const [id, expiresAt] of used) {
      if (expiresAt > at) break;
      used.delete(id);
    }
    while (used.size > MAX_TRACKED) {
      const oldest = used.keys().next().value;
      if (oldest === undefined) break;
      used.delete(oldest);
    }
    for (const [ip, state] of failures) {
      if (state.since + FAILURE_WINDOW_MS <= at) failures.delete(ip);
    }
    while (failures.size > MAX_TRACKED) {
      const oldest = failures.keys().next().value;
      if (oldest === undefined) break;
      failures.delete(oldest);
    }
  }

  function blocked(ip: string, at: number): boolean {
    const state = failures.get(ip);
    return (
      state !== undefined && state.since + FAILURE_WINDOW_MS > at && state.count >= MAX_FAILURES
    );
  }

  function fail(ip: string, at: number): false {
    const state = failures.get(ip);
    if (state && state.since + FAILURE_WINDOW_MS > at) state.count += 1;
    else failures.set(ip, { count: 1, since: at });
    return false;
  }

  function check(proof: string, at: number): boolean {
    const parts = proof.split('.');
    if (parts.length !== 5 || proof.length > 512) return false;
    const [id = '', rawDifficulty = '', rawExpiry = '', signature = '', nonce = ''] = parts;
    const claimed = Number(rawDifficulty);
    const expiresAt = Number(rawExpiry);
    if (!Number.isInteger(claimed) || !Number.isInteger(expiresAt) || id === '' || nonce === '') {
      return false;
    }
    // The signature covers the difficulty: a client cannot ask for an easier puzzle.
    if (!sameText(signature, sign(secret, id, claimed, expiresAt))) return false;
    if (claimed < difficulty || expiresAt <= at || used.has(id)) return false;
    return leadingZeroBits(hashOf(id, nonce)) >= claimed;
  }

  return {
    issue() {
      const at = now();
      const id = randomBytes(16).toString('base64url');
      const expiresAt = at + LOCAL_CHALLENGE_LIFETIME_MS;
      const token: BotChallengeToken = {
        kind: 'pow',
        payload: {
          algorithm: ALGORITHM,
          id,
          difficulty,
          expiresAt,
          signature: sign(secret, id, difficulty, expiresAt),
        },
      };
      return Promise.resolve(token);
    },

    verify(proof, ip) {
      const at = now();
      prune(at);
      if (blocked(ip, at)) return Promise.resolve(false);
      if (!check(proof, at)) return Promise.resolve(fail(ip, at));
      // Spent from here on, whatever happens to the form that carried it.
      const id = proof.split('.')[0] ?? '';
      used.set(id, Number(proof.split('.')[2]));
      return Promise.resolve(true);
    },

    usedCount: () => {
      prune(now());
      return used.size;
    },
  };
}
