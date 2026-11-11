import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { archiveWriterPolicy, legalErasurePolicy } from './policies.js';

/**
 * The bucket policies are written twice on purpose: in code (the integration tests create the same
 * bucket the compose job does) and in `infra/docker-compose.yml` (what a developer runs). This keeps
 * the two equal, so what the immutability test proves is what the development environment enforces.
 */
const compose = readFileSync(
  new URL('../../../../../infra/docker-compose.yml', import.meta.url),
  'utf8',
);

function composePolicy(name: string): unknown {
  const start = compose.indexOf(`  ${name}:\n    content: |\n`);
  expect(start, name).toBeGreaterThan(-1);
  const body = compose.slice(start + `  ${name}:\n    content: |\n`.length);
  const lines: string[] = [];
  for (const line of body.split('\n')) {
    if (line !== '' && !line.startsWith('      ')) break;
    lines.push(line.slice(6));
  }
  return JSON.parse(
    lines.join('\n').replaceAll('${ARCHIVE_S3_BUCKET:-consultorio-archive}', 'consultorio-archive'),
  ) as unknown;
}

describe('the bucket policies of the archive', () => {
  it('are the same in the compose file as in the code', () => {
    expect(composePolicy('archive-writer-policy')).toEqual(
      JSON.parse(archiveWriterPolicy('consultorio-archive')),
    );
    expect(composePolicy('legal-erasure-policy')).toEqual(
      JSON.parse(legalErasurePolicy('consultorio-archive')),
    );
  });

  it('let only the legal-erasure identity delete or bypass a retention, and deny the writer all of it', () => {
    const writer = JSON.parse(archiveWriterPolicy('b')) as {
      Statement: { Effect: string; Action: string[] }[];
    };
    const erasure = JSON.parse(legalErasurePolicy('b')) as {
      Statement: { Effect: string; Action: string[] }[];
    };
    const dangerous = ['s3:DeleteObject', 's3:DeleteObjectVersion', 's3:BypassGovernanceRetention'];

    const writerAllows = writer.Statement.filter((entry) => entry.Effect === 'Allow').flatMap(
      (entry) => entry.Action,
    );
    const writerDenies = writer.Statement.filter((entry) => entry.Effect === 'Deny').flatMap(
      (entry) => entry.Action,
    );
    const erasureAllows = erasure.Statement.flatMap((entry) => entry.Action);

    for (const action of dangerous) {
      expect(writerAllows, action).not.toContain(action);
      expect(writerDenies, action).toContain(action);
      expect(erasureAllows, action).toContain(action);
    }
    // The writer cannot lower the lock of the bucket either.
    expect(writerDenies).toContain('s3:PutBucketObjectLockConfiguration');
    // And the eraser writes nothing: it only removes.
    expect(erasureAllows).not.toContain('s3:PutObject');
  });
});
