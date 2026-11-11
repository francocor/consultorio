import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf',
};

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Maps a URL path to a file under `root`, or `null` when it would leave the folder. The path is decoded
 * once, and anything with a NUL, a backslash or a `..` part is refused rather than cleaned up.
 */
export function resolveInside(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const parts = decoded.split('/').filter((part) => part !== '');
  if (parts.some((part) => part === '..' || part === '.')) return null;
  const target = normalize(join(root, ...parts));
  const base = normalize(root);
  return target === base || target.startsWith(base + sep) ? target : null;
}

/** How long a browser may keep a file without asking again. */
function cacheControlFor(urlPath: string): string {
  // The build names these files after their content, so they never change under the same name.
  if (urlPath.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  // The page, the service worker and everything else are checked on every use.
  return 'no-cache';
}

export interface StaticOptions {
  /** The folder of the web bundle (`apps/web/dist`). */
  root: string;
  /** Headers added to every response of the bundle (the Content Security Policy). */
  headers: Record<string, string>;
}

interface Found {
  path: string;
  size: number;
  mtimeMs: number;
}

async function fileAt(path: string): Promise<Found | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? { path, size: info.size, mtimeMs: info.mtimeMs } : null;
  } catch {
    return null;
  }
}

/**
 * Serves the web bundle. Unknown paths answer `index.html` so the router of the app handles them, except
 * when they look like a file (`/assets/x.js`): a missing script must be a 404, not a page of HTML.
 */
export async function serveStatic(
  options: StaticOptions,
  request: IncomingMessage,
  response: ServerResponse,
  urlPath: string,
): Promise<void> {
  const method = request.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD', ...options.headers });
    response.end();
    return;
  }
  const mapped = resolveInside(options.root, urlPath === '/' ? '/index.html' : urlPath);
  let found = mapped === null ? null : await fileAt(mapped);
  let servedPath = urlPath;
  if (found === null) {
    const looksLikeFile = extname(urlPath) !== '' || urlPath.startsWith('/assets/');
    if (mapped === null || looksLikeFile) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...options.headers });
      response.end(method === 'HEAD' ? undefined : 'No encontrado');
      return;
    }
    found = await fileAt(join(options.root, 'index.html'));
    servedPath = '/index.html';
    if (found === null) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...options.headers });
      response.end(method === 'HEAD' ? undefined : 'No encontrado');
      return;
    }
  }
  const etag = `W/"${found.size.toString(16)}-${Math.floor(found.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': contentTypeFor(found.path),
    'Cache-Control': cacheControlFor(servedPath === '/index.html' ? '/' : urlPath),
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
    ...options.headers,
  };
  if (request.headers['if-none-match'] === etag) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  response.writeHead(200, { ...headers, 'Content-Length': String(found.size) });
  if (method === 'HEAD') {
    response.end();
    return;
  }
  const stream = createReadStream(found.path);
  stream.on('error', () => {
    response.destroy();
  });
  stream.pipe(response);
}
