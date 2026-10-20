import { describe, expect, it } from 'vitest';

import { legalErase, parseLegalEraseArguments, type LegalEraseDeps } from './legal-erase.js';

const TENANT = '0190a000-0000-7000-8000-000000000001';
const OTHER = '0190a000-0000-7000-8000-000000000002';
const REFERENCE = 'Oficio 123/2031, Juzgado Civil y Comercial 4, expediente 998/2030';

function fixture(objects: Record<string, number>) {
  const erased: string[] = [];
  const trail: { reason: string; objects: number; versions: number; complete: boolean }[] = [];
  const deps: LegalEraseDeps = {
    eraser: {
      list: (prefix) =>
        Promise.resolve(
          Object.entries(objects)
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, versions]) => ({ key, versions })),
        ),
      erase: (key) => {
        erased.push(key);
        return Promise.resolve({ status: 'erased', versions: objects[key] ?? 0 });
      },
    },
    audit: (entry) => {
      trail.push(entry);
      return Promise.resolve();
    },
  };
  return { deps, erased, trail };
}

describe('the legal erasure procedure', () => {
  it('erases every object of the organization, and writes ONE entry with the legal reference and the counts', async () => {
    const { deps, erased, trail } = fixture({
      [`tenants/${TENANT}/a/000001.enc`]: 1,
      [`tenants/${TENANT}/a/000002.enc`]: 2,
      [`tenants/${OTHER}/a/000001.enc`]: 1,
    });

    const result = await legalErase(deps, { tenantId: TENANT, reference: REFERENCE });

    expect(result).toEqual({ objects: 2, versions: 3 });
    expect(erased).toEqual([`tenants/${TENANT}/a/000001.enc`, `tenants/${TENANT}/a/000002.enc`]);
    expect(trail).toEqual([{ reason: REFERENCE, objects: 2, versions: 3, complete: true }]);
  });

  it('narrows to a folder of the organization, and refuses a prefix that is not inside it', async () => {
    const { deps, erased } = fixture({
      [`tenants/${TENANT}/a/one`]: 1,
      [`tenants/${TENANT}/b/two`]: 1,
    });

    const narrow = await legalErase(deps, {
      tenantId: TENANT,
      reference: REFERENCE,
      prefix: `tenants/${TENANT}/b/`,
    });

    expect(narrow).toEqual({ objects: 1, versions: 1 });
    expect(erased).toEqual([`tenants/${TENANT}/b/two`]);
    for (const prefix of [`tenants/${OTHER}/`, 'tenants/', '', `tenants/${TENANT}`]) {
      await expect(
        legalErase(deps, { tenantId: TENANT, reference: REFERENCE, prefix }),
        prefix,
      ).rejects.toThrow(/inside the archive of the organization/);
    }
  });

  it('refuses to start without a legal reference worth the name, and touches nothing', async () => {
    const { deps, erased, trail } = fixture({ [`tenants/${TENANT}/a`]: 1 });

    for (const reference of ['', '   ', 'x', 'abcd']) {
      await expect(legalErase(deps, { tenantId: TENANT, reference }), reference).rejects.toThrow(
        /legal reference/,
      );
    }

    expect(erased).toEqual([]);
    expect(trail).toEqual([]);
  });

  it('says so when there is nothing to erase, and writes no entry', async () => {
    const { deps, trail } = fixture({});

    const result = await legalErase(deps, { tenantId: TENANT, reference: REFERENCE });

    expect(result).toEqual({ objects: 0, versions: 0 });
    expect(trail).toEqual([]);
  });

  it('records what was erased even when it stops halfway, and then fails', async () => {
    const { deps, trail } = fixture({
      [`tenants/${TENANT}/a/1`]: 1,
      [`tenants/${TENANT}/a/2`]: 1,
    });
    let calls = 0;
    const failing: LegalEraseDeps = {
      ...deps,
      eraser: {
        ...deps.eraser,
        erase: (key) => {
          calls += 1;
          if (calls === 2) return Promise.reject(new Error('the store went away'));
          return deps.eraser.erase(key, { reference: REFERENCE });
        },
      },
    };

    await expect(legalErase(failing, { tenantId: TENANT, reference: REFERENCE })).rejects.toThrow(
      'the store went away',
    );

    expect(trail).toEqual([{ reason: REFERENCE, objects: 1, versions: 1, complete: false }]);
  });
});

describe('the arguments of pnpm archive:legal-erase', () => {
  it('reads the reference, the organization and an optional prefix', () => {
    expect(
      parseLegalEraseArguments(['--reference', REFERENCE, '--tenant', TENANT, '--yes']),
    ).toEqual({ reference: REFERENCE, tenantId: TENANT, confirmed: true });
    expect(
      parseLegalEraseArguments([
        '--tenant',
        TENANT,
        '--reference',
        REFERENCE,
        '--prefix',
        `tenants/${TENANT}/x/`,
      ]),
    ).toEqual({
      reference: REFERENCE,
      tenantId: TENANT,
      prefix: `tenants/${TENANT}/x/`,
      confirmed: false,
    });
  });

  it('refuses a call without a reference or without an organization, and an unknown flag', () => {
    expect(() => parseLegalEraseArguments(['--tenant', TENANT])).toThrow(/--reference/);
    expect(() => parseLegalEraseArguments(['--reference', REFERENCE])).toThrow(/--tenant/);
    expect(() =>
      parseLegalEraseArguments(['--reference', REFERENCE, '--tenant', 'not-a-uuid']),
    ).toThrow(/--tenant/);
    expect(() =>
      parseLegalEraseArguments(['--reference', REFERENCE, '--tenant', TENANT, '--force']),
    ).toThrow(/--force/);
  });
});
