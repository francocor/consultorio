import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { healthProof, probeApiHealth } from './health-probe.js';
import { findFreePort } from './ports.js';

const SECRET = 'run-secret-0123456789-abcdefghijklmnopqrstuvwxyz';

let server: Server | undefined;

afterEach(async () => {
  const closing = server;
  server = undefined;
  if (closing) {
    closing.closeAllConnections();
    await new Promise((resolve) => closing.close(resolve));
  }
});

/** A program on a loopback port that answers `/health` the way `answer` says. */
async function listen(
  answer: (nonce: string | undefined, headers: Record<string, unknown>) => Record<string, string>,
  status = 200,
): Promise<number> {
  const port = await findFreePort();
  server = createServer((request, response) => {
    const nonce = request.headers['x-consulvia-nonce'];
    response.writeHead(status, {
      'content-type': 'application/json',
      ...answer(typeof nonce === 'string' ? nonce : undefined, request.headers),
    });
    response.end('{"status":"ok"}');
  });
  await new Promise<void>((resolve) => server?.listen(port, '127.0.0.1', resolve));
  return port;
}

describe('knowing that the program on the API port is our API', () => {
  it('is true when the program proves it holds the secret of the run', async () => {
    const port = await listen((nonce) => ({
      'x-consulvia-proof': healthProof(SECRET, nonce ?? ''),
    }));

    expect(await probeApiHealth(port, SECRET)).toBe(true);
  });

  it('is false for a program that answers 200 without a proof: an impostor that took the port', async () => {
    const port = await listen(() => ({}));

    expect(await probeApiHealth(port, SECRET)).toBe(false);
  });

  it('is false for a proof made with another secret, or for another nonce (a replay)', async () => {
    const wrongSecret = await listen((nonce) => ({
      'x-consulvia-proof': healthProof(`${SECRET}x`, nonce ?? ''),
    }));
    expect(await probeApiHealth(wrongSecret, SECRET)).toBe(false);

    await new Promise((resolve) => server?.close(resolve));
    server = undefined;
    const replay = await listen(() => ({
      'x-consulvia-proof': healthProof(SECRET, 'a-nonce-the-shell-did-not-send'),
    }));
    expect(await probeApiHealth(replay, SECRET)).toBe(false);
  });

  it('never sends the secret itself, and uses a new nonce every time', async () => {
    const nonces: string[] = [];
    const port = await listen((nonce, headers) => {
      nonces.push(nonce ?? '');
      expect(JSON.stringify(headers)).not.toContain(SECRET);
      return { 'x-consulvia-proof': healthProof(SECRET, nonce ?? '') };
    });

    await probeApiHealth(port, SECRET);
    await probeApiHealth(port, SECRET);

    expect(nonces).toHaveLength(2);
    expect(nonces[0]).not.toBe(nonces[1]);
    expect(nonces[0]).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  });

  it('is false when the answer is not a 200, or when nothing listens', async () => {
    const port = await listen(
      (nonce) => ({ 'x-consulvia-proof': healthProof(SECRET, nonce ?? '') }),
      503,
    );
    expect(await probeApiHealth(port, SECRET)).toBe(false);

    await new Promise((resolve) => server?.close(resolve));
    server = undefined;
    expect(await probeApiHealth(await findFreePort(), SECRET)).toBe(false);
  });
});
