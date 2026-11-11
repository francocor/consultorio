import { randomBytes, timingSafeEqual } from 'node:crypto';

interface Entry {
  token: string;
  expiresAt: number | null;
}

/**
 * One-time-per-window tokens for the pages of the shell. A page address carries `?t=<token>`; the page
 * sends the token back with every action. Another program on the PC can open `localhost:<port>` but does
 * not know the token, which only exists in the address of the window the shell opened. There is one
 * token per purpose: asking for a new one replaces the old one.
 */
export class TokenVault {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A fresh token for `purpose`. `ttlMs` of `null` means it is good until revoked. */
  issue(purpose: string, ttlMs: number | null = null): string {
    const token = randomBytes(24).toString('base64url');
    this.entries.set(purpose, { token, expiresAt: ttlMs === null ? null : this.now() + ttlMs });
    return token;
  }

  verify(purpose: string, candidate: string | null | undefined): boolean {
    const entry = this.entries.get(purpose);
    if (!entry || typeof candidate !== 'string') return false;
    if (entry.expiresAt !== null && this.now() > entry.expiresAt) {
      this.entries.delete(purpose);
      return false;
    }
    const expected = Buffer.from(entry.token);
    const given = Buffer.from(candidate);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  revoke(purpose: string): void {
    this.entries.delete(purpose);
  }
}
