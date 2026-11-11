import { createHash } from 'node:crypto';

/** Optional second line of defence behind the bundled common-password list. */
export interface BreachedPasswordCheck {
  isBreached(password: string): Promise<boolean>;
}

type Fetch = (url: string) => Promise<Response>;

export interface RangeCheckOptions {
  fetch?: Fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = 'https://api.pwnedpasswords.com/range/';
const PREFIX_LENGTH = 5;

/**
 * Checks a password against a k-anonymity range API (Have I Been Pwned format). Only the first
 * five characters of the SHA-1 of the password leave the server, never the password and never
 * the full hash; the suffix is compared here. It is OFF unless the deployment turns it on, and it
 * never blocks a sign-up when the provider is unreachable (the bundled list is the guarantee).
 */
export function createRangeCheck(options: RangeCheckOptions = {}): BreachedPasswordCheck {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = options.timeoutMs ?? 2000;
  const doFetch: Fetch =
    options.fetch ??
    ((url) =>
      fetch(url, { headers: { 'Add-Padding': 'true' }, signal: AbortSignal.timeout(timeoutMs) }));

  return {
    async isBreached(password) {
      const hash = createHash('sha1').update(password).digest('hex').toUpperCase();
      const prefix = hash.slice(0, PREFIX_LENGTH);
      const suffix = hash.slice(PREFIX_LENGTH);
      try {
        const response = await doFetch(`${baseUrl}${prefix}`);
        if (!response.ok) return false;
        const body = await response.text();
        return body.split(/\r?\n/).some((line) => {
          const [candidate, count] = line.split(':');
          return candidate?.trim().toUpperCase() === suffix && Number(count) > 0;
        });
      } catch {
        return false;
      }
    },
  };
}
