/**
 * The one corner of Vite that the API's tests use: `import.meta.glob` with `eager: true`, which
 * Vitest resolves while it transforms the test. Declared here so `apps/api` does not need the
 * whole `vite/client` type package (it is a dependency of the web app and Vitest, not of the API).
 */
interface ImportMeta {
  glob<T = unknown>(
    pattern: string | readonly string[],
    options: { eager: true; import?: string },
  ): Record<string, T>;
}
