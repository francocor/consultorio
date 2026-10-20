import { describe, expect, it } from 'vitest';

import {
  LINKS_PER_CLIENT,
  SIGNUPS_OVERALL,
  SIGNUPS_PER_CLIENT,
  SIGNUP_EMAILS_PER_ADDRESS,
  addressCounter,
  clientCounter,
} from './limits.js';

describe('the counters of the public form', () => {
  it('counts an address by a hash of it, the same for any case or spacing, and never holds the address', () => {
    expect(addressCounter(' Ana@Example.test ')).toBe(addressCounter('ana@example.test'));
    expect(addressCounter('ana@example.test')).not.toBe(addressCounter('ana2@example.test'));
    expect(addressCounter('ana@example.test')).not.toContain('ana');
    expect(addressCounter('ana@example.test')).toMatch(/^signup\|address\|[0-9a-f]{32}$/);
  });

  it('counts the clients of one IPv6 /64 as one, and a client with no known address as one more', () => {
    expect(clientCounter('2001:db8:1:2::1')).toBe(clientCounter('2001:db8:1:2:ffff::9'));
    expect(clientCounter('2001:db8:1:3::1')).not.toBe(clientCounter('2001:db8:1:2::1'));
    expect(clientCounter('::ffff:203.0.113.7')).toBe(clientCounter('203.0.113.7'));
    expect(clientCounter(null)).toBe(clientCounter(null));
  });

  it('counts the requests for a new link apart from the signups of the same client', () => {
    expect(clientCounter('203.0.113.7', 'link')).not.toBe(clientCounter('203.0.113.7'));
    expect(clientCounter('2001:db8:1:2::1', 'link')).toBe(
      clientCounter('2001:db8:1:2:ffff::9', 'link'),
    );
    expect(LINKS_PER_CLIENT.max).toBeGreaterThan(SIGNUPS_PER_CLIENT.max);
  });

  it('lets a person create a handful of organizations an hour, three emails go to one address, and bounds the whole platform', () => {
    expect(SIGNUPS_PER_CLIENT).toEqual({ max: 5, windowMs: 3_600_000 });
    expect(SIGNUP_EMAILS_PER_ADDRESS).toEqual({ max: 3, windowMs: 3_600_000 });
    expect(SIGNUPS_OVERALL.max).toBeGreaterThan(SIGNUPS_PER_CLIENT.max);
  });
});
