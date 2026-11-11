import { X509Certificate, createPrivateKey } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { parseDevCertArgs, writeDevCertificate } from './dev-afip-cert.js';

const directory = mkdtempSync(join(tmpdir(), 'dev-afip-cert-test-'));
afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('dev-afip-cert arguments', () => {
  it('takes the CUIT as the first argument, with its formatting removed', () => {
    expect(parseDevCertArgs(['20-12345678-6'])).toEqual({
      cuit: '20123456786',
      validDays: 365,
      ageDays: 0,
      out: '.dev-afip',
      algorithm: 'rsa',
    });
  });

  it('reads the options that change the certificate and where it goes', () => {
    expect(
      parseDevCertArgs(['30712345671', '--days', '90', '--age-days', '75', '--out', 'x', '--ec']),
    ).toEqual({ cuit: '30712345671', validDays: 90, ageDays: 75, out: 'x', algorithm: 'ec' });
  });

  it.each([
    [[], /CUIT/],
    [['123'], /CUIT/],
    [['20123456786', '--days', 'many'], /--days/],
    [['20123456786', '--wat'], /--wat/],
  ])('refuses %j', (args, message) => {
    expect(() => parseDevCertArgs(args)).toThrow(message);
  });
});

describe('writing a development certificate', () => {
  it('writes the certificate and the key as .pem files that match, and says where', () => {
    const written = writeDevCertificate(
      { cuit: '20123456786', validDays: 365, ageDays: 0, out: directory, algorithm: 'ec' },
      new Date('2026-10-17T12:00:00Z'),
    );

    expect(written.certificatePath).toBe(join(directory, '20123456786-dev.crt.pem'));
    expect(written.keyPath).toBe(join(directory, '20123456786-dev.key.pem'));
    const certificate = new X509Certificate(readFileSync(written.certificatePath));
    const key = createPrivateKey(readFileSync(written.keyPath));
    expect(certificate.checkPrivateKey(key)).toBe(true);
    expect(certificate.subject).toContain('CUIT 20123456786');
    expect(written.notAfter.toISOString()).toBe('2027-10-17T12:00:00.000Z');
  });
});
