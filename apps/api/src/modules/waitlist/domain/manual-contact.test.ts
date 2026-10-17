import { describe, expect, it } from 'vitest';

import { manualContactReason, type Reach } from './manual-contact.js';

const reach = (email: Partial<Reach['email']>, whatsapp: Partial<Reach['whatsapp']>): Reach => ({
  email: { usable: false, optedOut: false, ...email },
  whatsapp: { usable: false, optedOut: false, ...whatsapp },
});

describe('why an entry is manual contact only', () => {
  it('is not, when the patient agreed and a chosen channel reaches them', () => {
    expect(
      manualContactReason({
        offersOptIn: true,
        channels: ['email'],
        reach: reach({ usable: true }, {}),
      }),
    ).toBeNull();
    expect(
      manualContactReason({
        offersOptIn: true,
        channels: ['whatsapp'],
        reach: reach({}, { usable: true }),
      }),
    ).toBeNull();
  });

  it('asks for the agreement first: without it nothing else matters', () => {
    expect(
      manualContactReason({
        offersOptIn: false,
        channels: ['email'],
        reach: reach({ usable: true }, {}),
      }),
    ).toBe('no_offers_opt_in');
    expect(
      manualContactReason({
        offersOptIn: false,
        channels: ['email'],
        reach: reach({ optedOut: true }, {}),
      }),
    ).toBe('no_offers_opt_in');
  });

  it('only counts the channels the entry chose', () => {
    // WhatsApp would reach the patient, but the entry asked for email, which does not.
    expect(
      manualContactReason({
        offersOptIn: true,
        channels: ['email'],
        reach: reach({}, { usable: true }),
      }),
    ).toBe('no_reachable_channel');
    // Both chosen: one is enough.
    expect(
      manualContactReason({
        offersOptIn: true,
        channels: ['email', 'whatsapp'],
        reach: reach({}, { usable: true }),
      }),
    ).toBeNull();
  });

  it('says the patient opted out when a chosen channel was refused and none is left', () => {
    expect(
      manualContactReason({
        offersOptIn: true,
        channels: ['email', 'whatsapp'],
        reach: reach({ optedOut: true }, { optedOut: true }),
      }),
    ).toBe('patient_opted_out');
    expect(
      manualContactReason({
        offersOptIn: true,
        channels: ['email'],
        reach: reach({ optedOut: true }, { usable: true }),
      }),
    ).toBe('patient_opted_out');
  });

  it('says there is no channel when the patient has no address and refused nothing', () => {
    expect(
      manualContactReason({
        offersOptIn: true,
        channels: ['email', 'whatsapp'],
        reach: reach({}, {}),
      }),
    ).toBe('no_reachable_channel');
  });
});
