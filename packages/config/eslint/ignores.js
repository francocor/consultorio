/**
 * Folders no one lints. One list for the ESLint config (`globalIgnores`) and for the runner that
 * splits the lint into processes (`shards.js`), so the runner never counts, or hands to ESLint, a
 * folder the config ignores.
 *
 * A pattern is `**` + `/name/**` (a folder of that name anywhere) or `name/**` (a top-level folder).
 */
export const GLOBAL_IGNORES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/coverage/**',
  '**/playwright-report/**',
  '**/test-results/**',
  // Planning artifacts and local caches.
  'openspec/**',
  '.atl/**',
  // Agent skills installed by AutoSkills (third-party content).
  '.agents/**',
  '.claude/**',
  // Deliberately wrong code that tests lint with `ignore: false`.
  '**/__fixtures__/**',
];

/**
 * True for a folder (path relative to the repository root, forward slashes) that
 * `GLOBAL_IGNORES` covers.
 */
export function isIgnoredFolder(relativePath) {
  const parts = relativePath.split('/');
  return GLOBAL_IGNORES.some((pattern) => {
    if (pattern.startsWith('**/')) {
      const name = pattern.slice(3, -3);
      return parts.includes(name);
    }
    const prefix = pattern.slice(0, -3);
    return relativePath === prefix || relativePath.startsWith(`${prefix}/`);
  });
}
