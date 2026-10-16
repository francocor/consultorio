import { defineConfig } from 'eslint/config';

/**
 * Rules of the web app (`apps/web/src`), on top of the base preset.
 *
 * 1. No literal user-facing text in JSX (SHL-05): every string goes through the i18n catalog, so
 *    another locale needs no code change.
 * 2. No persistence of query data or any browser storage (SHL-09): protected health data must not
 *    outlive the session on the device. The few files allowed to use storage hold only the look of
 *    the organization (theme tokens) or the color scheme preference.
 */

const LETTER = String.raw`/\p{L}/u`;

const JSX_TEXT_RULES = [
  {
    selector: `JSXText[value=${LETTER}]`,
    message:
      'Literal text in JSX. Use t() with a key from locales/es-AR so the string is translatable.',
  },
  {
    selector: `JSXElement > JSXExpressionContainer > Literal[value=${LETTER}]`,
    message:
      'Literal text in JSX. Use t() with a key from locales/es-AR so the string is translatable.',
  },
  {
    selector: `JSXAttribute[name.name=/^(aria-label|aria-description|aria-placeholder|placeholder|title|alt|label)$/] > Literal[value=${LETTER}]`,
    message:
      'Literal user-facing attribute. Use t() with a key from locales/es-AR so the string is translatable.',
  },
];

const STORAGE_RULES = [
  {
    selector: "Identifier[name='persistQueryClient']",
    message: 'Query data must never be persisted: it can hold protected health data (SHL-09).',
  },
  {
    selector: 'MemberExpression[property.name=/^(localStorage|sessionStorage|indexedDB)$/]',
    message:
      'Browser storage is forbidden outside the theme and color-scheme files: nothing clinical may stay on the device (SHL-09).',
  },
  {
    selector: 'Identifier[name=/^(localStorage|sessionStorage|indexedDB)$/]',
    message:
      'Browser storage is forbidden outside the theme and color-scheme files: nothing clinical may stay on the device (SHL-09).',
  },
];

const PERSIST_IMPORTS = {
  patterns: [
    {
      group: ['@tanstack/*persist*', '@tanstack/*persister*', '@tanstack/query-*-persister'],
      message:
        'Persisting the query cache would keep protected health data on the device (SHL-09).',
    },
  ],
};

/** Files that may touch storage because they only keep non-sensitive display preferences. */
const STORAGE_ALLOWED = [
  'apps/web/src/app/theme-boot.ts',
  'apps/web/src/shared/lib/color-scheme.ts',
];

export default defineConfig(
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}', '**/shared/test/**'],
    rules: {
      'no-restricted-syntax': ['error', ...JSX_TEXT_RULES, ...STORAGE_RULES],
      'no-restricted-imports': ['error', PERSIST_IMPORTS],
    },
  },
  {
    files: STORAGE_ALLOWED,
    rules: {
      'no-restricted-syntax': ['error', ...JSX_TEXT_RULES],
    },
  },
);
