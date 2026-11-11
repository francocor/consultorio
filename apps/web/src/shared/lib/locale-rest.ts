import { buildResources, type Catalog, type Resources } from './locale-files.js';

/**
 * Every catalog that is not in `locale-core.ts`: the texts of the features and the error catalogs of
 * the modules. Only `loadRemainingCatalogs` (`app/i18n.ts`) imports this module, with `import()`, so
 * the bundler keeps it as a chunk of its own and the sign-in page never downloads it.
 */
export const REST_RESOURCES: Resources = buildResources(
  import.meta.glob<Catalog>(
    ['../../locales/es-AR/*.json', '!../../locales/es-AR/{common,auth,shell,errors}.json'],
    { eager: true, import: 'default' },
  ),
);
