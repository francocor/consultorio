// @vitest-environment jsdom
import { resolve } from 'node:path';
import { runInThisContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { buildThemeBootScript, themeBootPlugin } from './theme-boot-plugin.js';

const SOURCE = resolve(import.meta.dirname, '../src/shared/lib/theme-boot.ts');

describe('theme boot inline script', () => {
  it('is plain JavaScript with no module syntax or leftover types', async () => {
    const script = await buildThemeBootScript(SOURCE);

    expect(script).not.toMatch(/^\s*(import|export)\s/m);
    expect(script).not.toMatch(/:\s*(string|BootTheme)\b/);
    expect(script.length).toBeLessThan(6_000);
  });

  it('runs on its own: applies the cached theme of the host synchronously', async () => {
    const script = await buildThemeBootScript(SOURCE);
    localStorage.setItem(
      `consultorio:theme:${window.location.host}`,
      JSON.stringify({
        primary: '#7c2d12',
        primaryForeground: '#ffffff',
        radius: 'lg',
        headingFont: 'lora',
      }),
    );
    document.documentElement.removeAttribute('style');
    window.fetch = () => new Promise<Response>(() => undefined);
    window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia;

    // Same realm as the test's jsdom globals, which is what a browser page would be.
    runInThisContext(script);

    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('#7c2d12');
    expect(document.documentElement.style.getPropertyValue('--radius')).toBe('0.5rem');
    expect(window.__CONSULTORIO_BOOT__).toBeInstanceOf(Promise);
  });

  it('is injected where index.html asks for it', async () => {
    const plugin = themeBootPlugin(SOURCE);
    const transform = plugin.transformIndexHtml;
    const handler =
      typeof transform === 'object' && 'handler' in transform ? transform.handler : null;

    const html = await (handler as unknown as (html: string) => Promise<string>)(
      '<head><!--theme-boot--></head>',
    );

    expect(html).toContain('<script>');
    expect(html).toContain('startThemeBoot');
    expect(html).not.toContain('<!--theme-boot-->');
  });
});
