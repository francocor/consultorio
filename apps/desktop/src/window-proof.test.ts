import { describe, expect, it } from 'vitest';

import {
  BROWSER_COOKIE,
  cookieValue,
  headersWithProof,
  isLocalServerUrl,
  presentsProof,
  secretsMatch,
  withoutBrowserCookie,
  WINDOW_HEADER,
} from './window-proof.js';

const CREDENTIALS = { window: 'window-proof-0123456789', browser: 'browser-proof-9876543210' };

describe('who presents the proof', () => {
  it('accepts the header of the window', () => {
    expect(presentsProof({ [WINDOW_HEADER]: CREDENTIALS.window }, CREDENTIALS)).toBe(true);
  });

  it('accepts the cookie of the browser that the owner opened through the shell', () => {
    const cookie = `sid=abc; ${BROWSER_COOKIE}=${CREDENTIALS.browser}`;
    expect(presentsProof({ cookie }, CREDENTIALS)).toBe(true);
  });

  it('refuses a request with nothing, with a wrong value, or with the value of the other credential', () => {
    expect(presentsProof({}, CREDENTIALS)).toBe(false);
    expect(presentsProof({ [WINDOW_HEADER]: 'nope' }, CREDENTIALS)).toBe(false);
    expect(presentsProof({ [WINDOW_HEADER]: '' }, CREDENTIALS)).toBe(false);
    // One credential is not the other: the cookie value does not pass as the header, nor the reverse.
    expect(presentsProof({ [WINDOW_HEADER]: CREDENTIALS.browser }, CREDENTIALS)).toBe(false);
    expect(presentsProof({ cookie: `${BROWSER_COOKIE}=${CREDENTIALS.window}` }, CREDENTIALS)).toBe(
      false,
    );
  });

  it('compares secrets of the same length without stopping at the first difference, and refuses empty ones', () => {
    expect(secretsMatch('abc', 'abc')).toBe(true);
    expect(secretsMatch('abd', 'abc')).toBe(false);
    expect(secretsMatch('ab', 'abc')).toBe(false);
    expect(secretsMatch('', '')).toBe(false);
    expect(secretsMatch(undefined, 'abc')).toBe(false);
  });
});

describe('cookies', () => {
  it('finds a cookie among others', () => {
    expect(cookieValue('a=1; consulvia_session=xyz; b=2', BROWSER_COOKIE)).toBe('xyz');
    expect(cookieValue('a=1', BROWSER_COOKIE)).toBeNull();
    expect(cookieValue(undefined, BROWSER_COOKIE)).toBeNull();
  });

  it('takes its own cookie out of what goes to the API and leaves the others', () => {
    expect(withoutBrowserCookie(`sid=abc; ${BROWSER_COOKIE}=xyz; theme=dark`)).toBe(
      'sid=abc; theme=dark',
    );
    expect(withoutBrowserCookie(`${BROWSER_COOKIE}=xyz`)).toBe('');
    expect(withoutBrowserCookie('sid=abc')).toBe('sid=abc');
  });
});

describe('the headers a window sends', () => {
  it('adds the proof to the local server by its numeric address, and only by that one', () => {
    for (const url of ['http://127.0.0.1:47800/api/x', 'http://127.0.0.1:47800/']) {
      const headers = headersWithProof({ Accept: '*/*' }, url, 47800, 'proof');
      expect(headers).toEqual({ Accept: '*/*', 'X-Consulvia-Window': 'proof' });
    }
  });

  it('never sends it to a name: localhost can lead to ::1, where any program may be listening on the same port', () => {
    for (const url of ['http://localhost:47800/api/x', 'http://[::1]:47800/api/x']) {
      expect(headersWithProof({ Accept: '*/*' }, url, 47800, 'proof'), url).toEqual({
        Accept: '*/*',
      });
      expect(isLocalServerUrl(url, 47800), url).toBe(false);
    }
  });

  it('replaces a header of that name that the page set, whatever its case', () => {
    const headers = headersWithProof(
      { 'x-CONSULVIA-window': 'forged' },
      'http://127.0.0.1:47800/api/x',
      47800,
      'proof',
    );
    expect(headers).toEqual({ 'X-Consulvia-Window': 'proof' });
  });

  it('never sends it anywhere else: another port, another host, another scheme', () => {
    for (const url of [
      'http://localhost:47801/',
      'http://example.com:47800/',
      'https://localhost:47800/',
      'http://localhost.evil.example:47800/',
      'not a url',
    ]) {
      expect(headersWithProof({ Accept: '*/*' }, url, 47800, 'proof'), url).toEqual({
        Accept: '*/*',
      });
      expect(isLocalServerUrl(url, 47800), url).toBe(false);
    }
  });
});
