import { configureAddressHash } from '../../../modules/notifications/index.js';

/**
 * The demo seed writes the message log, and the log keeps a keyed hash of every address (the pepper
 * of the platform). The server hashes with the `ADDRESS_HASH_PEPPER` it was started with; a seed that
 * hashed with the development default would leave rows no reply or failure check could ever match.
 * The scripts that seed call this with their configuration first, so seed and server agree
 * (judgment day round 2, finding A15). Without a configured pepper the development default applies
 * to both.
 */
export function useServerAddressPepper(config: {
  providers: { addressHashPepper?: string | undefined };
}): void {
  configureAddressHash(config.providers.addressHashPepper ?? null);
}
