import { createServer } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { startMetricsListener } from './metrics-listener.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => {
    probe.close(() => {
      resolve();
    });
  });
  return port;
}

describe('the metrics listener of a process', () => {
  it('listens where the configuration says and answers with the registry of the process', async () => {
    const port = await freePort();
    const messages: string[] = [];

    const close = await startMetricsListener(
      { host: '127.0.0.1', port },
      {
        render: () => 'up 1\n',
        log: { info: (message) => messages.push(message), warn: () => undefined },
      },
    );
    closers.push(close);

    const response = await fetch(`http://127.0.0.1:${String(port)}/metrics`);
    expect(await response.text()).toBe('up 1\n');
    expect(messages.join(' ')).toContain(String(port));
  });

  it('does nothing without configuration: nothing listens by default', async () => {
    const close = await startMetricsListener(undefined, {
      render: () => 'up 1\n',
      log: { info: () => undefined, warn: () => undefined },
    });

    await expect(close()).resolves.toBeUndefined();
  });

  it('goes on without metrics, and says so, when the port is taken (two processes of one machine)', async () => {
    const port = await freePort();
    const log = { info: () => undefined, warn: (message: string) => warnings.push(message) };
    const warnings: string[] = [];
    closers.push(
      await startMetricsListener({ host: '127.0.0.1', port }, { render: () => 'a\n', log }),
    );

    const second = await startMetricsListener(
      { host: '127.0.0.1', port },
      { render: () => 'b\n', log },
    );

    expect(warnings.join(' ')).toMatch(/METRICS_PORT/);
    expect(warnings.join(' ')).toContain(String(port));
    await expect(second()).resolves.toBeUndefined();
    expect(await (await fetch(`http://127.0.0.1:${String(port)}/metrics`)).text()).toBe('a\n');
  });
});
