import { describe, expect, it } from 'vitest';

import { buildResources, namespaceOfFile, LOCALE_RESOURCES } from './locale-files.js';

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
});
