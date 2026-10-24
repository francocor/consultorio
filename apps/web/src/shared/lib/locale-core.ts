import { buildResources, type Catalog, type Resources } from './locale-files.js';

/**
 * The catalogs of the first bundle: what the sign-in page and the frame around every screen
 * (the offline banner, the update prompt, the "not found" page) show. `errors` is only the base
 * file here; the error catalogs of the modules (`errors.<module>.json`) come with the rest.
 *
 * The file names are written out because a glob cannot be built at run time. The test in
 * `locale-files.test.ts` fails when this list and `locale-rest.ts` leave a file out or count one twice.
 */
export const CORE_RESOURCES: Resources = buildResources(
  import.meta.glob<Catalog>('../../locales/es-AR/{common,auth,shell,errors}.json', {
    eager: true,
    import: 'default',
  }),
);
