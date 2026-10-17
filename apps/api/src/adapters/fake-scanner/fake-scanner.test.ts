import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { EICAR } from '../../platform/files/test-files.js';
import { ScannerUnavailableError } from '../../platform/scanning/malware-scanner.js';

import { createFakeScanner } from './index.js';

describe('the fake scanner (tests and the demo organization)', () => {
  it('flags the EICAR string in a buffer and in a stream, and passes anything else', async () => {
    const scanner = createFakeScanner();

    expect(await scanner.scan(Buffer.from(`%PDF-1.4 ${EICAR}`))).toEqual({
      status: 'infected',
      signature: 'Eicar-Test-Signature',
    });
    expect(
      await scanner.scan(Readable.from([Buffer.from('parte uno '), Buffer.from(EICAR)])),
    ).toEqual({
      status: 'infected',
      signature: 'Eicar-Test-Signature',
    });
    expect(await scanner.scan(Buffer.from('%PDF-1.4 un informe normal'))).toEqual({
      status: 'clean',
    });
  });

  it('finds the string even when a stream splits it across two chunks', async () => {
    const scanner = createFakeScanner();
    const middle = Math.floor(EICAR.length / 2);

    const verdict = await scanner.scan(
      Readable.from([Buffer.from(EICAR.slice(0, middle)), Buffer.from(EICAR.slice(middle))]),
    );

    expect(verdict.status).toBe('infected');
  });

  it('can be taken down, and then fails closed like the real adapter', async () => {
    const scanner = createFakeScanner();
    scanner.setAvailable(false);

    await expect(scanner.scan(Buffer.from('hola'))).rejects.toBeInstanceOf(ScannerUnavailableError);

    scanner.setAvailable(true);
    expect((await scanner.scan(Buffer.from('hola'))).status).toBe('clean');
    expect(scanner.scans()).toBe(1);
  });
});
