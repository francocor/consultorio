import { AR_VALIDATION_MESSAGES_ES_AR } from '@consultorio/contracts';
import { createInstance, type i18n as I18n } from 'i18next';
import { initReactI18next } from 'react-i18next';

import { LOCALE } from '../shared/lib/format.js';
import { LOCALE_RESOURCES } from '../shared/lib/locale-files.js';
import { NAMESPACES, type Namespace } from '../shared/lib/translate.js';

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

/** Every catalog file of `locales/es-AR` (a feature adds its own file) and the country validators. */
const RESOURCES: Record<Namespace, Record<string, string>> = { ...LOCALE_RESOURCES, country };

export type { Namespace };

export interface I18nOptions {
  /** Called with the key of every message that has no translation (tests fail on it). */
  onMissing?: (key: string) => void;
}

/**
 * One i18next instance per app (tests create their own). Every catalog file is a flat map, so a
 * key such as `auth.password.too_short` sent by the API resolves to `auth:password.too_short`.
 */
export function createI18n(options: I18nOptions = {}): I18n {
  const instance = createInstance();
  void instance.use(initReactI18next).init({
    lng: LOCALE,
    fallbackLng: false,
    ns: NAMESPACES,
    defaultNS: 'common',
    resources: { [LOCALE]: RESOURCES },
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

export { describeError, translateApiKey, type DescribedError } from '../shared/lib/translate.js';
