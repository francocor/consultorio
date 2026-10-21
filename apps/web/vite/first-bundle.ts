/**
 * The first bundle is what a browser downloads before the sign-in page can draw: the scripts that
 * `index.html` loads and every chunk they import statically. `vite build` lists the chunks in
 * `dist/.vite/manifest.json` (`build.manifest`). These functions read that list; the checks that
 * use them are `first-bundle.test.ts` (on a made-up manifest) and `first-bundle.build-test.ts`
 * (on the real build).
 */

export interface ManifestChunk {
  file: string;
  src?: string;
  isDynamicEntry?: boolean;
  /** Keys of the chunks this one imports statically (the browser fetches them with it). */
  imports?: string[];
  /** Keys of the chunks this one imports with `import()` (fetched when the code asks for them). */
  dynamicImports?: string[];
}

export type Manifest = Record<string, ManifestChunk>;

/**
 * The scripts that `index.html` loads by itself (`<script type="module">` and `modulepreload`
 * links), as file names relative to the output folder, whatever the base of the application is.
 * The manifest cannot tell which chunk is the entry once the entry module shares a chunk with other
 * modules, so the page is the source of truth: it is what the browser reads.
 */
export function scriptsOfHtml(html: string): string[] {
  const files = new Set<string>();
  for (const tag of html.match(/<(?:script|link)\b[^>]*>/g) ?? []) {
    const isModule = /<script\b[^>]*\btype="module"/.test(tag) || /\brel="modulepreload"/.test(tag);
    const url = /\b(?:src|href)="([^"]+)"/.exec(tag)?.[1];
    if (isModule && url) files.add(url.replace(/^.*?(assets\/)/, '$1'));
  }
  return [...files];
}

/** The files of what `index.html` loads and of everything those import statically, however deep. */
export function firstBundleFiles(manifest: Manifest, html: string): Set<string> {
  const byFile = new Map(Object.entries(manifest).map(([key, chunk]) => [chunk.file, key]));
  const files = new Set<string>();
  const visit = (key: string) => {
    const chunk = manifest[key];
    if (!chunk || files.has(chunk.file)) return;
    files.add(chunk.file);
    for (const next of chunk.imports ?? []) visit(next);
  };
  for (const file of scriptsOfHtml(html)) {
    const key = byFile.get(file);
    if (key) visit(key);
  }
  return files;
}

/** The files a chunk needs to run: itself and what it imports statically. */
export function filesOf(manifest: Manifest, key: string): Set<string> {
  const files = new Set<string>();
  const visit = (next: string) => {
    const chunk = manifest[next];
    if (!chunk || files.has(chunk.file)) return;
    files.add(chunk.file);
    for (const dependency of chunk.imports ?? []) visit(dependency);
  };
  visit(key);
  return files;
}

/** The manifest key of the chunk that was built from a source file loaded with `import()`. */
export function dynamicEntryKey(manifest: Manifest, source: string): string | undefined {
  return Object.entries(manifest).find(
    ([, chunk]) => chunk.isDynamicEntry === true && chunk.src === source,
  )?.[0];
}
