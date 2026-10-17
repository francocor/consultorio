import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Plugin } from 'vite';

import { connectOriginsFrom, contentSecurityPolicy, scriptHash, type CspOptions } from './csp.js';
import { buildInlineScripts } from './theme-boot-plugin.js';

/** Where the build leaves the production policy, for the reverse proxy of the deployment. */
export const POLICY_FILE = 'content-security-policy.txt';

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

/**
 * Sends the Content Security Policy of the web bundle from the Vite servers: the development
 * policy from `vite dev`, the production one from `vite preview` (which serves the production
 * build, so the browser suite checks the real thing). The production proxy sends the same policy:
 * see "Reverse proxy contract" in docs/dev-setup.md.
 *
 * The hashes are computed from the inline scripts exactly as the HTML plugin injects them, so the
 * header can never disagree with the page. The build also writes the production policy to
 * `content-security-policy.txt` next to `index.html`, for the proxy of the deployment to send.
 */
export function cspPlugin(themeBootSource: string): Plugin {
  // The storage origin that receives document uploads, named by the deployment (docs/dev-setup.md).
  const connectSources = connectOriginsFrom(process.env['CSP_CONNECT_SOURCES']);
  const middleware =
    (mode: CspOptions['mode']): Middleware =>
    (_req, res, next) => {
      buildInlineScripts(themeBootSource).then(
        (scripts) => {
          res.setHeader(
            'content-security-policy',
            contentSecurityPolicy({ scriptHashes: scripts.map(scriptHash), mode, connectSources }),
          );
          next();
        },
        () => {
          next();
        },
      );
    };

  return {
    name: 'consultorio:csp',
    configureServer(server) {
      server.middlewares.use(middleware('development'));
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware('production'));
    },
    async generateBundle() {
      const scripts = await buildInlineScripts(themeBootSource);
      this.emitFile({
        type: 'asset',
        fileName: POLICY_FILE,
        source: `${contentSecurityPolicy({ scriptHashes: scripts.map(scriptHash), mode: 'production', connectSources })}
`,
      });
    },
  };
}
