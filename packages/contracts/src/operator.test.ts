import { describe, expect, it } from 'vitest';

import {
  MATRICULA_NOTE_MAX,
  MatriculaNoteRequest,
  MatriculaQueueQuery,
  MatriculaUnverifyRequest,
  MatriculaVerifyRequest,
  OperatorMatriculaDto,
  PLATFORM_AUDIT_ACTIONS,
  isPlatformAuditAction,
} from './operator.js';

describe('the platform audit actions', () => {
  it('record the verification of a matricula, and the withdrawal of it, apart from the tenant trail', () => {
    for (const action of ['operator.matricula.verified', 'operator.matricula.unverified']) {
      expect(isPlatformAuditAction(action), action).toBe(true);
      expect(PLATFORM_AUDIT_ACTIONS.filter((known) => known === action)).toHaveLength(1);
    }
  });

  it('keeps every action unique and dot separated', () => {
    expect(new Set(PLATFORM_AUDIT_ACTIONS).size).toBe(PLATFORM_AUDIT_ACTIONS.length);
    for (const action of PLATFORM_AUDIT_ACTIONS) {
      expect(action, action).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/);
    }
  });
});

describe('the matricula verification contracts', () => {
  const item = {
    tenant: { id: '0192f3a0-6b2c-7000-8000-000000000001', name: 'Consultorio Sur' },
    professionalId: '0192f3a0-6b2c-7000-8000-000000000002',
    fullName: 'Dra. Lucía Paz',
    jurisdiction: 'AR-B',
    number: 'MP 12.345',
    status: 'unverified',
    verifiedAt: null,
    note: null,
  };

  it('shows the operator only the name, the registration and the organization', () => {
    expect(OperatorMatriculaDto.parse(item)).toEqual(item);
    // Anything else a profile holds (specialties, contact, hours) is refused, not stripped.
    expect(OperatorMatriculaDto.safeParse({ ...item, specialties: ['clinica'] }).success).toBe(
      false,
    );
    expect(OperatorMatriculaDto.safeParse({ ...item, status: 'pending' }).success).toBe(false);
  });

  it('asks for the unverified queue unless the operator asks for the verified one', () => {
    expect(MatriculaQueueQuery.parse({})).toEqual({ status: 'unverified' });
    expect(MatriculaQueueQuery.parse({ status: 'verified' })).toEqual({ status: 'verified' });
    expect(MatriculaQueueQuery.safeParse({ status: 'all' }).success).toBe(false);
  });

  it('trims the operator note and keeps it short and plain', () => {
    expect(MatriculaNoteRequest.parse({ note: '  Consultado en el colegio  ' })).toEqual({
      note: 'Consultado en el colegio',
    });
    expect(MatriculaNoteRequest.parse({ note: '   ' })).toEqual({ note: '' });
    expect(
      MatriculaNoteRequest.safeParse({ note: 'x'.repeat(MATRICULA_NOTE_MAX + 1) }).success,
    ).toBe(false);
    expect(MatriculaNoteRequest.safeParse({ note: 'ok', extra: 1 }).success).toBe(false);
  });

  it('verifies the registration the operator reviewed, with an optional note', () => {
    expect(MatriculaVerifyRequest.parse({ jurisdiction: 'AR-B', number: '12345' })).toEqual({
      jurisdiction: 'AR-B',
      number: '12345',
    });
    expect(
      MatriculaVerifyRequest.parse({ jurisdiction: 'AR-B', number: ' 12345 ', note: ' Vigente ' }),
    ).toEqual({ jurisdiction: 'AR-B', number: '12345', note: 'Vigente' });
    // Without the number there is nothing to compare with what the organization holds now.
    expect(MatriculaVerifyRequest.safeParse({}).success).toBe(false);
    expect(MatriculaVerifyRequest.safeParse({ jurisdiction: 'AR-B', number: '' }).success).toBe(
      false,
    );
    expect(
      MatriculaVerifyRequest.safeParse({ jurisdiction: 'AR-B', number: '1', note: 5 }).success,
    ).toBe(false);
  });

  it('withdraws a verification with or without a note', () => {
    expect(MatriculaUnverifyRequest.parse({})).toEqual({});
    expect(MatriculaUnverifyRequest.parse({ note: ' Suspendida ' })).toEqual({
      note: 'Suspendida',
    });
    expect(MatriculaUnverifyRequest.safeParse({ number: '1' }).success).toBe(false);
  });
});
