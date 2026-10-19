import { describe, expect, it } from 'vitest';

import { demoEmailPolicy } from './index.js';

describe('the policy of the demo email', () => {
  it('keeps the outbox and copies the catcher outside production', () => {
    expect(
      demoEmailPolicy({ nodeEnv: 'development', providers: { localProvidersConsole: false } }),
    ).toEqual({
      record: true,
      forward: true,
    });
    expect(
      demoEmailPolicy({ nodeEnv: 'test', providers: { localProvidersConsole: true } }),
    ).toEqual({
      record: true,
      forward: true,
    });
  });

  it('never forwards in production, and keeps the outbox only for a deployment that turned the console on', () => {
    expect(
      demoEmailPolicy({ nodeEnv: 'production', providers: { localProvidersConsole: true } }),
    ).toEqual({
      record: true,
      forward: false,
    });
    expect(
      demoEmailPolicy({ nodeEnv: 'production', providers: { localProvidersConsole: false } }),
    ).toEqual({
      record: false,
      forward: false,
    });
  });
});
