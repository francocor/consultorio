/**
 * Keeps the first bundle in few files.
 *
 * The bundler cuts a module that the sign-in page needs AND some other chunk needs (a button, an
 * icon, a Radix primitive, a helper) out into a chunk of its own, and the modules of the application
 * import each other in cycles, so it cannot fold those chunks back into the entry. The result was
 * thirty-odd tiny files that the browser fetched before it could draw. Over a slow connection every
 * round of requests costs a round trip (six connections per origin, 170 ms each in the Lighthouse
 * budget), and that cost, not the bytes, was most of the time to the first paint.
 *
 * So the modules of this application that the entry imports statically (however deep) are gathered
 * into one chunk, `app`. With them in one place there is no cycle between chunks left, and the
 * bundler folds the shared packages (React, the router, zod, the icons...) into the entry chunk on
 * its own. Everything a screen loads later (`import()`) is still split as before.
 *
 * Two kinds of module are left to the bundler on purpose, because a group pulls in whatever it
 * captures even when the bundler would have dropped it as unused:
 *
 * - packages: one that re-exports hundreds of files (the icon set, the Radix umbrella) makes every
 *   one of them look reachable;
 * - the contracts package: its index re-exports every schema of the API, and building a schema
 *   costs time at start-up, so only the ones the sign-in page uses should be in the first bundle.
 *
 * `vite/first-bundle.build-test.ts` fails when the first bundle grows past a handful of files.
 */

/** What the chunking pass lets us ask about a module (the part of Rolldown's `ModuleInfo` we use). */
export interface ModuleGraph {
  getModuleInfo(id: string): { isEntry: boolean; importers: readonly string[] } | null;
}

export type FirstBundleChunk = 'app';

const RUNTIME = /^\0rolldown[\\/]runtime/;

/** The workspace package of the schemas and error codes, shared with the API. */
const CONTRACTS = /[\\/]packages[\\/]contracts[\\/]/;

/** Whether the module is the entry or is imported statically, however deep, by it. */
function reachableFromEntry(id: string, graph: ModuleGraph, memo: Map<string, boolean>): boolean {
  const known = memo.get(id);
  if (known !== undefined) return known;
  // Marked false while it is being looked into, so a cycle of imports cannot loop forever.
  memo.set(id, false);
  const info = graph.getModuleInfo(id);
  const reachable =
    info !== null &&
    (info.isEntry || info.importers.some((importer) => reachableFromEntry(importer, graph, memo)));
  memo.set(id, reachable);
  return reachable;
}

/** The chunk a module of the first bundle goes to, or `null` for a module the bundler places. */
export function chunkOfFirstBundle(
  id: string,
  graph: ModuleGraph,
  memo: Map<string, boolean>,
): FirstBundleChunk | null {
  if (RUNTIME.test(id) || id.includes('node_modules') || CONTRACTS.test(id)) return null;
  if (graph.getModuleInfo(id)?.isEntry) return null;
  return reachableFromEntry(id, graph, memo) ? 'app' : null;
}

/** The `name` function of the chunking group for Rolldown (`build.rolldownOptions.output.codeSplitting`). */
export function firstBundleChunks() {
  const memos = new WeakMap<ModuleGraph, Map<string, boolean>>();
  return (id: string, graph: ModuleGraph): FirstBundleChunk | null => {
    let memo = memos.get(graph);
    if (!memo) {
      memo = new Map();
      memos.set(graph, memo);
    }
    return chunkOfFirstBundle(id, graph, memo);
  };
}
