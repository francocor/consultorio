import { isIP } from 'node:net';

/**
 * Which hops of `X-Forwarded-For` the server believes.
 * - `false`: none. The client address is the socket's.
 * - a number N: N proxies sit in front of the app, so the client address is the Nth entry from the
 *   right (the one our own proxy appended). Anything a client prepends to the header is ignored.
 * - a list: proxy addresses or ranges; the client address is the first entry from the right that
 *   is not one of them.
 *
 * `true` ("trust every hop") does not exist: it takes the LEFTmost entry, which the client writes.
 */
export type TrustProxySetting = false | number | readonly string[];

const MAX_HOPS = 10;
const KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);

function isProxyAddress(entry: string): boolean {
  if (KEYWORDS.has(entry)) return true;
  const [address, prefix, ...extra] = entry.split('/');
  const version = isIP(address ?? '');
  if (version === 0 || extra.length > 0) return false;
  if (prefix === undefined) return true;
  const limit = version === 4 ? 32 : 128;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= limit;
}

/** Parses `TRUST_PROXY`. Returns a message when the value is not valid. */
export function parseTrustProxy(
  raw: string,
): { ok: true; value: TrustProxySetting } | { ok: false; message: string } {
  const text = raw.trim();
  if (text === 'false' || text === '0') return { ok: true, value: false };
  if (text === 'true') {
    return {
      ok: false,
      message:
        'true would trust every hop and let a client choose its own address; use the number of proxies in front of the app (1) or a list of proxy addresses',
    };
  }
  if (/^\d+$/.test(text)) {
    const hops = Number(text);
    return hops <= MAX_HOPS
      ? { ok: true, value: hops }
      : { ok: false, message: `the number of proxies must be between 1 and ${String(MAX_HOPS)}` };
  }
  const entries = text.split(',').map((entry) => entry.trim());
  if (entries.every(isProxyAddress)) return { ok: true, value: entries };
  return {
    ok: false,
    message:
      'must be false, the number of proxies in front of the app, or a list of proxy addresses',
  };
}

/**
 * The shape Fastify takes. Fastify refuses a bare hop count (it fails closed, because a count
 * cannot check the immediate peer), so a count becomes a function that believes the first N hops
 * from the socket. The contract is then the usual one: the app is reachable only through its
 * proxy(ies), which append the address they received the request from.
 */
export function fastifyTrustProxy(
  setting: TrustProxySetting,
): false | string[] | ((address: string, hop: number) => boolean) {
  if (setting === false) return false;
  if (typeof setting === 'number') return (_address, hop) => hop < setting;
  return [...setting];
}
