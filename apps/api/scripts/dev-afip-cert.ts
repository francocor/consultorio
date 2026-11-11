import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateDevCertificate } from '../src/testing/dev-afip-certificate.js';

/**
 * `pnpm dev:afip-cert <CUIT>` makes a self-signed certificate and its private key for LOCAL
 * development: upload them in Settings > Facturacion to try the credential flow against the AFIP
 * simulator. The files are `.pem`, which git ignores. The certificate says "DEV ONLY" in its subject
 * and AFIP would never accept it; it is not a way to reach the real service.
 *
 *   pnpm dev:afip-cert 20-12345678-6 [--days 365] [--age-days 0] [--out .dev-afip] [--ec]
 *
 * `--age-days` makes a certificate that started that many days ago, to see the "expiring" warning
 * (`--days 365 --age-days 345` leaves 20 days). `--ec` uses a P-256 key instead of RSA 2048.
 */

export interface DevCertArgs {
  cuit: string;
  validDays: number;
  ageDays: number;
  out: string;
  algorithm: 'rsa' | 'ec';
}

export function parseDevCertArgs(args: readonly string[]): DevCertArgs {
  const [first, ...rest] = args;
  const cuit = first?.replaceAll(/\D/g, '') ?? '';
  if (!/^\d{11}$/.test(cuit)) {
    throw new Error(
      'Usage: dev:afip-cert <CUIT, 11 digits> [--days N] [--age-days N] [--out DIR] [--ec]',
    );
  }
  const parsed: DevCertArgs = {
    cuit,
    validDays: 365,
    ageDays: 0,
    out: '.dev-afip',
    algorithm: 'rsa',
  };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (flag === '--ec') {
      parsed.algorithm = 'ec';
    } else if (flag === '--days' || flag === '--age-days') {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 0) {
        throw new Error(`${flag} needs a whole number of days.`);
      }
      if (flag === '--days') parsed.validDays = number;
      else parsed.ageDays = number;
      index += 1;
    } else if (flag === '--out' && value) {
      parsed.out = value;
      index += 1;
    } else {
      throw new Error(`Unknown option ${flag ?? ''}.`);
    }
  }
  return parsed;
}

export interface WrittenCertificate {
  certificatePath: string;
  keyPath: string;
  notBefore: Date;
  notAfter: Date;
}

export function writeDevCertificate(args: DevCertArgs, now: Date = new Date()): WrittenCertificate {
  const made = generateDevCertificate({
    cuit: args.cuit,
    now,
    validDays: args.validDays,
    ageDays: args.ageDays,
    algorithm: args.algorithm,
  });
  const directory = resolve(args.out);
  mkdirSync(directory, { recursive: true });
  const certificatePath = join(directory, `${args.cuit}-dev.crt.pem`);
  const keyPath = join(directory, `${args.cuit}-dev.key.pem`);
  writeFileSync(certificatePath, made.certificate);
  // The key is readable by its owner only.
  writeFileSync(keyPath, made.privateKey, { mode: 0o600 });
  return { certificatePath, keyPath, notBefore: made.notBefore, notAfter: made.notAfter };
}

function main(): void {
  if (process.env['NODE_ENV'] === 'production') {
    process.stderr.write('This helper never runs in production.\n');
    process.exit(2);
  }
  try {
    const written = writeDevCertificate(parseDevCertArgs(process.argv.slice(2)));
    process.stdout.write(
      [
        'Development certificate written (DEV ONLY, not accepted by AFIP):',
        `  certificate  ${written.certificatePath}`,
        `  private key  ${written.keyPath}`,
        `  valid until  ${written.notAfter.toISOString()}`,
        'Upload both in Settings > Facturacion, after saving the fiscal profile with the same CUIT.',
        '',
      ].join('\n'),
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Could not write the certificate.'}\n`,
    );
    process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
