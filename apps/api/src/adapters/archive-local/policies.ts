/**
 * The two identities of the local archive bucket (MinIO), as bucket policies. They are the second
 * wall of the retention archive: the application refuses to overwrite or remove an archived object,
 * and the store refuses it too, whatever the application does.
 *
 * - `archive-writer`: the credential of the API, the worker and the releaser. It writes objects (with
 *   their Object Lock retention), reads them and lists them. It can NOT delete an object or a version
 *   of it, can NOT bypass a governance retention, and can NOT touch the lock configuration of the
 *   bucket (shorten the default retention) or the retention of an object.
 * - `legal-erasure`: the only identity with `s3:BypassGovernanceRetention` and the right to delete a
 *   version. It is used by `pnpm archive:legal-erase --reference <text>` and by nothing else; the
 *   procedure records the legal reference in the platform trail.
 *
 * MinIO's root user is not used by the application at all: it only creates the bucket and these
 * two users when the environment is set up (`infra/docker-compose.yml`, `bootstrap.ts`).
 */

export const ARCHIVE_WRITER_USER = 'archive-writer';
export const LEGAL_ERASURE_USER = 'legal-erasure';

export function archiveWriterPolicy(bucket: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: [
          's3:PutObject',
          's3:GetObject',
          's3:GetObjectRetention',
          's3:PutObjectRetention',
          's3:ListBucket',
          's3:GetBucketObjectLockConfiguration',
          's3:GetBucketVersioning',
        ],
        Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
      },
      {
        Effect: 'Deny',
        Action: [
          's3:DeleteObject',
          's3:DeleteObjectVersion',
          's3:BypassGovernanceRetention',
          's3:PutBucketObjectLockConfiguration',
          's3:PutBucketVersioning',
          's3:DeleteBucket',
        ],
        Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
      },
    ],
  });
}

export function legalErasurePolicy(bucket: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: [
          's3:GetObject',
          's3:ListBucket',
          's3:ListBucketVersions',
          's3:DeleteObject',
          's3:DeleteObjectVersion',
          's3:BypassGovernanceRetention',
        ],
        Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
      },
    ],
  });
}
