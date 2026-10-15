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
 *   stay off until the first modules exist (Stage 1) and are switched on there.
 */
export default defineConfig(
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    '**/coverage/**',
    '**/playwright-report/**',
    '**/test-results/**',
    // Legacy code is reference only and is never linted.
    'BackEnd/**',
    'FrontEnd/**',
    // Planning artifacts and local caches.
    'openspec/**',
    '.atl/**',
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
      // Switched on in Stage 1 once modules exist.
      'boundaries/dependencies': 'off',
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
