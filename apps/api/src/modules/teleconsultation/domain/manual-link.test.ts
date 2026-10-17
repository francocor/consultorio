import { describe, expect, it } from 'vitest';

import { validateManualLink } from './manual-link.js';

const ALLOWED = ['meet.google.com', 'zoom.us'];

describe('manual video link', () => {
  it('accepts an https address on an allowed host and returns it normalised', () => {
    expect(validateManualLink('https://meet.google.com/abc-defg-hij', ALLOWED)).toEqual({
      ok: true,
      url: 'https://meet.google.com/abc-defg-hij',
    });
    expect(
      validateManualLink('  HTTPS://Meet.Google.com/abc-defg-hij?authuser=1  ', ALLOWED),
    ).toEqual({ ok: true, url: 'https://meet.google.com/abc-defg-hij?authuser=1' });
  });

  it('accepts a subdomain of an allowed host, as Zoom uses for each account', () => {
    expect(validateManualLink('https://us02web.zoom.us/j/123456789', ALLOWED)).toEqual({
      ok: true,
      url: 'https://us02web.zoom.us/j/123456789',
    });
  });

  it.each([
    ['plain http', 'http://meet.google.com/abc', 'not_https'],
    ['a script address', 'javascript:alert(1)', 'not_https'],
    ['a data address', 'data:text/html,<p>x</p>', 'not_https'],
    ['a file address', 'file:///etc/passwd', 'not_https'],
    ['text that is not an address', 'meet.google.com/abc', 'not_a_link'],
    ['an empty text', '   ', 'not_a_link'],
    ['credentials in the address', 'https://user:pass@meet.google.com/abc', 'credentials'],
    ['a host that is not listed', 'https://evil.example/abc', 'host_not_allowed'],
    ['a host that only ends like an allowed one', 'https://evilzoom.us/j/1', 'host_not_allowed'],
    [
      'an allowed name used as a subdomain of another host',
      'https://zoom.us.evil.example/j/1',
      'host_not_allowed',
    ],
    ['an address with a port', 'https://zoom.us:8443/j/1', 'host_not_allowed'],
    ['an IP address', 'https://127.0.0.1/abc', 'host_not_allowed'],
  ])('rejects %s', (_label, input, reason) => {
    expect(validateManualLink(input, ALLOWED)).toEqual({ ok: false, reason });
  });

  it('rejects everything when the platform lists no host', () => {
    expect(validateManualLink('https://meet.google.com/abc', [])).toEqual({
      ok: false,
      reason: 'host_not_allowed',
    });
  });
});
