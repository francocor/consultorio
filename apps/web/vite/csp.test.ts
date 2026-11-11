import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { connectOriginsFrom, contentSecurityPolicy, scriptHash } from './csp.js';
import { buildThemeBootScript } from './theme-boot-plugin.js';

const SOURCE = resolve(import.meta.dirname, '../src/shared/lib/theme-boot.ts');

function directive(policy: string, name: string): string[] {
  const found = policy
    .split(';')
    .map((part) => part.trim().split(/\s+/))
    .find((parts) => parts[0] === name);
  return found ? found.slice(1) : [];
}

describe('script hash', () => {
  it('is the base64 SHA-256 of the script text, in the form a CSP expects', () => {
    const expected = createHash('sha256').update('alert(1)').digest('base64');

    expect(scriptHash('alert(1)')).toBe(`'sha256-${expected}'`);
  });

  it('changes when a single character of the script changes', () => {
    expect(scriptHash('a')).not.toBe(scriptHash('b'));
  });
});

describe('Content Security Policy of the web bundle (ASVS 14.4.7)', () => {
  const hash = scriptHash('boot()');
  const production = contentSecurityPolicy({ scriptHashes: [hash], mode: 'production' });

  it('allows scripts only from the same origin plus the hash of the one inline theme script', () => {
    expect(directive(production, 'script-src')).toEqual(["'self'", hash]);
    expect(production).not.toContain("'unsafe-eval'");
    expect(directive(production, 'script-src')).not.toContain("'unsafe-inline'");
  });

  it('keeps everything else on the same origin: the API, fonts, the logo and the manifest', () => {
    expect(directive(production, 'default-src')).toEqual(["'self'"]);
    expect(directive(production, 'connect-src')).toEqual(["'self'"]);
    expect(directive(production, 'font-src')).toEqual(["'self'"]);
    expect(directive(production, 'manifest-src')).toEqual(["'self'"]);
    expect(directive(production, 'worker-src')).toEqual(["'self'"]);
  });

  it('lets images be inline or local only (the two-factor QR code and the logo preview)', () => {
    expect(directive(production, 'img-src')).toEqual(["'self'", 'data:', 'blob:']);
  });

  it('forbids plugins, base tag tricks, foreign form targets and being framed', () => {
    expect(directive(production, 'object-src')).toEqual(["'none'"]);
    expect(directive(production, 'base-uri')).toEqual(["'self'"]);
    expect(directive(production, 'form-action')).toEqual(["'self'"]);
    expect(directive(production, 'frame-ancestors')).toEqual(["'none'"]);
  });

  it('upgrades insecure requests in production only', () => {
    const development = contentSecurityPolicy({ scriptHashes: [hash], mode: 'development' });

    expect(production).toContain('upgrade-insecure-requests');
    expect(development).not.toContain('upgrade-insecure-requests');
  });

  it('allows the dev server what it needs and nothing about the real policy changes', () => {
    const development = contentSecurityPolicy({ scriptHashes: [hash], mode: 'development' });

    // The React refresh preamble is an inline module script and hot reload uses a websocket. A hash
    // in the list makes the browser ignore 'unsafe-inline', which blocked the preamble and left the
    // page blank, so the development policy carries no hash.
    expect(directive(development, 'script-src')).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directive(development, 'connect-src')).toEqual(["'self'", 'ws:', 'wss:']);
    // When the dev server restarts, its client waits for it from a shared worker built from a blob.
    expect(directive(development, 'worker-src')).toEqual(["'self'", 'blob:']);
    expect(directive(production, 'worker-src')).toEqual(["'self'"]);
    expect(directive(development, 'object-src')).toEqual(["'none'"]);
    expect(directive(development, 'frame-ancestors')).toEqual(["'none'"]);
  });

  it('carries the hash of the real theme boot script, so the first paint is not blocked', async () => {
    const script = await buildThemeBootScript(SOURCE);
    const policy = contentSecurityPolicy({
      scriptHashes: [scriptHash(script)],
      mode: 'production',
    });

    expect(directive(policy, 'script-src')).toContain(scriptHash(script));
  });
});

describe('the storage origin of document uploads', () => {
  it('is added to connect-src when the deployment names it, and only then', () => {
    const hash = scriptHash('boot()');

    const withStorage = contentSecurityPolicy({
      scriptHashes: [hash],
      mode: 'production',
      connectSources: ['https://files.example.test'],
    });
    const without = contentSecurityPolicy({ scriptHashes: [hash], mode: 'production' });

    expect(directive(withStorage, 'connect-src')).toEqual(["'self'", 'https://files.example.test']);
    expect(directive(without, 'connect-src')).toEqual(["'self'"]);
    // Nothing else opens up with it.
    expect(directive(withStorage, 'script-src')).toEqual(directive(without, 'script-src'));
    expect(directive(withStorage, 'default-src')).toEqual(["'self'"]);
  });

  it('reads the origins from a comma or space separated list and keeps only http(s) origins', () => {
    expect(
      connectOriginsFrom(
        'https://files.example.test, http://localhost:9000  https://s3.sa-east-1.amazonaws.com/bucket',
      ),
    ).toEqual([
      'https://files.example.test',
      'http://localhost:9000',
      'https://s3.sa-east-1.amazonaws.com',
    ]);
  });

  it('drops anything that could widen the policy: wildcards, other schemes, keywords, garbage', () => {
    expect(
      connectOriginsFrom(
        "* 'unsafe-inline' data: javascript:alert(1) ftp://x.test not-a-url https://ok.example.test",
      ),
    ).toEqual(['https://ok.example.test']);
    expect(connectOriginsFrom(undefined)).toEqual([]);
    expect(connectOriginsFrom('')).toEqual([]);
  });
});
