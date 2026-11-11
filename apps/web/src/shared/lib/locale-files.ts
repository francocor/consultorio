/**
 * The translation catalogs, found by their file names instead of a list. Every file of
 * `locales/es-AR/` is a flat key-to-text map and its name is its namespace (`messaging.json` is the
 * namespace `messaging`). The error catalog of a module, `errors.<module>.json`, is part of the
 * `errors` namespace, so the API's `errors.<code>` keys resolve unchanged; a module adds its own
 * file and never edits `errors.json`.
 *
 * A feature adds `locales/es-AR/<feature>.json` (and `errors.<module>.json` when it has error
 * codes) and nothing else: `app/i18n.ts` loads whatever is in the folder.
 *
 * The catalogs travel in two parts so the sign-in page downloads only the texts it shows:
 *
 * - `locale-core.ts`: `common`, `auth`, `shell` and `errors.json`, in the first bundle;
 * - `locale-rest.ts`: every other file, a chunk that the screens of the application, the portal and
 *   the public pages load before they draw (`loadRemainingCatalogs` in `app/i18n.ts`).
 *
 * This module only has the functions both parts share. Nothing that ships to the browser may import
 * `locale-all.ts` (the two parts together, for tests).
 */

export type Catalog = Readonly<Record<string, string>>;

/** The texts of every namespace: namespace, then key. */
export type Resources = Record<string, Record<string, string>>;

/** The namespace a catalog file belongs to. */
export function namespaceOfFile(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.json$/, '');
  return name.startsWith('errors.') ? 'errors' : name;
}

/** Groups the files by namespace. A key two files both give to one namespace is an error. */
export function buildResources(files: Readonly<Record<string, Catalog>>): Resources {
  const resources: Resources = {};
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

/** Joins resources that were built apart (the namespace `errors` has files in both parts). */
export function mergeResources(...parts: readonly Resources[]): Resources {
  const merged: Resources = {};
  for (const part of parts) {
    for (const [namespace, catalog] of Object.entries(part)) {
      const target = (merged[namespace] ??= {});
      for (const [key, text] of Object.entries(catalog)) {
        if (key in target) {
          throw new Error(`The key "${key}" of the namespace "${namespace}" is defined twice.`);
        }
        target[key] = text;
      }
    }
  }
  return merged;
}
