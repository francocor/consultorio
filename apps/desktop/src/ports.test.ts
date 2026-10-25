import { createServer } from 'node:net';

import { describe, expect, it } from 'vitest';

import { chooseServerPort, findFreePort, isPortFree, PREFERRED_PORT } from './ports.js';

describe('ports', () => {
  it('finds a free loopback port and sees a taken one', async () => {
    const port = await findFreePort();
    expect(await isPortFree(port)).toBe(true);

    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(port, '127.0.0.1', resolve));
    try {
      expect(await isPortFree(port)).toBe(false);
    } finally {
      await new Promise((resolve) => taken.close(resolve));
    }
  });

  describe('the port of the local server', () => {
    const never = () => Promise.reject(new Error('no free port needed'));

    it('is 47800 on the first run', async () => {
      expect(await chooseServerPort(null, () => Promise.resolve(true), never)).toBe(PREFERRED_PORT);
      expect(PREFERRED_PORT).toBe(47800);
    });

    it('is a free one on the first run when 47800 is taken', async () => {
      const port = await chooseServerPort(
        null,
        (candidate) => Promise.resolve(candidate !== 47800),
        () => Promise.resolve(51234),
      );

      expect(port).toBe(51234);
    });

    it('stays the stored port while it is free, so PUBLIC_URL never changes', async () => {
      expect(await chooseServerPort(51234, () => Promise.resolve(true), never)).toBe(51234);
    });

    it('moves to a free port only when the stored one is taken by something else', async () => {
      const port = await chooseServerPort(
        51234,
        () => Promise.resolve(false),
        () => Promise.resolve(52000),
      );

      expect(port).toBe(52000);
    });
  });
});
