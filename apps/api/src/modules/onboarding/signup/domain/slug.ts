import { RESERVED_SLUGS, slugBase, slugWithSuffix } from '../../../operator/index.js';

/**
 * Words that an organization of a self-service signup may not use as its address, on top of the
 * ones the console already keeps (`RESERVED_SLUGS`: the platform's own hosts). They name services
 * a visitor could pass off as the product's (mail, billing, help, status pages) or the hosts of a
 * deployment (storage, the mail catcher, name servers), and a visitor chooses the NAME of the
 * organization, never its address, so the rule is on what the name turns into.
 */
export const SIGNUP_RESERVED_SLUGS: readonly string[] = [
  'ayuda',
  'autodiscover',
  'billing',
  'blog',
  'cdn',
  'cuenta',
  'demo',
  'dev',
  'faq',
  'files',
  'ftp',
  'health',
  'help',
  'imap',
  'mailpit',
  'metrics',
  'minio',
  'ns1',
  'ns2',
  'pop',
  'portal',
  'public',
  'registro',
  'signup',
  'smtp',
  'soporte',
  'staging',
  'test',
  'webmail',
];

/**
 * The address a name turns into when nothing else holds it. A reserved word, in either list, gets
 * `-org` after it, so it can never shadow a host of the platform. The visitor never sees or chooses
 * the result: only the verification email carries it.
 */
export function signupSlugBase(name: string): string {
  const base = slugBase(name);
  return SIGNUP_RESERVED_SLUGS.includes(base) ? `${base}-org` : base;
}

/** True when `slug` is a word the platform keeps for itself. */
export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.includes(slug) || SIGNUP_RESERVED_SLUGS.includes(slug);
}

export { RESERVED_SLUGS, slugWithSuffix };
