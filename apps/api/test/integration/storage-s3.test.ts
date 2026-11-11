import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { GenericContainer, Wait } from 'testcontainers';

import { createS3ObjectStorage } from '../../src/adapters/s3/index.js';
import { describeObjectStorage } from '../support/storage-contract.js';

/**
 * The S3 adapter against a real S3-compatible service: the same MinIO image the local environment
 * runs (`infra/docker-compose.yml`). The contract suite is the one the in-memory fake passes too.
 */
const IMAGE = 'bitnamilegacy/minio:2025.7.23-debian-12-r5';
const USER = 'minio_test';
const PASSWORD = 'minio_test_only_secret';
const BUCKET = 'consultorio-test';

describeObjectStorage('S3 adapter against MinIO', async () => {
  const container = await new GenericContainer(IMAGE)
    .withEnvironment({ MINIO_ROOT_USER: USER, MINIO_ROOT_PASSWORD: PASSWORD })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/ready', 9000).forStatusCode(200))
    .withStartupTimeout(120_000)
    .start();
  const endpoint = `http://${container.getHost()}:${String(container.getMappedPort(9000))}`;
  const credentials = { accessKeyId: USER, secretAccessKey: PASSWORD };

  const admin = new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true, credentials });
  await admin.send(new CreateBucketCommand({ Bucket: BUCKET }));
  admin.destroy();

  const storage = createS3ObjectStorage({
    bucket: BUCKET,
    region: 'us-east-1',
    endpoint,
    forcePathStyle: true,
    credentials,
  });

  return {
    storage,
    async upload(post, body, contentType) {
      // The browser's side: the form fields the service handed out, then the file, last.
      const form = new FormData();
      for (const [name, value] of Object.entries(post.fields)) form.append(name, value);
      // S3 stores the type named in the `Content-Type` field, not the one on the file part, so a
      // client that wants another type has to change the field, which the policy forbids.
      form.set('Content-Type', contentType);
      form.append('file', new Blob([new Uint8Array(body)], { type: contentType }), 'upload');
      const response = await fetch(post.url, { method: 'POST', body: form });
      return response.status;
    },
    async close() {
      storage.close();
      await container.stop();
    },
  };
});
