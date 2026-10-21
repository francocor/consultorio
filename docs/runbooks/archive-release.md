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
  can find a missing, damaged or overwritten object without the key. It runs every week. It is a
  **checksum** check: it proves the bytes are the ones that were written, not that they still open. That
  they open is the restore drill, a separate procedure (see "Test restore" below).
- The hot rows of the organization are never removed by the archive.
- The plain zips of the export (`t/{organization}/cancellation-export/...`) are NOT kept for ever: once the
  download window is over AND the archive of the organization is written and its last verification was
  `ok`, the worker removes them, records `object_removed_at` on each package and writes the entry
  `export.cancellation.removed` in the organization's trail. The owner then sees "El paquete ya no está
  disponible". A verification that found a problem keeps the plain copy (it may be the only good one).

## The processes and what each one holds

| Process    | Holds                                                                                                                        | Does                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `api`      | `ARCHIVE_RELEASER_PUBLIC_KEY`, the database as `app_rw`                                                                      | Serves the operator console (`/operator/archives`, `/operator/archive-releases`) and the public release link.             |
| `worker`   | `ARCHIVE_S3_*` (writer), `ARCHIVE_RELEASER_PUBLIC_KEY`, the database as `app_rw`                                             | Runs `export.build`, `archive.write` and `archive.verify`. It can seal to the releaser but cannot open anything it wrote. |
| `releaser` | `ARCHIVE_S3_*` (writer), **`ARCHIVE_RELEASER_KEK`**, **`RELEASER_DATABASE_URL`** (`app_releaser`), the files bucket and mail | Runs only `archive.release` and a sweep. The ONE process that can open the archive. It needs NO `KMS_*`.                  |

`api` and `worker` **refuse to start** when `ARCHIVE_RELEASER_KEK` or `RELEASER_DATABASE_URL` is in
their environment, and the `api` refuses to start in production with `ARCHIVE_S3_ACCESS_KEY_ID` (it never
writes the archive; outside production it simply leaves the archive store out of its adapters). Start the
releaser with the image command `releaser` (`docker run IMAGE releaser`), with its own small connection
pool (six connections by default). It has no HTTP port: override the image health check. In production
`ARCHIVE_RELEASER_KEK` must not be the development key of the repository, `ARCHIVE_S3_ENDPOINT` must be
https and `ARCHIVE_AFTER_DAYS` must be at least 1; the application refuses to start otherwise.

### The database role of the releaser

The releaser connects as its own login, `app_releaser`, a **member of `app_rw`** (so it keeps everything
it used) that holds what migration `0688` takes away from `app_rw`: the delivery columns of
`archive_release_request` (`status`, `released_at`, `package_*`, `link_expires_at`, `failure_code`), the
functions that say what to carry out (`archive_release_due`, `archive_release_cleanup_due`,
`archive_release_expire_stale`), its heartbeat, and the audit entries of a release
(`app.write_release_audit`). The API keeps the download side (`downloaded_at`, the lease of the
download) and one function that writes the entry of a download (`app.write_download_audit`). The worker
keeps `archive.written` and `archive.verified`. A written archive can no longer be changed by any of
the application roles (trigger `tenant_archive_guard`).

- **The role must exist BEFORE the migration** (it refuses to run without it). Locally
  `infra/postgres/init/01-roles.sql` creates it on a new database. On an existing database, as a
  superuser: `CREATE ROLE app_releaser LOGIN PASSWORD '...' NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;`
  `GRANT app_rw TO app_releaser WITH INHERIT TRUE, SET FALSE;`
  `GRANT CONNECT ON DATABASE <name> TO app_releaser;`. In production the infrastructure provisions it with
  a managed secret.
- **What is left:** the API and the worker still share `app_rw`; and `archive_key.wrapped_private_key` is
  readable by `app_rw` (it is sealed to the releaser, opaque without `ARCHIVE_RELEASER_KEK`, and the
  writer needs the table to insert the key). Splitting those is the next step if the threat model asks.

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
organization asks the platform. Nothing is released on an email alone. It takes **three pairs of eyes**
(the person who records, the person who verifies the identity, and the person who approves; the first two
may be the same operator, the approver is neither):

1. **Record** (operator A, console tab "Archivo", "Nueva solicitud"): the organization, who asks (a
   patient is found by document, a professional by registration), the address the link goes to, and the
   reason. The address is where the link goes and nowhere else.
2. **Verify the identity** (operator A): out of band (a call, a video call, a desk), tick the four
   checks: the identity document was seen and is valid, the person is the one in the document, the
   address was confirmed with the person, and the records are theirs (or the registration is valid).
   The server refuses anything less.
3. **Approve** (operator B, a DIFFERENT person from the one who recorded and the one who verified): two
   database constraints refuse it, and the console hides the button from them. Each step also carries the
   operator of the session (a trigger refuses a step that names anybody else, and refuses any later change of
   who recorded, verified, approved or rejected: on every update, not only on a change of status; JD-S6 R2-2).
   The setting that carries the operator (`app.user_id`) protects against bugs and misuse of the console, NOT
   against a hostile database credential, which can set it to anything. A request that waits seven
   days in `requested` or `identity_verified` is closed as `expired` by the releaser and cannot be
   approved late. An approval is valid for seven days; after that the request expires.
4. **Delivery**: the releaser finds the approved request (it looks every 15 seconds), opens only the scope of the
   requester (a patient: that patient's rows from the administrative package and from the clinical parts
   of the professionals; a professional: their own clinical part), builds a package, and emails a
   single-use link (72 hours) to the address recorded. The organization's owner is told a copy was
   delivered.
5. **Download**: the requester opens the link on the organization's own address, with no session.
   Opening only looks; pressing the button starts the download. The link is spent when the transfer
   ENDS: a download that breaks (a lost signal) can be tried again while the link lives, up to five
   attempts and one at a time. The package is removed from the bucket when a download completes or the
   link expires.

The request is marked `released` BEFORE the email goes out. If the email cannot be sent (three tries) the
release is undone: the link is revoked, the package leaves the bucket and the request ends `failed`
with `email_failed`; record a new one. A release that fails or expires for any reason leaves no package
(the sweep takes it out within minutes if the releaser died first).

Every step is in the platform trail: `archive.released` with a `phase` (`recorded`, `identity_verified`,
`approved`, `rejected`, `delivered`, `downloaded`, `failed`, `expired`) and `archive.accessed` when the
archive was decrypted, with who, when and the stated reason. The organization's own trail has nothing:
it is gone.

A request that fails shows `Con error` and a code in the console (for example `scope_not_found`, the
requester was not found in the archive, or `erased`, what they ask for was removed by a legal order).
Record a new one once the cause is clear.

### Checks while it happens

- A request stays `Aprobada` for more than a minute: is the releaser running? Look for
  `releaser started` in its log, and check that it reaches the database and the files bucket.
- `archive.verify` reports `overwritten`, `corrupted` or `missing`: do **not** release. Restore from
  the bucket's versions or from the backup of the bucket, then verify again. Escalate: the archive is
  the legal record.

### A release whose email was lost

The row is marked `released` before the email goes out. If the releaser dies in between, or the undo of a
failed email cannot complete, the request stays `released` with no `emailed_at`. After ten minutes the sweep
of the releaser issues a NEW link (the old token is stored hashed and revoked) and emails it to the
recorded address; `ArchiveReleaseNotEmailed` fires if that does not happen (JD-S6 R2, B-W6).

## Legal erasure

The archive is kept for the legal term. The ONLY way an archived object is removed is a legal order
(a court order, a data protection authority decision). It is a command, not a console button, run by a
person who holds the order and the `legal-erasure` credential:

```sh
ARCHIVE_LEGAL_ERASURE_ACCESS_KEY_ID=legal-erasure \
ARCHIVE_LEGAL_ERASURE_SECRET_ACCESS_KEY='...' \
  pnpm --filter @consultorio/api archive:legal-erase \
  --tenant <uuid> --reference "Oficio 123/2031, Juzgado Civil 5" \
  --operator <operator id> --approver <another operator id> [--prefix <p>] [--yes]
```

- Two NAMED people: `--operator` runs it and `--approver` is a different one; both must be active
  operators of the console (their ids are on the operators list). An id on the command line is
  attribution, not authentication: the control is the credential of the `legal-erasure` identity, which
  only the person who holds the order has.
- Without `--yes` it only lists what it would erase. Read the list, then run it again with `--yes`.
- It is limited to one organization's prefix. `--prefix` narrows it further (one professional's part).
- It reads `ARCHIVE_S3_BUCKET`, `ARCHIVE_S3_ENDPOINT`, `ARCHIVE_S3_REGION` and `OPERATOR_DATABASE_URL`
  like the application, but the credential is its own: the writer cannot erase.
- The platform trail (`archive.erased`) gets the INTENT first (before the first object goes; the trail is
  append-only, so a command that dies halfway leaves its trace), then the outcome (`done`, or
  `incomplete`), each with the legal reference, the operator as the actor and the second operator named in
  the entry (`namedSecondOperator`). That is an ATTRIBUTION, not an approval: nobody has to confirm it, so the
  erasure does not have two-person control in the database (JD-S6 R2, B-W5). The control is the credential of
  the `legal-erasure` identity and the legal order; a real second approval (a console-written approval row
  the command requires) is open work. A folder is given with its trailing slash (`tenants/<id>/part/`).
- The folder erased is recorded on the archive (`erased_prefixes`, `erased_at` when the whole archive
  went): `archive.verify` stops looking for it, no release can be recorded for an archive that is gone,
  and a release whose scope touches what was erased ends `failed` with `erased`.
- **What it does not do:** the hot rows of the organization (its database) are not touched, and neither
  are the backups of the bucket and of the database; those leave with their own retention. Say so to
  counsel when the order asks for everything.

## Test restore

`restoreParts` (`modules/tenancy/archive/restore.ts`) opens an archive with the releaser key and checks every object
against the manifest; it is what the release itself uses first. It is a function, not a command yet: the
restore drill of readiness (S6.11) wraps it. Run the drill from a machine that holds `ARCHIVE_RELEASER_KEK`
after a bucket restore or a key rotation, and at least once a year. **`archive.verify` does NOT include a
test restore**: it is checksum-only, it proves the bytes are the ones written; the restore drill is a
separate procedure and the only thing that proves they still open.

## Deploy notes

- Migrations `0650` to `0655` create the export and archive tables, the definer functions the worker uses
  to find work without a tenant, and the platform table `archive_release_request`. The judgment day of
  Stage 6 added `0685` to `0689` (track `6jd2`): the signup without a stored password, the four-eyes and
  expiry rules of the release, the erasure state and the health function, the role of the releaser and the
  guard of the operator's cancel.
- The `releaser` is a separate process in the same image. Give it the database URL of the `app_releaser`
  login (`RELEASER_DATABASE_URL`, and `DATABASE_URL` too, which every process requires), the files bucket
  (the package waits there for its link), the mail settings and the archive settings. It needs no `KMS_*`.
- The alerts that watch all of this (`ArchiveVerifyProblem`, `ArchiveWriteFailed`,
  `ArchiveReleaseNotCarriedOut`, `ReleaserSilent`, ...) and what to do about them are in
  `docs/runbooks/incident.md`.
- The `export.build` queue is shared with billing; the worker merges both handlers (see
  `main/wiring/worker.ts`).
- **Pool floor.** The jobs that hold a framework transaction while they wait for an outside service need
  a second connection for their own work. `export.build`, `archive.write` and `archive.verify` do, so
  they count in `CONNECTION_HOLDING_JOBS` (`platform/jobs/concurrency.ts`) and raise `DB_POOL_MAX`. The
  releaser's `archive.release` runs only in its own pool and does not.
- The e2e stack (`pnpm --filter @consultorio/api e2e:stack`) creates the archive bucket, a second
  operator and an in-process releaser (as `app_releaser`), and archives at once (the stack brings the window
  to zero after reading the configuration, which refuses `ARCHIVE_AFTER_DAYS=0`).
