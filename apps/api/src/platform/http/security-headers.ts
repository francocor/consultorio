import type { FastifyInstance } from 'fastify';

/**
 * Headers every answer of the API carries (ASVS V14.4, V8.3). The API only returns JSON, problem
 * documents and a few small public files, so the policy is the strictest one: nothing is framed,
 * sniffed, cached by a browser or a shared cache, or leaked through the referrer. A route that has
 * a reason to differ (the public logo is cacheable, with its own sandbox policy) sets its own value
 * first and keeps it.
 *
 * The web bundle is served by the reverse proxy, which sets its own headers (see
 * docs/dev-setup.md, "Reverse proxy contract"); these apply to `/api/*` and the API's own routes.
 */
export function registerSecurityHeaders(app: FastifyInstance, options: { secure: boolean }): void {
  app.addHook('onSend', (_request, reply, payload, done) => {
    const fixed: Record<string, string> = {
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'cross-origin-resource-policy': 'same-origin',
    };
    for (const [name, value] of Object.entries(fixed)) void reply.header(name, value);
    // Defaults a route may replace by setting the header before it answers. The referrer policy is
    // one: a page with a form that posts back to itself (the token pages) needs `same-origin`,
    // because a browser sends `Origin: null` for a POST under `no-referrer`.
    if (!reply.hasHeader('referrer-policy')) void reply.header('referrer-policy', 'no-referrer');
    if (!reply.hasHeader('cache-control')) void reply.header('cache-control', 'no-store');
    if (!reply.hasHeader('content-security-policy')) {
      void reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    }
    if (options.secure) {
      void reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    done(null, payload);
  });
}
