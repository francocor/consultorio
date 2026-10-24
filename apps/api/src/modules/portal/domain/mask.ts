/** `l***@example.test`: enough to tell whose address it is, no more. */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 1) return '***';
  return `${address.slice(0, 1)}***${address.slice(at)}`;
}
