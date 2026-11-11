import { isAbsolute, relative, resolve } from 'node:path';

import { StorageKeyError } from '../../platform/storage/object-storage.js';

/**
 * Where a key lives on the disk. The adapter calls `assertTenantKey` first; this is the second wall,
 * written for the filesystem rather than for S3: S3 treats a key as a string, a disk reads `..`,
 * drive letters, `:` streams and device names as things. A key maps to
 * `<root>/t/<tenant>/<segments...>.obj`, with its content type in `<same>.meta`, and a path that
 * would leave the root is refused instead of cleaned up.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_KEY_LENGTH = 1024;
// Characters Windows refuses in a name, and the ones that change the meaning of a path: `:` opens an
// alternate stream or names a drive, `\` is a separator there. Control characters never belong.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARACTERS = /[<>:"|?*\\\u0000-\u001f\u007f]/;
const DEVICE_NAMES = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;

const DATA_SUFFIX = '.obj';
const META_SUFFIX = '.meta';

function isSafeSegment(segment: string): boolean {
  return (
    segment !== '' &&
    segment !== '.' &&
    segment !== '..' &&
    !UNSAFE_CHARACTERS.test(segment) &&
    // Windows drops a trailing dot or space, so "x." and "x" would be the same file.
    !segment.endsWith('.') &&
    !segment.endsWith(' ') &&
    !DEVICE_NAMES.test(segment)
  );
}

/** The folders and the name of an object, or a `StorageKeyError`. */
function checkedSegments(key: string): string[] {
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) throw new StorageKeyError();
  const segments = key.split('/');
  const [prefix, tenant, ...rest] = segments;
  if (prefix !== 't' || tenant === undefined || !UUID.test(tenant) || rest.length === 0) {
    throw new StorageKeyError();
  }
  if (!rest.every(isSafeSegment)) throw new StorageKeyError();
  return segments;
}

function pathUnder(root: string, segments: readonly string[], suffix: string): string {
  const base = resolve(root);
  const path = resolve(base, ...segments) + suffix;
  const inside = relative(base, path);
  // After resolving, the path must still be below the root. Anything else is a bug upstream.
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) throw new StorageKeyError();
  return path;
}

/** The file that holds the bytes of an object. */
export function dataPathOf(root: string, key: string): string {
  return pathUnder(root, checkedSegments(key), DATA_SUFFIX);
}

/** The file that holds the content type of an object. */
export function metaPathOf(root: string, key: string): string {
  return pathUnder(root, checkedSegments(key), META_SUFFIX);
}
