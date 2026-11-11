import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));

/** Lints with the repository's real ESLint config; fixtures are ignored in normal runs. */
async function boundaryMessages(file: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: REPO_ROOT, ignore: false });
  const [result] = await eslint.lintFiles([file]);
  return (result?.messages ?? [])
    .filter((message) => message.ruleId?.startsWith('boundaries/') ?? false)
    .map((message) => message.message);
}

describe('country pack isolation (lint)', () => {
  it('rejects a file that imports country/ar directly', async () => {
    const messages = await boundaryMessages(here('./__fixtures__/imports-ar-directly.ts'));

    expect(messages).toHaveLength(1);
  }, 120_000);

  it('accepts a file that goes through the registry', async () => {
    const messages = await boundaryMessages(here('./__fixtures__/uses-registry.ts'));

    expect(messages).toEqual([]);
  }, 120_000);

  it('lets the registry itself import country/ar', async () => {
    const messages = await boundaryMessages(here('./country-pack.ts'));

    expect(messages).toEqual([]);
  }, 120_000);
});
