/** Only same-origin paths may be a post-sign-in destination (never an open redirect). */
export function safeRedirect(value: unknown): string | undefined {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
    ? value
    : undefined;
}
