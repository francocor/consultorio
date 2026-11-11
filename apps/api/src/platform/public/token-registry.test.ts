import { afterEach, describe, expect, it } from 'vitest';

import {
  registerTokenHandler,
  registeredTokenKinds,
  resetTokenHandlers,
  type TokenHandler,
} from './token-router.js';

const handler = (): TokenHandler => ({
  allowedWhenReadOnly: false,
  audits: [],
  describe: () => Promise.resolve(null),
  perform: () => Promise.resolve(null),
});

describe('the token handler registry', () => {
  afterEach(() => {
    resetTokenHandlers();
  });

  it('registers one handler per kind', () => {
    registerTokenHandler('appointment_confirm', handler());
    registerTokenHandler('waitlist_offer', handler());
    expect(registeredTokenKinds()).toEqual(['appointment_confirm', 'waitlist_offer']);
  });

  it('refuses a second handler for the same kind instead of replacing the first', () => {
    registerTokenHandler('waitlist_offer', handler());
    expect(() => registerTokenHandler('waitlist_offer', handler())).toThrow(/waitlist_offer/);
    expect(registeredTokenKinds()).toEqual(['waitlist_offer']);
  });

  it('refuses the very same handler twice as well', () => {
    const same = handler();
    registerTokenHandler('video_join', same);
    expect(() => registerTokenHandler('video_join', same)).toThrow(/already/);
  });

  it('lets a kind be registered again after its own unregister function ran', () => {
    const remove = registerTokenHandler('appointment_cancel', handler());
    remove();
    expect(() => registerTokenHandler('appointment_cancel', handler())).not.toThrow();
  });

  it('starts empty after the reset helper, which exists for the start of an application and for tests', () => {
    registerTokenHandler('appointment_cancel', handler());
    resetTokenHandlers();
    expect(registeredTokenKinds()).toEqual([]);
    expect(() => registerTokenHandler('appointment_cancel', handler())).not.toThrow();
  });
});
