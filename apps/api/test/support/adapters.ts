import { randomBytes } from 'node:crypto';

import { createFakeInvoiceIssuer } from '../../src/adapters/afip-fake/index.js';
import { createFakeBotChallenge } from '../../src/adapters/bot-challenge-fake/index.js';
import { createFakeEmailSender } from '../../src/adapters/fake-email/index.js';
import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import { createMemoryObjectStorage } from '../../src/adapters/memory-storage/index.js';
import { createFakeVideoLinkProvider } from '../../src/adapters/video-fake/index.js';
import { createFakeWhatsAppSender } from '../../src/adapters/whatsapp-fake/index.js';
import {
  assembleAdapterRegistry,
  createAdapterResolver,
  fake,
  real,
  type AdapterResolver,
} from '../../src/main/adapter-resolver.js';
import type { WhatsAppSender } from '../../src/modules/notifications/application/ports.js';
import type { EmailSender } from '../../src/platform/mail/email-sender.js';

/**
 * An adapter resolver for the tests that need the application to know its providers: every port is
 * registered (the registry refuses a missing one), a customer gets the senders the test passes, a
 * demo organization the in-memory fakes.
 */
export function createTestAdapterResolver(
  customer: { whatsapp?: WhatsAppSender; email?: EmailSender } = {},
): AdapterResolver {
  const kek = () => createLocalKeyManagement(randomBytes(32).toString('base64'));
  return createAdapterResolver(
    assembleAdapterRegistry([
      {
        email: {
          real: real(customer.email ?? createFakeEmailSender()),
          demo: fake(createFakeEmailSender()),
        },
        objectStorage: { real: undefined, demo: fake(createMemoryObjectStorage()) },
        keyManagement: { real: real(kek()), demo: fake(kek()) },
        whatsapp: {
          real: customer.whatsapp ? fake(customer.whatsapp) : undefined,
          demo: fake(createFakeWhatsAppSender()),
        },
        videoLink: { real: undefined, demo: fake(createFakeVideoLinkProvider()) },
        botChallenge: { real: undefined, demo: fake(createFakeBotChallenge()) },
        invoiceIssuer: { real: undefined, demo: fake(createFakeInvoiceIssuer()) },
      },
    ]),
  );
}
