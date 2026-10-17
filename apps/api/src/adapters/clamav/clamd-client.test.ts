import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { Readable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EICAR } from '../../platform/files/test-files.js';
import { ScannerUnavailableError } from '../../platform/scanning/malware-scanner.js';

import { createClamdScanner } from './clamd-client.js';
import { startFakeClamd, type FakeClamd } from './fake-clamd-server.js';

let clamd: FakeClamd;

beforeAll(async () => {
  clamd = await startFakeClamd();
});

afterAll(async () => {
  await clamd.close();
});

const scannerFor = (
  port: number,
  overrides: Partial<Parameters<typeof createClamdScanner>[0]> = {},
) =>
  createClamdScanner({
    host: '127.0.0.1',
    port,
    connectTimeoutMs: 500,
    idleTimeoutMs: 300,
    chunkBytes: 16 * 1024,
    ...overrides,
  });

describe('the clamd client (INSTREAM over TCP)', () => {
  it('sends the content in bounded chunks and reports a clean file', async () => {
    clamd.setBehavior('scan');
    const before = clamd.received.length;
    const content = randomBytes(100_000);

    const verdict = await scannerFor(clamd.port).scan(content);

    expect(verdict).toEqual({ status: 'clean' });
    const received = clamd.received.at(-1);
    expect(clamd.received.length).toBe(before + 1);
    expect(received?.length).toBe(content.length);
    expect(
      createHash('sha256')
        .update(received ?? Buffer.alloc(0))
        .digest('hex'),
    ).toBe(createHash('sha256').update(content).digest('hex'));
    expect(Math.max(...clamd.chunkSizes.slice(-7))).toBeLessThanOrEqual(16 * 1024);
  });

  it('reports the signature of an infected file (the EICAR test string)', async () => {
    clamd.setBehavior('scan');

    const verdict = await scannerFor(clamd.port).scan(Buffer.from(`prefijo ${EICAR} sufijo`));

    expect(verdict).toEqual({ status: 'infected', signature: 'Eicar-Test-Signature' });
  });

  it('streams a source it cannot hold at once, and delivers every byte', async () => {
    clamd.setBehavior('scan');
    const parts = Array.from({ length: 40 }, () => randomBytes(50_000));
    const expected = createHash('sha256').update(Buffer.concat(parts)).digest('hex');

    const verdict = await scannerFor(clamd.port).scan(Readable.from(parts));

    expect(verdict.status).toBe('clean');
    const received = clamd.received.at(-1) ?? Buffer.alloc(0);
    expect(createHash('sha256').update(received).digest('hex')).toBe(expected);
    expect(received.length).toBe(2_000_000);
  });

  it('scans an empty file without sending a data chunk', async () => {
    clamd.setBehavior('scan');
    const sizesBefore = clamd.chunkSizes.length;

    const verdict = await scannerFor(clamd.port).scan(Buffer.alloc(0));

    expect(verdict).toEqual({ status: 'clean' });
    expect(clamd.chunkSizes.length).toBe(sizesBefore);
  });
});

describe('the clamd client fails closed: no verdict means unavailable, never clean', () => {
  it('is unavailable when nothing listens on the port', async () => {
    const free = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        const port = typeof address === 'object' && address !== null ? address.port : 0;
        probe.close(() => {
          resolve(port);
        });
      });
    });

    await expect(scannerFor(free).scan(Buffer.from('hola'))).rejects.toBeInstanceOf(
      ScannerUnavailableError,
    );
  });

  it('is unavailable when the scanner never answers (idle timeout)', async () => {
    clamd.setBehavior('silent');
    const started = Date.now();

    await expect(scannerFor(clamd.port).scan(Buffer.from('hola'))).rejects.toBeInstanceOf(
      ScannerUnavailableError,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    clamd.setBehavior('scan');
  });

  it('is unavailable when the scanner answers with an error, such as a size limit', async () => {
    clamd.setBehavior('error');

    await expect(scannerFor(clamd.port).scan(Buffer.from('hola'))).rejects.toBeInstanceOf(
      ScannerUnavailableError,
    );
    clamd.setBehavior('scan');
  });

  it('is unavailable when the connection drops in the middle of the content', async () => {
    clamd.setBehavior('hangup');

    await expect(
      scannerFor(clamd.port).scan(Readable.from([randomBytes(60_000), randomBytes(60_000)])),
    ).rejects.toBeInstanceOf(ScannerUnavailableError);
    clamd.setBehavior('scan');
  });

  it('is unavailable when the source of the content fails halfway', async () => {
    clamd.setBehavior('scan');
    async function* broken() {
      await Promise.resolve();
      yield randomBytes(1000);
      throw new Error('disk error');
    }

    await expect(scannerFor(clamd.port).scan(Readable.from(broken()))).rejects.toBeInstanceOf(
      ScannerUnavailableError,
    );
  });

  it('never leaks the content into the error', async () => {
    clamd.setBehavior('error');
    const secret = 'DATO-CLINICO-RESERVADO';

    const failure = await scannerFor(clamd.port)
      .scan(Buffer.from(secret))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ScannerUnavailableError);
    expect((failure as Error).message).not.toContain(secret);
    clamd.setBehavior('scan');
  });
});
