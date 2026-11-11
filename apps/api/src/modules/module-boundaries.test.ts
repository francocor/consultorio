import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));

/** Lints with the repository's real ESLint config; fixtures are ignored in normal runs. */
async function boundaryMessages(file: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: REPO_ROOT, ignore: false });
  const [result] = await eslint.lintFiles([file]);
  return (result?.messages ?? [])
    .filter((message) => message.ruleId?.startsWith('boundaries/') ?? false)
    .map((message) => message.message);
}

describe('module boundaries (lint): modules talk to each other only through index.ts', () => {
  it('rejects a module that reaches into the internals of another module', async () => {
    const messages = await boundaryMessages(
      here('./scheduling/__fixtures__/reaches-into-another-module.ts'),
    );

    expect(messages).toHaveLength(1);
  }, 120_000);

  it('accepts a module that uses the public API (index.ts) of another', async () => {
    const messages = await boundaryMessages(here('./scheduling/__fixtures__/uses-the-index.ts'));

    expect(messages).toEqual([]);
  }, 120_000);

  it('accepts a module that imports its own internals', async () => {
    const messages = await boundaryMessages(
      here('./scheduling/__fixtures__/uses-own-internals.ts'),
    );

    expect(messages).toEqual([]);
  }, 120_000);

  it('leaves the real modules clean', async () => {
    const eslint = new ESLint({ cwd: REPO_ROOT });
    const results = await eslint.lintFiles(['apps/api/src/modules/**/*.ts']);
    const violations = results.flatMap((result) =>
      result.messages
        .filter((message) => message.ruleId?.startsWith('boundaries/') ?? false)
        .map((message) => `${result.filePath}: ${message.message}`),
    );

    expect(violations).toEqual([]);
  }, 240_000);
});
