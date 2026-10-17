import type { Role } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import type { Actor } from '../../../platform/authz/actor.js';

import { documentDecision, permissionFor } from './access.js';

const TENANT = '0190a000-0000-7000-8000-0000000000a1';

function actor(roles: Role[], overrides: Partial<Actor> = {}): Actor {
  return {
    kind: 'staff',
    userId: '0190a000-0000-7000-8000-0000000000a2',
    tenantId: TENANT,
    membershipId: '0190a000-0000-7000-8000-0000000000a3',
    roles,
    grants: [],
    professionalId: roles.includes('professional') ? '0190a000-0000-7000-8000-0000000000a4' : null,
    ...overrides,
  };
}

describe('which permission a document action needs', () => {
  it('maps the classification and the action to the catalog', () => {
    expect(permissionFor('administrative', 'read')).toBe('patients.read');
    expect(permissionFor('administrative', 'write')).toBe('patients.write');
    expect(permissionFor('clinical', 'read')).toBe('clinical.document.read');
    expect(permissionFor('clinical', 'write')).toBe('clinical.document.write');
  });
});

describe('who may read and write which documents', () => {
  const cases: {
    who: string;
    actor: Actor;
    administrative: [boolean, boolean];
    clinical: [boolean, boolean];
  }[] = [
    {
      who: 'a professional with a profile',
      actor: actor(['professional']),
      administrative: [true, true],
      clinical: [true, true],
    },
    {
      who: 'a professional the gate refused (no valid matricula)',
      actor: actor(['professional'], { professionalId: null }),
      administrative: [true, true],
      clinical: [false, false],
    },
    {
      who: 'reception',
      actor: actor(['reception']),
      administrative: [true, true],
      clinical: [false, false],
    },
    {
      who: 'an administrator',
      actor: actor(['admin']),
      administrative: [true, true],
      clinical: [false, false],
    },
    {
      who: 'the owner',
      actor: actor(['owner']),
      administrative: [true, true],
      clinical: [false, false],
    },
  ];

  it.each(cases)('$who', ({ actor: subject, administrative, clinical }) => {
    const answer = (classification: 'administrative' | 'clinical', action: 'read' | 'write') =>
      documentDecision(subject, classification, action).allowed;

    expect([answer('administrative', 'read'), answer('administrative', 'write')]).toEqual(
      administrative,
    );
    expect([answer('clinical', 'read'), answer('clinical', 'write')]).toEqual(clinical);
  });

  it('never lets a grant open clinical documents to a non-clinical role', () => {
    const granted = actor(['reception'], {
      grants: ['clinical.document.read', 'clinical.document.write', 'patients.administer'],
    });

    expect(documentDecision(granted, 'clinical', 'read').allowed).toBe(false);
    expect(documentDecision(granted, 'clinical', 'write').allowed).toBe(false);
  });

  it('states the reason of a refusal for the audit trail', () => {
    expect(documentDecision(actor(['admin']), 'clinical', 'read')).toEqual({
      allowed: false,
      reason: 'not_permitted',
    });
    expect(
      documentDecision(actor(['professional'], { professionalId: null }), 'clinical', 'read'),
    ).toEqual({
      allowed: false,
      reason: 'professional_gate',
    });
  });

  it('refuses a patient session and another organization', () => {
    expect(
      documentDecision(actor(['patient'], { kind: 'patient' }), 'administrative', 'read').allowed,
    ).toBe(false);
    expect(
      documentDecision(actor(['reception'], { tenantId: 'other' }), 'administrative', 'read', {
        tenantId: TENANT,
      }),
    ).toEqual({ allowed: false, reason: 'cross_tenant' });
  });
});
