import { resolve } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const fixture = (name: string) => resolve(import.meta.dirname, '__fixtures__', name);

/** Lints with the repository's real config; fixtures are ignored in normal runs. */
async function restrictions(file: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: REPO_ROOT, ignore: false });
  const [result] = await eslint.lintFiles([file]);
  return (result?.messages ?? [])
    .filter((message) => message.ruleId?.startsWith('no-restricted-') ?? false)
    .map((message) => message.message);
}

describe('web lint rules', () => {
  it('rejects literal text, literal attributes and string expressions in JSX', async () => {
    const messages = await restrictions(fixture('literal-jsx.tsx'));

    // "Guardar", the title attribute and {'Sin resultados'}.
    expect(messages).toHaveLength(3);
    expect(messages.every((message) => message.includes('t()'))).toBe(true);
  }, 120_000);

  it('accepts markup whose text comes from the catalog', async () => {
    expect(await restrictions(fixture('translated-jsx.tsx'))).toEqual([]);
  }, 120_000);

  it('rejects persisting the query cache (SHL-09)', async () => {
    const messages = await restrictions(fixture('persists-query-cache.ts'));

    expect(messages.some((message) => message.includes('persisted'))).toBe(true);
    expect(messages.some((message) => message.includes('Persisting the query cache'))).toBe(true);
  }, 120_000);

  it('rejects browser storage outside the allowed files (SHL-09)', async () => {
    const messages = await restrictions(fixture('stores-in-browser-storage.ts'));

    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages.every((message) => message.includes('storage'))).toBe(true);
  }, 120_000);

  it('lets the theme boot module use storage for the look of the organization', async () => {
    const messages = await restrictions(
      resolve(REPO_ROOT, 'apps/web/src/shared/lib/theme-boot.ts'),
    );

    expect(messages).toEqual([]);
  }, 120_000);
});
