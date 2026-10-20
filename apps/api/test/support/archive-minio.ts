import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

import {
  ARCHIVE_WRITER_USER,
  LEGAL_ERASURE_USER,
  archiveWriterPolicy,
  legalErasurePolicy,
} from '../../src/adapters/archive-local/policies.js';

/**
 * A MinIO of its own for the archive tests, set up the way `infra/docker-compose.yml` sets up the
 * development one: a bucket created with Object Lock (governance mode, a default retention), and two
 * identities with the policies of `adapters/archive-local/policies.ts`. The same image as the local
 * environment, so what is proven here is what a developer runs.
 */
const IMAGE = 'bitnamilegacy/minio:2025.7.23-debian-12-r5';
const ROOT_USER = 'minio_archive_root';
const ROOT_PASSWORD = 'minio_archive_root_dev_only';
const WRITER_SECRET = 'archive_writer_dev_only_secret';
const ERASURE_SECRET = 'legal_erasure_dev_only_secret';

export const ARCHIVE_TEST_BUCKET = 'consultorio-archive';

export interface ArchiveMinio {
  endpoint: string;
  bucket: string;
  region: string;
  root: { accessKeyId: string; secretAccessKey: string };
  writer: { accessKeyId: string; secretAccessKey: string };
  legalErasure: { accessKeyId: string; secretAccessKey: string };
  /** Runs an `mc` command inside the container as the root user (policies, users). */
  mc(...args: string[]): Promise<void>;
  /** Puts a file in the container (a policy to hand to `mc`). */
  putFile(content: string, target: string): Promise<void>;
  stop(): Promise<void>;
}

async function mc(container: StartedTestContainer, ...args: string[]): Promise<void> {
  const result = await container.exec(['mc', ...args]);
  if (result.exitCode !== 0) {
    throw new Error(`mc ${args.slice(0, 3).join(' ')} failed: ${result.output}`);
  }
}

export async function startArchiveMinio(
  options: { retentionDays?: number } = {},
): Promise<ArchiveMinio> {
  const container = await new GenericContainer(IMAGE)
    .withEnvironment({ MINIO_ROOT_USER: ROOT_USER, MINIO_ROOT_PASSWORD: ROOT_PASSWORD })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/ready', 9000).forStatusCode(200))
    .withStartupTimeout(120_000)
    .start();

  // The image restarts MinIO once while it starts: the alias is retried like the compose job does.
  let ready = false;
  for (let attempt = 0; attempt < 30 && !ready; attempt += 1) {
    const set = await container.exec([
      'mc',
      'alias',
      'set',
      'local',
      'http://127.0.0.1:9000',
      ROOT_USER,
      ROOT_PASSWORD,
    ]);
    ready = set.exitCode === 0;
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error('the MinIO of the archive tests did not accept the alias');

  await mc(container, 'mb', '--with-lock', `local/${ARCHIVE_TEST_BUCKET}`);
  await mc(
    container,
    'retention',
    'set',
    '--default',
    'GOVERNANCE',
    `${String(options.retentionDays ?? 3650)}d`,
    `local/${ARCHIVE_TEST_BUCKET}`,
  );
  await container.copyContentToContainer([
    { content: archiveWriterPolicy(ARCHIVE_TEST_BUCKET), target: '/tmp/archive-writer.json' },
    { content: legalErasurePolicy(ARCHIVE_TEST_BUCKET), target: '/tmp/legal-erasure.json' },
  ]);
  await mc(
    container,
    'admin',
    'policy',
    'create',
    'local',
    'archive-writer',
    '/tmp/archive-writer.json',
  );
  await mc(
    container,
    'admin',
    'policy',
    'create',
    'local',
    'legal-erasure',
    '/tmp/legal-erasure.json',
  );
  await mc(container, 'admin', 'user', 'add', 'local', ARCHIVE_WRITER_USER, WRITER_SECRET);
  await mc(container, 'admin', 'user', 'add', 'local', LEGAL_ERASURE_USER, ERASURE_SECRET);
  await mc(
    container,
    'admin',
    'policy',
    'attach',
    'local',
    'archive-writer',
    '--user',
    ARCHIVE_WRITER_USER,
  );
  await mc(
    container,
    'admin',
    'policy',
    'attach',
    'local',
    'legal-erasure',
    '--user',
    LEGAL_ERASURE_USER,
  );

  return {
    endpoint: `http://${container.getHost()}:${String(container.getMappedPort(9000))}`,
    bucket: ARCHIVE_TEST_BUCKET,
    region: 'us-east-1',
    root: { accessKeyId: ROOT_USER, secretAccessKey: ROOT_PASSWORD },
    writer: { accessKeyId: ARCHIVE_WRITER_USER, secretAccessKey: WRITER_SECRET },
    legalErasure: { accessKeyId: LEGAL_ERASURE_USER, secretAccessKey: ERASURE_SECRET },
    mc: (...args) => mc(container, ...args),
    putFile: (content, target) => container.copyContentToContainer([{ content, target }]),
    stop: async () => {
      await container.stop();
    },
  };
}
