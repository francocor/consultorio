import { AR_VALIDATION_MESSAGES_ES_AR } from '@consultorio/contracts';
import { createInstance, type i18n as I18n } from 'i18next';
import { initReactI18next } from 'react-i18next';

import { LOCALE } from '../shared/lib/format.js';
import { CORE_RESOURCES } from '../shared/lib/locale-core.js';
import type { Resources } from '../shared/lib/locale-files.js';
import { registerNamespaces, type Namespace } from '../shared/lib/translate.js';

/**
 * The country validators of `@consultorio/contracts` ship their own es-AR texts under
 * `country.ar.*`; they are registered as a namespace so the API's keys resolve unchanged.
 */
const country = Object.fromEntries(
  Object.entries(AR_VALIDATION_MESSAGES_ES_AR).map(([key, message]) => [
    key.replace(/^country\./, ''),
    message,
  ]),
);

export type { Namespace };

export interface I18nOptions {
  /** Called with the key of every message that has no translation (tests fail on it). */
  onMissing?: (key: string) => void;
  /**
   * The catalogs the instance starts with. The application starts with the core catalogs only (what
   * the sign-in page shows) and adds the rest with `loadRemainingCatalogs`; a test that renders
   * screens passes `LOCALE_RESOURCES` (`shared/lib/locale-all.ts`) to have every text in hand.
   */
  resources?: Resources;
}

/**
 * One i18next instance per app (tests create their own). Every catalog file is a flat map, so a
 * key such as `auth.password.too_short` sent by the API resolves to `auth:password.too_short`.
 */
export function createI18n(options: I18nOptions = {}): I18n {
  const resources: Record<Namespace, Record<string, string>> = {
    ...(options.resources ?? CORE_RESOURCES),
    country,
  };
  registerNamespaces(Object.keys(resources));
  const instance = createInstance();
  void instance.use(initReactI18next).init({
    lng: LOCALE,
    fallbackLng: false,
    ns: Object.keys(resources),
    defaultNS: 'common',
    resources: { [LOCALE]: resources },
    keySeparator: false,
    interpolation: { escapeValue: false },
    initAsync: false,
    returnNull: false,
    saveMissing: options.onMissing !== undefined,
    missingKeyHandler: (_languages, namespace, key) => {
      options.onMissing?.(namespace === 'common' ? key : `${namespace}:${key}`);
    },
  });
  return instance;
}

const remaining = new WeakMap<I18n, Promise<void>>();

/**
 * Adds the catalogs that the first bundle does not carry (the texts of the features and the error
 * catalogs of the modules) to the instance. Every frame that is not the sign-in page waits for this
 * before it draws (the signed-in route, the portal, the public pages, the platform host), so a
 * screen never shows a key instead of its text. Safe to call again and again: the chunk is
 * fetched once per instance, and a failed fetch is tried again by the next call.
 */
export function loadRemainingCatalogs(instance: I18n): Promise<void> {
  let loading = remaining.get(instance);
  if (!loading) {
    loading = import('../shared/lib/locale-rest.js').then(({ REST_RESOURCES }) => {
      for (const [namespace, catalog] of Object.entries(REST_RESOURCES)) {
        // Deep, because `errors` has a base in the core and the error catalogs of the modules here.
        instance.addResourceBundle(LOCALE, namespace, catalog, true, false);
      }
      registerNamespaces(Object.keys(REST_RESOURCES));
    });
    remaining.set(instance, loading);
    loading.catch(() => {
      remaining.delete(instance);
    });
  }
  return loading;
}

export { describeError, translateApiKey, type DescribedError } from '../shared/lib/translate.js';
