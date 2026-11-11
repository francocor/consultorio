import { describe, expect, it } from 'vitest';

import { describeFailure } from './failure-log.js';

describe('describeFailure', () => {
  it('reads the database code from the cause of a wrapped driver error', () => {
    const wrapped = new Error('Failed query: select ... params: 600123456', {
      cause: Object.assign(new Error('division by zero'), { code: '22012' }),
    });
    wrapped.name = 'DrizzleQueryError';

    expect(describeFailure(wrapped)).toEqual({ name: 'DrizzleQueryError', code: '22012' });
  });

  it('reads the code of a bare driver error', () => {
    expect(describeFailure(Object.assign(new Error('boom'), { code: '40001' }))).toEqual({
      name: 'Error',
      code: '40001',
    });
  });

  it('never carries the message, and tolerates what is not an error', () => {
    expect(JSON.stringify(describeFailure(new Error('patient 600123456')))).not.toContain(
      '600123456',
    );
    expect(describeFailure('plain string')).toEqual({ name: 'unknown', code: 'unknown' });
    expect(describeFailure(null)).toEqual({ name: 'unknown', code: 'unknown' });
  });
});
