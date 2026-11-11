import { resolve } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

const fixture = (path: string) => resolve(REPO_ROOT, 'apps/web/src/features', path);

/** Lints with the repository's real configuration; fixtures are ignored in normal runs. */
async function boundaryMessages(file: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: REPO_ROOT, ignore: false });
  const [result] = await eslint.lintFiles([file]);
  return (result?.messages ?? [])
    .filter((message) => message.ruleId?.startsWith('boundaries/') ?? false)
    .map((message) => message.message);
}

describe('feature boundaries (lint): a feature reaches another only through its index.ts', () => {
  it('rejects a feature added after Stage 2 that imports a file inside another feature', async () => {
    const messages = await boundaryMessages(
      fixture('_lint/__fixtures__/reaches-into-another-feature.ts'),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('components/PatientPicker.tsx');
  }, 120_000);

  it('accepts a new feature that imports the shared kit and the shell', async () => {
    expect(await boundaryMessages(fixture('_lint/__fixtures__/uses-the-shared-kit.ts'))).toEqual(
      [],
    );
  }, 120_000);

  it('leaves the features of Stages 1 and 2 as they are: they are exempt until they get an index', async () => {
    const messages = await boundaryMessages(
      fixture('calendar/__fixtures__/reaches-into-another-feature.ts'),
    );

    expect(messages).toEqual([]);
  }, 120_000);
});
