import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SCHEMA = fileURLToPath(new URL('../../src/db/schema/', import.meta.url));

/**
 * drizzle-kit reads `schema/index.ts`: a table file that the index does not re-export never gets a
 * migration. Every file of the folder is exported there, so a track fills in its own file and
 * edits nothing shared.
 */
describe('the schema index', () => {
  const files = readdirSync(SCHEMA)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => name.replace(/\.ts$/, ''))
    .filter((name) => name !== 'index' && !name.startsWith('_'));
  const index = readFileSync(join(SCHEMA, 'index.ts'), 'utf8');

  it('finds the schema files (the guard is not silently empty)', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files)('re-exports %s', (name) => {
    expect(index).toContain(`export * from './${name}.js';`);
  });

  it('has a file for each table family the Stage 3 tracks add, already exported', () => {
    for (const name of [
      'notifications',
      'channel-preference',
      'usage-event',
      'online-booking',
      'booking-submission',
      'waitlist',
      'teleconsultation',
    ]) {
      expect(files, name).toContain(name);
    }
  });

  it('has a file for each table family the Stage 4 tracks add, already exported', () => {
    for (const name of [
      'billing-pricing',
      'billing-charges',
      'billing-payments',
      'invoicing-config',
      'invoicing',
      'local-afip',
    ]) {
      expect(files, name).toContain(name);
    }
  });
});
