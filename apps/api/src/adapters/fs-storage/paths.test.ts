import { isAbsolute, join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { StorageKeyError } from '../../platform/storage/object-storage.js';

import { dataPathOf, metaPathOf } from './paths.js';

const TENANT = '0190a000-0000-7000-8000-0000000000a1';
const ROOT = resolve('storage-root-for-tests');
const key = (...parts: string[]) => `t/${TENANT}/${parts.join('/')}`;

describe('the path of a key', () => {
  it('maps a key to a file under the root, one folder per segment', () => {
    const path = dataPathOf(ROOT, key('docs', 'a1'));

    expect(path).toBe(join(ROOT, 't', TENANT, 'docs', 'a1.obj'));
    expect(relative(ROOT, path).startsWith('..')).toBe(false);
    expect(isAbsolute(relative(ROOT, path))).toBe(false);
  });

  it('keeps the content type beside the object, under a name no object can have', () => {
    expect(metaPathOf(ROOT, key('docs', 'a1'))).toBe(join(ROOT, 't', TENANT, 'docs', 'a1.meta'));
    // An object called "a1.meta" is a different file from the content type of "a1".
    expect(dataPathOf(ROOT, key('docs', 'a1.meta'))).not.toBe(metaPathOf(ROOT, key('docs', 'a1')));
  });

  it.each([
    ['a parent segment', key('docs', '..', '..', 'x')],
    ['a parent segment at the end', key('docs', '..')],
    ['a current-directory segment', key('docs', '.', 'x')],
    ['an empty segment', key('docs', '', 'x')],
    ['a trailing slash', `${key('docs', 'x')}/`],
    ['a leading slash', `/${key('docs', 'x')}`],
    ['an absolute posix path', '/etc/passwd'],
    ['an absolute path after the prefix', key('/etc/passwd')],
    ['a drive letter', 'C:/Windows/system.ini'],
    ['a drive letter after the prefix', key('C:', 'Windows')],
    ['a drive letter glued to a name', key('docs', 'C:evil')],
    ['a backslash', key('docs', '..\\..\\evil')],
    ['a backslash path', `t\\${TENANT}\\docs\\x`],
    ['a UNC path', `//server/share/${key('x')}`],
    ['an alternate data stream', key('docs', 'x:stream')],
    ['a wildcard', key('docs', 'x*')],
    ['a question mark', key('docs', 'x?')],
    ['a reserved device name', key('docs', 'CON')],
    ['a reserved device name with an extension', key('docs', 'nul.txt')],
    ['a trailing dot', key('docs', 'x.')],
    ['a trailing space', key('docs', 'x ')],
    ['a NUL byte', key('docs', 'x\u0000y')],
    ['a control character', key('docs', 'x\ny')],
    ['no tenant prefix', 'docs/a1'],
    ['a tenant that is not a UUID', 't/not-a-uuid/docs/a1'],
    ['nothing after the tenant', `t/${TENANT}`],
    ['nothing after the tenant and a slash', `t/${TENANT}/`],
    ['the empty key', ''],
  ])('refuses a key with %s', (_name, bad) => {
    expect(() => dataPathOf(ROOT, bad)).toThrow(StorageKeyError);
    expect(() => metaPathOf(ROOT, bad)).toThrow(StorageKeyError);
  });

  it('never leaves the root, whatever the key is made of', () => {
    const attempts = [
      key('a', '%2e%2e', 'x'),
      key('a', '..%2fx'),
      key('a', '....', 'x'),
      key('a', ' ..'),
      key('a', '.. '),
    ];
    for (const attempt of attempts) {
      let path: string | undefined;
      try {
        path = dataPathOf(ROOT, attempt);
      } catch (error) {
        expect(error).toBeInstanceOf(StorageKeyError);
      }
      if (path !== undefined) {
        expect(relative(ROOT, path).startsWith('..')).toBe(false);
      }
    }
  });

  it('refuses a key that is too long', () => {
    expect(() => dataPathOf(ROOT, key('x'.repeat(2000)))).toThrow(StorageKeyError);
  });
});
