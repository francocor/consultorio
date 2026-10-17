import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createRangeCheck } from './breached-passwords.js';

const sha1 = (value: string) => createHash('sha1').update(value).digest('hex').toUpperCase();

function fakeFetch(body: (prefix: string) => string, requested: string[]) {
  return (url: string | URL | Request): Promise<Response> => {
    const text = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    requested.push(text);
    const prefix = text.slice(text.lastIndexOf('/') + 1);
    return Promise.resolve(new Response(body(prefix), { status: 200 }));
  };
}

describe('breached password range check', () => {
  it('asks the provider for the first five characters of the hash only, never the password', async () => {
    const requested: string[] = [];
    const hash = sha1('hunter2-hunter2');
    const check = createRangeCheck({
      fetch: fakeFetch(
        () => `${hash.slice(5)}:52\r\n0123456789ABCDEF0123456789ABCDEF012:3`,
        requested,
      ),
    });

    expect(await check.isBreached('hunter2-hunter2')).toBe(true);

    expect(requested).toEqual([`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`]);
    expect(requested[0]).not.toContain(hash.slice(5));
    expect(requested[0]).not.toContain('hunter2');
  });

  it('is not breached when the suffix is absent or only present as padding with count zero', async () => {
    const hash = sha1('a-rather-unusual-passphrase');
    const absent = createRangeCheck({
      fetch: fakeFetch(() => '0123456789ABCDEF0123456789ABCDEF012:3', []),
    });
    const padded = createRangeCheck({ fetch: fakeFetch(() => `${hash.slice(5)}:0`, []) });

    expect(await absent.isBreached('a-rather-unusual-passphrase')).toBe(false);
    expect(await padded.isBreached('a-rather-unusual-passphrase')).toBe(false);
  });

  it('does not block anyone when the provider is down: the check is an optional extra', async () => {
    const down = createRangeCheck({ fetch: () => Promise.reject(new Error('network')) });
    const failing = createRangeCheck({
      fetch: () => Promise.resolve(new Response('', { status: 503 })),
    });

    expect(await down.isBreached('whatever-password')).toBe(false);
    expect(await failing.isBreached('whatever-password')).toBe(false);
  });
});
