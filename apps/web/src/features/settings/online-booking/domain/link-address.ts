/**
 * The address a patient opens: the origin of the organization (the host the staff are on) and the
 * path the API gives for the link. Null while the API cannot name the path, which happens for a
 * professional until the link of the organization exists.
 */
export function addressOf(origin: string, path: string | null): string | null {
  if (path === null) return null;
  return `${origin.replace(/\/+$/, '')}${path}`;
}
