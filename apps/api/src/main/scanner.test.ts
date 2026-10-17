import { describe, expect, it } from 'vitest';

import { startFakeClamd } from '../adapters/clamav/fake-clamd-server.js';
import { EICAR } from '../platform/files/test-files.js';
import { ScannerUnavailableError } from '../platform/scanning/malware-scanner.js';

import { createConfiguredScanner } from './scanner.js';

describe('createConfiguredScanner', () => {
  it('uses the fake scanner when no ClamAV is configured, and says so', async () => {
    const configured = createConfiguredScanner(undefined);

    expect(configured.kind).toBe('fake');
    expect((await configured.scanner.scan(Buffer.from(EICAR))).status).toBe('infected');
    expect((await configured.scanner.scan(Buffer.from('un informe'))).status).toBe('clean');
  });

  it('talks to clamd when it is configured', async () => {
    const clamd = await startFakeClamd();
    try {
      const configured = createConfiguredScanner({ host: '127.0.0.1', port: clamd.port });

      expect(configured.kind).toBe('clamav');
      expect(await configured.scanner.scan(Buffer.from(EICAR))).toEqual({
        status: 'infected',
        signature: 'Eicar-Test-Signature',
      });
      expect(clamd.received).toHaveLength(1);
    } finally {
      await clamd.close();
    }
  });

  it('fails closed when the configured clamd is not there, instead of falling back to the fake', async () => {
    const clamd = await startFakeClamd();
    const port = clamd.port;
    await clamd.close();
    const configured = createConfiguredScanner({ host: '127.0.0.1', port });

    await expect(configured.scanner.scan(Buffer.from('hola'))).rejects.toBeInstanceOf(
      ScannerUnavailableError,
    );
  });
});
