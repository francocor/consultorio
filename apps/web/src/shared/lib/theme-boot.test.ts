import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyColorScheme,
  applyTheme,
  runThemeBoot,
  themeToCssVariables,
  type BootTheme,
} from './theme-boot.js';

const teal: BootTheme = {
  primary: '#0f766e',
  primaryForeground: '#ffffff',
  radius: 'md',
  headingFont: 'inter',
};

describe('themeToCssVariables', () => {
  it('maps the tenant theme to the semantic variables the components read', () => {
    const vars = themeToCssVariables(teal);

    expect(vars['--primary']).toBe('#0f766e');
    expect(vars['--primary-foreground']).toBe('#ffffff');
    expect(vars['--ring']).toBe('#0f766e');
    expect(vars['--radius']).toBe('0.375rem');
    expect(vars['--font-heading']).toContain('Inter Variable');
  });

  it('follows the radius step and the heading font of another tenant', () => {
    const vars = themeToCssVariables({
      primary: '#1e3a8a',
      primaryForeground: '#ffffff',
      radius: 'xl',
      headingFont: 'lora',
    });

    expect(vars['--radius']).toBe('0.75rem');
    expect(vars['--font-heading']).toContain('Lora Variable');
    expect(vars['--primary']).toBe('#1e3a8a');
  });

  it('never lets a hostile color value break out of the declaration', () => {
    const vars = themeToCssVariables({
      ...teal,
      primary: 'red; background: url(//evil.test/x)',
    });

    expect(vars['--primary']).toBe('#0f766e');
  });
});

describe('applyTheme and applyColorScheme', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('style');
    document.documentElement.className = '';
  });

  it('sets the variables on the root element', () => {
    applyTheme(document.documentElement, teal);

    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('#0f766e');
    expect(document.documentElement.style.getPropertyValue('--radius')).toBe('0.375rem');
  });

  it('adds the dark class for a dark preference and for system when the device is dark', () => {
    applyColorScheme(document.documentElement, 'dark', false);
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    applyColorScheme(document.documentElement, 'light', true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    applyColorScheme(document.documentElement, 'system', true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    applyColorScheme(document.documentElement, null, false);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});

describe('runThemeBoot (what runs before the first paint)', () => {
  const bootPayload = { name: 'Clínica Norte', theme: teal };

  function environment(overrides: { stored?: Record<string, string>; fetch?: typeof fetch } = {}) {
    const root = document.createElement('html');
    const store = new Map(Object.entries(overrides.stored ?? {}));
    return {
      root,
      store,
      options: {
        root,
        host: 'norte.localhost:5173',
        storage: {
          getItem: (key: string) => store.get(key) ?? null,
          setItem: (key: string, value: string) => void store.set(key, value),
        },
        fetch:
          overrides.fetch ??
          (() => Promise.resolve(new Response(JSON.stringify(bootPayload), { status: 200 }))),
        prefersDark: () => false,
        timeoutMs: 50,
      },
    };
  }

  it('applies the cached theme of this host synchronously, before any network answer', () => {
    const cached = { ...teal, primary: '#7c2d12' };
    const env = environment({
      stored: { 'consultorio:theme:norte.localhost:5173': JSON.stringify(cached) },
      fetch: () => new Promise<Response>(() => undefined),
    });

    void runThemeBoot(env.options);

    expect(env.root.style.getPropertyValue('--primary')).toBe('#7c2d12');
    expect(env.root.getAttribute('data-boot')).toBeNull();
  });

  it('holds the first paint until the boot payload arrives when nothing is cached, then reveals', async () => {
    const env = environment();

    const booted = runThemeBoot(env.options);
    expect(env.root.getAttribute('data-boot')).toBe('pending');

    const payload = await booted;

    expect(payload).toMatchObject({ name: 'Clínica Norte' });
    expect(env.root.style.getPropertyValue('--primary')).toBe('#0f766e');
    expect(env.root.getAttribute('data-boot')).toBeNull();
    expect(JSON.parse(env.store.get('consultorio:theme:norte.localhost:5173') ?? '{}')).toEqual(
      teal,
    );
  });

  it('keeps hosts apart: the theme cached for one host is not applied to another', () => {
    const env = environment({
      stored: { 'consultorio:theme:otra.localhost:5173': JSON.stringify(teal) },
      fetch: () => new Promise<Response>(() => undefined),
    });

    void runThemeBoot(env.options);

    expect(env.root.style.getPropertyValue('--primary')).toBe('');
    expect(env.root.getAttribute('data-boot')).toBe('pending');
  });

  it('reveals the neutral page when the server fails or is too slow', async () => {
    const failing = environment({ fetch: () => Promise.reject(new TypeError('offline')) });
    expect(await runThemeBoot(failing.options)).toBeNull();
    expect(failing.root.getAttribute('data-boot')).toBeNull();

    const slow = environment({ fetch: () => new Promise<Response>(() => undefined) });
    const result = await runThemeBoot(slow.options);
    expect(result).toBeNull();
    expect(slow.root.getAttribute('data-boot')).toBeNull();
  });

  it('ignores a corrupted cache entry and a payload that does not look like a theme', async () => {
    const env = environment({
      stored: { 'consultorio:theme:norte.localhost:5173': '{not json' },
      fetch: vi.fn(() => Promise.resolve(new Response('{"theme":{"primary":5}}', { status: 200 }))),
    });

    const payload = await runThemeBoot(env.options);

    expect(payload).toBeNull();
    expect(env.root.style.getPropertyValue('--primary')).toBe('');
  });
});
