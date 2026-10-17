import { describe, expect, it } from 'vitest';

import { createPublicOrigins } from './public-origin.js';

const multi = { mode: 'multi', baseDomain: 'consultorio.example' } as const;

describe('public origins of the emailed links', () => {
  it('builds the organization origin from the base domain and the slug, never from a request', () => {
    const origin = createPublicOrigins(multi, { secure: true });

    expect(origin('acme')).toBe('https://acme.consultorio.example');
    expect(origin('norte-sur')).toBe('https://norte-sur.consultorio.example');
  });

  it('uses http only when the deployment is plain-http local development', () => {
    expect(createPublicOrigins(multi, { secure: false })('acme')).toBe(
      'http://acme.consultorio.example',
    );
  });

  it('adds the port only when one is configured', () => {
    expect(createPublicOrigins(multi, { secure: false, port: 5173 })('acme')).toBe(
      'http://acme.consultorio.example:5173',
    );
    expect(createPublicOrigins(multi, { secure: false })('acme')).toBe(
      'http://acme.consultorio.example',
    );
  });

  it('serves a single-organization deployment from its configured public URL', () => {
    const origin = createPublicOrigins(
      { mode: 'single' },
      { secure: true, publicUrl: 'https://agenda.clinica.example/' },
    );

    expect(origin('whatever-slug')).toBe('https://agenda.clinica.example');
  });

  it('keeps a non-default port in the single-organization URL', () => {
    const origin = createPublicOrigins(
      { mode: 'single' },
      { secure: false, publicUrl: 'http://localhost:8080' },
    );

    expect(origin('x')).toBe('http://localhost:8080');
  });

  it('refuses to start a single-organization deployment without a public URL', () => {
    expect(() => createPublicOrigins({ mode: 'single' }, { secure: true })).toThrow(/PUBLIC_URL/);
  });

  it('refuses a public URL that is not an origin', () => {
    expect(() =>
      createPublicOrigins({ mode: 'single' }, { secure: true, publicUrl: 'not a url' }),
    ).toThrow(/PUBLIC_URL/);
    expect(() =>
      createPublicOrigins(
        { mode: 'single' },
        { secure: true, publicUrl: 'https://user:pass@clinica.example' },
      ),
    ).toThrow(/PUBLIC_URL/);
  });
});
