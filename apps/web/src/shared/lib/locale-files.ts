/**
 * The translation catalogs, found by their file names instead of a list. Every file of
 * `locales/es-AR/` is a flat key-to-text map and its name is its namespace (`messaging.json` is the
 * namespace `messaging`). The error catalog of a module, `errors.<module>.json`, is part of the
 * `errors` namespace, so the API's `errors.<code>` keys resolve unchanged; a module adds its own
 * file and never edits `errors.json`.
 *
 * A feature adds `locales/es-AR/<feature>.json` (and `errors.<module>.json` when it has error
 * codes) and nothing else: `app/i18n.ts` loads whatever is in the folder.
 */

export type Catalog = Readonly<Record<string, string>>;

/** The namespace a catalog file belongs to. */
export function namespaceOfFile(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.json$/, '');
  return name.startsWith('errors.') ? 'errors' : name;
}

/** Groups the files by namespace. A key two files both give to one namespace is an error. */
export function buildResources(
  files: Readonly<Record<string, Catalog>>,
): Record<string, Record<string, string>> {
  const resources: Record<string, Record<string, string>> = {};
  for (const [path, catalog] of Object.entries(files)) {
    const namespace = namespaceOfFile(path);
    const target = (resources[namespace] ??= {});
    for (const [key, text] of Object.entries(catalog)) {
      if (key in target) {
        throw new Error(
          `The key "${key}" of the namespace "${namespace}" is defined twice (${path}).`,
        );
      }
      target[key] = text;
    }
  }
  return resources;
}

/** Every catalog of the application, loaded with the bundle. */
export const LOCALE_RESOURCES: Record<string, Record<string, string>> = buildResources(
  import.meta.glob<Catalog>('../../locales/es-AR/*.json', { eager: true, import: 'default' }),
);
