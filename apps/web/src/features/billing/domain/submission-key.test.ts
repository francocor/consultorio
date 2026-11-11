import { describe, expect, it } from 'vitest';

import { createSubmissionKeys } from './submission-key.js';

function counter() {
  let n = 0;
  return () => {
    n += 1;
    return `key-${String(n)}`;
  };
}

describe('the key of a submission', () => {
  it('stays the same while the same thing is sent again, so a retry cannot be recorded twice', () => {
    const keys = createSubmissionKeys(counter());

    const first = keys.keyFor('debit|500000|');
    const retry = keys.keyFor('debit|500000|');
    const third = keys.keyFor('debit|500000|');

    expect(first).toBe('key-1');
    expect(retry).toBe(first);
    expect(third).toBe(first);
  });

  it('changes as soon as what is sent changes, so a corrected amount is a new submission', () => {
    const keys = createSubmissionKeys(counter());

    const first = keys.keyFor('debit|500000|');
    const corrected = keys.keyFor('debit|450000|');
    const back = keys.keyFor('debit|500000|');

    expect(corrected).not.toBe(first);
    expect(back).not.toBe(corrected);
    expect(back).not.toBe(first);
  });

  it('starts a new submission after one went through', () => {
    const keys = createSubmissionKeys(counter());

    const first = keys.keyFor('debit|500000|');
    keys.done();
    const next = keys.keyFor('debit|500000|');

    expect(next).not.toBe(first);
  });
});
