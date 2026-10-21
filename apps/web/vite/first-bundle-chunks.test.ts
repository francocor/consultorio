import { describe, expect, it } from 'vitest';

import { chunkOfFirstBundle, firstBundleChunks, type ModuleGraph } from './first-bundle-chunks.js';

/** A made-up module graph: each module lists the modules that import it statically. */
function graphOf(modules: Record<string, { entry?: boolean; importers?: string[] }>): ModuleGraph {
  return {
    getModuleInfo: (id) => {
      const module = modules[id];
      return module ? { isEntry: module.entry === true, importers: module.importers ?? [] } : null;
    },
  };
}

const reactDom =
  '/repo/node_modules/.pnpm/react-dom@19.3.1_react@19.3.1/node_modules/react-dom/cjs/react-dom-client.production.js';
const contracts = '/repo/packages/contracts/src/scheduling.ts';

const graph = graphOf({
  '/repo/apps/web/index.html': { entry: true },
  '/repo/apps/web/src/main.tsx': { importers: ['/repo/apps/web/index.html'] },
  '/repo/apps/web/src/ui/button.tsx': {
    importers: ['/repo/apps/web/src/main.tsx', '/repo/apps/web/src/pages/Later.tsx'],
  },
  '/repo/apps/web/src/pages/Later.tsx': { importers: [] },
  '/repo/apps/web/src/pages/OnlyLater.ts': { importers: ['/repo/apps/web/src/pages/Later.tsx'] },
  [reactDom]: { importers: ['/repo/apps/web/src/main.tsx'] },
  [contracts]: { importers: ['/repo/apps/web/src/main.tsx'] },
  '\0vite/preload-helper.js': { importers: ['/repo/apps/web/src/main.tsx'] },
  '\0rolldown/runtime.js': { importers: ['/repo/apps/web/src/main.tsx'] },
  '/repo/apps/web/src/a.ts': { importers: ['/repo/apps/web/src/b.ts'] },
  '/repo/apps/web/src/b.ts': {
    importers: ['/repo/apps/web/src/a.ts', '/repo/apps/web/src/main.tsx'],
  },
});

const chunk = (id: string) => chunkOfFirstBundle(id, graph, new Map());

describe('the chunk of the first bundle', () => {
  it('gathers the modules of the application that the entry imports, even when a later chunk shares them', () => {
    expect(chunk('/repo/apps/web/src/main.tsx')).toBe('app');
    expect(chunk('/repo/apps/web/src/ui/button.tsx')).toBe('app');
  });

  it('takes the helpers that Vite injects along', () => {
    expect(chunk('\0vite/preload-helper.js')).toBe('app');
  });

  it('leaves what only a later chunk imports to the bundler', () => {
    expect(chunk('/repo/apps/web/src/pages/Later.tsx')).toBeNull();
    expect(chunk('/repo/apps/web/src/pages/OnlyLater.ts')).toBeNull();
  });

  it('leaves the packages to the bundler: some re-export hundreds of files nobody uses', () => {
    expect(chunk(reactDom)).toBeNull();
  });

  it('leaves the schemas to the bundler: only the ones the sign-in page uses should be built at start-up', () => {
    expect(chunk(contracts)).toBeNull();
  });

  it('leaves the entry itself and the runtime of the bundler alone', () => {
    expect(chunk('/repo/apps/web/index.html')).toBeNull();
    expect(chunk('\0rolldown/runtime.js')).toBeNull();
  });

  it('does not loop on modules that import each other', () => {
    expect(chunk('/repo/apps/web/src/a.ts')).toBe('app');
    expect(chunk('/repo/apps/web/src/b.ts')).toBe('app');
  });

  it('knows nothing about a module the graph does not have', () => {
    expect(chunk('/repo/apps/web/src/unknown.ts')).toBeNull();
  });

  it('reads Windows paths too', () => {
    expect(
      chunk('C:\\repo\\node_modules\\.pnpm\\react-dom@19\\node_modules\\react-dom\\index.js'),
    ).toBeNull();
    expect(chunk('C:\\repo\\packages\\contracts\\src\\roles.ts')).toBeNull();
  });

  it('keeps one memo per pass of the bundler', () => {
    const name = firstBundleChunks();

    expect(name('/repo/apps/web/src/ui/button.tsx', graph)).toBe('app');
    expect(name(reactDom, graph)).toBeNull();
    expect(name('/repo/apps/web/src/pages/Later.tsx', graph)).toBeNull();
  });
});
