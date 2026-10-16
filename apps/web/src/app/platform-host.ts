/**
 * The platform operator console lives on its own host (`platform.<base domain>`), never on an
 * organization's. The first label decides, unless a deployment names the host explicitly
 * (`VITE_PLATFORM_HOST`), so nothing about customers is hardcoded here.
 */
export function isPlatformHost(host: string, configured?: string): boolean {
  const name = host.toLowerCase().split(':')[0] ?? '';
  if (name === '') return false;
  if (configured !== undefined && configured !== '') {
    return name === configured.toLowerCase().split(':')[0];
  }
  return name.split('.')[0] === 'platform';
}

export function onPlatformHost(): boolean {
  const configured: unknown = import.meta.env['VITE_PLATFORM_HOST'];
  return isPlatformHost(
    window.location.host,
    typeof configured === 'string' ? configured : undefined,
  );
}
