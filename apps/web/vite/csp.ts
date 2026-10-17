import { createHash } from 'node:crypto';

/** The CSP source for an inline script: `'sha256-<base64 of the SHA-256 of its text>'`. */
export function scriptHash(code: string): string {
  return `'sha256-${createHash('sha256').update(code).digest('base64')}'`;
}

export interface CspOptions {
  /** Hashes of the inline scripts the page is allowed to run (see `buildInlineScripts`). */
  scriptHashes: readonly string[];
  /**
   * `production`: the policy the reverse proxy must send (docs/dev-setup.md, "Reverse proxy
   * contract"). `development`: the same policy plus what the Vite dev server needs.
   */
  mode: 'production' | 'development';
  /**
   * Extra origins the page may connect to: the object storage that receives the document uploads
   * straight from the browser (a presigned POST). Empty when documents are not used.
   */
  connectSources?: readonly string[];
}

/**
 * The origins in a list the deployment provides (`CSP_CONNECT_SOURCES`), separated by commas or
 * spaces. Only plain http(s) origins survive, reduced to scheme, host and port: a wildcard, a
 * keyword such as `'unsafe-inline'`, another scheme or a malformed entry is dropped, so this setting
 * can name a storage service and can never loosen the policy.
 */
export function connectOriginsFrom(list: string | undefined): string[] {
  const origins = new Set<string>();
  for (const entry of (list ?? '').split(/[\s,]+/)) {
    if (entry === '') continue;
    try {
      const url = new URL(entry);
      const web = url.protocol === 'https:' || url.protocol === 'http:';
      if (web && url.username === '' && url.password === '') origins.add(url.origin);
    } catch {
      // Not a URL: dropped.
    }
  }
  return [...origins];
}

/**
 * The Content Security Policy of the web bundle (ASVS 14.4.7).
 *
 * - Scripts: this origin and the hashes of the two inline scripts of `index.html` (zod without code
 *   generation, and the theme boot, which paints the organization's colors before the first
 *   frame). No `unsafe-inline`, no `unsafe-eval`.
 * - Styles: this origin and inline styles. Libraries (the toast queue) add `<style>` elements and
 *   React sets style properties; a style cannot run code, so this is the one relaxation.
 * - Everything else (API calls, fonts, the manifest, the service worker) is the same origin,
 *   images may also be `data:` (the QR code of the second factor) or `blob:` (a logo preview).
 *
 * The development policy adds `unsafe-inline` for scripts (the React refresh preamble the dev
 * server injects is inline) and websockets (hot reload); nothing else changes, so a request to a
 * foreign origin is still caught while developing.
 */
export function contentSecurityPolicy(options: CspOptions): string {
  const development = options.mode === 'development';
  const directives: [string, readonly string[]][] = [
    ['default-src', ["'self'"]],
    [
      'script-src',
      ["'self'", ...options.scriptHashes, ...(development ? ["'unsafe-inline'"] : [])],
    ],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:']],
    ['font-src', ["'self'"]],
    [
      'connect-src',
      ["'self'", ...(options.connectSources ?? []), ...(development ? ['ws:', 'wss:'] : [])],
    ],
    ['manifest-src', ["'self'"]],
    ['worker-src', ["'self'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
    ...(development ? [] : ([['upgrade-insecure-requests', []]] as [string, readonly string[]][])),
  ];
  return directives
    .map(([name, sources]) => (sources.length === 0 ? name : `${name} ${sources.join(' ')}`))
    .join('; ');
}
