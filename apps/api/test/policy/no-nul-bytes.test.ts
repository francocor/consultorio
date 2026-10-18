import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** Extensions of files that are text by nature: a NUL byte in one is a mistake, not content. */
const TEXT_FILE = /\.(?:[cm]?[jt]sx?|json|md|css|html|ya?ml|sql|sh|ps1|toml)$/u;

/** Returns the offset of the first NUL byte, or -1 when the content has none. */
export function firstNulByte(content: Uint8Array): number {
  return content.indexOf(0);
}

function trackedTextFiles(): string[] {
  const listing = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return listing.split('\0').filter((path) => path !== '' && TEXT_FILE.test(path));
}

describe('no tracked source file contains a NUL byte', () => {
  const files = trackedTextFiles();

  it('scans the repository (the guard is not silently empty)', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('keeps every tracked text file free of NUL bytes (git would treat it as binary and refuse to merge it as text)', () => {
    const offenders = files
      .filter((path) => firstNulByte(readFileSync(join(REPOSITORY_ROOT, path))) >= 0)
      .sort();

    // To spell a NUL in source, write the escape (\u0000) instead of the raw byte.
    expect(offenders).toEqual([]);
  });

  describe('the scanner itself', () => {
    it('finds the offset of a NUL byte', () => {
      expect(firstNulByte(Uint8Array.from([97, 0, 98]))).toBe(1);
    });

    it('finds nothing in clean text', () => {
      expect(firstNulByte(new TextEncoder().encode('const missing = text;'))).toBe(-1);
    });
  });
});
