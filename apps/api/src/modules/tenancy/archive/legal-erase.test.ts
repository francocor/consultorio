import { describe, expect, it } from 'vitest';

import {
  legalErase,
  parseLegalEraseArguments,
  type LegalEraseAuditEntry,
  type LegalEraseDeps,
} from './legal-erase.js';

const TENANT = '0190a000-0000-7000-8000-000000000001';
const OTHER = '0190a000-0000-7000-8000-000000000002';
const OPERATOR = '0190a000-0000-7000-8000-0000000000a1';
const APPROVER = '0190a000-0000-7000-8000-0000000000a2';
const REFERENCE = 'Oficio 123/2031, Juzgado Civil y Comercial 4, expediente 998/2030';
const WHO = { operatorId: OPERATOR, approverId: APPROVER };

function fixture(objects: Record<string, number>, options: { known?: readonly string[] } = {}) {
  /** What happened, in order: the trail, the mark in the database and each erased object. */
  const events: string[] = [];
  const erased: string[] = [];
  const trail: LegalEraseAuditEntry[] = [];
  const marked: string[] = [];
  const known = options.known ?? [OPERATOR, APPROVER];
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
        events.push(`erase ${key}`);
        return Promise.resolve({ status: 'erased', versions: objects[key] ?? 0 });
      },
    },
    verifyOperators: (ids) => {
      events.push('verify');
      return ids.every((id) => known.includes(id))
        ? Promise.resolve()
        : Promise.reject(new Error('The operator and the approver must be active operators'));
    },
    markErased: (prefix) => {
      marked.push(prefix);
      events.push('mark');
      return Promise.resolve();
    },
    audit: (entry) => {
      trail.push(entry);
      events.push(`audit ${entry.phase}`);
      return Promise.resolve();
    },
  };
  return { deps, erased, trail, marked, events };
}

describe('the legal erasure procedure', () => {
  it('erases every object of the organization, and writes the intent first and then the outcome, with the legal reference and the counts', async () => {
    const { deps, erased, trail, marked, events } = fixture({
      [`tenants/${TENANT}/a/000001.enc`]: 1,
      [`tenants/${TENANT}/a/000002.enc`]: 2,
      [`tenants/${OTHER}/a/000001.enc`]: 1,
    });

    const result = await legalErase(deps, { tenantId: TENANT, reference: REFERENCE, ...WHO });

    expect(result).toEqual({ objects: 2, versions: 3 });
    expect(erased).toEqual([`tenants/${TENANT}/a/000001.enc`, `tenants/${TENANT}/a/000002.enc`]);
    const common = {
      reason: REFERENCE,
      ...WHO,
      prefix: `tenants/${TENANT}/`,
    };
    expect(trail).toEqual([
      { ...common, phase: 'intent', objects: 2, versions: 0 },
      { ...common, phase: 'done', objects: 2, versions: 3 },
    ]);
    // The trail says what is about to happen BEFORE the first object goes, and the database records
    // the erasure as soon as the first one is gone.
    expect(events).toEqual([
      'verify',
      'audit intent',
      `erase tenants/${TENANT}/a/000001.enc`,
      'mark',
      `erase tenants/${TENANT}/a/000002.enc`,
      'audit done',
    ]);
    expect(marked).toEqual([`tenants/${TENANT}/`]);
  });

  it('narrows to a folder of the organization, and refuses a prefix that is not inside it', async () => {
    const { deps, erased, marked } = fixture({
      [`tenants/${TENANT}/a/one`]: 1,
      [`tenants/${TENANT}/b/two`]: 1,
    });

    const narrow = await legalErase(deps, {
      tenantId: TENANT,
      reference: REFERENCE,
      prefix: `tenants/${TENANT}/b/`,
      ...WHO,
    });

    expect(narrow).toEqual({ objects: 1, versions: 1 });
    expect(erased).toEqual([`tenants/${TENANT}/b/two`]);
    expect(marked).toEqual([`tenants/${TENANT}/b/`]);
    // A folder without its trailing slash would also match its neighbours (`b` and `b-2`).
    await expect(
      legalErase(deps, {
        tenantId: TENANT,
        reference: REFERENCE,
        prefix: `tenants/${TENANT}/b`,
        ...WHO,
      }),
    ).rejects.toThrow(/end with a slash/);
    for (const prefix of [`tenants/${OTHER}/`, 'tenants/', '']) {
      await expect(
        legalErase(deps, { tenantId: TENANT, reference: REFERENCE, prefix, ...WHO }),
        prefix,
      ).rejects.toThrow(/inside the archive of the organization/);
    }
  });

  it('refuses to start without a legal reference worth the name, and touches nothing', async () => {
    const { deps, erased, trail, marked } = fixture({ [`tenants/${TENANT}/a`]: 1 });

    for (const reference of ['', '   ', 'x', 'abcd']) {
      await expect(
        legalErase(deps, { tenantId: TENANT, reference, ...WHO }),
        reference,
      ).rejects.toThrow(/legal reference/);
    }

    expect(erased).toEqual([]);
    expect(trail).toEqual([]);
    expect(marked).toEqual([]);
  });

  it('needs two different, named, active operators, and touches nothing without them (JD-S6 R1-S6-7)', async () => {
    const { deps, erased, trail, marked } = fixture({ [`tenants/${TENANT}/a`]: 1 });
    const input = { tenantId: TENANT, reference: REFERENCE };

    await expect(
      legalErase(deps, { ...input, operatorId: OPERATOR, approverId: OPERATOR }),
    ).rejects.toThrow(/not the one who runs it/);
    await expect(
      legalErase(deps, { ...input, operatorId: 'franco', approverId: APPROVER }),
    ).rejects.toThrow(/operator who runs it/);
    // A stranger's id, or one that is not an active operator, is refused by the console's list.
    await expect(
      legalErase(deps, { ...input, operatorId: OPERATOR, approverId: OTHER }),
    ).rejects.toThrow(/active operators/);

    expect(erased).toEqual([]);
    expect(trail).toEqual([]);
    expect(marked).toEqual([]);
  });

  it('says so when there is nothing to erase, writes no entry, and marks the folder as erased so a crash before the marker is repaired (JD-S6 R2)', async () => {
    const { deps, erased, trail, marked } = fixture({});

    const result = await legalErase(deps, { tenantId: TENANT, reference: REFERENCE, ...WHO });

    expect(result).toEqual({ objects: 0, versions: 0 });
    expect(erased).toEqual([]);
    expect(trail).toEqual([]);
    expect(marked).toEqual([`tenants/${TENANT}/`]);
  });

  it('keeps the intent and records what was erased even when it stops halfway, and then fails', async () => {
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

    await expect(
      legalErase(failing, { tenantId: TENANT, reference: REFERENCE, ...WHO }),
    ).rejects.toThrow('the store went away');

    const phases = (entries: readonly LegalEraseAuditEntry[]) =>
      entries.map((entry) => [entry.phase, entry.objects, entry.versions]);
    expect(phases(trail)).toEqual([
      ['intent', 2, 0],
      ['incomplete', 1, 1],
    ]);
  });
});

describe('the arguments of pnpm archive:legal-erase', () => {
  const people = ['--operator', OPERATOR, '--approver', APPROVER];

  it('reads the reference, the organization, the two operators and an optional prefix', () => {
    expect(
      parseLegalEraseArguments(['--reference', REFERENCE, '--tenant', TENANT, ...people, '--yes']),
    ).toEqual({
      reference: REFERENCE,
      tenantId: TENANT,
      operatorId: OPERATOR,
      approverId: APPROVER,
      confirmed: true,
    });
    expect(
      parseLegalEraseArguments([
        '--tenant',
        TENANT,
        '--reference',
        REFERENCE,
        ...people,
        '--prefix',
        `tenants/${TENANT}/x/`,
      ]),
    ).toEqual({
      reference: REFERENCE,
      tenantId: TENANT,
      operatorId: OPERATOR,
      approverId: APPROVER,
      prefix: `tenants/${TENANT}/x/`,
      confirmed: false,
    });
  });

  it('refuses a call without a reference, an organization or the two operators, and an unknown flag', () => {
    expect(() => parseLegalEraseArguments(['--tenant', TENANT, ...people])).toThrow(/--reference/);
    expect(() => parseLegalEraseArguments(['--reference', REFERENCE, ...people])).toThrow(
      /--tenant/,
    );
    expect(() =>
      parseLegalEraseArguments(['--reference', REFERENCE, '--tenant', 'not-a-uuid', ...people]),
    ).toThrow(/--tenant/);
    expect(() =>
      parseLegalEraseArguments([
        '--reference',
        REFERENCE,
        '--tenant',
        TENANT,
        '--force',
        ...people,
      ]),
    ).toThrow(/--force/);
    // Two named people: neither can be missing, and they cannot be the same one.
    expect(() =>
      parseLegalEraseArguments([
        '--reference',
        REFERENCE,
        '--tenant',
        TENANT,
        '--approver',
        APPROVER,
      ]),
    ).toThrow(/--operator/);
    expect(() =>
      parseLegalEraseArguments([
        '--reference',
        REFERENCE,
        '--tenant',
        TENANT,
        '--operator',
        OPERATOR,
      ]),
    ).toThrow(/--approver/);
    expect(() =>
      parseLegalEraseArguments([
        '--reference',
        REFERENCE,
        '--tenant',
        TENANT,
        '--operator',
        OPERATOR,
        '--approver',
        OPERATOR,
      ]),
    ).toThrow(/different/);
  });
});
