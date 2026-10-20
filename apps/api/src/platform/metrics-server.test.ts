import { afterEach, describe, expect, it } from 'vitest';

import { createMetricsServer, type MetricsServer } from './metrics-server.js';

const TOKEN = 'metrics-token-0123456789-abcdefghijklmnop';

let server: MetricsServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(options: { token?: string; render?: () => string | Promise<string> } = {}) {
  server = createMetricsServer({
    host: '127.0.0.1',
    port: 0,
    render: options.render ?? (() => 'up 1\n'),
    ...(options.token === undefined ? {} : { token: options.token }),
  });
  const { port } = await server.listen();
  return `http://127.0.0.1:${String(port)}`;
}

describe('the metrics server', () => {
  it('answers the exposition on /metrics, as plain text that is never cached', async () => {
    const base = await start({ render: () => 'queue_jobs{queue="a"} 3\n' });

    const response = await fetch(`${base}/metrics`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('queue_jobs{queue="a"} 3\n');
  });

  it('renders again for every request (the numbers are the ones of now)', async () => {
    let calls = 0;
    const base = await start({ render: () => `calls ${String(++calls)}\n` });

    const first = await (await fetch(`${base}/metrics`)).text();
    const second = await (await fetch(`${base}/metrics`)).text();

    expect([first, second]).toEqual(['calls 1\n', 'calls 2\n']);
  });

  it('knows nothing else: another path is 404 and another method is 405', async () => {
    const base = await start();

    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/metrics/extra`)).status).toBe(404);
    const post = await fetch(`${base}/metrics`, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET');
  });

  it('asks for the token when it has one, and answers nothing without it', async () => {
    const calls: string[] = [];
    const base = await start({
      token: TOKEN,
      render: () => {
        calls.push('rendered');
        return 'secret_count 1\n';
      },
    });

    const none = await fetch(`${base}/metrics`);
    const wrong = await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer nope' } });
    const basic = await fetch(`${base}/metrics`, { headers: { authorization: `Basic ${TOKEN}` } });
    const right = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } });

    expect([none.status, wrong.status, basic.status, right.status]).toEqual([401, 401, 401, 200]);
    expect(none.headers.get('www-authenticate')).toBe('Bearer');
    expect(await none.text()).toBe('');
    expect(await right.text()).toBe('secret_count 1\n');
    // The numbers were measured only for the request that was allowed.
    expect(calls).toEqual(['rendered']);
  });

  it('says only that it failed when the numbers cannot be rendered', async () => {
    const base = await start({
      render: () => {
        throw new Error('select * from patient where ... failed');
      },
    });

    const response = await fetch(`${base}/metrics`);

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('patient');
  });
});
