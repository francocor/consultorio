import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createClamdScanner } from '../../src/adapters/clamav/clamd-client.js';
import { EICAR } from '../../src/platform/files/test-files.js';
import {
  ScannerUnavailableError,
  type MalwareScanner,
} from '../../src/platform/scanning/malware-scanner.js';

/**
 * The clamd client against a REAL ClamAV, the same image the local environment runs
 * (`infra/docker-compose.yml`, profile `scan`). ClamAV loads about a million signatures before it
 * answers, so starting it takes one to three minutes: this suite is tagged slow and runs only when
 * `SLOW_TESTS=1` (`SLOW_TESTS=1 pnpm test:integration -- clamav`), and in the dedicated CI job.
 */
const SLOW = process.env['SLOW_TESTS'] === '1';
const IMAGE = 'clamav/clamav:1.5.4-debian';

describe.skipIf(!SLOW)('the clamd client against ClamAV (slow)', () => {
  let container: StartedTestContainer;
  let scanner: MalwareScanner;

  beforeAll(async () => {
    container = await new GenericContainer(IMAGE)
      .withExposedPorts(3310)
      .withWaitStrategy(Wait.forLogMessage(/socket found, clamd started/))
      .withStartupTimeout(300_000)
      .start();
    scanner = createClamdScanner({
      host: container.getHost(),
      port: container.getMappedPort(3310),
      idleTimeoutMs: 60_000,
    });
  }, 330_000);

  afterAll(async () => {
    await container.stop();
  });

  it('reports a clean file as clean', async () => {
    const verdict = await scanner.scan(Buffer.from('%PDF-1.4\nun informe de laboratorio\n%%EOF\n'));

    expect(verdict).toEqual({ status: 'clean' });
  });

  it('flags the EICAR test string with the signature name ClamAV gives it', async () => {
    const verdict = await scanner.scan(Buffer.from(EICAR));

    expect(verdict.status).toBe('infected');
    expect(verdict.status === 'infected' && verdict.signature).toMatch(/EICAR/i);
  });

  it('scans a large stream in many chunks without a framing or size error', async () => {
    // The EICAR signature matches the whole file, so it cannot be hidden inside other bytes: this
    // checks that 6 MB sent as 64 KB frames are accepted and judged, here as clean.
    const verdict = await scanner.scan(
      Readable.from([randomBytes(3_000_000), randomBytes(3_000_000)]),
    );

    expect(verdict).toEqual({ status: 'clean' });
  });

  it('fails closed when the scanner stops answering', async () => {
    const stopped = createClamdScanner({
      host: container.getHost(),
      port: container.getMappedPort(3310) + 1,
      connectTimeoutMs: 500,
    });

    await expect(stopped.scan(Buffer.from('hola'))).rejects.toBeInstanceOf(ScannerUnavailableError);
  });
});
