import { describe, expect, it } from 'vitest';

import type { Actor } from '../../../platform/authz/actor.js';

import { viewsOthersCalendar } from './delegated-view.js';

const ME = 'professional-me';
const COLLEAGUE = 'professional-colleague';

const professional = (extra: Partial<Actor> = {}): Actor => ({
  kind: 'staff',
  userId: 'user',
  tenantId: 'tenant',
  membershipId: 'membership',
  roles: ['professional'],
  grants: ['scheduling.delegated_calendar'],
  professionalId: ME,
  delegatedProfessionalIds: [COLLEAGUE],
  ...extra,
});

describe('who is audited for looking at a calendar', () => {
  it('audits a professional who looks at a colleague calendar, and not at their own', () => {
    expect(viewsOthersCalendar(professional(), COLLEAGUE)).toBe(true);
    expect(viewsOthersCalendar(professional(), ME)).toBe(false);
  });

  it('does not audit the ordinary work of owner, admin and reception', () => {
    for (const role of ['owner', 'admin', 'reception'] as const) {
      expect(viewsOthersCalendar(professional({ roles: [role] }), COLLEAGUE)).toBe(false);
    }
  });

  it('audits a delegated look even when the clinical gate is closed (JD-S2 R2-S1)', () => {
    // No matricula yet: no `professionalId`, but the profile exists and the calendar was delegated.
    const ungated = professional({ professionalId: null, ownProfessionalId: ME });

    expect(viewsOthersCalendar(ungated, COLLEAGUE)).toBe(true);
    expect(viewsOthersCalendar(ungated, ME)).toBe(false);
  });

  it('audits a delegated look by a member without any profile', () => {
    const noProfile = professional({ professionalId: null, ownProfessionalId: null });

    expect(viewsOthersCalendar(noProfile, COLLEAGUE)).toBe(true);
  });
});
