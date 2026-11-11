import { describe, expect, it } from 'vitest';

import { pwaOptions, workboxConfig } from './pwa-config.js';

type UrlPattern = (context: { url: URL }) => boolean;

const patternOf = (index: number): UrlPattern => {
  const rule = workboxConfig.runtimeCaching?.[index];
  if (!rule || typeof rule.urlPattern !== 'function')
    throw new Error('expected a function pattern');
  return rule.urlPattern as unknown as UrlPattern;
};

const at = (path: string) => ({ url: new URL(path, 'https://norte.example.test') });

describe('PWA: what is precached (the app shell only)', () => {
  it('lists the shell: html, scripts, styles, icons and the default font, nothing from the API', () => {
    const globs = workboxConfig.globPatterns ?? [];

    expect(globs).toContain('index.html');
    expect(globs.some((glob) => glob.startsWith('assets/'))).toBe(true);
    expect(globs.some((glob) => glob.startsWith('icons/'))).toBe(true);
    for (const glob of globs) {
      expect(glob, glob).not.toMatch(/api|files|public|json|csv|pdf/);
    }
  });

  it('does not precache the manifest: it is per organization and comes from the API', () => {
    expect((workboxConfig.globPatterns ?? []).join(' ')).not.toContain('webmanifest');
    expect(pwaOptions.manifest).toBe(false);
  });

  it('serves the shell for page navigations, but never for the API, files or the manifest', () => {
    expect(workboxConfig.navigateFallback).toBe('/index.html');
    const denied = workboxConfig.navigateFallbackDenylist ?? [];
    for (const path of [
      '/api/auth/me',
      '/files/abc',
      '/public/branding/logo',
      '/manifest.webmanifest',
    ]) {
      expect(
        denied.some((pattern) => pattern.test(path)),
        path,
      ).toBe(true);
    }
    for (const path of ['/', '/patients', '/login', '/account/security']) {
      expect(
        denied.some((pattern) => pattern.test(path)),
        path,
      ).toBe(false);
    }
  });
});

describe('PWA: nothing clinical is ever cached at runtime', () => {
  it('uses the network only for /api, /files, /public and the manifest', () => {
    const rules = workboxConfig.runtimeCaching ?? [];

    expect(rules).toHaveLength(1);
    expect(rules[0]?.handler).toBe('NetworkOnly');
    const matches = patternOf(0);
    for (const path of [
      '/api/patients?q=ana',
      '/api/auth/me',
      '/files/token123',
      '/public/branding/logo?v=2',
      '/manifest.webmanifest',
    ]) {
      expect(matches(at(path)), path).toBe(true);
    }
    for (const path of ['/assets/index-abc.js', '/icons/icon-192.png', '/patients']) {
      expect(matches(at(path)), path).toBe(false);
    }
  });

  it('has no caching strategy that could keep a response', () => {
    const handlers = (workboxConfig.runtimeCaching ?? []).map((rule) => rule.handler);

    expect(handlers).not.toContain('CacheFirst');
    expect(handlers).not.toContain('StaleWhileRevalidate');
    expect(handlers).not.toContain('NetworkFirst');
  });
});

describe('PWA: updates and registration', () => {
  it('asks before updating and registers from the app code', () => {
    expect(pwaOptions.registerType).toBe('prompt');
    expect(pwaOptions.injectRegister).toBe(false);
    expect(workboxConfig.skipWaiting).toBe(false);
    expect(workboxConfig.cleanupOutdatedCaches).toBe(true);
  });
});
