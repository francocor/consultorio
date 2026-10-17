import { describe, expect, it } from 'vitest';

import * as scheduling from './index.js';

/**
 * The tracks of Stage 3 book, move, hold and read availability through scheduling, and a module
 * reaches another only through its index.ts. These are the public use cases the tracks rely on.
 */
describe('the public API of scheduling', () => {
  it.each([
    'bookAppointment',
    'transitionAppointment',
    'rescheduleAppointment',
    'createHold',
    'releaseHold',
    'availability',
    'createSchedulingPorts',
    'SlotTakenError',
    'SlotNoLongerAvailableError',
    'HOLD_MINUTES',
  ])('exports %s', (name) => {
    expect(scheduling, name).toHaveProperty(name);
  });
});
