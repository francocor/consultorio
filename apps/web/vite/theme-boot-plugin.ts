import { readFile } from 'node:fs/promises';

import { transformWithOxc, type Plugin } from 'vite';

const PLACEHOLDER = '<!--theme-boot-->';

/**
 * Compiles `src/shared/lib/theme-boot.ts` (which only imports types) into a classic script: types
 * stripped, `export` removed, wrapped so nothing leaks into the global scope. Keeping a single
 * source means the code that runs before the first paint is the code the unit tests cover.
 */
export async function buildThemeBootScript(sourcePath: string): Promise<string> {
  const source = await readFile(sourcePath, 'utf8');
  const { code } = await transformWithOxc(source, sourcePath, { lang: 'ts' });
  const body = code.replace(/^export\s+/gm, '').replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  return `(function(){${body}\nstartThemeBoot(window);})();`;
}

/**
 * Zod compiles object schemas with `new Function` when the page allows it, and probes for that by
 * trying. Under the Content Security Policy of the bundle (no `unsafe-eval`) the probe throws, zod
 * catches it and falls back, but the browser reports a `securitypolicyviolation` and logs an error
 * for every schema. Zod keeps its global configuration on `globalThis.__zod_globalConfig` and
 * skips the probe when `jitless` is set, so a classic script that runs BEFORE any module turns code
 * generation off for the whole bundle. (Calling `z.config` from a module is too late: the schemas of
 * the contracts package are built while the modules load, in chunks that run before the entry's own
 * code.) The cost is a little speed when parsing very large objects, which forms are not.
 */
export const ZOD_JITLESS_SCRIPT =
  'globalThis.__zod_globalConfig=Object.assign(globalThis.__zod_globalConfig||{},{jitless:true});';

/**
 * The inline scripts of `index.html`, in the order they run. The Content Security Policy names the
 * hash of each, so this is the one list both the HTML and the policy are built from.
 */
export async function buildInlineScripts(themeBootSource: string): Promise<string[]> {
  return [ZOD_JITLESS_SCRIPT, await buildThemeBootScript(themeBootSource)];
}

/** Replaces `<!--theme-boot-->` in `index.html` with the inline scripts. */
export function themeBootPlugin(sourcePath: string): Plugin {
  return {
    name: 'consultorio:theme-boot',
    transformIndexHtml: {
      order: 'pre',
      async handler(html) {
        const scripts = await buildInlineScripts(sourcePath);
        return html.replace(
          PLACEHOLDER,
          scripts.map((script) => `<script>${script}</script>`).join(''),
        );
      },
    },
  };
}
