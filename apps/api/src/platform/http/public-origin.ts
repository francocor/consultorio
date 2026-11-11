/**
 * Where the links we email point. They come from configuration only: never from the `Host` header
 * (or any other header) of the request that triggered the email. A forged `Host` would otherwise
 * put an attacker's address in a password reset or an invitation sent to the victim.
 */
export type PublicOrigins = (tenantSlug: string) => string;

export interface PublicOriginSettings {
  /** `https` unless the deployment is plain-http local development. */
  secure: boolean;
  /** Multi mode, development only: the port the web app is served on (`aillu.localhost:5173`). */
  port?: number;
  /** Single mode: the origin the deployment is served from (`PUBLIC_URL`). */
  publicUrl?: string;
}

export type PublicOriginDeployment = { mode: 'multi'; baseDomain: string } | { mode: 'single' };

/** Parses `PUBLIC_URL` and keeps only its origin (no path, query or credentials). */
function originOfPublicUrl(publicUrl: string): string {
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    throw new Error('PUBLIC_URL must be an http(s) URL such as https://agenda.clinica.example');
  }
  const isHttp = url.protocol === 'https:' || url.protocol === 'http:';
  if (!isHttp || url.username !== '' || url.password !== '') {
    throw new Error('PUBLIC_URL must be an http(s) URL without credentials');
  }
  return url.origin;
}

export function createPublicOrigins(
  deployment: PublicOriginDeployment,
  settings: PublicOriginSettings,
): PublicOrigins {
  if (deployment.mode === 'single') {
    if (settings.publicUrl === undefined) {
      throw new Error('PUBLIC_URL is required when DEPLOYMENT_MODE is single');
    }
    const origin = originOfPublicUrl(settings.publicUrl);
    return () => origin;
  }
  const scheme = settings.secure ? 'https' : 'http';
  const port = settings.port === undefined ? '' : `:${String(settings.port)}`;
  return (tenantSlug) => `${scheme}://${tenantSlug}.${deployment.baseDomain}${port}`;
}
