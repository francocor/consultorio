import { describe, expect, it } from 'vitest';

import {
  dynamicEntryKey,
  filesOf,
  firstBundleFiles,
  scriptsOfHtml,
  type Manifest,
} from './first-bundle.js';

const manifest: Manifest = {
  '_app.js': {
    file: 'assets/app.js',
    imports: ['_shared.js'],
    dynamicImports: ['src/shared/lib/locale-rest.ts', 'src/pages/Later.tsx'],
  },
  '_shared.js': { file: 'assets/shared.js', imports: ['_leaf.js'] },
  '_leaf.js': { file: 'assets/leaf.js' },
  'src/shared/lib/locale-rest.ts': {
    file: 'assets/locale-rest.js',
    src: 'src/shared/lib/locale-rest.ts',
    isDynamicEntry: true,
    imports: ['_leaf.js', '_rest-only.js'],
  },
  '_rest-only.js': { file: 'assets/rest-only.js' },
  'src/pages/Later.tsx': {
    file: 'assets/Later.js',
    src: 'src/pages/Later.tsx',
    isDynamicEntry: true,
  },
};

const html = `<!doctype html><html><head>
  <link rel="preload" as="font" type="font/woff2" crossorigin="" href="/assets/inter.woff2">
  <script>window.early = true;</script>
  <script type="module" crossorigin src="/assets/app.js"></script>
  <link rel="modulepreload" crossorigin href="/assets/shared.js">
  <link rel="stylesheet" crossorigin href="/assets/app.css">
</head><body></body></html>`;

describe('the scripts of the page', () => {
  it('are the module scripts and the modulepreload links, and nothing else', () => {
    expect(scriptsOfHtml(html)).toEqual(['assets/app.js', 'assets/shared.js']);
  });

  it('are found under any base of the application', () => {
    expect(
      scriptsOfHtml('<script type="module" src="https://cdn.example/app/assets/a.js"></script>'),
    ).toEqual(['assets/a.js']);
  });
});

describe('the first bundle', () => {
  it('is what the page loads and everything that imports statically, however deep', () => {
    expect([...firstBundleFiles(manifest, html)].sort()).toEqual([
      'assets/app.js',
      'assets/leaf.js',
      'assets/shared.js',
    ]);
  });

  it('leaves out what is only reached with import()', () => {
    const files = firstBundleFiles(manifest, html);

    expect(files.has('assets/locale-rest.js')).toBe(false);
    expect(files.has('assets/Later.js')).toBe(false);
    expect(files.has('assets/rest-only.js')).toBe(false);
  });

  it('is empty when the page loads no script the manifest knows', () => {
    expect(
      firstBundleFiles(manifest, '<script type="module" src="/assets/other.js"></script>').size,
    ).toBe(0);
  });

  it('follows the static imports of a chunk that is loaded later', () => {
    expect([...filesOf(manifest, 'src/shared/lib/locale-rest.ts')].sort()).toEqual([
      'assets/leaf.js',
      'assets/locale-rest.js',
      'assets/rest-only.js',
    ]);
  });

  it('finds the chunk built from a source file that is loaded with import()', () => {
    expect(dynamicEntryKey(manifest, 'src/shared/lib/locale-rest.ts')).toBe(
      'src/shared/lib/locale-rest.ts',
    );
    expect(dynamicEntryKey(manifest, 'src/missing.ts')).toBeUndefined();
  });
});
