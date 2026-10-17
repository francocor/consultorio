import { fileURLToPath } from 'node:url';

import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import boundaries from 'eslint-plugin-boundaries';
import importX from 'eslint-plugin-import-x';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Shared ESLint flat config.
 *
 * - TypeScript files use typescript-eslint `strictTypeChecked` (type-aware, via projectService).
 * - Plain JS files (configs, scripts) get the base rules only, without type information.
 * - React files (`.jsx`, `.tsx`) also get the React hooks rules and the JSX accessibility rules.
 * - Import order is enforced everywhere.
 * - `eslint-plugin-boundaries` is registered with the repo layout elements. Its dependency rules
 *   are switched on with a default of "allow" and the policies listed below; policies are added as
 *   the modules that need them appear.
 */
export default defineConfig(
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    '**/coverage/**',
    '**/playwright-report/**',
    '**/test-results/**',
    // Planning artifacts and local caches.
    'openspec/**',
    '.atl/**',
    // Agent skills installed by AutoSkills (third-party content).
    '.agents/**',
    '.claude/**',
    // Deliberately wrong code that tests lint with `ignore: false`.
    '**/__fixtures__/**',
  ]),

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
      },
    },
    plugins: {
      'import-x': importX,
      boundaries,
    },
    settings: {
      // Boundaries resolves imports like the compiler does, so `./x.js` finds `./x.ts`.
      'import/resolver': {
        typescript: {
          project: ['apps/*/tsconfig.json', 'packages/*/tsconfig.json'],
          noWarnOnMultipleProjects: true,
        },
      },
      // Element patterns are relative to the repository root, whatever the working directory is
      // (editors and test runners start ESLint from a package folder).
      'boundaries/root-path': fileURLToPath(new URL('../../../', import.meta.url)),
      // File categories: patterns here match single files, unlike elements which match folders.
      'boundaries/files': [
        // The one file allowed to import `country/ar`.
        { category: 'country-registry', pattern: 'apps/api/src/platform/country/country-pack.ts' },
      ],
      'boundaries/elements': [
        { type: 'api-module', pattern: 'apps/api/src/modules/*', capture: ['module'] },
        { type: 'api-platform', pattern: 'apps/api/src/platform/**' },
        { type: 'api-country', pattern: 'apps/api/src/country/**' },
        { type: 'api-adapters', pattern: 'apps/api/src/adapters/**' },
        { type: 'web-feature', pattern: 'apps/web/src/features/*', capture: ['feature'] },
        { type: 'web-shared', pattern: 'apps/web/src/shared/**' },
        { type: 'contracts', pattern: 'packages/contracts/src/**' },
      ],
    },
    rules: {
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'import-x/no-duplicates': 'error',
      'boundaries/dependencies': [
        'error',
        {
          default: 'allow',
          policies: [
            // Country isolation (country-rules-ar): core code never imports the Argentina rules.
            // It asks the CountryPack, and only the registry builds it. Later policies override
            // earlier ones, so the two allows below are exceptions to the first.
            { disallow: { to: { element: { type: 'api-country' } } } },
            {
              from: { file: { categories: 'country-registry' } },
              allow: { to: { element: { type: 'api-country' } } },
            },
            {
              from: { element: { type: 'api-country' } },
              allow: { to: { element: { type: 'api-country' } } },
            },
          ],
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },

  {
    files: ['**/*.{jsx,tsx}'],
    extends: [reactHooks.configs.flat.recommended, jsxA11y.flatConfigs.recommended],
    languageOptions: { globals: { ...globals.browser } },
  },

  {
    files: ['**/*.{js,cjs,mjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
