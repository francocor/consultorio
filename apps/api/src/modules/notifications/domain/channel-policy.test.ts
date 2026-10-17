import {
  APPOINTMENT_MESSAGE_KINDS,
  EMAIL_ONLY_MESSAGE_KINDS,
  MESSAGE_KINDS,
  type MessageKind,
} from '@consultorio/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { selectChannels, type ChannelFacts, type ChannelOptions } from './channel-policy.js';

const reachable: ChannelFacts = {
  email: 'ana@example.test',
  phone: '+5491155550000',
  emailPreference: 'default',
  whatsappPreference: 'opted_in',
  emailUnreachable: false,
  whatsappUnreachable: false,
};
const open: ChannelOptions = { whatsappEnabled: true, whatsappQuotaAvailable: true };

const channelsOf = (kind: MessageKind, facts: Partial<ChannelFacts> = {}, options = open) =>
  selectChannels(kind, { ...reachable, ...facts }, options).channels;

describe('selectChannels, the channel policy', () => {
  it('prefers WhatsApp and falls back to email for a reminder of an opted-in patient', () => {
    expect(channelsOf('reminder')).toEqual(['whatsapp', 'email']);
  });

  it('uses WhatsApp for the appointment kinds and for nothing else', () => {
    for (const kind of APPOINTMENT_MESSAGE_KINDS) {
      expect(channelsOf(kind)).toEqual(['whatsapp', 'email']);
    }
    for (const kind of EMAIL_ONLY_MESSAGE_KINDS) {
      expect(channelsOf(kind)).toEqual(['email']);
    }
  });

  it('never uses WhatsApp without a recorded opt-in, and says why it was left out', () => {
    const none = selectChannels('reminder', { ...reachable, whatsappPreference: 'none' }, open);

    expect(none.channels).toEqual(['email']);
    expect(none.skipped).toContainEqual({ channel: 'whatsapp', reason: 'no_opt_in' });
  });

  it('honors an opt-out per channel and keeps the other channel', () => {
    const emailOut = selectChannels(
      'reminder',
      { ...reachable, emailPreference: 'opted_out' },
      open,
    );
    const whatsappOut = selectChannels(
      'reminder',
      { ...reachable, whatsappPreference: 'opted_out' },
      open,
    );

    expect(emailOut.channels).toEqual(['whatsapp']);
    expect(emailOut.skipped).toContainEqual({ channel: 'email', reason: 'opted_out' });
    expect(whatsappOut.channels).toEqual(['email']);
    expect(whatsappOut.skipped).toContainEqual({ channel: 'whatsapp', reason: 'opted_out' });
  });

  it('gives no channel to a patient who opted out of everything', () => {
    const result = selectChannels(
      'reminder',
      { ...reachable, emailPreference: 'opted_out', whatsappPreference: 'opted_out' },
      open,
    );

    expect(result.channels).toEqual([]);
    expect(result.skipped.map((skip) => skip.reason)).toEqual(['opted_out', 'opted_out']);
  });

  it('skips a contact that is missing or marked unreachable', () => {
    expect(channelsOf('reminder', { email: null })).toEqual(['whatsapp']);
    expect(channelsOf('reminder', { phone: null })).toEqual(['email']);
    expect(channelsOf('reminder', { whatsappUnreachable: true })).toEqual(['email']);
    expect(channelsOf('reminder', { emailUnreachable: true })).toEqual(['whatsapp']);
    expect(selectChannels('reminder', { ...reachable, phone: null }, open).skipped).toContainEqual({
      channel: 'whatsapp',
      reason: 'no_contact',
    });
    expect(
      selectChannels('reminder', { ...reachable, whatsappUnreachable: true }, open).skipped,
    ).toContainEqual({ channel: 'whatsapp', reason: 'unreachable' });
  });

  it('drops WhatsApp when the integration is off or the quota says no, and keeps email', () => {
    const off = selectChannels('reminder', reachable, { ...open, whatsappEnabled: false });
    const noQuota = selectChannels('reminder', reachable, {
      ...open,
      whatsappQuotaAvailable: false,
    });

    expect(off.channels).toEqual(['email']);
    expect(off.skipped).toContainEqual({ channel: 'whatsapp', reason: 'integration_off' });
    expect(noQuota.channels).toEqual(['email']);
    expect(noQuota.skipped).toContainEqual({ channel: 'whatsapp', reason: 'quota' });
  });

  it('does not report WhatsApp as skipped for a kind that never uses it', () => {
    const result = selectChannels('otp_code', reachable, open);

    expect(result.channels).toEqual(['email']);
    expect(result.skipped).toEqual([]);
  });

  it('keeps email-only kinds on email even for a patient who is opted in to WhatsApp', () => {
    expect(channelsOf('invitation', { whatsappPreference: 'opted_in' })).toEqual(['email']);
  });

  it('property: a kind that is not tied to an appointment never selects WhatsApp', () => {
    const preference = fc.constantFrom('none', 'opted_in', 'opted_out');
    fc.assert(
      fc.property(
        fc.constantFrom(...EMAIL_ONLY_MESSAGE_KINDS),
        fc.record({
          email: fc.option(fc.constant('x@example.test'), { nil: null }),
          phone: fc.option(fc.constant('+5491100000000'), { nil: null }),
          emailPreference: fc.constantFrom('default', 'opted_out'),
          whatsappPreference: preference,
          emailUnreachable: fc.boolean(),
          whatsappUnreachable: fc.boolean(),
        }),
        fc.record({ whatsappEnabled: fc.boolean(), whatsappQuotaAvailable: fc.boolean() }),
        (kind, facts, options) =>
          !selectChannels(kind, facts, options).channels.includes('whatsapp'),
      ),
    );
  });

  it('property: WhatsApp is selected only with an opt-in, and nothing opted out is ever selected', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...MESSAGE_KINDS),
        fc.record({
          email: fc.option(fc.constant('x@example.test'), { nil: null }),
          phone: fc.option(fc.constant('+5491100000000'), { nil: null }),
          emailPreference: fc.constantFrom('default', 'opted_out'),
          whatsappPreference: fc.constantFrom('none', 'opted_in', 'opted_out'),
          emailUnreachable: fc.boolean(),
          whatsappUnreachable: fc.boolean(),
        }),
        fc.record({ whatsappEnabled: fc.boolean(), whatsappQuotaAvailable: fc.boolean() }),
        (kind, facts, options) => {
          const { channels } = selectChannels(kind, facts, options);
          const whatsappOk =
            !channels.includes('whatsapp') || facts.whatsappPreference === 'opted_in';
          const emailOk = !channels.includes('email') || facts.emailPreference !== 'opted_out';
          return whatsappOk && emailOk;
        },
      ),
    );
  });
});
