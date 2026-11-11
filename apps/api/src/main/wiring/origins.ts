import { createPublicOrigins, type PublicOrigins } from '../../platform/http/public-origin.js';
import type { Config } from '../config.js';
import { deploymentFromConfig } from '../deployment.js';

/**
 * Where the links in a message point, built from the configuration as the API builds them. The
 * worker has no request, so a message it renders gets its addresses from here.
 */
export function originsFromConfig(config: Config): PublicOrigins {
  return createPublicOrigins(deploymentFromConfig(config), {
    secure: config.cookieSecure,
    ...(config.publicUrl === undefined ? {} : { publicUrl: config.publicUrl }),
    ...(config.publicPort === undefined ? {} : { port: config.publicPort }),
  });
}
