import { CORE_RESOURCES } from './locale-core.js';
import { mergeResources } from './locale-files.js';
import { REST_RESOURCES } from './locale-rest.js';

/**
 * Every catalog of the application at once, for tests and tools that need all the texts in hand.
 * The application itself never imports this module (that would put the whole catalog back in the
 * first bundle): it takes the core with the bundle and the rest with `loadRemainingCatalogs`.
 */
export const LOCALE_RESOURCES = mergeResources(CORE_RESOURCES, REST_RESOURCES);
