import type { Role } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import {
  deriveProfessionalId,
  resolveProfessionalIds,
  type ProfessionalProfile,
  type ProfessionalRepo,
} from './professional-gate.js';

const PROFILE: ProfessionalProfile = {
  id: '0190a000-0000-7000-8000-0000000000f1',
  status: 'active',
  matricula: 'MP 12345',
  matriculaJurisdiction: 'AR-B',
};

/** Accepts "MP" followed by digits in jurisdiction AR-B, like a stub country pack. */
const validateMatricula = (jurisdiction: string, value: string) =>
  jurisdiction === 'AR-B' && /^MP \d{3,6}$/.test(value);

function repoWith(profile: ProfessionalProfile | null): ProfessionalRepo & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    findByMembership: (_tenantId, membershipId) => {
      calls.push(membershipId);
      return Promise.resolve(profile);
    },
  };
}

const derive = (roles: Role[], profile: ProfessionalProfile | null) =>
  deriveProfessionalId(
    { tenantId: 't1', membershipId: 'm1', roles },
    repoWith(profile),
    validateMatricula,
  );

describe('professional gate (authorization, "Health professional" definition)', () => {
  it('gives the profile id to a professional with an active profile and a valid matricula', async () => {
    expect(await derive(['professional'], PROFILE)).toBe(PROFILE.id);
  });

  it('gives it to an owner who is also a professional, through the profile', async () => {
    expect(await derive(['owner', 'professional'], PROFILE)).toBe(PROFILE.id);
  });

  it('does not consider an unverified matricula a problem: a recorded valid one is enough', async () => {
    expect(await derive(['professional'], { ...PROFILE })).toBe(PROFILE.id);
  });

  it.each([
    ['an inactive profile', { ...PROFILE, status: 'inactive' as const }],
    ['no matricula recorded', { ...PROFILE, matricula: null }],
    ['an empty matricula', { ...PROFILE, matricula: '' }],
    ['a matricula of the wrong format', { ...PROFILE, matricula: 'not a matricula' }],
    ['no jurisdiction for the matricula', { ...PROFILE, matriculaJurisdiction: null }],
    ['an unknown jurisdiction', { ...PROFILE, matriculaJurisdiction: 'ZZ' }],
  ])('refuses %s', async (_label, profile) => {
    expect(await derive(['professional'], profile)).toBeNull();
  });

  it('refuses a user with no profile at all', async () => {
    expect(await derive(['professional'], null)).toBeNull();
  });

  it('never gives an owner, admin or reception an id through the role alone', async () => {
    for (const role of ['owner', 'admin', 'reception'] as Role[]) {
      expect(await derive([role], PROFILE), role).toBeNull();
    }
  });

  it('looks the profile up for any member, but a role other than professional never unlocks the gate', async () => {
    const repo = repoWith(PROFILE);

    const id = await deriveProfessionalId(
      { tenantId: 't1', membershipId: 'm1', roles: ['owner'] },
      repo,
      validateMatricula,
    );

    expect(id).toBeNull();
    expect(repo.calls).toEqual(['m1']);
  });

  it('asks the repository for the profile of the membership', async () => {
    const repo = repoWith(PROFILE);

    await deriveProfessionalId(
      { tenantId: 't1', membershipId: 'membership-42', roles: ['professional'] },
      repo,
      validateMatricula,
    );

    expect(repo.calls).toEqual(['membership-42']);
  });

  it('fails closed if the repository fails', async () => {
    const broken: ProfessionalRepo = {
      findByMembership: () => Promise.reject(new Error('database down')),
    };

    await expect(
      deriveProfessionalId(
        { tenantId: 't1', membershipId: 'm1', roles: ['professional'] },
        broken,
        validateMatricula,
      ),
    ).resolves.toBeNull();
  });
});

describe('own professional profile (D14), independent of the clinical gate', () => {
  const resolve = (roles: Role[], profile: ProfessionalProfile | null) =>
    resolveProfessionalIds(
      { tenantId: 't1', membershipId: 'm1', roles },
      repoWith(profile),
      validateMatricula,
    );

  it('knows the own profile of a professional whose matricula is not recorded yet', async () => {
    expect(await resolve(['professional'], { ...PROFILE, matricula: null })).toEqual({
      professionalId: null,
      ownProfessionalId: PROFILE.id,
    });
  });

  it('knows the own profile of an owner who is also a professional without a valid matricula', async () => {
    expect(
      await resolve(['owner', 'professional'], { ...PROFILE, matricula: 'not a matricula' }),
    ).toEqual({ professionalId: null, ownProfessionalId: PROFILE.id });
  });

  it('gives both ids when the profile passes the gate', async () => {
    expect(await resolve(['professional'], PROFILE)).toEqual({
      professionalId: PROFILE.id,
      ownProfessionalId: PROFILE.id,
    });
  });

  it('keeps the own profile of a member who lost the professional role, with the gate closed (JD-S2 R2-S2)', async () => {
    // Demoted: the old appointments are still theirs for the identity rules, but nothing clinical opens.
    expect(await resolve(['owner'], PROFILE)).toEqual({
      professionalId: null,
      ownProfessionalId: PROFILE.id,
    });
    expect(await resolve(['reception'], PROFILE)).toEqual({
      professionalId: null,
      ownProfessionalId: PROFILE.id,
    });
  });

  it('has no own profile for a member who never had one', async () => {
    expect(await resolve(['owner'], null)).toEqual({
      professionalId: null,
      ownProfessionalId: null,
    });
  });

  it('does not guess when the lookup fails: it rejects instead of answering "none"', async () => {
    const broken: ProfessionalRepo = {
      findByMembership: () => Promise.reject(new Error('database down')),
    };

    await expect(
      resolveProfessionalIds(
        { tenantId: 't1', membershipId: 'm1', roles: ['professional'] },
        broken,
        validateMatricula,
      ),
    ).rejects.toThrow('database down');
  });
});
