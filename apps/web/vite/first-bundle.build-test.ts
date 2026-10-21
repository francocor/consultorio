import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { dynamicEntryKey, filesOf, firstBundleFiles, type Manifest } from './first-bundle.js';

/**
 * The sign-in page is the page the performance budget measures (Lighthouse, LCP at 2.5 s), and the
 * first bundle is everything it downloads before it can draw. This reads the real build and checks
 * that what the sign-in page does not show stayed out of it (the catalogs of the features, and the
 * navigation and slots of the features), and that what it does need comes in few files. Run it after
 * `vite build`: `pnpm --filter @consultorio/web test:build`.
 */

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const manifestPath = join(dist, '.vite', 'manifest.json');

if (!existsSync(manifestPath)) {
  throw new Error('There is no build to check: run `vite build` first (dist/.vite/manifest.json).');
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
const first = firstBundleFiles(manifest, readFileSync(join(dist, 'index.html'), 'utf8'));
const read = (file: string) => readFileSync(join(dist, file), 'utf8');
const firstText = [...first].map(read).join('\n');

/** What the sign-in page and the frame around every screen show: the catalogs of the first bundle. */
const CORE_FILES = new Set(['common.json', 'auth.json', 'shell.json', 'errors.json']);
/** The budget of the JavaScript the sign-in page downloads, gzipped (the build at the time was 211 KB). */
const FIRST_BUNDLE_GZIP_BUDGET = 235 * 1024;
/** Files of the first bundle. Each one is a round trip on the connection the budget measures (2 at the time). */
const FIRST_BUNDLE_MAX_FILES = 6;

const localesDir = join(root, 'src', 'locales', 'es-AR');
const featuresDir = join(root, 'src', 'features');

/**
 * A piece of text of a catalog that no other file repeats and the minifier leaves as it is: the
 * first 28 characters of its longest message that have no quote, backslash or brace in them.
 */
function sentinelOf(file: string): string {
  const catalog = JSON.parse(readFileSync(join(localesDir, file), 'utf8')) as Record<
    string,
    string
  >;
  const pieces = Object.values(catalog)
    .flatMap((text) => text.match(/[^"'`\\{}$\n]{28,}/g) ?? [])
    .sort((a, b) => b.length - a.length);
  const piece = pieces[0];
  if (!piece) throw new Error(`No message of ${file} is long enough to tell it apart.`);
  return piece.slice(0, 28);
}

/** Whether the text appears as a whole string literal (a property named like `a.b.c` is not it). */
function hasLiteral(text: string, value: string): boolean {
  return ['"', "'", '`'].some((quote) => text.includes(`${quote}${value}${quote}`));
}

/** Every file under `dir` whose name is one of `names`. */
function filesNamed(dir: string, names: readonly string[]): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && names.includes(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

/**
 * Texts that identify the navigation and the slots of the features in the output: the label keys
 * (`billing:nav`) and the ids of the slot pieces that have a dot (`billing.charge`).
 */
function contributionSentinels(): string[] {
  const found = new Set<string>();
  for (const file of filesNamed(featuresDir, ['nav.ts', 'slots.tsx'])) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/labelKey:\s*'([^']+:[^']+)'/g)) found.add(match[1] ?? '');
    for (const match of source.matchAll(/\bid:\s*'([^'.]+\.[^']+)'/g)) found.add(match[1] ?? '');
  }
  found.delete('');
  return [...found].sort();
}

describe('the first bundle of the sign-in page', () => {
  it('is found: the page loads at least one script', () => {
    expect(first.size).toBeGreaterThan(0);
    expect(firstText).toContain('createRoot');
  });

  it('keeps the catalogs of the features out: they are a chunk loaded after sign-in', () => {
    const restKey = dynamicEntryKey(manifest, 'src/shared/lib/locale-rest.ts');
    expect(restKey, 'locale-rest.ts must be loaded with import()').toBeDefined();
    const restFiles = filesOf(manifest, restKey ?? '');

    const rest = readdirSync(localesDir).filter((name) => !CORE_FILES.has(name));
    expect(rest.length).toBeGreaterThan(20);
    for (const file of rest) {
      const sentinel = sentinelOf(file);
      expect(firstText.includes(sentinel), `${file} is in the first bundle`).toBe(false);
      expect(
        [...restFiles].some((chunk) => read(chunk).includes(sentinel)),
        `${file} is in no chunk of the rest of the catalogs`,
      ).toBe(true);
    }
    expect(
      first.has(manifest[restKey ?? '']?.file ?? ''),
      'the rest of the catalogs is in the first bundle',
    ).toBe(false);
  });

  it('carries the catalogs the sign-in page shows', () => {
    for (const file of CORE_FILES) {
      expect(firstText.includes(sentinelOf(file)), `${file} is not in the first bundle`).toBe(true);
    }
  });

  it('keeps the navigation and the slots of the features out', () => {
    const key = dynamicEntryKey(manifest, 'src/app/registry-contributions.ts');
    expect(key, 'registry-contributions.ts must be loaded with import()').toBeDefined();
    const files = filesOf(manifest, key ?? '');
    const sentinels = contributionSentinels();
    expect(sentinels.length).toBeGreaterThan(10);

    for (const sentinel of sentinels) {
      expect(hasLiteral(firstText, sentinel), `"${sentinel}" is in the first bundle`).toBe(false);
      expect(
        [...files].some((chunk) => hasLiteral(read(chunk), sentinel)),
        `"${sentinel}" is in no chunk of the contributions`,
      ).toBe(true);
    }
  });

  it('is a handful of files: each one costs a round trip before the page can draw', () => {
    // The names are in the message so a failure shows which files crept in (see first-bundle-chunks.ts).
    expect(first.size, [...first].join(', ')).toBeLessThanOrEqual(FIRST_BUNDLE_MAX_FILES);
  });

  it('stays within the budget of JavaScript the sign-in page downloads', () => {
    const gzip = [...first].reduce((sum, file) => sum + gzipSync(read(file)).length, 0);

    expect(gzip).toBeLessThan(FIRST_BUNDLE_GZIP_BUDGET);
  });
});
