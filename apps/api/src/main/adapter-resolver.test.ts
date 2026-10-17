import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createFakeEmailSender } from '../adapters/fake-email/index.js';
import { createLocalKeyManagement } from '../adapters/local-kek/index.js';
import { createMemoryObjectStorage } from '../adapters/memory-storage/index.js';

import {
  ADAPTER_PORTS,
  createAdapterResolver,
  createTenantRoutedEmail,
  DemoAdapterError,
  fake,
  real,
  type AdapterRegistry,
} from './adapter-resolver.js';

const DEMO = { id: '0190a000-0000-7000-8000-0000000000d1', isDemo: true };
const CUSTOMER = { id: '0190a000-0000-7000-8000-0000000000c1', isDemo: false };

function registry(overrides: Partial<AdapterRegistry> = {}): AdapterRegistry {
  const kek = () => createLocalKeyManagement(randomBytes(32).toString('base64'));
  return {
    email: { real: real(createFakeEmailSender()), demo: fake(createFakeEmailSender()) },
    objectStorage: {
      real: real(createMemoryObjectStorage()),
      demo: fake(createMemoryObjectStorage()),
    },
    keyManagement: { real: real(kek()), demo: fake(kek()) },
    ...overrides,
  };
}

describe('adapter resolver', () => {
  it('registers every port the application depends on', () => {
    expect([...ADAPTER_PORTS].sort()).toEqual(['email', 'keyManagement', 'objectStorage']);
  });

  it.each(ADAPTER_PORTS.map((port) => [port] as const))(
    'a demo organization gets the fake for %s, and a customer the real one',
    (port) => {
      const entries = registry();
      const resolver = createAdapterResolver(entries);

      expect(resolver.forTenant(DEMO, port)).toBe(entries[port].demo.adapter);
      expect(resolver.forTenant(CUSTOMER, port)).toBe(entries[port].real?.adapter);
      expect(resolver.forTenant(DEMO, port)).not.toBe(resolver.forTenant(CUSTOMER, port));
    },
  );

  it.each(ADAPTER_PORTS.map((port) => [port] as const))(
    'refuses to hand a real %s adapter to a demo organization',
    (port) => {
      const entries = registry();
      const misconfigured = {
        ...entries,
        [port]: { ...entries[port], demo: real(entries[port].real?.adapter) },
      };

      expect(() => createAdapterResolver(misconfigured).forTenant(DEMO, port)).toThrow(
        DemoAdapterError,
      );
    },
  );

  it('refuses a misconfigured registry up front, not at the first demo request', () => {
    const entries = registry();
    const misconfigured: AdapterRegistry = {
      ...entries,
      email: { real: entries.email.real, demo: real(createFakeEmailSender()) },
    };

    expect(() => createAdapterResolver(misconfigured)).toThrow(DemoAdapterError);
  });

  it('a port with no real adapter (storage not configured) is unavailable for customers, not for demos', () => {
    const entries = registry({
      objectStorage: { real: undefined, demo: fake(createMemoryObjectStorage()) },
    });
    const resolver = createAdapterResolver(entries);

    expect(resolver.forTenant(CUSTOMER, 'objectStorage')).toBeUndefined();
    expect(resolver.forTenant(DEMO, 'objectStorage')).toBeDefined();
  });

  it('the error never names an organization or an address', () => {
    const entries = registry({ email: { real: undefined, demo: real(createFakeEmailSender()) } });

    try {
      createAdapterResolver(entries);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain(DEMO.id);
      expect((error as Error).message).toContain('email');
    }
  });
});

describe('email routed by organization', () => {
  it('a message about a demo organization goes to the fake sender, never to the real one', async () => {
    const realSender = createFakeEmailSender();
    const demoSender = createFakeEmailSender();
    const sender = createTenantRoutedEmail(
      createAdapterResolver(
        registry({ email: { real: real(realSender), demo: fake(demoSender) } }),
      ),
    );

    await sender.send({ to: 'a@demo.invalid', subject: 'x', text: 'y', tenant: DEMO });
    await sender.send({ to: 'b@clinica.example', subject: 'x', text: 'y', tenant: CUSTOMER });

    expect(demoSender.sent.map((message) => message.to)).toEqual(['a@demo.invalid']);
    expect(realSender.sent.map((message) => message.to)).toEqual(['b@clinica.example']);
  });

  it('a message that does not say which organization it is about is refused, never guessed', async () => {
    const realSender = createFakeEmailSender();
    const demoSender = createFakeEmailSender();
    const sender = createTenantRoutedEmail(
      createAdapterResolver(
        registry({ email: { real: real(realSender), demo: fake(demoSender) } }),
      ),
    );

    await expect(sender.send({ to: 'c@clinica.example', subject: 'x', text: 'y' })).rejects.toThrow(
      /organization/,
    );

    expect(realSender.sent).toHaveLength(0);
    expect(demoSender.sent).toHaveLength(0);
  });
});
