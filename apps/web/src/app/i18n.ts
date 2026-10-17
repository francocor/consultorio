import { AR_VALIDATION_MESSAGES_ES_AR } from '@consultorio/contracts';
import { createInstance, type i18n as I18n } from 'i18next';
import { initReactI18next } from 'react-i18next';

import audit from '../locales/es-AR/audit.json';
import auth from '../locales/es-AR/auth.json';
import common from '../locales/es-AR/common.json';
import documents from '../locales/es-AR/documents.json';
import errors from '../locales/es-AR/errors.json';
import operator from '../locales/es-AR/operator.json';
import patients from '../locales/es-AR/patients.json';
import settings from '../locales/es-AR/settings.json';
import shell from '../locales/es-AR/shell.json';
import staff from '../locales/es-AR/staff.json';
import { LOCALE } from '../shared/lib/format.js';
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

const RESOURCES = {
  audit,
  auth,
  common,
  country,
  documents,
  errors,
  operator,
  patients,
  settings,
  shell,
  staff,
} as const satisfies Record<Namespace, Record<string, string>>;

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
