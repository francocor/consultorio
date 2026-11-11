# Apply progress: Stage 6, track C (retention: S6.08, S6.09, S6.10)

Strict TDD, automatic mode, work-unit commits, no PR, no merge. Worktree `consultorio-wt-6c`, branch `feat/stage-6-track-6c`, cut from the Stage 6 seam (`09574fde`, S6.00). Tasks 6.33 to 6.43 are marked done in `tasks.md`. Engram topic `sdd/health-practice-saas/apply-progress-6c`.

Track C owns cancellation and the split export (S6.08), the retention archive (S6.09) and the break-glass release (S6.10). Cancellation is announced through the `TenantCancelled` door of the seam; C subscribes. It does not wait for billing (track A) to be merged: the operator action `POST /operator/tenants/:id/cancel` publishes the same event.

## Commits (oldest first)

| Slice | Commit | What |
|---|---|---|
| S6.08 | `1542d64c` | `export_package` table (migration 0650) and the definer functions of cancellation (0651: `operator_cancel_tenant`, `cancellation_export_pending`, the audit-scope policy) |
| S6.08 | `2690f1c9` | streaming deflate zip writer with data descriptors, redaction by field name, the clinical-key guard, the content of the packages and the summary PDF |
| S6.08 | `41ef6787` | `mergeJobsByName` in `combineWorkerContributions`: two modules that own one queue (`export.build`: billing and tenancy) share one handler |
| S6.08 | `bc1786f5` | the build job, the sweeper, delivery (session-bound single-use link through the files door), the owner and professional routes, the operator cancel, the anamnesis clinical contributor, completeness tests |
| S6.08 | `3e8054fe` | the owner page and the professional page of the export (web), es-AR texts, tests |
| S6.09 | `8038f694` | `ArchiveStore` contract suite, the fake and the local MinIO adapter (Object Lock, write-once, versions) |
| S6.09 | `760e1e3e` | per-organization keys (0652), `tenant_archive` (0653), `archive.write` and `archive.verify`, manifest, restore |
| S6.09 | `68e789f7` | legal erasure command, the archive bucket and the releaser of `infra/docker-compose.yml`, ARCHIVE_* configuration |
| S6.10 | `3450e33d` | `archive_release_request` (0654, 0655), token kind `archive_release`, operator service and routes (record, verify identity, approve, reject), contracts, errors |
| S6.10 | `78138a66` | the release package, the `archive.release` job, the single-use link routes, the `releaser` process role, public route declarations |
| S6.10 | `3c772c22` | the operator archive tab (states and requests, three dialogs), the public page of the link, `ApiClient.download` accepting `POST` |
| S6.10 | `d7774c3f` | e2e `stage6-archive.spec.ts`, the stack: archive bucket, second operator, releaser in-process, faster sweeps |
| docs | `df64c7ac` | `docs/runbooks/archive-release.md` (release, KEK generation, legal erasure, deploy notes), Dockerfile comment |
| pool | `03d0cff5` | `export.build`, `archive.write` and `archive.verify` move to `CONNECTION_HOLDING_JOBS`; `DEFAULT_RUNTIME_POOL_MAX` 26; docs and tests |
| test | `67eac61f` | boot test: `api` and `worker` refuse `ARCHIVE_RELEASER_KEK`; `releaser` refuses to start without it |
| docs | this unit | `tasks.md`, this file |

## Migrations (range 6c, 0650 to 0655)

- `0650_export_package.sql`: `export_package` (kind administrative or clinical, status, file key, size, owner of a clinical part), RLS and FORCE, column-limited updates for `app_rw`, operator SELECT on named columns, a RESTRICTIVE `operator_request_only` policy.
- `0651_cancellation_functions.sql`: `app.operator_cancel_tenant(uuid)` (unknown, demo, already, not_cancellable, cancelled), `app.cancellation_export_pending(int)`, the `export_package_owner_lookup` policy, and the `operator_audit_scope` policy extended with `tenant.cancelled` and `export.cancellation.requested`.
- `0652_archive_key.sql`: `archive_key` (public key, the private key sealed to the releaser, key version).
- `0653_tenant_archive.sql`: `tenant_archive` and the definers `archive_due`, `archive_verify_due`, `write_archive_audit`, `archive_overview`.
- `0654_archive_release.sql`: platform table `archive_release_request` with RLS (operator: all; `app_rw`: its tenant), the four-eyes CHECK (verifier differs from approver), the checklist CHECK, the status-transition trigger by role, `archive_release_due`, `archive_is_written`.
- `0655_archive_release_cleanup.sql`: `archive_release_cleanup_due` (packages whose link ended).

`db:check` reports no drift; the journal and snapshots were restamped.

## What was built

- **Cancellation export (S6.08).** The `TenantCancelled` subscriber writes a request row (`export_package` queued); `app_operator` cannot enqueue pg-boss jobs, so a worker sweeper (`cancellation_export_pending`) turns rows into `export.build` jobs. The job spools each package to disk and streams the zip (deflate, data descriptors, no zip64) to the files bucket. The administrative package has a registry of contributors by module; a guard fails closed if a clinical key appears in it. Each professional has their own clinical package. Delivery: a session-bound, single-use link through the file door (`cancellation_export` resource), re-authorized on redeem. The pages `/export` and `/export/clinical` poll while queued and download with the name the server gives.
- **Archive (S6.09).** `ArchiveStore` is write-once with sha256 and retention; removal is always refused. Every object is AES-256-GCM sealed with its own data key, bound by AAD to tenant, name and key version; the per-organization RSA-OAEP 3072 private key is sealed to the releaser (X25519 sealed box). The administrative package and the clinical package of EVERY professional the organization ever had are archived (departed ones included). `archive.verify` checks checksums and flags a missing, damaged or overwritten object. Legal erasure is a command with its own identity, limited to one tenant prefix and audited with the legal reference.
- **Release (S6.10).** An operator records the request, verifies the identity of the requester (four checks), a different operator approves (database constraint and console both enforce it). The `releaser` process (the only one with `ARCHIVE_RELEASER_KEK`) opens only the scope of the requester, builds a package, emails a single-use link (72 h) and the owner is told a copy was delivered. The public page inspects without spending (GET) and spends on the button (POST). The package is removed after download or expiry. The platform trail records each phase (`archive.released` with a `phase`) and the decrypt (`archive.accessed`).

## TDD cycle evidence

| Task | Test files | Layer | RED | GREEN | TRIANGULATE | REFACTOR |
|---|---|---|---|---|---|---|
| 6.33 | `zip.test.ts`, `package-content.test.ts`, `redaction`/guard cases, `worker.test.ts` (merge) | Unit | written before the writer and the merge; the zip failed on the data descriptor and the guard on `entries` | all passed | stored and deflated entries, large streams, secret names, nested keys, two jobs on one queue | the guard list trimmed to keys that are really clinical (`entries` and `templateKind` were false positives) |
| 6.33 to 6.36 | `cancellation-export.test.ts` (24) | Integration, real Postgres and files bucket | operator cancel returned 500 (audit scope policy); clinical packages stayed queued (rows from the framework tx invisible to inner transactions) | 24 passed | owner, professional, wrong role, other organization, expired link, reused link, demo refused, already cancelled | requests created and read through inner `withTenant` |
| 6.35 | `export-registry.test.ts` | Unit | completeness test red until each module with data had a contributor | passed | administrative vs clinical kind | none |
| 6.36 | `export-pages.test.tsx` (20), axe | Component | written before the pages | passed | queued, ready, failed codes, none, role guards | none |
| 6.37 | `archive-store.contract.ts` run by the fake and `archive-local.test.ts` | Contract and integration (MinIO) | the MinIO write-once retry returned `locked` (reset after the 412) | passed after `maxAttempts: 3` | write once, same bytes twice, different bytes, wrong sha, list, versions | policy generator `policies.ts` with its test |
| 6.38 | `archive-crypto.test.ts`, `keys` cases | Unit and integration | written before the crypto | passed | tamper with AAD, name, version, ciphertext, wrong key | none |
| 6.39 | `archive-write.test.ts` (22) | Integration | written before the jobs | passed | departed professional, inactive professional, two professionals, repeat run, attempt folders, verify finds missing, corrupted, overwritten | none |
| 6.40 | `archive-immutability.test.ts` (9), `legal-erase.test.ts`, `definer-functions`, `operator-privileges`, `no-delete` | Integration | red for the new definers and tables until listed | passed | tenant role, operator, writer, shadow version, legal erasure with and without reference | none |
| 6.41 | `archive-release-requests.test.ts` (16) | Integration | written before the service | passed after the raw-SQL insert (column grants) | four eyes at the database, checklist gap, transitions by role, expiry window, reject, list scope | `iso()` tolerant of strings |
| 6.42 | `archive-release.test.ts` (13), `release-package.test.ts`, `zip-read.test.ts`, `kinds.test.ts`, `public-tokens.test.ts` | Integration and unit | written before the job and the routes | passed | patient scope vs another patient, professional scope, link spent once, GET does not spend, other host, expired, package removed, audit trail without content | link routes do not read the slug of the path (the page of the link cannot know it) |
| 6.42 | `boot.test.ts` (3 new) | Process | written after the guard | passed | api, worker, releaser without key | none |
| 6.43 | `archive-tab.test.tsx` (13), `archive-release-page.test.tsx` (4), `tabs.seam.test.tsx`, axe | Component | written before the tab and the page | passed after one landmark fix (two regions with one name) | four checks, four eyes hint, reject length, patient vs professional form, spent and unavailable link | sections without a landmark name |
| 6.43 | `e2e/stage6-archive.spec.ts` (1 journey) | E2E, real stack | first run failed in the stack: MinIO restarted under the first `mc` commands | passed after retrying `mc` on connection errors | cancel, both exports, archive, four eyes, release, one-time download, second visit | none |

## Verification

Node 24, pnpm 10.34.7, Docker shared with other agents. E2E on ports 5040 / 4040 / 9040 with `--workers=1` and only the files of this track (and `operator.spec.ts`).

| Command | Result |
| --- | --- |
| `install --frozen-lockfile`, `typecheck`, `lint`, `format:check`, `build`, `db:check` | exit 0, no drift |
| `pnpm test` (all workspaces) | **464 files: 463 passed, 1 failed; 5,853 tests passed, 1 failed, 2 skipped.** The one failure is `config.test.ts` "`.env.example` is accepted by the config schema as it is": the pool floor is now 26 and `.env.example` pins `DB_POOL_MAX=16`, a file only the maintainer edits. With the line at 26 it passes (verified locally and restored) |
| Integration, targeted: `cancellation-export`, `archive-local`, `archive-immutability`, `archive-write`, `archive-release-requests`, `archive-release`, `definer-functions`, `operator-privileges`, `no-delete-privileges`, `demo-coverage`, `worker` | **11 files, 119 tests passed** |
| Integration: `test/tenancy` (generated isolation and RLS catalog) | **2 files, 410 tests passed** |
| Playwright, desktop, `--workers=1`: `stage6-archive.spec.ts` + `operator.spec.ts` (fresh stack, ports 5040 / 4040 / 9040) | **6 passed** (the journey of this track takes about 19 s: cancel, both downloads, archive, four eyes, release, one download, the second visit unavailable; axe on every screen). Run twice, the second time on the final tree |

The full integration suite was not run (shared Docker, targeted files only, as instructed).

## Deviations from the plan

1. **Request row plus sweeper** instead of enqueuing from the cancelling transaction: the operator role has no pg-boss rights. The subscriber writes `export_package` (queued); a worker sweeper enqueues `export.build`.
2. **`export.build` is one queue for two modules** (billing and tenancy). `combineWorkerContributions` now merges jobs with the same name (`mergeJobsByName` in `main/wiring/worker.ts`), discriminating by payload (`reason: 'cancellation'` vs `exportId`).
3. **`archived_at` lives in `tenant_archive`**, not a `tenant` column, to avoid touching `schema/tenant.ts` (track B).
4. **A clinical contributor for anamnesis** was added in `patients` and `main/export-contributors.ts` passes its dependencies (the registry completeness test required it).
5. **The summary PDF is an index**; the JSON files carry the data.
6. **ARCHIVE configuration is in `main/config-providers.ts`**, not `config.ts`, and `.env.example` was not touched.
7. **`ARCHIVE_RELEASER_KEK` is an X25519 private key** (32 bytes, base64); the public half can be derived from it.
8. **Operator audit uses `archive.released` with a `phase`** rather than one action per phase.
9. **Worker verification is checksum-only.** Opening the archive needs the key, which the worker must not have; the test restore (`restore.ts`) runs where the key is.
10. **MinIO has no condition key for `If-None-Match` in policies**, so a plain overwrite by the writer cannot be refused by policy. The adapter reads the oldest version and reports `versions`; `archive.verify` flags any object with more than one.
11. **The link routes ignore the slug of the path** (`/public/_/archive-release/:token`, as the portal does): the page of an emailed link cannot know the slug, the host decides the organization.
12. **The e2e stack runs the releaser in-process** and brings the sweeps forward (every 2 s), and has a second operator (four eyes need two people).

## Risks

- **Large contributors still return whole arrays.** The zip writer streams iterables and spools to disk, but the audit, notification and some clinical contributors of other modules materialize their rows in memory. Fine for a clinic, a risk for a very large organization. Converting them to async iterables is mechanical and left for readiness (S6.11).
- **Losing `ARCHIVE_RELEASER_KEK` loses the archive.** Two custodians and an offline copy are in the runbook; there is no escrow built in.
- **A rotated releaser key does not re-seal what is archived.** The old private half must be kept (runbook).
- **Overwrite by the writer is detected, not prevented**, on the local MinIO (deviation 10). On S3, add the `s3:if-none-match` bucket policy.
- **Conflicts expected at the merge** with track A: `test/policy/stage6-public-routes.ts`, the lists in `definer-functions.test.ts` and `operator-privileges.test.ts`, and the two lists of `platform/jobs/concurrency.ts` (A moves `dunning.step` and `subscription.reconcile` to the same list: the floor becomes 34, so `DEFAULT_RUNTIME_POOL_MAX`, `config.test.ts` and `.env.example` take 34).

## What the integrator and the maintainer must do

1. **`.env.example`: `DB_POOL_MAX=26`** (34 once A's two families join). Until then the single `.env.example` test of `config.test.ts` is red. The default of the code is already 26.
2. **`apps/api/package.json`:** `"archive:legal-erase": "tsx --env-file-if-exists=../../.env scripts/archive-legal-erase.ts"`, plus the root proxy `"archive:legal-erase": "pnpm --filter @consultorio/api archive:legal-erase"`.
3. **Track A's cancellation path** (S6.04) must call `tenantLifecycle.publishCancelled(tx, ...)`; the subscriber of C already writes the request and the sweeper does the rest.
4. **Deploy:** run a `releaser` process (image command `releaser`) with `ARCHIVE_RELEASER_KEK`, the archive bucket (`ARCHIVE_S3_*`), the files bucket, mail and the database; give `api` and `worker` only `ARCHIVE_RELEASER_PUBLIC_KEY`. See `docs/runbooks/archive-release.md`.
5. **Readiness (S6.11):** the restore drill should wrap `restoreParts`; the demo seed (S6.12) removes `test/integration/demo-coverage-exemptions/retention.ts` when it seeds `export_package`, `tenant_archive` and `archive_release_request`.
