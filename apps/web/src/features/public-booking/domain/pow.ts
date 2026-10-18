/**
 * The proof of work the public forms ask for (`adapters/bot-challenge-local` on the API). The server
 * issues a signed puzzle; the browser searches a number whose hash, with the puzzle id, starts with
 * enough zero bits, and sends it back with the signature. About 65 thousand hashes on average at the
 * production difficulty, a fraction of a second on a phone.
 *
 * `crypto.subtle.digest` is asynchronous and would make every try wait for a promise, which is far
 * too slow for tens of thousands of tries, so the hash is a small synchronous SHA-256 below. It runs
 * in a Web Worker (`pow.worker.ts`), so the page never freezes.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const words = new Uint32Array(64);

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** Runs the compression function over one 64-byte block of `block` starting at `offset`. */
function compress(state: Uint32Array, block: Uint8Array, offset: number): void {
  for (let index = 0; index < 16; index += 1) {
    const at = offset + index * 4;
    words[index] =
      ((block[at] ?? 0) << 24) |
      ((block[at + 1] ?? 0) << 16) |
      ((block[at + 2] ?? 0) << 8) |
      (block[at + 3] ?? 0);
  }
  for (let index = 16; index < 64; index += 1) {
    const w15 = words[index - 15] ?? 0;
    const w2 = words[index - 2] ?? 0;
    const s0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3);
    const s1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10);
    words[index] = ((words[index - 16] ?? 0) + s0 + (words[index - 7] ?? 0) + s1) | 0;
  }
  let a = state[0] ?? 0;
  let b = state[1] ?? 0;
  let c = state[2] ?? 0;
  let d = state[3] ?? 0;
  let e = state[4] ?? 0;
  let f = state[5] ?? 0;
  let g = state[6] ?? 0;
  let h = state[7] ?? 0;
  for (let index = 0; index < 64; index += 1) {
    const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
    const choose = (e & f) ^ (~e & g);
    const temp1 = (h + sum1 + choose + (K[index] ?? 0) + (words[index] ?? 0)) | 0;
    const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
    const majority = (a & b) ^ (a & c) ^ (b & c);
    const temp2 = (sum0 + majority) | 0;
    h = g;
    g = f;
    f = e;
    e = (d + temp1) | 0;
    d = c;
    c = b;
    b = a;
    a = (temp1 + temp2) | 0;
  }
  state[0] = ((state[0] ?? 0) + a) | 0;
  state[1] = ((state[1] ?? 0) + b) | 0;
  state[2] = ((state[2] ?? 0) + c) | 0;
  state[3] = ((state[3] ?? 0) + d) | 0;
  state[4] = ((state[4] ?? 0) + e) | 0;
  state[5] = ((state[5] ?? 0) + f) | 0;
  state[6] = ((state[6] ?? 0) + g) | 0;
  state[7] = ((state[7] ?? 0) + h) | 0;
}

/** SHA-256 of a byte string. */
export function sha256(message: Uint8Array): Uint8Array {
  const state = Uint32Array.from(INITIAL);
  const length = message.length;
  // The message, a 1 bit, zeros, and the length in bits as 64 bits: a multiple of 64 bytes.
  const padded = new Uint8Array(Math.ceil((length + 9) / 64) * 64);
  padded.set(message);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((length * 8) / 0x100000000));
  view.setUint32(padded.length - 4, (length * 8) >>> 0);
  for (let offset = 0; offset < padded.length; offset += 64) compress(state, padded, offset);
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let index = 0; index < 8; index += 1) outView.setUint32(index * 4, state[index] ?? 0);
  return out;
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

export interface Puzzle {
  id: string;
  difficulty: number;
  expiresAt: number;
  signature: string;
}

/** More than this would take a phone minutes: the server never asks for it, so it is refused. */
const MAX_DIFFICULTY = 26;

/**
 * Reads the challenge the API sent. `null` means there is nothing to solve (the fake challenge of a
 * demo organization); a kind the page does not know is an error, never silently skipped.
 */
export function parsePuzzle(challenge: {
  kind: string;
  payload: Readonly<Record<string, unknown>>;
}): Puzzle | null {
  if (challenge.kind === 'fake') return null;
  if (challenge.kind !== 'pow') throw new Error(`Unknown bot challenge: ${challenge.kind}`);
  const { id, difficulty, expiresAt, signature } = challenge.payload;
  if (
    typeof id !== 'string' ||
    typeof difficulty !== 'number' ||
    !Number.isInteger(difficulty) ||
    difficulty < 0 ||
    difficulty > MAX_DIFFICULTY ||
    typeof expiresAt !== 'number' ||
    typeof signature !== 'string'
  ) {
    throw new Error('The bot challenge is not a proof-of-work puzzle');
  }
  return { id, difficulty, expiresAt, signature };
}

const encoder = new TextEncoder();

/** Searches the nonce and returns the proof the API reads: `id.difficulty.expiresAt.signature.nonce`. */
export function solvePuzzle(puzzle: Puzzle): string {
  for (let nonce = 0; ; nonce += 1) {
    const digest = sha256(encoder.encode(`${puzzle.id}.${String(nonce)}`));
    if (leadingZeroBits(digest) >= puzzle.difficulty) {
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
