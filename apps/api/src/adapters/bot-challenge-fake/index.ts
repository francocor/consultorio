import type { BotChallenge } from '../../platform/bot-challenge/bot-challenge.js';

/**
 * Bot challenge for tests and demo organizations: nothing to solve, everything passes. A customer
 * organization never gets it (the adapter resolver keeps fakes in the demo slot).
 */
export function createFakeBotChallenge(): BotChallenge {
  return {
    issue: () => Promise.resolve({ kind: 'fake', payload: {} }),
    verify: () => Promise.resolve(true),
  };
}
