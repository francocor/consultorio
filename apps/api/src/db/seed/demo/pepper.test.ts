import { afterEach, describe, expect, it } from 'vitest';

import {
  configureAddressHash,
  hashAddress,
} from '../../../modules/notifications/domain/address.js';

import { useServerAddressPepper } from './pepper.js';

describe('the pepper of the demo seed', () => {
  afterEach(() => {
    configureAddressHash(null);
  });

  it('is the one the server is configured with, so seeded hashes can be found by it', () => {
    const development = hashAddress('email', 'paciente@example.test');

    useServerAddressPepper({ providers: { addressHashPepper: 'x'.repeat(40) } });
    const seeded = hashAddress('email', 'paciente@example.test');
    configureAddressHash('x'.repeat(40));
    const server = hashAddress('email', 'paciente@example.test');

    expect(seeded).toBe(server);
    expect(seeded).not.toBe(development);
  });

  it('falls back to the development default when none is configured, like the server', () => {
    const development = hashAddress('email', 'paciente@example.test');

    useServerAddressPepper({ providers: {} });

    expect(hashAddress('email', 'paciente@example.test')).toBe(development);
  });
});
