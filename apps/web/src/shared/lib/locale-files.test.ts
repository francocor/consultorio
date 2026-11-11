import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LOCALE_RESOURCES } from './locale-all.js';
import { CORE_RESOURCES } from './locale-core.js';
import { buildResources, mergeResources, namespaceOfFile } from './locale-files.js';
import { REST_RESOURCES } from './locale-rest.js';

describe('the namespace of a catalog file', () => {
  it('is the name of the file', () => {
    expect(namespaceOfFile('../../locales/es-AR/messaging.json')).toBe('messaging');
    expect(namespaceOfFile('../locales/es-AR/common.json')).toBe('common');
  });

  it('is "errors" for the error catalog of a module, errors.<module>.json', () => {
    expect(namespaceOfFile('../../locales/es-AR/errors.json')).toBe('errors');
    expect(namespaceOfFile('../../locales/es-AR/errors.notifications.json')).toBe('errors');
    expect(namespaceOfFile('../../locales/es-AR/errors.online-booking.json')).toBe('errors');
  });
});

describe('building the resources from the catalog files', () => {
  it('gives each file its namespace and joins the error catalogs of the modules into "errors"', () => {
    const resources = buildResources({
      '../locales/es-AR/errors.json': { forbidden: 'Sin acceso' },
      '../locales/es-AR/errors.waitlist.json': { 'waitlist.entry_exists': 'Ya está en la lista' },
      '../locales/es-AR/errors.notifications.json': { 'notifications.not_found': 'No existe' },
      '../locales/es-AR/waitlist.json': { title: 'Lista de espera' },
    });

    expect(Object.keys(resources).sort()).toEqual(['errors', 'waitlist']);
    expect(resources['errors']).toEqual({
      forbidden: 'Sin acceso',
      'waitlist.entry_exists': 'Ya está en la lista',
      'notifications.not_found': 'No existe',
    });
    expect(resources['waitlist']).toEqual({ title: 'Lista de espera' });
  });

  it('refuses a key that two files both give to one namespace: one translation would hide the other', () => {
    expect(() =>
      buildResources({
        '../locales/es-AR/errors.json': { shared: 'a' },
        '../locales/es-AR/errors.waitlist.json': { shared: 'b' },
      }),
    ).toThrow(/shared/);
  });

  it('finds the real catalog files: the namespaces the application already had are all there', () => {
    expect(Object.keys(LOCALE_RESOURCES)).toEqual(
      expect.arrayContaining(['audit', 'auth', 'clinical', 'common', 'errors', 'shell', 'staff']),
    );
    expect(LOCALE_RESOURCES['common']?.['pagination.results_one']).toBeDefined();
  });

  it('words the reuse of a submission key for payments AND invoices, not for payments alone (JD-S4 R2-B-S3)', () => {
    const message = LOCALE_RESOURCES['errors']?.['idempotency_key_reused'];

    expect(message).toMatch(/factura/);
    expect(message).toMatch(/pago/);
  });
});

describe('joining resources that were built apart', () => {
  it('puts the files of one namespace together, whichever part they came in', () => {
    const merged = mergeResources(
      { errors: { forbidden: 'Sin acceso' }, common: { ok: 'Aceptar' } },
      { errors: { 'waitlist.entry_exists': 'Ya está en la lista' }, waitlist: { title: 'Lista' } },
    );

    expect(merged).toEqual({
      errors: { forbidden: 'Sin acceso', 'waitlist.entry_exists': 'Ya está en la lista' },
      common: { ok: 'Aceptar' },
      waitlist: { title: 'Lista' },
    });
  });

  it('refuses a key that both parts give to one namespace', () => {
    expect(() => mergeResources({ errors: { shared: 'a' } }, { errors: { shared: 'b' } })).toThrow(
      /shared/,
    );
  });
});

describe('the two parts of the catalog (the sign-in page carries only the first)', () => {
  const folder = resolve(import.meta.dirname, '../../locales/es-AR');
  const names = readdirSync(folder).filter((name) => name.endsWith('.json'));
  const read = (name: string) =>
    JSON.parse(readFileSync(resolve(folder, name), 'utf8')) as Record<string, string>;

  it('are the whole folder between them: no file is left out and none is counted twice', () => {
    const everything = buildResources(
      Object.fromEntries(names.map((name) => [`../../locales/es-AR/${name}`, read(name)])),
    );

    expect(mergeResources(CORE_RESOURCES, REST_RESOURCES)).toEqual(everything);
  });

  it('keep to the first bundle only what the sign-in page and the frame of every screen show', () => {
    expect(Object.keys(CORE_RESOURCES).sort()).toEqual(['auth', 'common', 'errors', 'shell']);
    expect(CORE_RESOURCES['errors']).toEqual(read('errors.json'));
  });

  it('leave the catalogs of the features and of the error codes of the modules to the rest', () => {
    const rest = Object.keys(REST_RESOURCES);

    expect(rest).toEqual(expect.arrayContaining(['scheduling', 'patients', 'billing', 'errors']));
    for (const core of ['auth', 'common', 'shell']) expect(rest).not.toContain(core);
    expect(REST_RESOURCES['errors']).not.toHaveProperty('forbidden');
    expect(REST_RESOURCES['errors']).toHaveProperty(
      Object.keys(read('errors.billing.json'))[0] ?? '',
    );
  });
});
