import { describe, expect, it } from 'vitest';

import { createSubmissionKeys } from './submission-key.js';

describe('the key of a submission', () => {
  const counting = () => {
    let next = 0;
    return () => `key-${String((next += 1))}`;
  };

  it('stays the same while the request is the same, so a double click is one invoice', () => {
    const keys = createSubmissionKeys(counting());

    expect(keys.keyFor('lines:a|patient')).toBe('key-1');
    expect(keys.keyFor('lines:a|patient')).toBe('key-1');
  });

  it('changes when the request changes, so another invoice is not mistaken for a repeat', () => {
    const keys = createSubmissionKeys(counting());

    expect(keys.keyFor('lines:a|patient')).toBe('key-1');
    expect(keys.keyFor('lines:a,b|patient')).toBe('key-2');
    expect(keys.keyFor('lines:a|patient')).toBe('key-3');
  });

  it('is replaced once a submission went through', () => {
    const keys = createSubmissionKeys(counting());
    keys.keyFor('lines:a|patient');

    keys.done();

    expect(keys.keyFor('lines:a|patient')).toBe('key-2');
  });

  it('makes real keys when nothing is injected', () => {
    const keys = createSubmissionKeys();

    expect(keys.keyFor('x')).toMatch(/^[0-9a-f-]{36}$/);
  });
});
