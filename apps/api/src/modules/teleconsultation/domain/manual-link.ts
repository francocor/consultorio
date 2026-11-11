import { isIP } from 'node:net';

export type ManualLinkProblem = 'not_a_link' | 'not_https' | 'credentials' | 'host_not_allowed';

export type ManualLinkCheck = { ok: true; url: string } | { ok: false; reason: ManualLinkProblem };

/**
 * Checks the address a person pastes as a manual video link (teleconsultation, "Provider failure
 * and manual fallback"). It must be https, carry no credentials and no port, and point at a host
 * the platform allows (`VIDEO_ALLOWED_DOMAINS`) or at a subdomain of one, which is how video
 * services give each account its own host. An empty list allows nothing. The link is returned in
 * its normal form, so what is stored is what was checked.
 */
export function validateManualLink(
  input: string,
  allowedDomains: readonly string[],
): ManualLinkCheck {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, reason: 'not_a_link' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'not_https' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials' };
  if (url.port !== '' || isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0) {
    return { ok: false, reason: 'host_not_allowed' };
  }
  const host = url.hostname.toLowerCase();
  const allowed = allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  if (!allowed) return { ok: false, reason: 'host_not_allowed' };
  return { ok: true, url: url.href };
}
