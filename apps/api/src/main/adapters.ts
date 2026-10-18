import { randomBytes } from 'node:crypto';

import { createFakeEmailSender } from '../adapters/fake-email/index.js';
import { createLocalKeyManagement } from '../adapters/local-kek/index.js';
import { createMemoryObjectStorage } from '../adapters/memory-storage/index.js';
import type { KeyManagement } from '../platform/crypto/key-management.js';
import type { Db } from '../platform/db/pool.js';
import type { ObjectStorage } from '../platform/storage/object-storage.js';

import { assembleAdapterRegistry, fake, real, type AdapterRegistry } from './adapter-resolver.js';
import type { Config } from './config.js';
import type { ConfiguredEmail } from './email.js';
import type { ModuleWiring } from './wiring/types.js';

export interface AdapterRegistryInput {
  config: Config;
  email: ConfiguredEmail;
  /** Undefined when no bucket is configured. */
  storage: ObjectStorage | undefined;
  kms: KeyManagement;
  /** The runtime connection, for the adapters that keep their state in Postgres. */
  db: Db;
  wiring: readonly ModuleWiring[];
}

/**
 * Which adapter serves which organization: a demo organization only ever gets the fakes. The ports
 * of the platform are registered here; the ports of a capability module are registered by the
 * module's own wiring file, and `assembleAdapterRegistry` refuses a port nobody registered or two
 * modules that both claim one. Both the API and the worker process build the registry this way.
 */
export function buildAdapterRegistry(input: AdapterRegistryInput): AdapterRegistry {
  const { config, email, storage, kms } = input;
  return assembleAdapterRegistry([
    {
      email: {
        real: email.kind === 'smtp' ? real(email.sender) : fake(email.sender),
        // Outside production the configured SMTP server is a development catcher (Mailpit): a demo
        // organization's invitations show up there. In production nothing is ever delivered.
        demo: fake(config.nodeEnv === 'production' ? createFakeEmailSender() : email.sender),
      },
      objectStorage: {
        real: storage ? real(storage) : undefined,
        demo: fake(createMemoryObjectStorage()),
      },
      keyManagement: {
        real: real(kms),
        demo: fake(createLocalKeyManagement(randomBytes(32).toString('base64'))),
      },
    },
    ...input.wiring.map((module) => module.adapters?.({ config, db: input.db }) ?? {}),
  ]);
}
