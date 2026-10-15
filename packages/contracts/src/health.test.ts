import { describe, expect, it } from 'vitest';

import { HealthResponse } from './health.js';

describe('HealthResponse', () => {
  it.each(['ok', 'unavailable'])('accepts status %s', (status) => {
    expect(HealthResponse.parse({ status })).toEqual({ status });
  });

  it.each([{}, { status: 'degraded' }, { status: 200 }, 'ok', null])('rejects %j', (payload) => {
    expect(HealthResponse.safeParse(payload).success).toBe(false);
  });
});
