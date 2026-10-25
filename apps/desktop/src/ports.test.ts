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

    const noWait = { sleep: () => Promise.resolve() };

    it('moves to a free port only when the stored one stays taken by something else', async () => {
      const port = await chooseServerPort(
        51234,
        () => Promise.resolve(false),
        () => Promise.resolve(52000),
        noWait,
      );

      expect(port).toBe(52000);
    });

    it('tries the stored port again before it moves: a port in TIME_WAIT or held for a moment frees itself', async () => {
      const answers = [false, false, true];
      let waits = 0;

      const port = await chooseServerPort(
        51234,
        () => Promise.resolve(answers.shift() ?? false),
        never,
        {
          attempts: 5,
          sleep: () => {
            waits += 1;
            return Promise.resolve();
          },
        },
      );

      expect(port).toBe(51234);
      expect(waits).toBe(2);
    });

    it('gives up after the attempts it was allowed, and no more', async () => {
      let asked = 0;

      await chooseServerPort(
        51234,
        () => {
          asked += 1;
          return Promise.resolve(false);
        },
        () => Promise.resolve(52000),
        { attempts: 4, sleep: () => Promise.resolve() },
      );

      expect(asked).toBe(4);
    });
  });
});
