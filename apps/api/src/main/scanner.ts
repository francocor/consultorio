import { createClamdScanner } from '../adapters/clamav/clamd-client.js';
import { createFakeScanner } from '../adapters/fake-scanner/index.js';
import type { MalwareScanner } from '../platform/scanning/malware-scanner.js';

import type { ScannerConfig } from './config-scanner.js';

export interface ConfiguredScanner {
  scanner: MalwareScanner;
  /** `fake` only flags the EICAR test string: the caller logs a warning for it. */
  kind: 'clamav' | 'fake';
}

/**
 * Composition root for the malware scanner: ClamAV when the deployment configures it, otherwise
 * the fake one. Production never reaches the fake: the configuration refuses to start with a
 * bucket and no scanner, so an unscanned file cannot be released by accident.
 */
export function createConfiguredScanner(config: ScannerConfig | undefined): ConfiguredScanner {
  if (!config) return { scanner: createFakeScanner(), kind: 'fake' };
  return { scanner: createClamdScanner({ host: config.host, port: config.port }), kind: 'clamav' };
}
