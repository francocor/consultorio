import { describe, expect, it } from 'vitest';

import { isPlatformHost } from './platform-host.js';

describe('isPlatformHost', () => {
  it('is the host whose first label is "platform"', () => {
    expect(isPlatformHost('platform.localhost')).toBe(true);
    expect(isPlatformHost('platform.consultorio.example')).toBe(true);
    expect(isPlatformHost('PLATFORM.consultorio.example')).toBe(true);
  });

  it('is never an organization host', () => {
    expect(isPlatformHost('aillu.localhost')).toBe(false);
    expect(isPlatformHost('clinica-platform.consultorio.example')).toBe(false);
    expect(isPlatformHost('localhost')).toBe(false);
    expect(isPlatformHost('')).toBe(false);
  });

  it('can be set to another host explicitly', () => {
    expect(isPlatformHost('admin.consultorio.example', 'admin.consultorio.example')).toBe(true);
    expect(isPlatformHost('platform.consultorio.example', 'admin.consultorio.example')).toBe(false);
  });

  it('ignores the port', () => {
    expect(isPlatformHost('platform.localhost:4173')).toBe(true);
  });
});
