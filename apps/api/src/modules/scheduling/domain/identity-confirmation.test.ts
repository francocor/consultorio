import { describe, expect, it } from 'vitest';

import {
  canConfirmIdentity,
  initialIdentityConfirmed,
  isSoloPractice,
} from './identity-confirmation.js';

const B = 'professional-b';
const OTHER = 'professional-c';

describe('initialIdentityConfirmed (decision D14)', () => {
  // [source, patient, booking actor's professional id, appointment professional, expected]
  it.each([
    // A public booking that matches an existing patient: nobody checked who it is.
    ['online', 'existing', null, B, false],
    ['waitlist_offer', 'existing', null, B, false],
    // A booking that creates the patient is not a match.
    ['online', 'created', null, B, true],
    ['waitlist_offer', 'created', null, B, true],
    ['staff', 'created', null, B, true],
    ['staff', 'created', B, B, true],
    // Staff booking an existing patient is a person looking at the record.
    ['staff', 'existing', null, B, true],
    ['staff', 'existing', OTHER, B, true],
    // The professional booking themselves for an existing patient: nobody else has looked.
    ['staff', 'existing', B, B, false],
  ] as const)(
    '%s booking, %s patient, actor %s, professional %s -> %s',
    (source, patient, actor, professional, expected) => {
      expect(
        initialIdentityConfirmed({
          source,
          patient,
          bookingActorProfessionalId: actor,
          appointmentProfessionalId: professional,
        }),
      ).toBe(expected);
    },
  );
});

describe('canConfirmIdentity (who may confirm, and how)', () => {
  const confirm = (
    actorProfessionalId: string | null,
    channel: 'worklist' | 'check_in',
    solo: boolean,
  ) =>
    canConfirmIdentity({
      actorProfessionalId,
      appointmentProfessionalId: B,
      channel,
      soloPractice: solo,
    });

  it.each(['worklist', 'check_in'] as const)(
    'lets a staff member who is not the professional confirm at %s, as staff',
    (channel) => {
      expect(confirm(null, channel, false)).toBe('staff');
      expect(confirm(null, channel, true)).toBe('staff');
    },
  );

  it.each(['worklist', 'check_in'] as const)(
    'lets another professional confirm at %s, as staff',
    (channel) => {
      expect(confirm(OTHER, channel, false)).toBe('staff');
    },
  );

  it('never lets the appointment professional confirm from the worklist, solo or not', () => {
    expect(confirm(B, 'worklist', false)).toBeNull();
    expect(confirm(B, 'worklist', true)).toBeNull();
  });

  it('lets the appointment professional confirm at in-person check-in only in a solo practice (D18)', () => {
    expect(confirm(B, 'check_in', true)).toBe('self_confirmed');
    expect(confirm(B, 'check_in', false)).toBeNull();
  });
});

describe('isSoloPractice (decision D18)', () => {
  it('is true with exactly one active professional and nobody else active', () => {
    expect(isSoloPractice({ activeProfessionals: 1, otherActiveMembers: 0 })).toBe(true);
  });

  it.each([
    [2, 0],
    [1, 1],
    [1, 3],
    [0, 0],
    [2, 2],
  ])(
    'is false with %i professionals and %i other members',
    (activeProfessionals, otherActiveMembers) => {
      expect(isSoloPractice({ activeProfessionals, otherActiveMembers })).toBe(false);
    },
  );
});
