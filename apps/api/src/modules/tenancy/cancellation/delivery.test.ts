import type { Role } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import type { ExportPackageRow } from '../../../db/schema/export-package.js';
import type { Actor } from '../../../platform/authz/actor.js';

import { mayHavePackage } from './delivery.js';

const PROFESSIONAL_A = '0190a000-0000-7000-8000-0000000000a1';
const PROFESSIONAL_B = '0190a000-0000-7000-8000-0000000000b1';

function actor(roles: Role[], professionalId: string | null = null, grants: string[] = []): Actor {
  return {
    kind: 'staff',
    userId: '0190a000-0000-7000-8000-000000000001',
    tenantId: '0190a000-0000-7000-8000-000000000002',
    membershipId: '0190a000-0000-7000-8000-000000000003',
    roles,
    grants,
    professionalId,
  };
}

const administrative = { kind: 'administrative', professionalId: null } as ExportPackageRow;
const clinicalOf = (professionalId: string) =>
  ({ kind: 'clinical', professionalId }) as ExportPackageRow;

describe('who may have a package of the cancellation export', () => {
  it('gives the administrative package to the owner role and to nobody else', () => {
    expect(mayHavePackage(actor(['owner']), administrative)).toBe(true);
    for (const roles of [['admin'], ['reception'], ['professional']] satisfies Role[][]) {
      expect(mayHavePackage(actor(roles, PROFESSIONAL_A), administrative), roles.join()).toBe(
        false,
      );
    }
  });

  it('does not let a grant make an administrator the owner of the export', () => {
    expect(mayHavePackage(actor(['admin'], null, ['payments.read']), administrative)).toBe(false);
  });

  it('gives a clinical package to the professional it was made for', () => {
    expect(
      mayHavePackage(actor(['professional'], PROFESSIONAL_A), clinicalOf(PROFESSIONAL_A)),
    ).toBe(true);
  });

  it('refuses a clinical package to a colleague, to an owner who is not a professional and to staff without clinical access', () => {
    expect(
      mayHavePackage(actor(['professional'], PROFESSIONAL_B), clinicalOf(PROFESSIONAL_A)),
    ).toBe(false);
    expect(mayHavePackage(actor(['owner']), clinicalOf(PROFESSIONAL_A))).toBe(false);
    expect(mayHavePackage(actor(['admin']), clinicalOf(PROFESSIONAL_A))).toBe(false);
    expect(mayHavePackage(actor(['reception']), clinicalOf(PROFESSIONAL_A))).toBe(false);
  });

  it('refuses an owner who holds a professional profile that is not the one the package is for', () => {
    expect(
      mayHavePackage(actor(['owner', 'professional'], PROFESSIONAL_B), clinicalOf(PROFESSIONAL_A)),
    ).toBe(false);
    expect(
      mayHavePackage(actor(['owner', 'professional'], PROFESSIONAL_A), clinicalOf(PROFESSIONAL_A)),
    ).toBe(true);
  });

  it('refuses a professional whose profile lost the clinical gate (no professional id)', () => {
    expect(mayHavePackage(actor(['professional'], null), clinicalOf(PROFESSIONAL_A))).toBe(false);
  });
});
