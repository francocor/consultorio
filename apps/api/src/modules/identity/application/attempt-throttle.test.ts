import { describe, expect, it } from 'vitest';

import { createAttemptThrottle } from './attempt-throttle.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

function clock(start = 0) {
  let now = start;
  return {
    now: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('attempt throttle for identifiers that have no account row', () => {
  it('lets the first two failures through without delay, like a real account', () => {
    const time = clock();
    const throttle = createAttemptThrottle({ lockAfter: 10, lockMs: 15 * MINUTE, clock: time.now });

    expect(throttle.check('ghost')).toEqual({ blocked: false });
    throttle.recordFailure('ghost');
    throttle.recordFailure('ghost');

    expect(throttle.check('ghost')).toEqual({ blocked: false });
  });

  it('delays attempts after the third failure following the same schedule as accounts', () => {
    const time = clock();
    const throttle = createAttemptThrottle({ lockAfter: 10, lockMs: 15 * MINUTE, clock: time.now });
    for (let i = 0; i < 3; i += 1) throttle.recordFailure('ghost');

    expect(throttle.check('ghost')).toEqual({ blocked: true });
    time.advance(SECOND);
    expect(throttle.check('ghost')).toEqual({ blocked: false });
  });

  it('locks after the limit for the lock window, then starts afresh', () => {
    const time = clock();
    const throttle = createAttemptThrottle({ lockAfter: 10, lockMs: 15 * MINUTE, clock: time.now });
    for (let i = 0; i < 10; i += 1) {
      time.advance(10 * MINUTE);
      throttle.recordFailure('ghost');
    }

    time.advance(14 * MINUTE);
    expect(throttle.check('ghost')).toEqual({ blocked: true });
    time.advance(MINUTE);
    expect(throttle.check('ghost')).toEqual({ blocked: false });
  });

  it('keeps identifiers apart', () => {
    const time = clock();
    const throttle = createAttemptThrottle({ lockAfter: 10, lockMs: 15 * MINUTE, clock: time.now });
    for (let i = 0; i < 4; i += 1) throttle.recordFailure('one');

    expect(throttle.check('one')).toEqual({ blocked: true });
    expect(throttle.check('two')).toEqual({ blocked: false });
  });

  it('forgets failures that are old enough, and can be reset', () => {
    const time = clock();
    const throttle = createAttemptThrottle({ lockAfter: 10, lockMs: 15 * MINUTE, clock: time.now });
    for (let i = 0; i < 4; i += 1) throttle.recordFailure('one');
    throttle.reset('one');

    expect(throttle.check('one')).toEqual({ blocked: false });
  });

  it('does not grow without bound under a flood of distinct identifiers', () => {
    const time = clock();
    const throttle = createAttemptThrottle({
      lockAfter: 10,
      lockMs: 15 * MINUTE,
      clock: time.now,
      maxKeys: 3,
    });
    for (let i = 0; i < 4; i += 1) throttle.recordFailure('first');
    for (const other of ['a', 'b', 'c']) throttle.recordFailure(other);

    // "first" was the least recently used and has been forgotten.
    expect(throttle.check('first')).toEqual({ blocked: false });
  });
});

describe('attempt throttle per client address', () => {
  it('tolerates a busy shared address: delays start only after many failures', () => {
    const time = clock();
    const throttle = createAttemptThrottle({ freeFailures: 10, clock: time.now });
    for (let i = 0; i < 10; i += 1) throttle.recordFailure('203.0.113.9');
    expect(throttle.check('203.0.113.9')).toEqual({ blocked: false });

    throttle.recordFailure('203.0.113.9');

    expect(throttle.check('203.0.113.9')).toEqual({ blocked: true });
    time.advance(SECOND);
    expect(throttle.check('203.0.113.9')).toEqual({ blocked: false });
  });

  it('never locks outright: the delay only grows up to its cap', () => {
    const time = clock();
    const throttle = createAttemptThrottle({ freeFailures: 10, clock: time.now });
    for (let i = 0; i < 200; i += 1) throttle.recordFailure('203.0.113.9');

    time.advance(5 * MINUTE);

    expect(throttle.check('203.0.113.9')).toEqual({ blocked: false });
  });
});
