import { createAwsKeyManagement, createKmsClient } from '../adapters/aws-kms/index.js';
import { createLocalKeyManagement } from '../adapters/local-kek/index.js';
import type { KeyManagement } from '../platform/crypto/key-management.js';

import type { KmsConfig } from './config.js';

/**
 * Composition root for key management: the configuration picks the adapter. Production
 * configuration cannot select the local one (see `loadConfig`).
 */
export function createKeyManagement(config: KmsConfig): KeyManagement {
  if (config.provider === 'aws') {
    return createAwsKeyManagement(createKmsClient(config.region), config.keyId);
  }
  return createLocalKeyManagement(config.kekBase64);
}
