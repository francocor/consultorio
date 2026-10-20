# Runbook: the retention archive, its release and its legal erasure

Audience: the platform operators who release archived records, and whoever deploys and keeps the
archive. Status: Stage 6, track C (tasks 6.37 to 6.43). The design is in the tenancy spec, "Retention
archive after cancellation" and "Break-glass release".

## What the archive is

When an organization is cancelled, its owner and each of its professionals can download their export
(`/export`, `/export/clinical`) during a window (`ARCHIVE_AFTER_DAYS`, 30 by default). After that the
worker writes the records of the organization to a **write-once bucket** (Object Lock, governance
mode, `ARCHIVE_RETENTION_DAYS`, ten years by default) and keeps them as the law requires.

- The administrative package and the clinical package of EVERY professional the organization ever had
  (including the ones that left) are archived, so a departed professional's patients are in custody.
- Every object is sealed with AES-256-GCM under a data key of its own. The data keys are wrapped with a
  per-organization RSA-OAEP key, and the private half of that key is sealed to the **releaser** with an
  X25519 sealed box. Nothing in the database or in the bucket opens without `ARCHIVE_RELEASER_KEK`.
- The manifest is plain JSON (names, sizes and a sha256 of each object, no content), so `archive.verify`
  can find a missing, damaged or overwritten object without the key. It runs every few days.
- The hot rows of the organization are never removed by the archive.

## The processes and what each one holds

| Process    | Holds                                                                                        | Does                                                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `api`      | `ARCHIVE_S3_*` (writer), `ARCHIVE_RELEASER_PUBLIC_KEY`                                       | Serves the operator console (`/operator/archives`, `/operator/archive-releases`) and the public release link.             |
| `worker`   | `ARCHIVE_S3_*` (writer), `ARCHIVE_RELEASER_PUBLIC_KEY`                                       | Runs `export.build`, `archive.write` and `archive.verify`. It can seal to the releaser but cannot open anything it wrote. |
| `releaser` | `ARCHIVE_S3_*` (writer), **`ARCHIVE_RELEASER_KEK`**, the database, the files bucket and mail | Runs only `archive.release` and a sweep. The ONE process that can open the archive.                                       |

`api` and `worker` **refuse to start** when `ARCHIVE_RELEASER_KEK` is in their environment. Start the
releaser with the image command `releaser` (`docker run IMAGE releaser`), with its own small
connection pool (six connections by default). It has no HTTP port: override the image health check.

## Making the key pair

The pair is X25519. Make it once per environment, on a trusted machine, and store the private half in
the secrets manager of the releaser alone:

```sh
node -e "const {generateKeyPairSync:g}=require('node:crypto');const j=g('x25519').privateKey.export({format:'jwk'});const b=s=>Buffer.from(s,'base64url').toString('base64');console.log('ARCHIVE_RELEASER_KEK='+b(j.d));console.log('ARCHIVE_RELEASER_PUBLIC_KEY='+b(j.x))"
```

- `ARCHIVE_RELEASER_KEK` goes to the releaser. It is the key to every cancelled organization's records:
  keep an offline, sealed copy with two custodians. **Losing it makes the archive unreadable for good.**
- `ARCHIVE_RELEASER_PUBLIC_KEY` goes to the `api` and the `worker`. It opens nothing.
- Rotating the pair does not re-seal what is already archived (the private key of each organization was
  sealed to the public key of the day it was written). Keep the old private half for as long as those
  archives exist.

The development values in `infra/docker-compose.yml` (profile `app`) are public and for development only.

## The bucket

Create it once with Object Lock and two identities (the compose file does exactly this for the local
environment, in the `archive-init` job):

1. Bucket with Object Lock: `mc mb --with-lock local/consultorio-archive`, default retention
   `GOVERNANCE` for the number of days of `ARCHIVE_RETENTION_DAYS`.
2. Identity `archive-writer` (policy `adapters/archive-local/policies.ts`, `archiveWriterPolicy`): it
   writes, reads and lists. It cannot delete an object, bypass governance retention or change the lock.
   Its credential is `ARCHIVE_S3_ACCESS_KEY_ID` / `ARCHIVE_S3_SECRET_ACCESS_KEY` for the three processes.
3. Identity `legal-erasure` (policy `legalErasurePolicy`): the only one allowed to bypass governance
   retention and delete. Its credential is NOT in any process. It is used by hand, below.

MinIO has no policy condition that forbids a plain overwrite, so the writer could add a version over an
object. The adapter always reads the OLDEST version, and `archive.verify` counts versions and flags any
object with more than one (`overwritten`). In production on S3 use a bucket policy with
`s3:if-none-match` on top.

## Releasing records (break-glass)

A patient, or a professional with a verified registration, who needs records of a cancelled
organization asks the platform. Nothing is released on an email alone. It takes **two different
operators**:

1. **Record** (operator A, console tab "Archivo", "Nueva solicitud"): the organization, who asks (a
   patient is found by document, a professional by registration), the address the link goes to, and the
   reason. The address is where the link goes and nowhere else.
2. **Verify the identity** (operator A): out of band (a call, a video call, a desk), tick the four
   checks: the identity document was seen and is valid, the person is the one in the document, the
   address was confirmed with the person, and the records are theirs (or the registration is valid).
   The server refuses anything less.
3. **Approve** (operator B, a DIFFERENT person): a database constraint refuses the same operator on both
   steps, and the console hides the button from the one who verified. An approval is valid for seven
   days; after that the request expires.
4. **Delivery**: the releaser finds the approved request (it looks every 15 seconds), opens only the scope of the
   requester (a patient: that patient's rows from the administrative package and from the clinical parts
   of the professionals; a professional: their own clinical part), builds a package, and emails a
   single-use link (72 hours) to the address recorded. The organization's owner is told a copy was
   delivered.
5. **Download**: the requester opens the link on the organization's own address, with no session.
   Opening only looks; pressing the button spends the link and downloads once. The package is removed
   from the bucket when the download ends or the link expires.

Every step is in the platform trail: `archive.released` with a `phase` (`recorded`, `identity_verified`,
`approved`, `rejected`, `delivered`, `downloaded`, `failed`, `expired`) and `archive.accessed` when the
archive was decrypted, with who, when and the stated reason. The organization's own trail has nothing:
it is gone.

A request that fails shows `Con error` and a code in the console (for example the requester was not
found in the archive). Record a new one once the cause is clear.

### Checks while it happens

- A request stays `Aprobada` for more than a minute: is the releaser running? Look for
  `releaser started` in its log, and check that it reaches the database and the files bucket.
- `archive.verify` reports `overwritten`, `corrupted` or `missing`: do **not** release. Restore from
  the bucket's versions or from the backup of the bucket, then verify again. Escalate: the archive is
  the legal record.

## Legal erasure

The archive is kept for the legal term. The ONLY way an archived object is removed is a legal order
(a court order, a data protection authority decision). It is a command, not a console button, run by a
person who holds the order and the `legal-erasure` credential:

```sh
ARCHIVE_LEGAL_ERASURE_ACCESS_KEY_ID=legal-erasure \
ARCHIVE_LEGAL_ERASURE_SECRET_ACCESS_KEY='...' \
  pnpm --filter @consultorio/api archive:legal-erase \
  --tenant <uuid> --reference "Oficio 123/2031, Juzgado Civil 5" [--prefix <p>] [--yes]
```

- Without `--yes` it only lists what it would erase. Read the list, then run it again with `--yes`.
- It is limited to one organization's prefix. `--prefix` narrows it further (one professional's part).
- It reads `ARCHIVE_S3_BUCKET`, `ARCHIVE_S3_ENDPOINT`, `ARCHIVE_S3_REGION` and `OPERATOR_DATABASE_URL`
  like the application, but the credential is its own: the writer cannot erase.
- The legal reference and the counts go to the platform trail (`archive.erased`).

## Test restore

`restoreParts` (`modules/tenancy/archive/restore.ts`) opens an archive with the releaser key and checks every object
against the manifest; it is what the release itself uses first. It is a function, not a command yet: the
restore drill of readiness (S6.11) wraps it. Run the drill from a machine that holds `ARCHIVE_RELEASER_KEK`
after a bucket restore or a key rotation, and at least once a year. Verification in the worker is checksum-only: it proves the bytes
are the ones written, and a restore proves they still open.

## Deploy notes

- Migrations `0650` to `0655` create the export and archive tables, the definer functions the worker uses
  to find work without a tenant, and the platform table `archive_release_request`.
- The `releaser` is a separate process in the same image. Give it the database URL of the runtime login,
  the files bucket (the package waits there for its link), the mail settings and the archive settings.
- The `export.build` queue is shared with billing; the worker merges both handlers (see
  `main/wiring/worker.ts`).
- **Pool floor.** The jobs that hold a framework transaction while they wait for an outside service need
  a second connection for their own work. `export.build`, `archive.write` and `archive.verify` do, so
  they count in `CONNECTION_HOLDING_JOBS` (`platform/jobs/concurrency.ts`) and raise `DB_POOL_MAX`. The
  releaser's `archive.release` runs only in its own pool and does not.
- The e2e stack (`pnpm --filter @consultorio/api e2e:stack`) creates the archive bucket, a second
  operator and an in-process releaser, and archives at once (`ARCHIVE_AFTER_DAYS=0`).
