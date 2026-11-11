import { describe, expect, it } from 'vitest';

import { checkLocalProviders, localProvidersIn, type ProviderSelection } from './guard.js';

const local: ProviderSelection = {
  whatsapp: 'local',
  video: 'local',
  botChallenge: 'local',
  afip: 'local',
  erx: 'local',
  payments: 'local',
};
const real: ProviderSelection = {
  whatsapp: 'meta',
  video: 'jaas',
  botChallenge: 'turnstile',
  afip: 'afip',
  // The authorized e-prescription platform has no key yet (task 5.53): the real provider is none.
  erx: 'off',
  // Mercado Pago has no key yet (task 6.50): the real provider is none.
  payments: 'off',
};
const off: ProviderSelection = {
  whatsapp: 'off',
  video: 'off',
  botChallenge: 'turnstile',
  afip: 'off',
  erx: 'off',
  payments: 'off',
};

describe('localProvidersIn', () => {
  it('names the variable of every provider that is a local simulator', () => {
    expect(localProvidersIn(local)).toEqual([
      'WHATSAPP_PROVIDER',
      'VIDEO_PROVIDER',
      'BOT_CHALLENGE',
      'AFIP_PROVIDER',
      'ERX_PROVIDER',
      'PAYMENTS_PROVIDER',
    ]);
    expect(localProvidersIn({ ...real, video: 'local' })).toEqual(['VIDEO_PROVIDER']);
    expect(localProvidersIn({ ...real, afip: 'local' })).toEqual(['AFIP_PROVIDER']);
    expect(localProvidersIn({ ...real, erx: 'local' })).toEqual(['ERX_PROVIDER']);
    expect(localProvidersIn({ ...real, payments: 'local' })).toEqual(['PAYMENTS_PROVIDER']);
  });

  it('names nothing when every provider is real or switched off', () => {
    expect(localProvidersIn(real)).toEqual([]);
    expect(localProvidersIn(off)).toEqual([]);
  });
});

describe('checkLocalProviders (environment x provider x allow flag)', () => {
  const cases: {
    nodeEnv: 'development' | 'test' | 'production';
    selection: ProviderSelection;
    allow: boolean;
    console: boolean;
    problems: string[];
  }[] = [
    // Outside production the simulators are what the product runs on: nothing is refused.
    { nodeEnv: 'development', selection: local, allow: false, console: true, problems: [] },
    { nodeEnv: 'test', selection: local, allow: false, console: false, problems: [] },
    // Production with real or disabled providers never needs the flag.
    { nodeEnv: 'production', selection: real, allow: false, console: false, problems: [] },
    { nodeEnv: 'production', selection: off, allow: false, console: false, problems: [] },
    // Production with a simulator is refused, naming the variable, unless the flag is set.
    {
      nodeEnv: 'production',
      selection: { ...real, whatsapp: 'local' },
      allow: false,
      console: false,
      problems: ['WHATSAPP_PROVIDER'],
    },
    {
      nodeEnv: 'production',
      selection: local,
      allow: false,
      console: false,
      problems: [
        'WHATSAPP_PROVIDER',
        'VIDEO_PROVIDER',
        'BOT_CHALLENGE',
        'AFIP_PROVIDER',
        'ERX_PROVIDER',
        'PAYMENTS_PROVIDER',
      ],
    },
    // A fiscal simulator would pretend to issue invoices in production: the same refusal.
    {
      nodeEnv: 'production',
      selection: { ...real, afip: 'local' },
      allow: false,
      console: false,
      problems: ['AFIP_PROVIDER'],
    },
    // A prescription simulator would pretend to issue prescriptions in production: the same refusal.
    {
      nodeEnv: 'production',
      selection: { ...real, erx: 'local' },
      allow: false,
      console: false,
      problems: ['ERX_PROVIDER'],
    },
    // A payments simulator would pretend to charge subscriptions in production: the same refusal.
    {
      nodeEnv: 'production',
      selection: { ...real, payments: 'local' },
      allow: false,
      console: false,
      problems: ['PAYMENTS_PROVIDER'],
    },
    {
      nodeEnv: 'production',
      selection: { ...off, payments: 'local' },
      allow: true,
      console: false,
      problems: [],
    },
    {
      nodeEnv: 'production',
      selection: { ...off, erx: 'local' },
      allow: true,
      console: false,
      problems: [],
    },
    {
      nodeEnv: 'production',
      selection: { ...off, afip: 'local' },
      allow: true,
      console: false,
      problems: [],
    },
    { nodeEnv: 'production', selection: local, allow: true, console: false, problems: [] },
    { nodeEnv: 'production', selection: local, allow: true, console: true, problems: [] },
    // The simulator console is a development tool: in production it needs the same flag.
    {
      nodeEnv: 'production',
      selection: real,
      allow: false,
      console: true,
      problems: ['LOCAL_PROVIDERS_CONSOLE'],
    },
  ];

  it.each(cases)(
    '$nodeEnv, local providers $selection, allow=$allow, console=$console',
    ({ nodeEnv, selection, allow, console, problems }) => {
      const result = checkLocalProviders({
        nodeEnv,
        selection,
        allowLocalProviders: allow,
        localProvidersConsole: console,
      });

      expect(result.map((problem) => problem.path)).toEqual(problems);
    },
  );

  it('points to the flag that lifts the refusal, and says it is for demo or staging only', () => {
    const [problem] = checkLocalProviders({
      nodeEnv: 'production',
      selection: local,
      allowLocalProviders: false,
      localProvidersConsole: false,
    });

    expect(problem?.message).toContain('ALLOW_LOCAL_PROVIDERS');
    expect(problem?.message).toMatch(/demo or staging/);
  });
});
