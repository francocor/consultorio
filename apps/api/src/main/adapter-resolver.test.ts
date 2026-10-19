import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createFakeInvoiceIssuer } from '../adapters/afip-fake/index.js';
import { createFakeBotChallenge } from '../adapters/bot-challenge-fake/index.js';
import { createFakeEmailSender } from '../adapters/fake-email/index.js';
import { createLocalKeyManagement } from '../adapters/local-kek/index.js';
import { createMemoryObjectStorage } from '../adapters/memory-storage/index.js';
import { createFakeVideoLinkProvider } from '../adapters/video-fake/index.js';
import { createFakeWhatsAppSender } from '../adapters/whatsapp-fake/index.js';

import {
  ADAPTER_PORTS,
  assembleAdapterRegistry,
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
    // The Stage 3 ports have no real adapter yet: customers run on the local simulators, which
    // the tracks register as fakes (a simulator has no effect outside the process).
    whatsapp: { real: undefined, demo: fake(createFakeWhatsAppSender()) },
    videoLink: { real: undefined, demo: fake(createFakeVideoLinkProvider()) },
    botChallenge: { real: undefined, demo: fake(createFakeBotChallenge()) },
    // Stage 4: the invoice issuer. Customers run on the AFIP simulator the invoicing track registers.
    invoiceIssuer: { real: undefined, demo: fake(createFakeInvoiceIssuer()) },
    ...overrides,
  };
}

describe('adapter resolver', () => {
  it('registers every port the application depends on', () => {
    expect([...ADAPTER_PORTS].sort()).toEqual([
      'botChallenge',
      'email',
      'invoiceIssuer',
      'keyManagement',
      'objectStorage',
      'videoLink',
      'whatsapp',
    ]);
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

describe('assembling the registry from the modules', () => {
  const { email, objectStorage, keyManagement, whatsapp, videoLink, botChallenge, invoiceIssuer } =
    registry();

  it('joins what the composition root and each module register into one complete registry', () => {
    const assembled = assembleAdapterRegistry([
      { email, objectStorage, keyManagement },
      { whatsapp },
      { videoLink },
      { botChallenge },
      { invoiceIssuer },
    ]);

    expect(Object.keys(assembled).sort()).toEqual([...ADAPTER_PORTS].sort());
    expect(assembled.whatsapp).toBe(whatsapp);
  });

  it('refuses to start when a port has no adapter at all, naming the port', () => {
    expect(() =>
      assembleAdapterRegistry([
        { email, objectStorage, keyManagement, whatsapp, videoLink, invoiceIssuer },
      ]),
    ).toThrow(/botChallenge/);
    expect(() =>
      assembleAdapterRegistry([
        { email, objectStorage, keyManagement, whatsapp, videoLink, botChallenge },
      ]),
    ).toThrow(/invoiceIssuer/);
    expect(() => assembleAdapterRegistry([])).toThrow(/email.*whatsapp|whatsapp.*email/s);
  });

  it('refuses a port that two modules both register: the second would silently win', () => {
    expect(() =>
      assembleAdapterRegistry([
        { email, objectStorage, keyManagement, whatsapp, videoLink, botChallenge, invoiceIssuer },
        { whatsapp },
      ]),
    ).toThrow(/whatsapp.*twice/);
    expect(() =>
      assembleAdapterRegistry([
        { email, objectStorage, keyManagement, whatsapp, videoLink, botChallenge, invoiceIssuer },
        { invoiceIssuer },
      ]),
    ).toThrow(/invoiceIssuer.*twice/);
  });
});
