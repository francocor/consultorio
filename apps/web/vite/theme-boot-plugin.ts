import { readFile } from 'node:fs/promises';

import { transformWithOxc, type Plugin } from 'vite';

const PLACEHOLDER = '<!--theme-boot-->';

/**
 * Compiles `src/app/theme-boot.ts` (which only imports types) into a classic script: types
 * stripped, `export` removed, wrapped so nothing leaks into the global scope. Keeping a single
 * source means the code that runs before the first paint is the code the unit tests cover.
 */
export async function buildThemeBootScript(sourcePath: string): Promise<string> {
  const source = await readFile(sourcePath, 'utf8');
  const { code } = await transformWithOxc(source, sourcePath, { lang: 'ts' });
  const body = code.replace(/^export\s+/gm, '').replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  return `(function(){${body}\nstartThemeBoot(window);})();`;
}

/** Replaces `<!--theme-boot-->` in `index.html` with the inline script. */
export function themeBootPlugin(sourcePath: string): Plugin {
  return {
    name: 'consultorio:theme-boot',
    transformIndexHtml: {
      order: 'pre',
      async handler(html) {
        const script = await buildThemeBootScript(sourcePath);
        return html.replace(PLACEHOLDER, `<script>${script}</script>`);
      },
    },
  };
}
