import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { POLICY_FILE, cspPlugin } from './csp-plugin.js';
import { scriptHash } from './csp.js';
import { buildThemeBootScript, themeBootPlugin } from './theme-boot-plugin.js';

const SOURCE = resolve(import.meta.dirname, '../src/shared/lib/theme-boot.ts');

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

/** Runs the middleware a hook registers and returns the header it set. */
async function headerOf(hook: 'configureServer' | 'configurePreviewServer'): Promise<string> {
  const plugin = cspPlugin(SOURCE);
  let registered: Middleware | undefined;
  const server = {
    middlewares: {
      use: (fn: Middleware) => {
        registered = fn;
      },
    },
  };
  const configure = plugin[hook] as unknown as (server: unknown) => void;
  configure(server);
  const headers = new Map<string, string>();
  const response = { setHeader: (name: string, value: string) => headers.set(name, value) };
  await new Promise<void>((done) => {
    registered?.({} as IncomingMessage, response as unknown as ServerResponse, done);
  });
  return headers.get('content-security-policy') ?? '';
}

describe('the CSP header of the Vite servers', () => {
  it('sends the production policy from the preview server, which serves the production build', async () => {
    const header = await headerOf('configurePreviewServer');

    expect(header).toContain("script-src 'self' 'sha256-");
    expect(header).not.toContain("'unsafe-inline'; style");
    expect(header).toContain('upgrade-insecure-requests');
  });

  it('sends the development policy from the dev server', async () => {
    const header = await headerOf('configureServer');

    expect(header).toMatch(/script-src [^;]*'unsafe-inline'/);
    expect(header).toContain("connect-src 'self' ws: wss:");
    expect(header).not.toContain('upgrade-insecure-requests');
  });

  it('names the hash of the very script the HTML plugin injects into index.html', async () => {
    const transform = themeBootPlugin(SOURCE).transformIndexHtml;
    const handler =
      typeof transform === 'object' && 'handler' in transform ? transform.handler : null;
    const html = await (handler as unknown as (html: string) => Promise<string>)(
      '<head><!--theme-boot--></head>',
    );
    const injected = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? '';

    expect(injected).toBe(await buildThemeBootScript(SOURCE));
    expect(await headerOf('configurePreviewServer')).toContain(scriptHash(injected));
  });

  it('leaves the production policy in the build output for the proxy of the deployment', async () => {
    const emitted: { fileName: string; source: string }[] = [];
    const plugin = cspPlugin(SOURCE);
    const generate = plugin.generateBundle as unknown as (this: {
      emitFile: (file: { fileName: string; source: string }) => void;
    }) => Promise<void>;

    await generate.call({ emitFile: (file) => emitted.push(file) });

    expect(POLICY_FILE).toBe('content-security-policy.txt');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.fileName).toBe(POLICY_FILE);
    expect(emitted[0]?.source.trim()).toBe(await headerOf('configurePreviewServer'));
  });
});
