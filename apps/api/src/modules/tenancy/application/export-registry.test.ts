import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { registerAllExportContributors } from '../../../main/export-contributors.js';

import { createExportRegistry } from './export-registry.js';

const MODULES_DIR = fileURLToPath(new URL('../../', import.meta.url));

describe('export registry', () => {
  it('records contributors by kind and name', () => {
    const registry = createExportRegistry();
    const administrative = () => Promise.resolve({ rows: 1 });
    const clinical = () => Promise.resolve({ rows: 2 });

    registry.registerExportContributor('administrative', 'billing', administrative);
    registry.registerExportContributor('clinical', 'clinical', clinical);

    expect(registry.list()).toEqual([
      { kind: 'administrative', name: 'billing', contribute: administrative },
      { kind: 'clinical', name: 'clinical', contribute: clinical },
    ]);
    expect(registry.list('clinical').map((entry) => entry.name)).toEqual(['clinical']);
    expect(registry.list('administrative').map((entry) => entry.name)).toEqual(['billing']);
  });

  it('refuses to register the same contributor twice', () => {
    const registry = createExportRegistry();
    registry.registerExportContributor('administrative', 'tenancy', () => Promise.resolve({}));

    expect(() => {
      registry.registerExportContributor('administrative', 'tenancy', () => Promise.resolve({}));
    }).toThrow(/already registered/);
    // The same name under the other kind is a different contributor.
    expect(() => {
      registry.registerExportContributor('clinical', 'tenancy', () => Promise.resolve({}));
    }).not.toThrow();
  });
});

describe('every module registers an export contributor (hook for the cancellation export)', () => {
  const modules = readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  it('finds the modules to check (the guard is not silently empty)', () => {
    expect(modules).toContain('tenancy');
  });

  it.each(modules)('module %s has at least one registered contributor', (moduleName) => {
    const registry = createExportRegistry();

    registerAllExportContributors(registry);

    const names = registry.list().map((entry) => entry.name);
    expect(names, `module "${moduleName}" must register an export contributor`).toContain(
      moduleName,
    );
  });
});
