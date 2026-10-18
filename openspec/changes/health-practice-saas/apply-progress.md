# Apply progress: health-practice-saas

Mode: Standard for Stage 0; **Strict TDD from Stage 1** (`strict_tdd: true` in `openspec/config.yaml`). Artifact store: openspec. Delivery for Stage 0: chained PRs, `stacked-to-main` (merged). Delivery for Stage 1 (overnight run, owner decision "speed and automation"): ONE stage branch `feat/stage-1-secure-core` with work-unit commits per slice, one draft PR to `main` with `size:exception`, merged at the end of the stage.

## Cumulative status

Stage 0: tasks 0.2 to 0.34 done and merged. Task 0.1 (rotate secrets) is a manual owner action and is NOT done.

Stage 1: slices S1.00 to S1.37 done (tasks 1.1 to 1.130, all 130 tasks of Stage 1), and the independent security review of 1.129 has been run and its ten findings handled (batch 7). Next: the owner's review of PR #14 (and the confirmation of decision D19). See batches 3 to 7 below.

Stage 2: slices S2.01 to S2.16 done (tasks 2.1 to 2.46, the scheduling backend and web), plus the scheduling review fixes and the documents track (S2.25 to S2.28, tasks 2.75 to 2.85) merged in "Stage 2 integration 1" at the end of this file; branch `feat/stage-2-practice-core` stacked on `feat/stage-1-secure-core`. Still open: clinical (S2.17 to S2.24), onboarding, the Stage 2 gate. The per-track reports stay beside this file: `apply-progress-stage2-schedfix.md` and `apply-progress-stage2-documents.md`.

Stage 3: the seam slices S3.00 and S3.00b are done (tasks 3.1 to 3.10) on branch `feat/stage-3-patient-engagement`, stacked on the Stage 2 branch; see "Stage 3 seam" at the end of this file. Next: the parallel tracks A to D, then the integration track E (`docs/stage3-tracks.md`).

## Batch 1: Stage 0, slices S0.01 to S0.05

| Slice | Branch (stacked on previous) | Commits | Tasks | State |
|---|---|---|---|---|
| S0.01 Repo hygiene `size:exception` | `chore/s0-01-repo-hygiene` (from `master`) | `99b06a13` | 0.2, 0.3, 0.4 | done. Task 0.1 (rotate secrets) is a manual owner action and is NOT done |
| S0.02 SDD artifacts `size:exception` | `chore/s0-02-sdd-artifacts` | `211d83ac` | 0.5, 0.6 | done |
| S0.03 Workspace and shared config | `chore/s0-03-workspace` | `4151e1aa` | 0.7, 0.8, 0.9 | done (0.9 test is task 0.16 by design) |
| S0.04 API skeleton | `feat/s0-04-api-skeleton` | `e3cabf00`, `4700022e` | 0.10, 0.11, 0.12 | done |
| S0.05 Web skeleton | `feat/s0-05-web-skeleton` | `930e47db`, `e1985e42`, `d341d2fc` (docs: this file) | 0.13, 0.14, 0.15 | done (0.15 test is task 0.16 by design) |

### Batch 1 verification evidence

Run on the tip of `feat/s0-05-web-skeleton` with Node v24.22.0 and pnpm 8.15.9 (superseded by batch 2, which uses Node 24 from the system and pnpm 10):

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | exit 0 |
| `pnpm typecheck` | exit 0 (contracts, api, web) |
| `pnpm lint` | exit 0 |
| `pnpm format:check` | exit 0 |
| `pnpm test` | exit 0, 2 files, 10 tests (api only) |
| `pnpm build` | exit 0 (`manifest.webmanifest`, `sw.js`, `registerSW.js` emitted; service worker denylist covers `/api/` and `/files/`) |

Slice checks:

- S0.01: `git check-ignore -v --no-index BackEnd/.env FrontEnd/node_modules` prints a rule for each. `git ls-files | rg "node_modules|\.env$"` is empty (18,349 node_modules entries + `BackEnd/.env` untracked). Local `node_modules` and `BackEnd/.env` still exist on disk (existence checked only; the `.env` content was never read).
- S0.02: `git ls-files openspec` lists 34 files.
- S0.03: `pnpm -r exec node -v` reports v24.22.0 for both workspace packages. `pnpm install` on Node 22.13.0 fails as intended (`engine-strict`, `engines.node >=24`).
- S0.04: smoke run with `tsx`: `/health` returns 200 `{"status":"ok"}`; `/ready` returns 503 `{"status":"unavailable"}` against an unreachable database; missing `DATABASE_URL` exits 1 naming only the variable; bad role exits 2.
- S0.05: `pnpm --filter @consultorio/web build` succeeds; dist has the manifest (`lang: es-AR`) and service worker.

### Batch 1 deviations and decisions

1. Node 24 was not installed during batch 1 (v22.13.0). Resolved before batch 2: Node v24.22.0 is now installed system-wide.
2. pnpm was pinned to `pnpm@8.15.9` because corepack 0.30 could not download newer versions. Resolved in batch 2 (pnpm 10.34.7, see below).
3. Package names are scoped (`@consultorio/api`, `@consultorio/web`, `@consultorio/contracts`, `@consultorio/config`), so filters are `pnpm --filter @consultorio/web ...`.
4. TypeScript is pinned to `~6.0.3` and ESLint to 10, because typescript-eslint 8.x supports TypeScript `<6.1` only.
5. Added `.gitattributes` (`* text=auto eol=lf`) in S0.03 so Prettier and EditorConfig LF rules hold on Windows checkouts.
6. Vitest was pulled forward into `apps/api` in S0.04 so the tests of tasks 0.10 and 0.12 ship with their code.
7. `PORT` and `HOST` were added to the API env schema. `/ready` used a small `pg` probe (`platform/db/probe.ts`).
8. ESLint boundaries: the plugin is registered with the repo layout elements, but `boundaries/dependencies` is `off` until modules exist (Stage 1).
9. The API had no `build` script in batch 1; the bundling step landed with the Dockerfile slice (S0.08).
10. Task 0.6 decision: `.atl/` stays ignored.
11. S0.04 is about 430 hand-written lines, above the 350 estimate. Lockfile excluded as generated.
12. In `tasks.md`, the `Chain strategy` forecast field was updated from `pending` to `stacked-to-main`.

## Batch 2: Stage 0, slices S0.06 to S0.10

Toolchain: Node v24.22.0 (system), `corepack pnpm@10` (10.34.7). Docker CLI present, daemon NOT running. Extra fixes from the batch 1 audit were folded into the most fitting slice as their own work-unit commits.

| Slice | Branch (stacked on previous) | Tip | Commits (work units, then review fixes) | Tasks |
|---|---|---|---|---|
| S0.06 Test tooling (+ audit fixes 1 to 5) | `feat/s0-06-test-tooling` (from `feat/s0-05-web-skeleton`) | `08c7612b` | `c07d6fd7` pnpm 10; `90f529e1` api logs/readiness; `255e23b5` problem+json; `9fadc84a` lint rules; `93675336` Vitest; `4408b6d8` Playwright; `65549a73` vitest-axe; `99753610` docs; **fix** `08c7612b` redact x-api-key and token | 0.16, 0.17, 0.18 |
| S0.07 Database foundation | `feat/s0-07-database-foundation` | `0968a0f0` | `d6411d9b` Drizzle foundation; `0e7dc9fe` withTenant; `37469b7b` RLS catalog; `67321d44` drift check; `3e16de50` docs; **fixes** `d7bec7e1` sorted expectation, `0968a0f0` assert DrizzleQueryError cause | 0.19 to 0.22 |
| S0.08 Local environment and image (+ audit fix 6) | `feat/s0-08-local-env-and-image` | `aa34a9c9` | `e5ba0416` esbuild bundle; `fc64a630` Dockerfile; `3e81325b` compose; `9a10528c` .env.example; `a0376b56` dev-setup; `d7f52b3a` docs; **fixes** `4d81933d` .dockerignore, `4aea17da` loopback ports + pinned images + bucket retry, `aa34a9c9` infra:up scripts | 0.23 to 0.26 |
| S0.09 CI and secret scanning | `feat/s0-09-ci-and-secret-scanning` | `71d8a964` | `8e849494` ci; `32547e7d` gitleaks + lefthook; `d023b262` renovate; `5fa4e36f` docs; **fixes** `d6713cbe` SHA-pinned actions + license, `71d8a964` prepare only with .git | 0.27 to 0.29 |
| S0.10 Legacy marker, docs, tooling refresh | `docs/s0-10-readme-legacy-markers` | see git (the last commit is the docs commit that adds this text) | `2bf7fdb2` README; `90e3231c` LEGACY; `750a6d71` ignore skills in lint/docker; `ca67265d` config refresh; `533ce1bb` progress; **fixes** `8e0fa6f5` ignore AutoSkills output in git, `f2292bfd` GITLEAKS_LICENSE note | 0.30 to 0.34 |

Hand-written lines before the review fixes: S0.06 about 667, S0.07 about 730 (both over the 400 budget, see deviation 10), S0.08 about 383, S0.09 about 182, S0.10 about 94.

### What was built

- pnpm 10.34.7 via `packageManager`, lockfile v9. `pnpm-workspace.yaml` carries `onlyBuiltDependencies` (esbuild), `minimumReleaseAge: 1440`, `ignoredBuiltDependencies`, and a peer rule for jsx-a11y on ESLint 10. `packages/config` tooling moved to devDependencies so `pnpm audit --prod` only reports shipped dependencies.
- API: problem+json error and 404 handlers with request id (messages never sent to clients and never logged, stack frames only), request serializer without query string, `/ready` failure logged as warn with only an error code, `DbCheckResult` probe type.
- Web/test tooling: root Vitest `projects` config, per-package configs, v8 coverage (no threshold), Testing Library, vitest-axe helper with a known-bad self-test, Playwright smoke test (mobile-360 and desktop, zero axe violations), `react-hooks` and `jsx-a11y` lint rules.
- Database: Drizzle config, migration 0000 (privilege checks, `app` schema, 5 extensions, default privileges), `infra/postgres/init/01-roles.sql` (role bootstrap), `createRuntimeDb`/`createOwnerDb`, `createWithTenant`, migration runner and CLI, Testcontainers global setup, RLS catalog check, migration drift check (`pnpm db:check`).
- Image/environment: esbuild bundle (`apps/api/scripts/build.ts`), multi-stage Dockerfile (Node 24 slim, non-root, tini, HEALTHCHECK), compose (postgres, minio + bucket init, mailpit, opt-in clamav and app profiles), `.env.example` validated by a test, `docs/dev-setup.md`.
- CI/security: `.github/workflows/ci.yml` plus a composite setup action, `.gitleaks.toml`, `lefthook.yml` + lint-staged, `renovate.json`.
- Docs/tooling: README, `docs/external-dependencies.md`, `BackEnd/LEGACY.md` and `FrontEnd/LEGACY.md`, `openspec/config.yaml` testing block and `strict_tdd: true`, engram `sdd-init/appmedicocmaillu` and `sdd/appmedicocmaillu/testing-capabilities` refreshed.

### Verification evidence (tip of `docs/s0-10-readme-legacy-markers`, Node v24.22.0, pnpm 10.34.7)

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | exit 0 |
| `pnpm typecheck` | exit 0 (root, contracts, api, web) |
| `pnpm lint` | exit 0 |
| `pnpm format:check` | exit 0 |
| `pnpm test` | exit 0, 8 files, 39 tests (api, contracts, web) |
| `pnpm build` | exit 0 (api bundle `dist/main.js`, web with PWA) |
| `pnpm db:check` | exit 0 ("No migration drift"); a hand-edited schema is detected (test `check-migration-drift.test.ts`) |
| `pnpm audit --prod --audit-level=high` | exit 0, no known vulnerabilities. Full `pnpm audit` (including dev tooling) reports 4 findings under `eslint-plugin-boundaries` (handlebars, braces); not shipped |
| `pnpm test:e2e` | exit 0, 6 Playwright tests (desktop and mobile-360, axe zero violations) with Chromium installed locally |
| `actionlint .github/workflows/ci.yml` (1.7.12, from a scratch venv) | exit 0 |
| `renovate-config-validator --strict renovate.json` | exit 0 |
| `docker compose -f infra/docker-compose.yml config -q` (also with `app` and `scan` profiles) | exit 0 |
| `gitleaks git --log-opts="master..HEAD"` (8.30.1, checksum verified, scratch dir) | 30 commits scanned, no leaks |
| Pre-commit with a staged fake AWS key | commit blocked (`leaks found: 1`); hook also blocks when gitleaks is missing |
| `git ls-files \| rg "node_modules\|\.env$"` | empty (only `.env.example` is tracked) |
| `node dist/main.js api` from `pnpm deploy --prod --legacy` output (no TS loader, no workspace links) | `/health` 200, `/ready` 503 with `ECONNREFUSED` logged as warn, unknown route 404 problem+json |
| SQL validation on PGlite (WASM Postgres), scratch only | roles bootstrap and migration 0000 apply; `app_rw` not superuser/BYPASSRLS/owner; extensions present; cross-tenant read returns only own rows; cross-tenant insert blocked; query outside `withTenant` raises; `app_rw` cannot create in `public` |

### Pending verification

Everything that needed Docker was run after the first report (see "Review fixes and Docker verification"). Still pending:

1. CI green on a PR and the gitleaks job on a throwaway branch: needs a push (nothing is pushed).
2. Branch protection on `master` and the Renovate app: owner actions.
3. Clean-clone walkthrough of `docs/dev-setup.md` (task 0.26): owner, PR checklist.
4. Task 0.1: rotate the secrets (owner).

### Batch 2 deviations from design and tasks

1. Root `vitest.workspace.ts` (task 0.16) is replaced by `test.projects` in the root `vitest.config.ts`: Vitest 5 no longer uses workspace files. Root `pnpm test` is `vitest run`.
2. The drift check lives in `apps/api/scripts/check-migration-drift.ts` (not root `scripts/`) because it needs the api's `drizzle-kit`. Root `pnpm db:check` delegates to it.
3. Role creation is not inside migration 0000. Roles are cluster-level and need privileges the migration owner lacks, so `infra/postgres/init/01-roles.sql` creates them (compose init and the Testcontainers setup both run it) and migration 0000 verifies and grants. The file's dev passwords are local only.
4. `createWithTenant(db)` returns `withTenant(ctx, fn)` instead of a module-level `db`, so tests can use their own pool. Same behavior as the design.
5. ClamAV is behind the compose profile `scan` so the default `up -d` stays light (about 1 GB RAM and slow first start).
6. `@consultorio/contracts` is a devDependency of `@consultorio/api` (bundled into `dist/main.js`), so `pnpm deploy --prod` ships only third-party runtime dependencies. The API build is an esbuild script rather than tsup.
7. `minimumReleaseAge: 1440` (one day) was added to `pnpm-workspace.yaml` as a supply-chain guard; the design does not mandate it. It rejected a vitest release published 8 hours earlier, so the api pin is `^5.0.4`/`^5.0.0` style ranges.
8. `strict_tdd: true` and `apply.tdd: true` are set in `openspec/config.yaml` for Stage 1 onward (task 0.33 recommendation: test-first for domain and security code). The orchestrator may revert this if the owner prefers standard mode.
9. AutoSkills was run (as allowed): it installed 14 skills (typescript-advanced-types, nodejs-backend-patterns, nodejs-best-practices, vitest, zod, drizzle, react-best-practices, composition-patterns, tailwind-css-patterns, playwright-best-practices, vite, frontend-design, accessibility, seo) for claude-code, opencode and codex. It wrote untracked `.agents/`, `.claude/skills/` and `skills-lock.json` into the repo and refreshed the ignored `.atl/skill-registry.md`. The owner then decided to ignore this output: `.gitignore` lists them (S0.10 fix commit `8e0fa6f5`). ESLint and the Docker context keep their own exclusions because neither reads `.gitignore`; the duplicate Prettier ones were removed because Prettier 3 does.
10. Slice sizes exceed the 400-line budget: S0.06 about 667 (the pnpm 10 upgrade, logging/problem+json fixes, lint rules and tests were folded in) and S0.07 about 730 (tests and Testcontainers support are most of it). Each is split into work-unit commits that can be promoted to separate PRs if the owner wants.

### Review fixes and Docker verification (after the fresh reviewer verdict FIX FIRST)

Each fix is its own commit in the slice that introduced the problem; descendants were restacked with `git rebase --update-refs` (local branches only, `master` untouched).

| # | Problem | Fix (slice) |
|---|---|---|
| 1 | `rls-catalog.test.ts` expected array order was wrong | `d7bec7e1` (S0.07) |
| 2 | drizzle-orm 0.45 wraps driver errors in `DrizzleQueryError`; the test matched the wrong message | `0968a0f0` (S0.07): assert `cause.code === '42501'` and the RLS message |
| 3 | `.dockerignore` only matched a root `.env` | `4d81933d` (S0.08): `**/.env`, `**/.env.*`, `!**/.env.example` |
| 4 | compose ports published on all interfaces | `4aea17da` (S0.08): every port bound to `127.0.0.1` |
| 5 | Actions pinned to tags | `d6713cbe` (S0.09): SHA plus version comment, `GITLEAKS_LICENSE` passed; README note `f2292bfd` (S0.10) |
| 6a | `:latest` images | `4aea17da`: postgres 17.11, mailpit v1.31.6, clamav 1.5.4-debian. **MinIO**: `minio/minio` and `minio/mc` no longer exist on Docker Hub or Quay (`:latest` could not even be pulled), so local dev uses the frozen `bitnamilegacy/minio:2025.7.23-debian-12-r5` (also used for the bucket job). It is unmaintained: development only; consider RustFS or SeaweedFS later |
| 6b | compose ignored the root `.env` | `aa34a9c9` (S0.08): `pnpm infra:up/down/reset` pass `--env-file .env`; documented in `docs/dev-setup.md` |
| 6c | logger redaction | `08c7612b` (S0.06): `x-api-key` headers and `token` / `*.token` fields |
| 7 | AutoSkills output untracked | `8e0fa6f5` (S0.10): `.gitignore` |
| new | Docker build failed: the root `prepare` script ran `lefthook install` with no git | `71d8a964` (S0.09): only runs when a `.git` directory exists |
| new | The MinIO bucket job raced the Bitnami entrypoint (it restarts MinIO once) | `4aea17da`: the job retries the alias for up to 60 s |

Verification against real Docker (Node v24.22.0, pnpm 10.34.7, Docker engine 29.4.0, gitleaks 8.30.1 from winget):

| Command | Result |
|---|---|
| `pnpm test:integration` (first run, before fixes 1 and 2) | 2 failed, 10 passed: exactly the two reviewed assertions |
| `pnpm test:integration` (after fixes) | exit 0, 3 files, 12 tests: roles, withTenant, RLS catalog on Postgres 17 as `app_rw` |
| `docker build -f infra/Dockerfile -t consultorio-api .` | first build failed (prepare/lefthook); exit 0 after `71d8a964` |
| `docker run -p 127.0.0.1:53000:3000 -e DATABASE_URL=... consultorio-api api` | `/health` 200, `/ready` 503, unknown route 404 problem+json, runs as uid 1000 `node`, HEALTHCHECK `healthy` |
| `docker compose --env-file <test env, alternate ports> -f infra/docker-compose.yml --profile scan --profile app up -d --build` | postgres, minio, mailpit, clamav and the built api all `healthy`; minio-init exited 0 and created the private bucket `consultorio-files` |
| Fresh volume, `select rolname, rolsuper, rolbypassrls from pg_roles where rolname like 'app_%'` | `app_owner` and `app_rw`, both super=false and bypassrls=false; database owned by `app_owner`; `pnpm --filter @consultorio/api db:migrate` applies migration 0000; the compose `api` answers `/ready` 200 as `app_rw` |
| Published ports | none outside `127.0.0.1` |
| `docker compose ... down -v` | all consultorio containers, volumes and network removed |
| `pnpm install --frozen-lockfile`, `typecheck`, `lint`, `format:check`, `test` (8 files, 39 tests), `build`, `db:check`, `audit --prod --audit-level=high`, `test:e2e` (6 tests) | all exit 0 |
| `actionlint` on `ci.yml` after pinning | exit 0 |

Notes: the host already runs other containers on ports 5432, 5433 and 9000-9001 (not this project's), so the compose run used a throwaway env file with alternate ports. A stray root `.env` (placeholders copied from `.env.example`, git-ignored) was created during this run and should be deleted by the owner. The pre-commit hook runs on every commit from S0.09 onward; on the earlier branches (S0.06 to S0.08) `lefthook.yml` does not exist yet, so the hook is a no-op there and a manual `gitleaks git --pre-commit --staged` was run before each fix commit instead.

## Risks and follow-ups

- Task 0.1: the secrets in `BackEnd/.env` remain in git history and must be rotated by the owner before anything is pushed or merged. History rewrite is out of scope.
- Nothing is pushed. CI, branch protection and Renovate have not run.
- The pre-commit hook needs `gitleaks` installed locally (Windows: `winget install Gitleaks.Gitleaks`, now done by the owner); without it every commit is blocked on purpose. On Windows the winget folder may be missing from a stale shell PATH. The hook was installed by `pnpm install` (`prepare` script).
- `gitleaks-action` requires a `GITLEAKS_LICENSE` secret under a GitHub organization (free for personal accounts); documented in the README.
- The integration tests now pass against a real Postgres 17 container (12 tests).
- A full-history `gitleaks detect` will report the old committed secrets; PR-range scans do not.

## Repository migration (clean repository, working name `consultorio`)

Stage 0 was replayed into a new repository, with the product working name `consultorio` (it was `aillu` while the work happened in the repository of the legacy app).

- The legacy `BackEnd/` and `FrontEnd/` apps, the legacy root `package-lock.json`, `node_modules` and any `.env` are not part of this repository. The legacy reference app lives in the separate archived repository `francocor/AppmedicoCMAillu`. Nothing legacy was copied, so the old secrets are not in this history. They still must be rotated (task 0.1).
- Slices S0.01 to S0.10 were replayed in order with the same Conventional Commit messages and dates. Two differences: S0.01 only adds `.gitignore` (there is nothing to untrack), and the S0.10 legacy marker commit, which only added `LEGACY.md` files inside the legacy folders, became a pointer to the legacy repository that also removes the legacy exclusions from the ESLint, Prettier, Docker, workspace and Renovate configs. The `LEGACY.md` markers named above do not exist here.
- Workspace scope `@aillu/*` is now `@consultorio/*`, and the other `aillu` identifiers (image `consultorio-api`, bucket `consultorio-files`, database `consultorio`, compose project `consultorio`) were renamed the same way. Commands and names quoted in this file use the new names.
- Commit hashes quoted in this file belong to the source repository and do not exist here.
- Tasks that only manage in-repo legacy (0.3, 0.4, 0.32 and S2.34) are marked "N/A: legacy lives in a separate repo".

### Re-verification in this repository (tip of `docs/s0-10-readme-legacy-markers`, Node v24.22.0, pnpm 10.34.7)

| Command                                                                                                          | Result                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                                                 | exit 0; `pnpm install --lockfile-only` leaves `pnpm-lock.yaml` unchanged                                                                |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`                                                               | pass                                                                                                                                    |
| `pnpm test`, `pnpm test:integration`, `pnpm test:e2e`                                                            | 39 unit tests in 8 files, 12 integration tests in 3 files, 6 e2e tests                                                                  |
| `pnpm build`, `pnpm db:check`, `pnpm audit --prod --audit-level=high`                                            | pass, no findings                                                                                                                       |
| `docker build -f infra/Dockerfile -t consultorio-api .` and `docker run ... consultorio-api api`                 | `/health` 200, `/ready` 503 without a database, unknown route 404 problem+json, runs as uid 1000, HEALTHCHECK `healthy`               |
| `docker compose --env-file <alternate ports> -f infra/docker-compose.yml --profile scan --profile app up -d --build --wait`, then `down -v` | postgres, minio, mailpit, clamav and api `healthy`; `app_owner` and `app_rw` are not superuser and cannot bypass RLS; everything removed; `minio-init` exited 0 |
| `gitleaks git` over the whole history (48 commits)                                                               | no leaks                                                                                                                                |

Fixed in S0.08: `minio-init` used to exit 1 with `Access Denied` on `mc mb`, also in the source repository, while `up --wait` could still look fine. Compose was interpolating `$MINIO_ROOT_USER` and `$MINIO_ROOT_PASSWORD` itself (empty when the env file does not define them) and only `mc alias set` was retried. The job now escapes the shell variables with `$$`, retries alias, bucket and private policy together for about 60 seconds, and exits 1 if that fails. The `api` service waits for the job to complete, so `up --wait` accepts the exit 0. Verified: `minio-init` exits 0, `consultorio-files` exists and is private (anonymous GET returns 403), and a wrong password fails the job with exit 1 after about 60 seconds.

Also fixed in S0.08: `pnpm infra:up` ran `up -d --wait` on the default profile, where Compose v5.1.2 reports a container that exits, even with code 0, as a failure. It now waits for `postgres`, `minio` and `mailpit` and then runs `minio-init` with `docker compose run --rm --no-deps`, so the job exit code is the script exit code. Verified with the script commands against the scratch env file (alternate ports): `infra:up` exit 0 (also when run twice), `infra:down` exit 0 with the volumes kept, `infra:reset` exit 0 with containers, volumes and network gone.

## Batch 3: Stage 1, slices S1.00 to S1.08

Mode: **Strict TDD** (test runner `pnpm test` for unit and `pnpm test:integration` for Testcontainers Postgres 17). Branch `feat/stage-1-secure-core` (from `main`), one draft PR, `size:exception` on the stage PR, no merges. Toolchain: Node v24.22.0, pnpm 10.34.7, Docker engine running. Delivery decision recorded: the owner chose speed and automation, so slices are work-unit commits inside one stage branch instead of stacked PRs.

### Commits (all on `feat/stage-1-secure-core`, in order)

| Slice | Tasks | Commits |
|---|---|---|
| S1.00 External lead-time track | 1.1 to 1.3 | `de569c2` docs: local-first note, every dependency `deferred` |
| S1.01 Contracts, errors, permissions | 1.4 to 1.8 | `9592a32` contracts (errors, roles, route categories); `3d7ea20` problem codes, request id header, uniform denial; `11a33c4` deployment, cookie and KMS config |
| S1.02 Country pack AR | 1.9 to 1.13 | `3d6049c` deps (fast-check, TS import resolver); `71b4e1e` AR identifiers, matricula, ports; `a466d49` pack, registry, ESLint isolation; `ee5fdde` platform catalogs and seeds (migration 0001) |
| S1.03 Tenant schema, RLS helper, isolation | 1.14 to 1.16 | `c337ece` tenantTable, tenantPolicies, UUIDv7; `9e4a5f1` tenant, location, tenant_feature (migration 0002); `b182b9e` generated isolation suite |
| S1.04 Host resolution, deployment mode | 1.17 to 1.20 | `9b02517` host guard, features, export hook (migration 0003); `9b61609` no tenant id in contracts |
| S1.05 Read-only policy skeleton | 1.21 to 1.23 | `bcb5f8a` route categories and 402 gate; `99624e8` job gate; `bd0e0a4` route category policy test |
| S1.06 Audit writer | 1.24 to 1.28 | `8a9539d` partitioned append-only audit_event (migration 0004); `cfdf17b` writer, deny, request context |
| S1.07 Jobs platform and audit sealer | 1.29 to 1.31 | `11f0c14` pg-boss platform (migration 0005); `c24008d` sealer; `e815b19` verify, worker role |
| S1.08 Envelope encryption | 1.32 to 1.34 | `679a5d5` AES-GCM; `7cf7a3d` key management and adapters; `2ecc1c4` tenant keys (migration 0006) |

Diff against `main`: about 14.6k added lines in 162 files, of which `pnpm-lock.yaml` (generated), migration snapshots (generated) and the tests are most. The stage PR is `size:exception`.

### TDD Cycle Evidence

Layers: Unit (Vitest, no Docker), Integration (Vitest + Testcontainers, runs as `app_rw`). "Triangulated" means at least two cases with different inputs or a table of cases. RED means the test file was written before the production code it exercises existed (the test failed to import it or asserted behavior that was absent). The GREEN run is the file-level run that followed.

| Task | Test file(s) | Layer | RED | GREEN | Triangulation | Refactor |
|---|---|---|---|---|---|---|
| 1.1 to 1.3 | none (documentation) | n/a | n/a | n/a | n/a | n/a |
| 1.4 | `packages/contracts/src/errors.test.ts` | Unit | written first, import failed | 3 files red then green | fixtures accepted and rejected (5 reject cases), status table | none needed |
| 1.5 | `roles.test.ts` | Unit | written first | green | 4 invariant tests, catalog corruption detected by `findClinicalLeaks`, grants union cases | extracted `findClinicalLeaks` |
| 1.6 | `route-category.test.ts` | Unit | written first | green | inline snapshot, allowlist loop, unknown category | none needed |
| 1.7 | `platform/http/problem-codes.test.ts` | Unit | written first | green (existing 4 problem tests kept passing) | 404, AppError, validation, 500, request id, three denial shapes | status override for framework 4xx |
| 1.8 | `main/config-deployment.test.ts` (+ updated `config.test.ts`) | Unit | written first | green | multi and single, 6 malformed slugs, cookie matrix, local and AWS KMS | `omit` test helper |
| 1.9 | `platform/country/country-pack.test.ts`, `country-isolation.test.ts` | Unit + lint | written first | green after the boundaries policy worked | registry hit and 4 misses; lint fixture rejects, registry file and clean file accepted | policy rewritten twice (see deviations) |
| 1.10 | `country/ar/identifiers.test.ts` | Unit | written first | green | tables of valid and invalid DNI, CUIT, passport; 3 property tests with fast-check | none needed |
| 1.11 | `country/ar/matricula.test.ts` | Unit | written first | green | 6 valid, 6 invalid, unknown jurisdiction, 24 jurisdictions | none needed |
| 1.12 | `country/ar/ar-pack.test.ts`, `messages.test.ts` | Unit | written first | green | defaults, retention, rules, adapters declared but not implemented | none needed |
| 1.13 | `db/seed/ar-holidays.test.ts`, `ar-payers.test.ts`, `test/integration/platform-catalogs.test.ts` | Unit + Integration | written first | green | Easter 2026 to 2028, movable rule in 4 weekday cases, idempotent loaders, duplicate and kind constraints, 6 refused writes | none needed |
| 1.14 | `db/schema/_helpers.test.ts`, `platform/db/uuid.test.ts` | Unit | written first | green | SQL snapshot, custom column option, quoting; UUID ordering within a millisecond and clock going back | generator factory for testable state |
| 1.15 | `test/integration/tenancy-schema.test.ts` | Integration | written first | green | 6 slugs, status, read_only_since, is_demo both directions, time zone checks, FK | none needed |
| 1.16 | `test/tenancy/isolation.generated.test.ts` | Integration | written first | green | every tenant table x 3 behaviors; composite FK mechanism proven on scratch tables | append-only branch added with the audit table |
| 1.17 | `modules/tenancy/domain/host.test.ts`, `application/resolve-tenant.test.ts`, `platform/http/tenant-host.test.ts`, `test/integration/tenant-lookup.test.ts` | Unit + Integration | written first | green | 22 host cases, spoofed headers, single and multi, DB lookup | none needed |
| 1.18 | `test/policy/no-tenant-in-contracts.test.ts` | Unit | written first | green | 6 flagged and 3 unflagged scanner cases | none needed |
| 1.19 | `platform/features.test.ts` | Unit | written first | green | both modes, signup and subscription routes present or absent | none needed |
| 1.20 | `export-registry.test.ts`, `create-tenant-policy.test.ts` | Unit | written first | green | registry kinds, duplicates, one contributor per module directory; single-mode second tenant refused | none needed |
| 1.21 | `platform/read-only/index.test.ts` | Unit | written first | green after one hang fix (async hook) | one case per category (10 x 2), cancelled tenant, public prefixes, boot failure | none needed |
| 1.22 | `platform/read-only/jobs.test.ts` | Unit | written first | green | active, frozen, AFIP before and after, boundary equal to the freeze, cancelled | none needed |
| 1.23 | `test/policy/route-categories.test.ts` | Unit | written first | green | real application routes enumerated | none needed |
| 1.24 | `test/integration/audit-table.test.ts` | Integration | written first | green | partitions, grants for 5 privileges, partition direct access refused, RLS | none needed |
| 1.25 | same file | Integration | written first | green | update and delete refused, seal once, second seal, other column, partial seal, no insert for sealer | none needed |
| 1.26 | `platform/audit/writer.test.ts`, `test/integration/audit-writer.test.ts` | Unit + Integration | written first | green | commit, forced failure, invalid event, rollback, context tenant | none needed |
| 1.27 | `audit-writer.test.ts` | Integration | written first | green | survives rollback, anonymous, unrecordable plus alert, failing alert | none needed |
| 1.28 | `platform/audit/request-context.test.ts` | Unit | written first | green | fields, actor set, proxy off and on, long agent, empty agent | done-callback hook |
| 1.29 | `test/integration/jobs.test.ts`, `platform/jobs/ticker.test.ts` | Integration + Unit | **test written after the code skeleton** (honest deviation: `define-job.ts`, `boss.ts`, `ticker.ts` existed before the test file; the test file was then written in full and the run was red once for the migration) | green (16 + 8) | commit and rollback of enqueue, tenant mismatch, worker context, read-only 4 cases, idempotence, rollback, invalid payload | FK made inline in migration |
| 1.30 | `canonicalize.test.ts`, `metrics.test.ts`, `test/integration/audit-sealer.test.ts` | Unit + Integration | written first | green after an `ORDER BY` alias bug (see gotchas) | interleaved concurrent inserts, idempotent, incremental, batches, grace, race of two sealers, late commit, lag | alias renamed |
| 1.31 | `test/integration/audit-verify.test.ts`, `worker.test.ts` | Integration | written first | green | intact, paged, empty, altered, metadata, gap, first row, swap, hash only, tenant independence, job metrics, end-to-end worker | none needed |
| 1.32 | `platform/crypto/aes-gcm.test.ts` | Unit | written first | green | text, binary, empty; 8 tamper positions; 4 AAD mismatches; wrong key; 20,000 nonces | none needed |
| 1.33 | `adapters/local-kek/local-kek.test.ts`, `adapters/aws-kms/aws-kms.test.ts`, `main/key-management.test.ts` | Unit | written first | green | wrap and unwrap, other tenant, other KEK, tamper; AWS commands, context, errors, bad key sizes | none needed |
| 1.34 | `test/integration/tenant-keys.test.ts`, `scripts/finish-migration.test.ts` | Integration + Unit | written first | green after removing the `tenantId` parameter (cache bypassed RLS) | create, idempotent, race of 5, round trip, tenant A vs B, row binding, cache TTL, eviction, rotation, no delete | API takes the tenant from the transaction |

### Test summary

- Unit: **45 files, 414 tests** (`pnpm test`).
- Integration: **16 files, 189 tests** (`pnpm test:integration`, Postgres 17 container, runtime role `app_rw`).
- Layers used: unit, integration, one ESLint-API lint test. No e2e test was added (no UI yet).
- Property tests: 3 (fast-check) on identifiers.
- Pure functions created: about 20 (validators, canonicalization, host classification, job gate, matricula, holidays).

### Verification evidence (tip of `feat/stage-1-secure-core`)

| Command | Result |
|---|---|
| `corepack pnpm install --frozen-lockfile` | exit 0 |
| `corepack pnpm typecheck` | exit 0 (root, contracts, api, web) |
| `corepack pnpm lint` | exit 0 |
| `corepack pnpm format:check` | exit 0 |
| `corepack pnpm test` | 45 files, 414 tests passed |
| `corepack pnpm test:integration` | 16 files, 189 tests passed |
| `corepack pnpm build` | exit 0 (api bundle, web with PWA) |
| `corepack pnpm db:check` | "No migration drift." |
| CI on PR #14 (draft) | all 6 checks green: typecheck/lint/unit/build, integration (Postgres 17), Docker image smoke test, Playwright, dependency audit, gitleaks |
| `docker build -f infra/Dockerfile -t consultorio-api:stage1 .` | exit 0; the container answers `/health` 200 with `x-request-id`, an unknown host gets the generic 404 problem+json, and a production config with the local KEK exits 1 naming `KMS_PROVIDER` |

### Decisions and deviations (all recorded because the owner was asleep)

1. **Migration numbering.** The task text names `0001_tenancy.sql`; platform catalogs (task 1.13) come first, so the files are `0001_platform_catalogs`, `0002_tenancy`, `0003_host_lookup`, `0004_audit`, `0005_jobs_and_platform_scope`, `0006_tenant_key`.
2. **Registry file.** The country registry lives in `platform/country/country-pack.ts` together with the interface (the task text puts both in that file). ESLint boundaries treat it as a file category (`boundaries/files`), because element patterns match folders.
3. **ESLint boundaries are now on** (`boundaries/dependencies: error`, default allow). The first policy is country isolation. The plugin needs `eslint-import-resolver-typescript` and `boundaries/root-path`, both added to `packages/config`.
4. **Lint fixtures** live in `__fixtures__` folders, ignored by normal runs and linted by the isolation test with `ignore: false`.
5. **Platform tables are read-only for `app_rw`** (task says "writable only by the operator role"). There is no operator database role yet; seed loaders and the future operator console write on the owner connection. To be revisited in S1.26.
6. **Holidays** are computed from Ley 27.399 (immovable list, movable rule, Easter-based days) plus the 2026 bridge days (23 March, 10 July, 7 December). **The owner should check these against the official calendar**: bridge days for 2027 and 2028 had not been declared and are intentionally absent (the operator adds them as data). Payers are a starter list of well-known obras sociales and prepagas, not an official registry.
7. **Roles.** `owner` and `admin` share one non-clinical bundle; only the owner holds `billing.manage`. The permission catalog is wider than the five grantable ones, as the design requires.
8. **Read-only gating also applies to `cancelled` tenants** (writes refused, allowlisted actions and reads served). The design only names `read_only`; the stricter reading is the safe one.
9. **Jobs have categories like routes.** Task 1.22 says only `afip.issue` jobs queued before `read_only_since` may run; audit sealing and exports are allowlisted categories (`audit_write`, `export`) and keep running for read-only tenants, otherwise the audit chain would stall. A job that cannot run is cancelled in pg-boss and the reason is logged; per-message "cancelled with reason" status arrives with the notifications module.
10. **Audit `occurred_at` default is `clock_timestamp()`** (insertion time, not transaction start) and the sealer waits a grace window (2 s default) before sealing, so rows that commit slightly late are not sealed out of order. A transaction longer than the grace window can still be sealed after newer events; the chain stays valid and verifiable.
11. **Platform scope policy.** Fan-out work (seal and verify per tenant) needs to list tenants before a tenant context exists. Two extra permissive policies on `tenant` exist: `tenant_host_lookup` (one row by `app.lookup_slug`, used by host resolution) and `tenant_platform_scan` (`app.scope = 'platform'`, used to list tenant ids). Both are transaction-local settings and are safety nets against forgotten filters, not defences against someone who already holds the application credentials; this is stated in the migrations.
12. **pg-boss is installed by the owner** (`installJobs`, called by `runMigrations`, so `db:migrate` and the Testcontainers setup both run it) and used by the runtime with `migrate: false`. A pg-boss upgrade is therefore applied by the next deploy's `db:migrate`. Enqueue joins the caller's transaction through the raw node-postgres client of the Drizzle transaction (`rawClientOf`), covered by a test that fails loudly if Drizzle moves that property.
13. **Job idempotence** uses a new tenant table `job_execution` (migration 0005) written in the handler's transaction; the wrapper skips a redelivered job id. This is not in the task text.
14. **Key management.** `encryptField`/`decryptField` take the tenant from the transaction (`app.tenant_id`), not from a parameter: a first version with a `tenantId` parameter let a cached key bypass row level security (found by the isolation test). `tenant_key` cannot be deleted by `app_rw`. A rotation function exists (`rotateTenantKey`) because ciphertexts carry the key version; it is not exposed by any route.
15. **Configuration additions** beyond the task text: `TRUST_PROXY` (client address from `X-Forwarded-For` only behind a trusted proxy), `COOKIE_SECURE`, `KMS_PROVIDER`, `KMS_LOCAL_KEK_BASE64`, `AWS_REGION`, `AWS_KMS_KEY_ID`. Production refuses the local KEK and insecure cookies. The compose `api` service runs with `NODE_ENV=development` for that reason.
16. **Sealer role.** `audit_sealer` is created by `infra/postgres/init/01-roles.sql` (cluster level) and granted to `app_rw` WITH SET, WITHOUT INHERIT. **Existing local Postgres volumes must be recreated** (`pnpm infra:reset`) or migration 0004 stops with a clear message.
17. **Tooling added:** `scripts/tenant-policies.ts` (prints the RLS SQL) and `scripts/finish-migration.ts` (inlines tenant foreign keys and appends the policies). The drift test was updated: its synthetic schema now re-exports the committed schema plus one extra table.
18. **Inline foreign keys to `tenant`.** `tenant` has FORCE row level security, so `ALTER TABLE ... ADD FOREIGN KEY ... REFERENCES tenant` fails in a migration (the validation scan has no tenant context). Foreign keys to `tenant` are declared inside `CREATE TABLE` (done by `finish-migration.ts`). Documented in the migrations.
19. **CI follow-ups found by the first push (PR #14).** (a) The CI image smoke test ran the production image with only `DATABASE_URL`; it now passes the production configuration (domains and AWS KMS settings, nothing contacts AWS at startup). (b) The worker end-to-end test timed out in CI: the jobs stayed `created` because each worker fetched ONE job per polling interval (2 s in production), so with a few dozen tenants the per-tenant seal queue starved the newest tenants. `registerJobs` now fetches batches of 20 with `burstWhenBatchFull`, settles every job on its own (`perJobResults`: one failing job no longer fails its neighbours) and logs failures by error code. Regression tests: a 150-job backlog is drained with the production polling interval (it fails with the old settings: verified), and a mixed batch settles as completed/failed/completed. After the fixes all six CI checks pass. A timeout in the worker test also prints the sealed counts and job states.
20. **Known limits stated in code:** removing only the newest sealed audit rows leaves a shorter consistent chain (needs the external anchor planned for Stage 6); the host guard queries the database on every request (no cache yet, to keep read-only changes immediate); the audit sealer fan-out lists every tenant every 5 s (fine for a pilot, needs a smarter trigger at scale).

### Files changed in this batch (main areas)

`packages/contracts/src` (errors, roles, route-category, result, ports, audit-actions, country/ar), `packages/config/eslint/base.js`, `apps/api/src/{main,platform,modules/tenancy,country/ar,adapters,db}`, `apps/api/test/{integration,tenancy,policy,support}`, `apps/api/scripts`, `infra/{docker-compose.yml,postgres/init/01-roles.sql}`, `.env.example`, `docs/{external-dependencies,dev-setup}.md`, `openspec/.../tasks.md`.

### Remaining after batch 3

Slices S1.09 to S1.37 (tasks 1.35 onward). Batch 4 (below) did S1.09 to S1.17.

## Batch 4: Stage 1, slices S1.09 to S1.17

Mode: **Strict TDD**. Branch `feat/stage-1-secure-core`, same delivery as batch 3 (work-unit commits, one draft PR #14 with `size:exception`, nothing merged). Toolchain: Node v24.22.0, pnpm 10.34.7, Docker engine running (Testcontainers: Postgres 17, Mailpit v1.31.6). Owner asleep, automatic mode: every decision below was taken from the design and specs.

### Commits (in order)

| Slice | Tasks | Commits |
|---|---|---|
| S1.09 Identity schema, password policy | 1.35 to 1.37 | `bd0c959` accounts, memberships, sessions, recovery codes + RLS (migration 0007); `a38665c` password policy + bundled list; `77449f4` argon2id with dummy verification |
| S1.10 Sessions and login | 1.38 to 1.41 | `11dc0af` sessions (migration 0008); `a6f0034` cookie, auth guard, Origin check; `ca6acb7` login, logout, me, sessions routes, `createApplication` |
| S1.11 Lockout and throttling | 1.42 to 1.44 | `96bdbdf` rate limits; `48c7ceb` lockout, backoff, throttles |
| S1.12 Action tokens, email | 1.45, 1.46 | `3366a95` tokens (migration 0009); `fb8a4de` email port, SMTP + fake adapters, templates, SMTP config |
| S1.13 Two-factor | 1.47 to 1.50 | `ee4b12a` TOTP, recovery codes, service (migration 0010); `04c914c` login flow, enrollment scope, routes |
| S1.14 Reset and invitations | 1.51 to 1.53 | `90f8d99` field errors, background tasks, breach check; `76c8519` reset, admin reset, invitations |
| S1.15 Authorization engine | 1.54 to 1.58 | `113a25a` `can()` and the professional gate; `44787a8` permission guard, role matrix and admin-denied harness |
| S1.16 Sharing-scope predicate | 1.59, 1.60 | `ddf9a39` |
| S1.17 SQL backstop and care tables | 1.61 to 1.63 | `c0b9353` care tables, functions (migration 0011); `3e43aa6` clinical policies helper, sharing settings per transaction, agreement test |

### What was built

- **Identity data.** `user_account` (global, citext email, no `tenant_id`), `membership`, `session`, `login_challenge`, `recovery_code`. `user_account` is protected by its own policies: readable if you ARE the user or the account has a membership in your tenant; insert and update only for the account the transaction acts as; the login lookup is the SECURITY DEFINER function `app.lookup_user_for_login(email)` (minimal columns, and a policy for `app_owner` only, so `app_rw` cannot read accounts directly). `app.revoke_user_sessions` (migration 0008) ends the sessions of the acting user in every tenant.
- **Passwords.** Argon2id (OWASP baseline), `verifyOrDummy` (exactly one verification on every path), policy of 10 to 128 characters, bundled NCSC top-100k list (`apps/api/assets`), rejection of a single repeated character and of the account email, optional k-anonymity breach check behind `AUTH_BREACH_CHECK` (off).
- **Sessions and HTTP.** Opaque 256-bit token, SHA-256 at rest, cookie `sid` `HttpOnly; Secure; SameSite=Lax; Path=/` with no Domain, idle 12 h and absolute 7 days, rotation on login and on privilege change. Authentication guard: every route declares `config.auth` or `config.permission`, otherwise it fails at boot. Origin check on every non-GET request (a request with a session cookie and no Origin is refused). `createApplication` is the composition both `main` and the tests build.
- **Lockout.** Gate before credentials, attempt charged BEFORE the password is verified (parallel guesses cannot exceed the limit), 10 failures lock for 15 minutes (both configurable by env), backoff 1 s doubling to 5 min after the third failure, per-account in-memory throttle for unknown identifiers so they behave like real accounts, per-address delay (only delays, after 10 failures), dummy verification on refused paths, audit `auth.account.locked|unlocked`, `auth.login.locked`.
- **Rate limit.** Per client address and per tenant, behind a store interface (in-memory), route-level overrides, `Retry-After`, probes exempt.
- **Tokens and email.** `action_token` (SHA-256 at rest, atomic single-use redeem, session binding, per-kind lifetime, canonical kinds with only the four account kinds enabled). Email port, SMTP adapter (Mailpit locally, SES SMTP in production), in-memory fake, es-AR templates for reset and invitation. Production requires `SMTP_HOST` and TLS.
- **Second factor.** TOTP (RFC 6238 vectors pass) with the secret encrypted by the tenant data key, replay block by last used step (atomic), ten hashed recovery codes, pending enrollment that never disables the working factor, challenge of 5 minutes and 5 attempts, wrong or reused codes count toward the same lock, mandatory for owner/admin/professional with a 7-day grace from the first sign-in then an enrollment-scoped session (403 `two_factor_enrollment_required` everywhere else), reception optional unless `tenant.settings.require_2fa`, password asked again to replace the factor or regenerate codes, mandatory roles cannot disable it.
- **Reset and invitations.** Reset request answers 204 for everyone and works after the response (background task), at most 3 emails per account per hour, 30-minute single-use token, weak passwords do not burn the token, completion ends every session in every tenant, lifts a lock, signs nobody in and does not bypass 2FA. `POST /users/:id/password-reset` (permission `staff.manage`) only sends the email. Invitations: ceiling per inviter role (admin cannot invite owners), re-checked when accepted, an existing account is linked without touching its password, 7-day single-use link.
- **Authorization.** `can(actor, action, resource)` over the catalog (grants limited to `GRANTABLE`, clinical needs the professional gate, unknown action or malformed actor denies, cross-tenant denies, patient class denied on every staff action), `deriveProfessionalId` (active profile + recorded valid matricula only), permission guard with uniform 403 and `auditDeny` on its own connection, `routePermissions` registry, role x permission matrix over HTTP generated from the catalog, admin-denied harness over every `clinical.*` route.
- **Sharing scope.** Pure predicate with the `treating()` port, inclusion list, prescriptions never shared (D17), psychology off by default, new templates never auto-added, `sharedReadAuditReason`. SQL mirror `app.clinical_readable` + `clinicalPolicies(table)` helper (RESTRICTIVE `clinical_professionals_only` and `clinical_scope`); `withTenant` loads the sharing settings once per professional transaction; sharing defaults to OFF when not loaded. A fast-check property test runs the TypeScript predicate and the SQL function on 150 random combinations.
- **Care tables.** `care_assignment` (ended, never deleted), `care_relationship` with the generated `active` flag, writable only through SECURITY DEFINER functions called by triggers (`app.care_set_assigned`, `app.care_adjust` for the Stage 2 triggers).

### TDD Cycle Evidence

RED means the test file was written before the production code it exercises. GREEN is the file-level run that followed. "Triangulated" means at least two cases with different inputs or a generated table.

| Task | Test file(s) | Layer | RED | GREEN | Triangulation |
|---|---|---|---|---|---|
| 1.35 | `test/integration/identity-schema.test.ts`, generated `isolation.generated.test.ts` | Integration | written first (import of the schema failed) | green, 49 tests with the generated suite | readable through membership, own row, two tenants, update of a colleague, no delete, citext duplicate, lookup function columns, role and status checks, recovery code owner |
| 1.36 | `modules/identity/domain/password-policy.test.ts`, `breached-passwords.test.ts` | Unit | written first | green | length boundaries (9/10, 128/129), emoji count, list hit with case and spaces, passphrases, email part, real 100k list, breach prefix only |
| 1.37 | `infrastructure/argon2.test.ts` | Unit | written first | green | spy counts: known, unknown, undefined hash, dummy built once, real library |
| 1.38 | `sessions.test.ts` (unit), `test/integration/sessions.test.ts`, `platform/http/session-cookie.test.ts` | Unit + Integration | written first | green (one test corrected: it spaced uses beyond the idle window) | fake clock at idle and absolute limits, rotation, revoke all, revoke everywhere as the acting user only, cookie flags matrix |
| 1.39 | `test/integration/auth-routes.test.ts`, `packages/contracts/src/auth.test.ts` | Integration + Unit | written first | green | wrong password vs unknown email equal, deactivated, other host, cookie replay on another tenant, rotation, sessions list and revoke, 404 for another user's session |
| 1.40 | `platform/http/auth-guard.test.ts`, `csrf-origin.test.ts`, `test/policy/public-routes.test.ts` | Unit + policy | written first | green | public prefix table (8 allowed, 9 refused), boot failure without declaration, Origin matrix (5 hostile origins), cookie without Origin |
| 1.41 | `auth-routes.test.ts` (audit section) | Integration | written first | green | success, failure with known and unknown account, no password, no email |
| 1.42 | `lockout.test.ts` (unit, 21), `attempt-throttle.test.ts`, `test/integration/lockout.test.ts` | Unit + Integration | written first | green after two test fixes (per-test client address) | 10 failures lock, 11th with right password 401, unlock after exactly 15 minutes, last second still locked, backoff table, parallel 25 guesses |
| 1.43 | `platform/http/rate-limit.test.ts`, `test/integration/login-rate-limit.test.ts` | Unit + Integration | written first | green | 429 after the limit, per tenant, per address, tenant-wide, route override, probes exempt, IPv6 /64 |
| 1.44 | `lockout.test.ts` (integration) | Integration | written first | green | locked account vs unknown email: same body, status and header names; one verification per path |
| 1.45 | `platform/tokens/kinds.test.ts`, `test/integration/action-tokens.test.ts` | Unit + Integration | written first | green | 12 simultaneous redemptions, one winner; expiry boundary; wrong kind keeps the token; other tenant; revoke; inspect; session binding |
| 1.46 | `platform/mail/templates.test.ts`, `adapters/fake-email/fake-email.test.ts`, `test/integration/smtp-email.test.ts` | Unit + Integration | written first | green (Mailpit container) | HTML escaping, javascript: link refused, singular/plural, accents survive SMTP, delivery failure without leaking |
| 1.47 | `application/totp.test.ts`, `test/integration/two-factor.test.ts` | Unit + Integration | written first | green | six RFC 6238 vectors, drift window, replay, spaces, malformed codes; encrypted at rest; concurrent replay; other tenant's key |
| 1.48 | `recovery-codes.test.ts`, `two-factor.test.ts` | Unit + Integration | written first | green | ten distinct, no confusable characters, any typing style, single use, regenerate, hashes only |
| 1.49 | `test/integration/two-factor-routes.test.ts`, `two-factor-policy.test.ts` | Unit + Integration | written first | green after a lock test fix and a real bug (below) | role x grace x enrolled matrix, enrollment scope 403, challenge single use, 5 minutes, 5 attempts, 10 wrong codes lock |
| 1.50 | `two-factor-routes.test.ts` (audit) | Integration | written first | green | enrolled, verified, failed, recovery used, regenerated, disabled |
| 1.51 | `test/integration/password-reset.test.ts` | Integration | written first | green | non-enumeration, 3 per hour, older links cancelled, reuse, 30 minutes, weak password keeps the link, all sessions ended in two tenants, 2FA kept, lock lifted |
| 1.52 | `password-reset.test.ts` (admin), `packages/contracts/src/auth-recovery.test.ts` | Integration + Unit | written first | green | reception 403, other tenant 404, body with password 400, contract scan: only five request schemas carry a password and none names a user |
| 1.53 | `test/integration/invitation-accept.test.ts`, `domain/invitation-ceiling.test.ts` | Integration + Unit | written first | green | roles equal invited, expired, inviter demoted or deactivated, existing account keeps its password, already member 409 |
| 1.54 | `platform/authz/can.test.ts` | Unit | written first | green | every non-patient role against every non-clinical permission, grants, unknown action, malformed actor, cross tenant, patient class |
| 1.55 | `platform/authz/guard.test.ts`, `test/policy/route-role-matrix.test.ts` | Unit + policy | written first | green | 4 staff roles x 34 permissions over HTTP, boot rules, denial audited, recording failure still denies |
| 1.56 | `test/integration/admin-denied.test.ts` | Integration | written first | green after a harness fix (Fastify registers HEAD for every GET) | owner, admin, reception on every clinical route: 403, uniform body, one audit row per denial |
| 1.57 | `platform/authz/professional-gate.test.ts` | Unit | written first | green | six invalid profiles, three roles without the professional role, repository failure |
| 1.58 | `can.test.ts`, `guard.test.ts` | Unit | written first | green | every staff permission denied to the patient class, disguised patient, portal permission kept |
| 1.59 / 1.60 | `platform/authz/sharing-scope.test.ts` | Unit + property | written first | green | table cases per rule plus five fast-check properties |
| 1.61 | `test/integration/care-relationship.test.ts` | Integration | written first | green after a real bug (below) | assignment, removal, re-assignment, one live per pair, direct writes refused, functions not callable, counters with a Stage 2 style trigger |
| 1.62 | `db/schema/_helpers.test.ts`, `clinical-backstop.test.ts` | Unit + Integration | written first | green | SQL text of both policies, quoting, constant template kind |
| 1.63 | `test/integration/clinical-backstop.test.ts` | Integration + property | written first | green | admin 0 rows, non-treating 0, treating 1, author_only, sharing on/off, immediate effect, prescription, damaged settings; SQL vs TypeScript on 150 random cases |

### Test summary and verification (tip of `feat/stage-1-secure-core`)

- Unit: **76 files, 766 tests** (`pnpm test`, includes contracts and policy tests). Integration: **33 files, 432 tests** (`pnpm test:integration`, Postgres 17 as `app_rw`, Mailpit container).
- Layers: unit, integration, policy (route enumeration), property (fast-check, 6 properties). No e2e added (no UI yet).

| Command | Result |
|---|---|
| `corepack pnpm install --frozen-lockfile` | exit 0 |
| `corepack pnpm typecheck` | exit 0 |
| `corepack pnpm lint` | exit 0 |
| `corepack pnpm format:check` | exit 0 |
| `corepack pnpm test` | 76 files, 766 tests passed |
| `corepack pnpm test:integration` | 33 files, 432 tests passed |
| `corepack pnpm build` | exit 0 |
| `corepack pnpm db:check` | "No migration drift." |
| `corepack pnpm audit --prod --audit-level=high` | no known vulnerabilities |
| `docker build -f infra/Dockerfile -t consultorio-api:stage1b .` + run with the production configuration of the CI smoke test | `/health` 200, unknown route 404, the common-password list is found in `/app/assets`; without `SMTP_HOST` the process exits naming `SMTP_HOST` |

### Bugs found by the tests and fixed in the same slice

1. **2FA step throttled right after a correct password.** The password attempt is charged before it is verified; the refund after a correct password left `last_failed_at` at "now", so after three earlier typos the code step was refused by the backoff. Fixed: the second-factor step is gated by the lock only (the backoff does not apply once the password was proven) and the refund restores the previous `last_failed_at`. Regression test: "does not make a user wait after earlier typos".
2. **`app_rw` could call the maintenance functions of the care relationship.** `REVOKE ... FROM PUBLIC` is not enough here because the default privileges of schema `app` give `app_rw` EXECUTE on every new function. Fixed with `REVOKE ... FROM PUBLIC, app_rw` (the triggers run them as the owner). Test: direct calls fail.
3. A challenge test spaced attempts beyond the 5-minute challenge life and proved nothing; rewritten to use short spacing and a fresh challenge per attempt.

### Decisions and deviations (all recorded because the owner was asleep)

1. **Table name `user_account`** (not `user`): `user` is a reserved word. `session.tenant_id` IS the task's `active_tenant_id`.
2. **Migrations** 0007 identity, 0008 session revocation, 0009 action token, 0010 `totp_pending_enc` column, 0011 care and clinical backstop. All foreign keys to RLS tables are inline in `CREATE TABLE` (same reason as batch 3). `care_relationship` and `care_assignment` have no foreign keys to `patient` and `professional` yet (the tables arrive in S1.19 and S1.20, which must add the composite keys; if the validation scan needs a tenant context, use `NOT VALID` or `NO FORCE` around the statement).
3. **`@fastify/rate-limit` was NOT used.** The plugin adds its limiter as a per-route hook, which runs after application-level hooks, so it cannot protect the session lookup of the auth guard, and registering a plugin is asynchronous so a route added right after `buildServer` could miss it. `platform/http/rate-limit.ts` is a synchronous `onRequest` hook over a `RateLimitStore` interface, with the same behavior the task lists (per address and per tenant, separate buckets, store interface, 429 with `Retry-After`). It was installed, tried and removed.
4. **Pre-charge lockout.** The attempt is charged before the password is verified and refunded on a right password that needs a second factor. This is what makes parallel guesses count; it is more than the task text, which only lists the counter.
5. **2FA secret per account, encrypted with the tenant key of the tenant where it was enrolled** (`totp_tenant_id`), because the account is global but keys are per tenant; another tenant reads it through a short transaction on the enrolling tenant. A pending secret lives in `totp_pending_enc` so a replacement never disables the working factor.
6. **Recovery codes** are 16 symbols of a 31-symbol alphabet (about 79 bits) hashed with SHA-256, shown once.
7. **Reset flows.** The reset request does its work in a background task after answering 204 (equal timing for known and unknown accounts); the tasks are awaited when the server closes and failures are logged by error code. At most 3 reset emails per account per hour. The link base is the tenant host of the request (`/reset-password?token=`, `/accept-invitation?token=` are the web routes S1.31 must provide). The organization name in the emails is the tenant slug until branding (S1.25) gives a display name.
8. **Invitation ceiling** (not specified in detail): owner may invite any staff role, admin may invite admin, professional and reception but not owner, nobody else may invite; re-checked when the invitation is accepted. The invitation is issued by `identity.invitations.issue` (S1.19 will call it and send the email). An existing account is linked to the new tenant without touching its password and without signing in.
9. **Routes without a permission** must live under `/auth/` (self-service) or be `public`; a policy exists at boot. `POST /users/:id/password-reset` uses `staff.manage`.
10. **`createApplication` options** `professionals`, `grants` and `modules` are the extension points for S1.18, S1.19 and the later capabilities. Until they exist nobody passes the professional gate and no grants apply (fail closed).
11. **`withTenant` loads the sharing settings** (`app.clinical_sharing`, `app.shared_templates`) only for transactions with an `actingProfessionalId`, one extra statement per such transaction. Without them sharing is off.
12. **`app.clinical_readable` template convention:** the note's template name; `NULL` for the entries under the general ceiling; `'prescription'` for prescriptions (excluded from sharing even if listed). `sqlTemplateKind()` maps TypeScript entries to it and the agreement test covers it. The RESTRICTIVE policies apply to reads and writes; author-only write rules stay in the services and in the Stage 2 triggers.
13. **Session mismatch audit.** A cookie replayed on another tenant's host simply finds no session (RLS) and gets 401. It is not written as `cross_tenant.denied` because the session cannot be looked up across tenants without another definer function. Cookies are host-only, so this only happens with a stolen cookie.
14. **Environment variables added** (all documented in `.env.example`, validated by tests): `AUTH_LOCKOUT_MAX_FAILURES`, `AUTH_LOCKOUT_MINUTES`, `AUTH_BREACH_CHECK`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM`. `SMTP_HOST` is required in production (with `starttls` or `tls`); the CI image smoke test and the compose `api` service were updated. `.env.example` was edited with placeholders only; no `.env` file was read or written.
15. **Dockerfile** copies `apps/api/assets` (the common-password list) to `/app/assets`; the API stops at startup if it cannot find it.
16. **Data asset licence.** `common-passwords-100k.txt` is the NCSC list distributed by SecLists (MIT); see `apps/api/assets/README.md`.
17. **Known limits:** the in-memory throttles and rate limits are per process (move to the store interface backed by Postgres or Valkey at two instances); a client address that fails more than 10 times is delayed up to 5 minutes (a clinic sharing one address could be delayed by one noisy user); the admin reset route sends the email inside the request, so an SMTP outage answers 500 to the administrator.

### Remaining

Slices S1.18 to S1.37 (tasks 1.64 onward). Next: **S1.18 Access module: grants, settings, locations** (it plugs `grants` into `createApplication` and the sharing settings write path), then S1.19 (staff and professionals: plugs `professionals`, sends invitations).


## Batch 5: Stage 1, slices S1.18 to S1.26

Mode: **Strict TDD**. Branch `feat/stage-1-secure-core`, same delivery as batches 3 and 4 (work-unit commits, draft PR #14 with `size:exception`, nothing merged). Toolchain: Node v24.22.0, pnpm 10.34.7, Docker engine running (Testcontainers: Postgres 17, MinIO `bitnamilegacy/minio:2025.7.23-debian-12-r5`). Owner asleep, automatic mode: every decision below was taken from the design and specs.

### Commits (in order)

| Slice | Tasks | Commits |
|---|---|---|
| S1.18 Access | 1.64 to 1.67 | `ad5676e` finish-migration inlines FKs; `2ca6911` grants + membership locations (0012); `4ee0d1b` grant/revoke API, role-change rules; `704a7ab` settings API; `00944b9` locations API |
| S1.19 Staff and professionals | 1.68 to 1.71 | `cbd66eb` professional tables + operator-only verification trigger (0013); `6d41867` profile service; `5bb7aa6` invitations, directory, lifecycle; `cf11822` weekly hours |
| S1.20 Patients core | 1.72 to 1.75 | `74d1ee4` tables (0014); `d483f25` registry API; `e3a178c` search; `8d596f2` minors and representatives |
| S1.21 Coverage, consent, rights | 1.76 to 1.78 | `c1ae8a7` tables (0015); `55e270c` coverage; `6f1a376` consent; `b4374a6` rights requests |
| S1.22 Anamnesis, safety flags, assignment | 1.79 to 1.82 | `5cb88ba` anamnesis + flag setter (0016); `7bfa924` anamnesis API; `e35bbbb` assignment API + DTO guard; `dba82a0` guard fix |
| S1.23 Audit viewer and report | 1.83 to 1.86 | `d4d5bc6` viewer, report, export; `fe68e05` partitions task + runbook; `8763182` coverage policy test |
| S1.24 Object storage | 1.87 | `d47fb3e` port, fake, S3 adapter against MinIO |
| S1.25 Branding API | 1.88 to 1.91 | `47fd24c` contrast; `438ae4e` identity API; `10d0a8c` logo upload; `51fbdd4` boot payload and manifest |
| S1.26 Operator console API | 1.92 to 1.95 | `49b5055` operator tables, platform trail, `app_operator` allowlist (0017); `3c394ce` console API, tenant creation, support grants |

### What was built

- **Access (S1.18).** `permission_grant` (`CHECK permission NOT LIKE 'clinical.%'`) and `membership_location`; grant and revoke API with role-change rules (no self-escalation, ceiling, last owner protected by a row lock, sessions ended on privilege change); settings API (`reception_sees_clinical_metadata`, `clinicalSharing`, `sharedTemplates`, 2FA policy, quiet hours); locations API and the `visibleLocationIds` helper. The helper script `finish-migration.ts` now moves foreign keys to existing FORCE-RLS tables inline into `CREATE TABLE`.
- **Staff (S1.19).** `professional` and `professional_hours`; the matricula is validated through the country pack; editing it resets to `unverified`; a trigger lets only `current_user = 'app_operator'` set `verified`. Invitations (role ceiling, email), role-aware directory, deactivate and reactivate that keep history. Weekly hours are compared as absolute instants across locations and time zones.
- **Patients (S1.20 to S1.22).** Registry with partial-unique document deduplication (409 carries `existingPatient`), append-only `patient_version`, accent-insensitive search (generated `search_name` through `app.f_unaccent`, phone digits), minors need a representative and carry `majority_review_on` from the country pack. Payer plans and coverage (edits end the old row and insert a new one), data-processing consent captured at registration (required field `dataProcessingConsent`), revocation and rights requests allowed in a read-only organization (category `patient_protective`). Encrypted versioned anamnesis behind the clinical policies; safety flags (`allergy_on_file`, `anticoagulant_on_file`, `pregnancy`, `implanted_device`) written only by the SECURITY DEFINER function `app.set_patient_safety_flags`, guarded by a trigger and a policy test that no code path sets them. Care assignment API where nobody assigns themselves.
- **Audit (S1.23).** Viewer with filters and cursor paging, patient access report, streamed CSV/JSON export whose own `audit.exported` entry is written before the first byte, CSV formula-injection guard, partition upkeep as a named platform task (`audit.partitions`, run by the worker at start and nightly), retention runbook. `audit-coverage.test.ts` makes a missing scenario for any audit action a compile error and requires every mutating route to declare `config.audits` (a list of actions or `'none'`).
- **Object storage (S1.24).** Port with tenant-prefixed keys (`t/{tenantId}/...`, a key outside the tenant is refused), in-memory fake with a shared contract suite, S3 adapter (AWS SDK v3, presigned POST) proven against MinIO. Optional `S3_*` variables, static keys refused in production.
- **Branding (S1.25).** OKLCH contrast computation (requested color kept, effective color adjusted until 4.5:1, white foreground), `GET|PUT /branding`, `POST /branding/preview`, diff audited. Logo: `PUT|DELETE /branding/logo` with the raw image as body (PNG, JPEG, WebP; SVG and anything else get 415; 512 KB cap; magic-byte sniff; polyglot detection by PNG IEND, JPEG EOI and WebP RIFF size; 2048 px cap; re-encode with `sharp` to a clean PNG of at most 512 px, EXIF gone); versioned key so a new logo is a new URL; the previous object is removed only after the commit. Public `GET /public/branding/logo` (nosniff, `default-src 'none'; sandbox`, immutable cache, optional `?size=192|512` square icon). Without storage the upload answers 503. Public `GET /public/boot` (whitelisted keys only) and per-host `GET /manifest.webmanifest`.
- **Operator console (S1.26).** `operator_user` (password + mandatory TOTP, no grace period, TOTP secret envelope-encrypted with a per-operator data key wrapped by the key service, lockout after 5 failures for 15 minutes), `operator_session` (`osid` cookie, `SameSite=Strict`, 30 min idle, 8 h absolute), `platform_audit_event` (one global append-only chain sealed by `audit_sealer` with the tenant hashing code, sealed and verified by the worker), `support_grant`. Routes live under `/operator/*`, answer only on the platform host (a tenant host, an unknown host or a deployment without `OPERATOR_DATABASE_URL` gets the same 404 as an unknown route) and are `auth: 'public'` for the global guard because the console has its own guard (`config.operatorAuth` is mandatory at boot). `POST /operator/tenants` creates the tenant (slug generated, random suffix on collision and never revealed, `is_demo` fixed at creation), its data key, default settings and the owner's single-use invitation (by email only, never in the response), audited on both trails. `POST /operator/tenants/:id/owner-invitation` re-sends it while nobody has joined. `POST /operator/tenants/:id/demo-reset` refuses non-demo organizations (409, audited) and calls an injected `DemoResetPort` (503 until S1.36 provides it). The organization's owner opens and closes a support window with `GET|POST /support-grants` and `DELETE /support-grants/:id` (permission `tenant.support.manage`, owner only, 1 to 168 hours); `GET /operator/tenants/:id/support/overview` needs an active, unexpired grant and writes `support.access` to both trails in the same transaction as the read.
- **The `app_operator` allowlist.** Table privileges on exactly: `tenant` (insert, select of non-sensitive columns, no `settings`, no update), `tenant_key`, `action_token`, `audit_event` (insert only, restricted by policy to `tenant.created` and `support.access`), `location` and `tenant_feature` (select, restricted by a RESTRICTIVE policy to organizations with an active support grant), `professional` (matricula verification columns only), and the operator's own tables. A test lists every table with any privilege and compares it with that list; another proves no patient, clinical, membership, account or scheduling table is touched and that a real read is refused. The operator can issue an invitation only for an organization with no member (`app.tenant_is_unclaimed`), only of kind `staff_invitation`, and the invitation of origin `operator` is accepted for the owner role only and only while the organization has no member.

### TDD Cycle Evidence

RED means the test file was written (or the type/behavior assertion failed) before the production code it exercises. Exceptions are stated in the last column.

| Tasks | Test file(s) | Layer | Notes |
|---|---|---|---|
| 1.64 | `access-schema.test.ts`, generated isolation | Integration | RED: schema import failed. The CHECK refuses clinical permissions at the database |
| 1.65 | `domain/role-change.test.ts`, `grant-rules.test.ts`, `access-grants.test.ts` | Unit + Integration | RED first. The last owner is protected by row locks in the service |
| 1.66 | `domain/settings.test.ts`, `access-settings.test.ts` | Unit + Integration | RED first. Psychology only by explicit confirmation |
| 1.67 | `access-locations.test.ts` | Integration | RED first. Reception sees only its locations |
| 1.68 to 1.70 | `staff-schema.test.ts`, `staff-profile.test.ts`, `staff-lifecycle.test.ts` | Integration | RED first. A tenant user cannot verify a matricula; edit resets; invitation ceiling |
| 1.71 | `domain/hours.test.ts`, `staff-hours.test.ts` | Unit + Integration | RED first. Overlap across time zones |
| 1.72, 1.73, 1.75 | `patients-schema.test.ts`, `patients-api.test.ts`, `patients-minors.test.ts`, `domain/majority.test.ts` | Unit + Integration | RED first |
| 1.74 | `patients-search.test.ts` | Integration | **Deviation:** the search query was implemented before its test; the test (accent-insensitive, 10,000 seeded patients) was written afterwards in the same work unit |
| 1.76 to 1.78 | `coverage-schema.test.ts`, `patients-coverage.test.ts`, `patients-consent.test.ts`, `patients-rights.test.ts` | Integration | RED first |
| 1.79 to 1.82 | `anamnesis-schema.test.ts`, `anamnesis-api.test.ts`, `application/safety-flags.test.ts`, `care-assignment-api.test.ts`, `policy/no-safety-flag-setter.test.ts` | Unit + Integration + policy | RED first. Self-assignment is denied: the spec wins over the task text |
| 1.83 to 1.85 | `audit-viewer.test.ts`, `audit-partitions.test.ts`, `domain/csv.test.ts`, `policy/no-audit-delete.test.ts` | Unit + Integration + policy | RED first |
| 1.86 | `policy/audit-coverage.test.ts`, `policy/audit-scenarios.ts` | policy | **Honest limit:** the `audits` tag of a route is a declaration checked to exist and to name known actions, not an assertion that the route really writes that entry; the entries themselves are proven by the scenario tests |
| 1.87 | `platform/storage/object-storage.test.ts`, `adapters/memory-storage`, `storage-s3.test.ts` (MinIO) | Unit + Integration | One contract suite runs against the fake and the S3 adapter |
| 1.88 | `branding/contrast.test.ts` | Unit + property | fast-check, stable over 8 runs |
| 1.89 | `branding-api.test.ts` | Integration | 19 tests |
| 1.90 | `branding/logo.test.ts` (12), `branding-logo.test.ts` (20) | Unit + Integration | Polyglot, oversize, SVG, mismatch, dimensions, EXIF stripped, 503 without storage, hardened headers |
| 1.91 | `branding-boot.test.ts` | Integration | Only whitelisted keys; two hosts, two themes; platform and unknown hosts 404 |
| 1.92 | `operator-privileges.test.ts`, generated isolation (fixture `support_grant`), `rls-catalog.test.ts` | Integration | Written with the console tests (the harness needs the module), so the 1.92 commit has no test of its own; the allowlist test and the matricula positive test (a real `app_operator` login verifies) run in the suite |
| 1.93 | `operator-auth.test.ts` (19) | Integration | Tenant users get 404 on `/operator/*`; uniform failures; replayed code; lockout and unlock; idle expiry; CSRF; secret encrypted at rest and bound to its row; platform chain sealed, verified, tamper detected (and restored) |
| 1.94 | `domain/slug.test.ts`, `operator-tenants.test.ts` (17) | Unit + Integration | Owner accepts the invitation and signs in; collision invisible; `is_demo` immutable; both trails; reissue; forged invitations refused at the database; demo reset (allow, deny, 404, 503) |
| 1.95 | `operator-support.test.ts` (15) | Integration | No grant, expired, revoked, other tenant's grant: all denied; each use on both trails; database policy proven without the service |

### Test summary and verification (tip of `feat/stage-1-secure-core`, before this progress commit)

- Unit: **95 files, 1102 tests** (`pnpm test`). Integration: **65 files, 1000 tests** (`pnpm test:integration`, Postgres 17 as `app_rw` and `app_operator`, MinIO container).

| Command | Result |
|---|---|
| `corepack pnpm install --frozen-lockfile` | exit 0 |
| `corepack pnpm typecheck` | exit 0 |
| `corepack pnpm lint` | exit 0 |
| `corepack pnpm format:check` | exit 0 |
| `corepack pnpm test` | 95 files, 1102 tests passed |
| `corepack pnpm test:integration` | 65 files, 1000 tests passed |
| `corepack pnpm build` | exit 0 |
| `corepack pnpm db:check` | "No migration drift." |
| `corepack pnpm audit --prod --audit-level=high` | no known vulnerabilities |
| `docker build -f infra/Dockerfile` + smoke run with the production configuration of the CI smoke test | `/health` 200, unknown route 404, `/operator/me` on the platform host 404 (no operator database configured), `sharp` loads and encodes inside the image |

### Bugs found by the tests and fixed in the same slice

1. A test-support helper for the operator emails collided across test files (one shared database): addresses are now random per call.
2. `platform-catalogs.test.ts` counted every payer of the shared database, so the payers the coverage tests insert broke it (a flaw from S1.21 that only a full run shows): it now counts the seeded payers only.
3. Drizzle stamps `updated_at` on every update, which the column-level grants of `app_operator` did not cover (matricula verification and the invitation revoke): both grants now include `updated_at`.
4. A raw `tx.execute` returns timestamps as strings with this driver setup: the support overview parsed a date from a raw query and failed; it converts explicitly.

### Decisions and deviations (all recorded because the owner was asleep)

1. **Routes have no `/api/v1` prefix** (like `/auth/*`); the task text says `/api/v1/...`. The web slices must proxy or rewrite `/api` (the dev server already proxies `/api`; the reverse proxy must strip it). Adding the prefix later is one change in `buildServer`.
2. **Permissions.** New `staff.directory.read` (every staff role) and `tenant.support.manage` (owner only). The task's `branding.manage` is the catalog's `tenant.branding.manage`.
3. **Self-assignment is denied** (spec "no one may assign themselves") although task 1.81 says "professional self-assign".
4. **`audit.partitions`** is a platform scheduled task run by the worker (global, not a per-tenant pg-boss job) because partitions are shared by all tenants.
5. **Hours date exceptions** are deferred to scheduling (S2.01); S1.19 covers the weekly pattern.
6. **Database guards.** Matricula verification keys on `current_user = 'app_operator'`; safety flags on `current_user = 'app_owner'` (the definer function runs as the owner).
7. **S3 variables are optional in production** until Stage 2 documents a bucket; without a bucket logo upload answers 503.
8. **Anamnesis clinical export contributor** is not registered yet (only administrative ones are); it must exist before Stage 6.
9. **Author reads of their own entries** after losing the treating relationship remain allowed (the design predicate).
10. **The audit export lists its own `audit.exported` entry.**
11. **Organization name in emails** comes from `theme.displayName`, falling back to the slug. The recovery-routes link context still uses the slug and should move to `readOrganizationName`.
12. **Migrations** 0012 access, 0013 staff, 0014 patients, 0015 coverage and privacy, 0016 anamnesis, 0017 operator. The role `app_operator` is created by `infra/postgres/init/01-roles.sql`: an existing local volume needs `pnpm infra:reset`.
13. **Operator TOTP secret** uses the key service with a new purpose `operator-dek` and the nil UUID as tenant, one data key per operator, instead of the tenant key table. The TOTP code module moved to `platform/crypto/totp.ts` so the operator module does not import identity internals.
14. **Operator sign-in is one step** (password and code together), so there is no half-signed-in state. Operators exist only through the bootstrap script `pnpm --filter @consultorio/api operator:create` (password from `OPERATOR_PASSWORD`), never through an endpoint.
15. **`OPERATOR_DATABASE_URL`** (documented in `.env.example`, compose and `docs/dev-setup.md`) is optional; without it, or in single-tenant mode, the console does not exist. The operator pool has 3 connections.
16. **Support access shows configuration only** (organization, locations, feature flags). Anything that would read people or care is impossible at the database level, not only in the service.
17. **The owner invitation of an operator-created tenant** carries `origin: 'operator'`; acceptance skips the inviting-member check only for that origin, only for the owner role, and only while the organization has no member. The operator can revoke older invitations of an unclaimed organization (typo in the address) but nothing else on `action_token`.
18. **Demo reset** is a port (`DemoResetPort`). The tenant-side `tenant.demo_reset` audit action stays `pending` for S1.36, because the reset deletes the demo organization's own chain; the platform-level entry is written now.
19. **Prettier and drizzle-kit snapshots.** `prettier --write <directory>` rewrites `migrations/meta/*.json` even though `.prettierignore` lists them (explicit paths override the ignore file). Never pass a directory that contains them; this cost one revert during the batch.
20. **Known limits:** operator rate limit and lockout are per account in the database but the login rate limit is per process (same as tenants); the platform chain has no external anchor (same limit as the tenant chains, Stage 6); the operator console has no UI (an operator uses the API; the web slice for it is out of Stage 1 scope).

### Attachment points for the web slices (S1.27 onward)

- Auth: `/auth/*` (existing). `/auth/me` now includes the effective permissions (role permissions plus grants). Web routes the emails link to: `/accept-invitation?token=`, `/reset-password?token=`.
- Settings `/settings`; locations `/locations`, `/members/:id/locations`; grants and roles `/members/:id/grants`, `/members/:id/roles`.
- Staff `/staff*`, `/professionals/:id/hours`. Patients `/patients*`, `/payer-catalog`, `/payer-plans*`, coverages, consent, rights requests, representatives, assignments, anamnesis (all under `/patients/:id/...`).
- Audit `/audit-events`, `/audit-events/export`, `/patients/:id/access-report`.
- Branding `/branding`, `/branding/preview`, `/branding/logo`; public `/public/branding/logo` (optional `?size=192|512`), `/public/boot` (for the theme boot, S1.98), `/manifest.webmanifest`. The product icons `/icons/icon-192.png` and `/icons/icon-512.png` must exist in the web app (the manifest uses them until a logo is uploaded).
- Support grants (owner) `/support-grants`. Operator `/operator/*` on the platform host only.

### Remaining

Slices S1.27 to S1.37 (tasks 1.96 onward): web foundation, shell, auth screens, then the admin screens, demo scaffold and the Stage 1 gate. The demo reset (S1.36) must implement `DemoResetPort` and pass it as `operator.demoReset` to `createApplication`.


## Batch 6: Stage 1, slices S1.27 to S1.37

Mode: **Strict TDD**. Branch `feat/stage-1-secure-core`, same delivery as batches 3 to 5 (work-unit commits, draft PR #14 with `size:exception`, nothing merged, CI not polled). Toolchain: Node v24.22.0, pnpm 10.34.7, Docker Desktop engine (Testcontainers: Postgres 17, Mailpit, MinIO). The run was interrupted once (the parent session restarted) and resumed from the working tree; Docker Desktop had to be started again twice during the resume. Owner asleep, automatic mode: every decision below was taken from the design and specs.

### Commits (in order, after batch 5)

| Slice | Tasks | Commits |
|---|---|---|
| S1.27 Web foundation | 1.96 to 1.99 | `54025e4` API client; `f278487` es-AR catalog, Intl formatters, lint rules; `5c9846e` theme before first paint + dev proxy |
| S1.28 Shared UI and states | 1.100 to 1.102 | `739e35d` tokens, contrast, design system doc; `5b7dba2` components and form wrappers; `5d17ece` states |
| S1.29 Shell, navigation, guards | 1.103 to 1.106 | `53ed314` `/auth/me` reports the organization status; `7bb0beb` AppShell, guards, banners, first-run slot; `6e6d515` Playwright against the real stack |
| S1.30 PWA | 1.107 to 1.109 | `d1de0c2` manifest per host, network-only API, update prompt, offline banner, Lighthouse budget |
| S1.31 Auth screens | 1.110 to 1.112 | `05cfdb7` sign-in, 2FA, recovery, invitation, enrollment, sessions; `a8e136e` emails in neutral Spanish with the display name |
| S1.32 Staff | 1.113 to 1.115 | `b5780e7` team, invitations, roles, profile, grants, locations, hours, Settings > Sedes |
| S1.33 Patients | 1.116 to 1.118 | `1eac971` list, registration, record, coverage, privacy, history, care, anamnesis, picker |
| S1.34 Audit and settings | 1.119 to 1.121 | `a958562` audit viewer, access report, branding, security (with S1.35) |
| S1.35 Operator console UI | 1.122 | `a958562` |
| S1.36 Demo | 1.123 to 1.127 | `d5858b5` seed; `7b4be82` catalogs in `db:migrate`; `a7598ac` story (assignments, anamneses), privileged reset, adapter resolver, delete policy, headers, coverage and timing tests |
| S1.37 Gate | 1.128 to 1.130 | `ae65258` boot revalidation, 12-character passwords, ASVS checklist, demo guide, reverse proxy contract, `stage1-demo.spec.ts` |

Also on the way: `d9042f9` (a constant dropped when the password limits moved to the contracts package, found by the whole-repo typecheck).

### What was built

- **Web foundation (S1.27).** Vite 8 + React 19 + TanStack Router (code-based route tree per router) and Query 5 (30 s stale, no persistence), Tailwind 4, self-hosted fonts. An API client that turns `application/problem+json` into `ApiError` (i18n key, field errors, request id, validated extensions such as the existing patient of a duplicate-document 409) and reacts globally to 401, 402 (read-only) and "enroll the second factor". Flat JSON catalogs per namespace in `es-AR` (API keys such as `errors.forbidden` map to `errors:forbidden`; zod messages become `validation.*` keys), `Intl` formatters that show dates in the location's time zone, and lint rules that forbid literal JSX text, browser storage and a persisted query cache (two allow-listed files). The tenant theme is applied before the first paint by a tiny inline script compiled from `shared/lib/theme-boot.ts` by a Vite plugin, cached per host, with the first visit held back instead of flashing the neutral theme. The dev and preview servers proxy `/api/*` (prefix stripped, `Host` preserved) and `/manifest.webmanifest` and `/public/branding/logo` untouched.
- **Design system (S1.28).** Tokens with contrast verified for every light and dark pair, the Aillu preset, `docs/design-system.md`; shadcn-style components on the unified `radix-ui` package (button, input, native select, textarea, dialog, sheet, tabs, dropdown, alert dialog, table, badge, card, skeleton, toaster, checkbox and radio cards) and form wrappers that wire labels, descriptions and errors; states for empty, error, forbidden, offline, read-only, two-factor, loading, status and the safety flag.
- **Shell (S1.29).** One `AppShell` driven by permissions (sidebar on desktop, bottom navigation of at most five items on phones, stage-gated entries), route guards that show "no access" with the shell around it, banners (offline, read-only with the reason, second-factor grace), a first-run slot, a minimal shell for the portal and booking, and `/auth/me` now reports the organization status. Playwright runs against the REAL stack (Testcontainers: Postgres 17, Mailpit; the API with in-memory object storage; the worker; two organizations and one operator) with axe at 360 and 1280 px.
- **PWA (S1.30).** Per-host manifest from the API, service worker with network-only API and cached assets, update prompt, offline banner, product icons, and a Lighthouse CI budget (mobile, 4G, 4x CPU: LCP <= 2.5 s, performance >= 0.85, accessibility >= 0.95, CLS <= 0.1).
- **Auth screens (S1.31).** Sign-in with the second factor, recovery by email, invitation acceptance, enrollment with a QR code and recovery codes, open sessions. The emails are in neutral Spanish with the organization's display name.
- **Staff (S1.32).** Team directory with roles, locations and the state of the matricula; invitations limited by the inviter's role ceiling; role changes; professional profile; per-person grants; locations; weekly hours; Settings > Sedes.
- **Patients (S1.33).** Searchable list with keep-previous-data paging; registration with live validation per country (DNI, passport, "no document"), minor detection that asks for a representative, a consent question that must be answered, duplicate-document handling (the 409 shows the existing record) and a possible-duplicates review; the record with tabs for data, coverage, privacy (consent and rights requests, the access copy as a file), history, care (assign professionals) and, for professionals only, the anamnesis with a live preview of the alert the team will see; edit with optimistic concurrency (`expectedVersion`, a stale edit asks to refresh); deactivate with confirmation; a combobox patient picker (also the quick search on the home page).
- **Audit and settings (S1.34).** Audit viewer (filters by action, outcome, period in the organization's time zone and patient; cursor paging; CSV and JSON export), the access report as a tab of the patient record, Settings > Identidad visual (presets, name, color with a live contrast check showing requested and effective colors, radius, font, logo upload with client-side limits and removal, live preview; the new look is applied and remembered at once) and Settings > Seguridad y privacidad (second factor for everyone, what reception sees, template sharing with an explicit confirmation for psychology, quiet hours).
- **Operator console (S1.35).** On the platform host only (first label `platform` or `VITE_PLATFORM_HOST`): a separate router tree with sign-in (password and code in one step), the organizations table, create organization (the demo flag is fixed at creation), resend the owner's invitation and reset a demonstration. A Playwright setup project signs the operator in once and shares the session (a TOTP code cannot be replayed).
- **Demo (S1.36).** `seedDemoTenant(deps, tenantId)` fills an organization with seven accounts, three locations, three professionals, 26 patients with coverage and consent, four minors with representatives, twelve care assignments and nine anamneses that raise the four kinds of safety alert (written through the same services the API uses, as reception and as each professional). `app.demo_reset(tenant)` (migration 0018) is the only way the product deletes tenant data: SECURITY DEFINER, refuses unless `is_demo`, executable only by `app_operator`, removes every tenant table in foreign-key order including the audit trail (a narrow exception in the append-only guard) and returns the last sealed hash, which the platform trail records as `demo.chain_reset`; the seed then refills it in about two seconds. `pnpm demo:seed`, `pnpm demo:reset [--rotate]`, `pnpm demo:stack`, `operator:code` (current TOTP code from a secret), the console button, and the adapter resolver (`main/adapter-resolver.ts`): a demo organization's email goes to a fake sender and a registry that would give it a real adapter fails at boot. Delete policy: a static scan with an allowlist (`test/policy/no-delete.test.ts`) and a database test of the exact tables the application role may still delete from.
- **Gate (S1.37).** `stage1-demo.spec.ts` (two looks, role navigation, the clinical story, the audit trail, isolation), `docs/security/asvs-l2-stage1.md` with a review pass and its fixes, `docs/demo.md`, and the "Reverse proxy contract" in `docs/dev-setup.md`.

### TDD Cycle Evidence

RED means the test file was written before the production code it exercises and a run was seen failing. Exceptions are stated.

| Tasks | Test file(s) | Layer | Notes |
|---|---|---|---|
| 1.96 | `shared/lib/api-client.test.ts` | Unit | RED first |
| 1.97, 1.99 | `shared/lib/format.test.ts`, `zod-i18n.test.ts`, `app/i18n.test.ts`, `shared/lint/web-lint-rules.test.ts` | Unit | RED first; the lint rules are tested against fixture files |
| 1.98 | `shared/lib/theme-boot.test.ts`, `vite/theme-boot-plugin.test.ts`, `shared/lib/preferences.test.ts` | Unit | RED first |
| 1.100 to 1.102 | `shared/lib/contrast.test.ts`, `shared/ui/primitives.test.tsx`, `form.test.tsx`, `overlays.test.tsx`, `states/states.test.tsx` | Unit + a11y | **Deviation:** the first components (button, input and similar) were written before their tests and covered in the same work unit; every later component was tested first. All run vitest-axe |
| 1.103 to 1.106 | `app/shell.test.tsx`, `app/services.test.ts`; Playwright `shell.responsive.spec.ts` | Component + e2e | RED first |
| 1.107 to 1.109 | `app/pwa.test.tsx`; Playwright `pwa.spec.ts`; Lighthouse CI | Component + e2e | The budget was measured, then met (see decisions) |
| 1.110 to 1.112 | `features/auth/auth-flows.test.tsx`; Playwright `auth.spec.ts`, `auth.responsive.spec.ts` | Component + e2e | RED first |
| 1.113 to 1.115 | `features/staff/staff.test.tsx`, `weekly-hours.test.tsx`, `domain/hours.test.ts`, `features/settings/locations.test.tsx`; Playwright `staff*.spec.ts` | Unit + Component + e2e | RED first |
| 1.116, 1.117 | `patients/domain/patient-form.test.ts` (19), `patients-list.test.tsx`, `patient-create.test.tsx`, `patient-detail.test.tsx`, `patient-sections.test.tsx`, `patient-picker.test.tsx`, `home/home-search.test.tsx` | Unit + Component | Tests written before the pages. A failing run was observed for the domain and the picker; for the pages the first run was the first run after the implementation (80 of 81 passed, the failure an axe finding on a definition list) |
| 1.118 | `patients/domain/anamnesis.test.ts`, `patient-anamnesis.test.tsx`; Playwright `patients.spec.ts`, `patients.responsive.spec.ts` | Unit + Component + e2e | RED observed for the domain (module missing). The professional-only tab is proven at the component level and end to end (reception has no tab; the allergy never reaches reception) |
| 1.119 | `audit/audit.test.tsx`, `domain/period.test.ts`, `domain/action-labels.test.ts` | Unit + Component | Every audit action the server can write must have a label (a test) |
| 1.120 | `settings/branding.test.tsx`, `security.test.tsx`, `shared/lib/preferences.test.ts` | Component | Written first; first run after the implementation |
| 1.121 | Playwright `settings.spec.ts` | e2e | The spec found the stale-boot bug (see bugs) |
| 1.122 | `app/platform-host.test.ts`, `operator/operator.test.tsx`; Playwright `operator*.spec.ts` | Unit + Component + e2e | The invitation really arrives in Mailpit |
| 1.123 | `db/seed/demo/dataset.test.ts`, `test/integration/demo-seed.test.ts` | Unit + Integration | RED first for the care story (counts and the anamnesis read through the API) |
| 1.124 | `test/integration/demo-reset.test.ts` (16) | Integration | RED first: 13 of 15 failed against the missing function. Refuses a non-demo organization, refuses the tenant role, removes everything, keeps the key, returns the last hash, leaves other organizations and their chains intact, a fresh chain verifies, platform trail entry, rotation |
| 1.125 | `main/adapter-resolver.test.ts` (12) | Unit | Iterates every registered port |
| 1.126 | `test/policy/no-delete.test.ts` (18), `test/integration/no-delete-privileges.test.ts` | Policy + Integration | The scanner failed once on its own test (spacing), then passed |
| 1.127 | `test/integration/demo-coverage.test.ts` | Integration | Reset takes about 1.4 s against a 30 s budget; no tenant table may be empty without a reason |
| 1.128 | Playwright `stage1-demo.spec.ts` | e2e | |
| 1.129 | `platform/http/security-headers.test.ts`, `branding-boot.test.ts` (ETag), password policy tests | Unit + Integration | RED first for the ETag (2 failed) and the headers |

### Test summary and verification (tip of `feat/stage-1-secure-core`)

- Unit: **141 files, 1610 tests** (`pnpm test`: api, contracts and web together). Integration: **71 files, 1061 tests** (`pnpm test:integration`, Postgres 17 as `app_rw`, `app_operator` and `app_owner`, MinIO container). End to end: **110 tests** (`pnpm test:e2e`: the `operator-setup`, `desktop` and `mobile-360` projects against the real stack, axe on every screen at 360 and 1280 px).

| Command | Result |
|---|---|
| `corepack pnpm install --frozen-lockfile` | exit 0 |
| `corepack pnpm typecheck` | exit 0 (contracts, api, web) |
| `corepack pnpm lint` | exit 0 |
| `corepack pnpm format:check` | exit 0 |
| `corepack pnpm test` | 141 files, 1610 tests passed |
| `corepack pnpm test:integration` | 71 files, 1061 tests passed |
| `corepack pnpm build` | exit 0 |
| `corepack pnpm db:check` | "No migration drift." |
| `corepack pnpm test:e2e` | 110 passed (about 2 minutes, 6 workers) |
| `docker build -f infra/Dockerfile` and a smoke run with the production configuration of the CI smoke test | `/health` 200, unknown route 404, the security headers present (including HSTS, because the production configuration uses secure cookies) |
| Lighthouse CI | **Not re-run at the tip.** `lhci` could not start the only browser available here (Edge) in this session; the last local measurement was at `d1de0c2` (performance 0.97, accessibility 1.0, LCP about 2.2 s at the 4G profile). The CI job runs it on Linux |

Between the first run of the list and the final tip, three tests that used passwords of 10 or 11 characters (the new minimum is 12) and the generous waits of the web tests were fixed; the unit, integration and e2e results above are from runs of the final tests, as follows: unit and integration after the fixes, e2e and image from the first run (no web or API code changed afterwards except test files and `setup.ts`).

### Bugs found by the tests and fixed in the same slice

1. Moving the password limits to the contracts package dropped a constant the API still used; the whole-repo typecheck found it (`d9042f9`).
2. The shared `user_account` email is global, so seeding two demo organizations in one database collided: the seed now reuses an existing account and resets its password and second-factor state.
3. A fresh database had no payers or holidays, so the demo coverage could not be seeded: `db:migrate` now loads the platform catalogs.
4. `lint-staged` failures blocked commits silently during the batch; the import order and rules were fixed, then recommitted.
5. **`/public/boot` was cacheable for 60 seconds.** After saving a branding change, a reload within the minute repainted the OLD look over the new one the page had just remembered. Found by the Playwright branding spec; fixed with `Cache-Control: public, no-cache` plus an ETag (304 when unchanged).
6. The audit append-only trigger sees the PARTITION name in `TG_TABLE_NAME`, not `audit_event`: the first version of the reset exception never matched. Found by the reset test; the guard now looks for a `tenant_id` key in the row.
7. `platform-catalogs.test.ts` assumed the catalogs hold exactly 2026 to 2028; once `db:migrate` seeds the years around today another suite could add 2025. It now checks that the three years are present.
8. The Playwright test "ten wrong attempts lock the account" only passed by timing: attempts beyond the third are throttled (not counted) and the right password worked again after one second. The lock needs a controllable clock, so it stays in `lockout.test.ts` and the e2e was removed.
9. Toasts are a global queue and leaked from one test to the next (`toast.dismiss()` after each test); under the load of the whole monorepo the first render of a lazy page took longer than the default wait (`asyncUtilTimeout` 15 s, test timeout 30 s).
10. Raising the minimum password length to 12 broke tests that used common passwords of 10 or 11 characters; two were found only by the whole-repo run, not by the folder run (always run everything before committing a contract change).
11. gitleaks flagged an alphabet constant of the demo password generator as an API key; it is now written in parts.
12. `prettier --write` on a folder that contains the drizzle snapshots rewrites them (already noted in batch 5); reverted.

### Decisions and deviations (all recorded because the owner was asleep)

1. **The web calls `/api/*`; the proxy strips the prefix.** The API has no `/api/v1`. Documented in "Reverse proxy contract" (`docs/dev-setup.md`), including the `Host` rule, the manifest and logo routes, the platform host, the CSP note for the inline theme script and the service worker headers.
2. **Select is a styled native `<select>`** (best phone experience, accessible and easy to test) instead of a custom listbox.
3. **No faker.** The demo data is curated lists plus a seeded generator (`rng.ts`); the same seed always gives the same content. The seed signature is `seedDemoTenant(deps, tenantId)` (one transaction per account because of the account insert policy), not `(tx, tenantId, clock)` as the task text says.
4. **Demo credentials.** One public password (`Demo-Aillu-2026-clave`), `.invalid` emails, in a committed dev-only file marked as such, never in `.env`. The reset keeps it unless `rotateCredentials` is on (a deployed demo): rotated passwords are returned to the caller and printed by `pnpm demo:reset --rotate`, but the console does not display them (how a deployed demo hands them over is a deployment decision).
5. **`app.demo_reset` is owned by the migration role, not by a dedicated role.** This matches the other SECURITY DEFINER functions; the guard is the grant (only `app_operator`), the `is_demo` check and the three-way condition of the audit trigger. It lifts row security table by table inside its own transaction (brief exclusive locks) instead of giving a new role a delete grant on every table, which would silently miss each future table. The scheduled `demo.reset` JOB was not built: the worker connects as `app_rw` and cannot call the function; the operator port and `pnpm demo:reset` cover the use. Deferred to the deployment stage.
6. **Adapter resolver.** Email is routed by organization (messages now carry `tenant`; a message without one is refused). Object storage and key management are registered with their fakes so the registry is complete and tested, but their call sites still use the single instance until they carry the organization. Outside production the configured SMTP server (Mailpit) counts as the demo's fake, so a local demo's invitations are visible.
7. **Database delete grants.** DELETE and TRUNCATE were revoked from seven tenant tables that nothing deletes from; five ephemeral tables keep DELETE with a written reason.
8. **Security headers on every API answer** (`nosniff`, deny framing, no-referrer, same-origin resource policy, a deny-all CSP, `no-store`, HSTS when cookies are secure); a route that sets its own cache policy keeps it.
9. **Minimum password length 12** (ASVS 2.1.1) instead of 10.
10. **The public boot payload is revalidated on every load** (ETag) instead of cached for a minute, so a branding change shows on the next reload.
11. **Navigation is stage-gated** (`ENABLED_STAGE = 1`): entries for later stages are not shown. Tabs of the patient record are local state, not part of the URL.
12. **The PWA manifest is per host** and comes from the API; the offline banner lives at the root so it also shows on the sign-in screen.
13. **Lighthouse budget uses a 4G profile** (9000 kbps, 170 ms) with a 4x CPU slowdown instead of Lighthouse's default slow 4G: with the default the sign-in LCP was 3.5 s; with the lazy toaster, an eager login page and `sideEffects: false` on the contracts package it is about 2.2 s at the 4G profile (performance 0.97, accessibility 1.0).
14. **The operator console is a separate router tree** chosen by host, with its own session query; the "session ended" redirect of the organization app does not apply to it.
15. **One signed-in operator session is shared by the e2e specs** (a setup project), because a TOTP code cannot be replayed.
16. **Emails are in neutral Spanish ("usted")**, with the organization's display name, not its slug.
17. **TDD deviations**, stated in the table: the first UI primitives were tested after being written; for the page-level component tests the first run happened after the implementation; the audit period helper's test and implementation were written in one step (its five cases passed at the first run).
18. **The independent review was not possible.** This executor has no delegation tool, so `docs/security/asvs-l2-stage1.md` records a structured self-review with ten findings: six fixed, three accepted with reasons, one open. The orchestrator should run the fresh-context review (judgment-day) before Stage 2 and attach its report to PR #14.
19. **Strict TDD stays on for Stage 2** (decision for task 1.130): the project has unit, integration (real Postgres), component, e2e (real stack) and accessibility runners, and they caught real bugs in this batch (items 5, 6 and 8 of the bug list). `sdd-init/appmedicocmaillu` was refreshed in memory.
20. **Known limits:** nothing was verified in CI (never polled); Lighthouse and the e2e suite ran locally on Windows; the demo organization is not deployed anywhere; the web CSP is documented but not enforced.

### Local run (exact steps) and demo logins

See `docs/demo.md` (logins, what to try, reset) and `docs/dev-setup.md` ("Reverse proxy contract", operator console). In short:

```bash
pnpm install
pnpm demo:stack                                  # Docker; prints every address and the operator secret
API_PROXY_TARGET=http://127.0.0.1:3000 pnpm --filter @consultorio/web dev      # second terminal
# open http://aillu.localhost:5173   password for every account: Demo-Aillu-2026-clave
```

### Remaining

Stage 2. Open items before the first production customer are listed at the end of `docs/security/asvs-l2-stage1.md`. The independent (fresh-context) security review that the plan asks for must be run by the orchestrator: this executor has no delegation tool, and its own pass is recorded as a self-review.

## Batch 7: Stage 1 security fixes (independent review, ten findings, three ASVS items)

Strict TDD. Branch `feat/stage-1-secure-core`, one work-unit commit per finding (or per ASVS item), no merge, CI not polled. The review was made against `ef72fed`; every finding was re-located at the tip before it was fixed. The review report is the orchestrator's `stage1-security-review.md`; the outcome per finding is also in `docs/security/asvs-l2-stage1.md`, section "Independent security review".

| # | Finding | Commit | Tests (RED first) |
|---|---|---|---|
| 1 | Host-header poisoning of reset and invitation links | `234303e` | `platform/http/public-origin.test.ts` (7), `main/config-deployment.test.ts` (PUBLIC_URL, PUBLIC_PORT), `test/integration/link-origin.test.ts` (4: forged Host in single mode for reset, invitation and admin-triggered reset; a port in the Host of multi mode) |
| 2 | `X-Forwarded-For` spoofing, non-IP value turning into a 500 | `234303e` | `main/config-deployment.test.ts` (TRUST_PROXY forms), `platform/audit/request-context.test.ts` (rotating fake hops, two proxies, CIDR list, non-IP/zone id/injection text stored as unknown), `test/integration/client-address.test.ts` (sign-in limit not bypassed by rotating values, audited IP is the proxy's hop, `not-an-ip` answers 401 not 500 and audits NULL) |
| 3 | Admin bypass of the clinical rule (D19) | `734d180` | `packages/contracts/src/roles.test.ts` (6 RED), `access/domain/role-change.test.ts`, `identity/domain/invitation-ceiling.test.ts`, `access-grants.test.ts` (3), `staff-lifecycle.test.ts` (3), `care-assignment-api.test.ts` (5: flag for reception and admin, none at 8 days, boundary at 6 and 8 days, none for a clinical actor), web `staff.test.tsx` (4) |
| 4 | SECURITY DEFINER functions executable by PUBLIC | `8abf39a`, `1260efa` | `test/integration/definer-functions.test.ts` (5: every definer function listed with its only roles, search path starts with `pg_catalog` and ends with `pg_temp`, not PUBLIC, new functions closed by default; 4 of 5 were RED before migration 0019, the search-path test was RED again before 0022) |
| 5 | Audit integrity not enforced in the database | `8c76b55` | `test/integration/audit-integrity.test.ts` (12: pre-filled seal refused for `app_rw`, owner and `app_operator`, forged near-max sequence cannot stop the sealer, membership revoked, sealer reaches nothing but the trails); `audit-table`, `audit-sealer`, `audit-verify`, `audit-viewer`, `demo-reset`, `operator-auth`, `worker` moved to the sealer login |
| 6 | DEK cache populated before commit | `921722d` | `test/integration/tenant-keys.test.ts` (4: first key rolled back, rotation rolled back, same-transaction use, committed rotation) |
| 7 | Operator console gaps | `2d150b7` | `operator-auth.test.ts` (a locked account, an unknown address and a wrong password each run exactly one verification), `operator-privileges.test.ts` (3: key only for an unclaimed organization and only version 1, registration columns only) |
| 8 | Unknown subdomain did a lookup before any rate limit | `ee9fde6` | `platform/http/rate-limit.test.ts` (4: lookups stop once the client is over its allowance, 429 with Retry-After, other clients and probes unaffected) |
| 9 | Compose dev defaults | `7847c7c` | `main/compose.test.ts` (3). **Deviation:** the header edit came before the test (a documentation change); the test pins it |
| 10 | Missing security headers | none | Already satisfied by S1.36 (`platform/http/security-headers.ts`, `security-headers.test.ts`): `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a deny-all CSP, HSTS where cookies are secure. The review was made before that commit |
| ASVS 3.4.4 | `__Host-` cookie prefix | `4f1375c` | `platform/http/session-cookie.test.ts`, `modules/operator/http/cookie.test.ts`, `auth-routes.test.ts`, `operator-auth.test.ts` |
| ASVS 3.3.2 | 30-minute idle timeout | `ac476f3` | `identity/application/sessions.test.ts`, `test/integration/sessions.test.ts` (the 7-day test now uses a 29-minute step) |
| ASVS 14.4.7 | CSP of the web bundle | `1b2ecf4`, `492c94e` | `vite/csp.test.ts` (9), `vite/csp-plugin.test.ts` (4), `vite/theme-boot-plugin.test.ts` (+3), Playwright `e2e/csp.spec.ts` (2; RED on the first run: five `eval` violations, see decision 8) |
| docs | ASVS checklist, proxy contract, ADR-004, D19 in the proposal and two specs | `5c68976`, `734d180` | none |

### Decisions and deviations

1. **D19 (decided by the orchestrator in automatic mode, pending owner confirmation).** Recorded in the proposal's decisions table, in `specs/authorization` (requirement and four scenarios plus the review-flag scenario) and in `specs/staff-professionals`. Beyond the text of the decision, the implementation separates two ceilings: what a person can HAND OUT (admin: administration and reception) and whom a person can MANAGE (admin: also professionals, never owners). Without that second ceiling an admin could no longer deactivate a departing professional or change their other roles. An admin can keep or remove the professional role of a member but not add it.
2. **TRUST_PROXY.** Fastify 5 fails closed on a bare number (it trusts nothing), so a hop count is passed as a function `(address, hop) => hop < N`. The default is 1 in production and `false` in development; `true` is refused. The residual contract (the API reachable only through its proxy, which appends the address it received) is in the proxy contract and the checklist.
3. **Public URL.** `PUBLIC_URL` is required in single mode; `PUBLIC_PORT` is an optional development port for multi mode. The operator console takes its link origin from the same place instead of the `Host` port. `demo:stack` passes the web port.
4. **Sealer login.** `audit_sealer` is a LOGIN used by the worker only (`AUDIT_SEALER_DATABASE_URL`, the worker refuses to start without it; the API logs a warning if it has it). Migration 0004 (already applied elsewhere, so immutable) still asserts that `app_rw` is a member of `audit_sealer`; the cluster bootstrap therefore creates the membership `GRANTED BY app_owner` (which holds ADMIN OPTION) and migration 0020 revokes it. A database whose membership was granted by a superuser needs one manual `REVOKE`, and the migration says so. The seal-continuity check in the trigger (next sequence number, previous hash) was NOT added: the nightly verification already detects a gap or a mismatch, and the insert trigger plus the login separation close the forging paths the review named.
5. **Definer functions.** `ALTER DEFAULT PRIVILEGES FOR ROLE app_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` makes a function created from now on executable by nobody until its own migration grants it; the schema-level default grant to `app_rw` was removed for `app`. Trigger functions do not need EXECUTE at firing time, so existing triggers are unaffected. Migration 0022 adds `pg_temp` as the LAST entry of the search path of every definer function (PostgreSQL searches the temporary schema first unless it is named, and any role can create temporary tables). `app.demo_reset` (S1.36) already had its search path pinned, no PUBLIC or `app_rw` grant, and an `app_operator`-only grant; the catalog test now covers it.
6. **Operator least privilege.** The operator keeps reading the registration of every professional without a support grant, because verifying a matricula is the operator's job (D1). The rest of the profile is no longer readable.
7. **Idle timeout** is 30 minutes for every staff role (not only clinical ones): one rule, no per-role session logic. The absolute limit stays at 7 days.
8. **CSP.** `style-src` keeps `'unsafe-inline'` (the toast library adds `<style>` elements; a style cannot run code). The dev server's policy adds `'unsafe-inline'` for scripts (the React refresh preamble) and websockets; the preview server, which the browser suite uses, sends the production policy. The build writes `dist/content-security-policy.txt` for the deployment's proxy. The browser suite found a real violation the first time it ran: zod probes for `eval` with `new Function`, which a strict CSP reports even though zod catches it. A first fix (a module imported first in `main.tsx` calling `z.config({ jitless: true })`) did not work: the build puts the schemas of the contracts package in chunks that run before the entry chunk's own code. Zod keeps its configuration on `globalThis.__zod_globalConfig`, so the fix is a second hashed inline script in `index.html` that sets it before any module runs (`ZOD_JITLESS_SCRIPT` in `vite/theme-boot-plugin.ts`); the policy lists both hashes.
9. **Demo seed.** The demo professionals are created 90 days in the past so that the D19 review flag does not fire on every assignment of the story.
10. **Own mistakes, fixed.** A Windows Python script wrote a few non-ASCII characters in cp1252 (found by a failing web test and a prettier replacement character); fixed, and `python -X utf8` is used since. The web tests of the role ceiling were written in the same step as the `RolesTab` change; RED was confirmed afterwards by reverting the component (one test failed as expected).

### Verification (tip of the branch, Node 24, pnpm 10.34.7, Docker running)

| Command | Result |
|---|---|
| `corepack pnpm install --frozen-lockfile` | exit 0 |
| `corepack pnpm typecheck` | exit 0 (contracts, api, web) |
| `corepack pnpm lint` | exit 0 |
| `corepack pnpm format:check` | exit 0 |
| `corepack pnpm test` | **146 files, 1693 tests passed** (it was 141 files, 1610 tests) |
| `corepack pnpm test:integration` | **75 files, 1105 tests passed** (it was 71 files, 1061; Postgres 17 as `app_rw`, `app_operator`, `app_owner` and `audit_sealer`, run again at the final tip, after migration 0022) |
| `corepack pnpm build` | exit 0 (the web build writes `dist/content-security-policy.txt`) |
| `corepack pnpm db:check` | "No migration drift." (migrations 0019 to 0022) |
| `corepack pnpm test:e2e` | **112 passed** (110 plus the two CSP specs; about 2.5 minutes on the real stack) |
| `docker build -f infra/Dockerfile` and a smoke run with the production configuration of the CI smoke test | `/health` 200 with the security headers including HSTS; the `worker` role refuses to start without `AUDIT_SEALER_DATABASE_URL` and names only the variable |
| `pnpm demo:stack`, started and stopped by hand | the stack starts (Postgres, Mailpit, API, worker with the sealer login, two organizations, operator); sign-in sets `sid` (plain http); a password reset link is `http://aillu.localhost:5173/reset-password?token=...`, built from configuration. Only the processes this run started were stopped; their containers were removed by the test-container reaper |
| Lighthouse CI | **Not re-run** (the local browser does not start under `lhci`) |

The first full `pnpm test` run (while the integration suite was running) timed out in two ESLint-based unit tests; run alone they pass in about 35 seconds, and the final full run, with nothing else running, passed.

### Remaining risks

- D19 awaits the owner. The owner can still create a second clinical account, which the decision accepts.
- `TRUST_PROXY` as a hop count assumes the API is not reachable except through its proxy.
- The worker holds `app_rw` and `audit_sealer`. Production must provision the `audit_sealer` login and make the proxy send `dist/content-security-policy.txt`.
- Nothing was verified in CI (never polled). Lighthouse was not re-run (the local browser would not start under `lhci`).
- The two ESLint-based unit tests (`web-lint-rules`, `country-isolation`) exceed 120 seconds when the whole monorepo runs while Docker is busy; they pass alone in about 35 seconds.

## Batch 8: Stage 2, slices S2.01 to S2.11 (the scheduling backend)

Strict TDD. Branch `feat/stage-2-practice-core` (from `feat/stage-1-secure-core`), one work-unit commit per slice step with the slice id in the subject, automatic mode, delivery `size:exception` (about 50k added lines including generated migration metadata and tests; the production code is a fraction of that), draft PR to `feat/stage-1-secure-core`, merged after PR #14. No merge, CI not polled.

### Commits (in order)

| Slice | Commits | Tasks |
|---|---|---|
| S2.01 Appointment types, blocks, days off | `78b4ab7` tables, `6e1fd5a` time zones (task 2.9 pulled forward: weekly blocks need them), `58333b0` services, routes, holiday calendar, hours for a range of dates, operator catalog | 2.1 to 2.3, 2.9 |
| S2.02 Appointment and occupancy schema | `4a6f848` tables, exclusion constraint, sync triggers; `9084cf7` concurrency | 2.4 to 2.6 |
| S2.03 Lanes and time zones | `50b3a0d` | 2.7, 2.8 |
| S2.04 Booking service | `2edbb46` working windows, free slots, ports and the in-memory fake; `3742449` booking and `POST /appointments` | 2.10 to 2.12 |
| S2.05 Lifecycle | `d7d2062` state machine; `d7af008` transitions, reschedule, reassign, correct, read-only | 2.13 to 2.16 |
| S2.06 Worklist | `a1cdd31` worklist; `2d1d454` module boundaries lint | 2.17 to 2.19 |
| S2.07 Identity confirmation | `ca6104d` rules; `9608d9e` review, confirmation, detach | 2.20 to 2.23 |
| S2.08 Care relationship | `7428236` | 2.24, 2.25 |
| S2.09 Slot holds | `3afe4a3` | 2.26, 2.27 |
| S2.10 Availability and series | `93354dc` | 2.28, 2.29 |
| S2.11 Authorization, audit, read-only | `13e6ae6` calendar scope in `can()`; `9a6c44e` scope on every route, calendar feed, detail, read-only matrix; `222c784` demo agenda; `fbfb628` es-AR labels; `85193b3` export contributor; one test fix for the catalog check | 2.30 to 2.33 |

### What was built

- **Schema** (migrations 0023 to 0027, hand-completed with `finish-migration`): `appointment_type`, `schedule_block`, `tenant_day_off`, `professional_hours_exception`; `appointment`, `appointment_event`, `slot_hold`, `slot_occupancy` (one conflict surface with a `btree_gist` exclusion constraint per tenant, professional, lane and range, DEFERRABLE) with definer sync triggers and a lane-capacity constraint trigger; `worklist_item`; `app.recompute_care_relationship` and `app.care_adjust` fed by a trigger on the appointment; `holiday_catalog.removed_at`.
- **Domain** (pure, unit tested): time zones with DST (luxon), holidays, lanes (greedy re-lane), working windows, free slots, the eight-status state machine, identity-confirmation rules.
- **Application**: types, blocks, days off, hours periods, placement (`planSlot`/`applyPlan` shared by booking, reschedule, correction, holds and series), booking, lifecycle, identity, history, worklist, holds and the `hold.expire` job, availability, recurring series, calendar, administrative export contributor. Ports and an in-memory fake keep the use cases unit-testable.
- **HTTP**: config routes, appointment routes, worklist routes, planning routes (availability, holds, series, calendar); `409 slot_taken` carries the conflict and the next free slots, `409 slot_no_longer_available`, `409 stale_revision` on a stale `version`.
- **Authorization**: scheduling permissions, calendar scope for professionals (own calendar unless one is delegated) in `can()`, reception filtered by its locations, read-only matrix (cancel allowed, book and reschedule refused with 402), `AUDIT_ACTIONS` for every scheduling action and the audit-scenario coverage.
- **Lint**: modules reach each other only through `index.ts` (policy plus a fixture test).
- **Demo seed**: types, one block, one day off, one special-hours period and appointments over the previous, current and next week with every status, booked through the same use cases; one booking made by the cardiologist for an existing patient shows the identity review in the worklist.
- **Web**: es-AR labels for the new audit actions and messages for the two new error codes (no scheduling screens yet).

### TDD Cycle Evidence

| Task | Test file(s) | Layer | RED | GREEN | Triangulation |
|---|---|---|---|---|---|
| 2.1 | `scheduling-config-schema.test.ts`, generated isolation suite | Integration | written first (tables missing) | green | CHECKs (duration, buffer, color, interval); the NULL-safe CHECK found a real hole (see bugs); isolation of the tables |
| 2.2 | `scheduling-config-api.test.ts`, `scheduling-config.test.ts` (contracts) | Integration + unit | written first | green | CRUD, deactivate not delete, denials per role, audit rows, 409 stale |
| 2.3 | `operator-holidays.test.ts`, `domain/holidays.test.ts`, `operator-privileges.test.ts` | Integration + unit | written first | green | moved holiday visible without a release, soft remove, operator only, forbidden columns |
| 2.4, 2.5 | `scheduling-schema.test.ts` | Integration | written first | green | transition table of every status against occupancy, holds, buffer range, lane capacity, isolation |
| 2.6 | `scheduling-concurrency.test.ts` | Integration | written first | green | N parallel connections, exactly one winner and `23P01` for the rest, back-to-back allowed |
| 2.7, 2.8 | `domain/lanes.test.ts` | Unit + property | written first | green | tables plus fast-check: never over capacity, no overlap per lane, re-lane fits whenever feasible |
| 2.9 | `domain/time.test.ts` | Unit | written first | green | spring-forward gap, fall-back overlap, Argentina (no DST) and a DST zone |
| 2.10 to 2.12 | `domain/working-hours.test.ts`, `domain/free-slots.test.ts`, `application/book-appointment.test.ts`, `scheduling-booking.test.ts` | Unit + integration | written first | green | golden path, overlap, buffer, hours, block, holiday, hold, capacity, other location, past date, override, 402, next slots |
| 2.13 to 2.16 | `domain/appointment-state-machine.test.ts`, `application/lifecycle.test.ts`, `scheduling-lifecycle.test.ts` | Unit + integration | written first | green | exhaustive pair test, each transition, version conflict, reschedule keeps the old slot until committed, read-only matrix |
| 2.17, 2.18 | `scheduling-worklist.test.ts` | Integration | written first | green | six kinds, invalid kind refused, location filter, encrypted detail, resolve and dismiss audited |
| 2.19 | `module-boundaries.test.ts` + fixtures | Lint | written first | green | internal import fails, `index.ts` import passes |
| 2.20 to 2.23 | `domain/identity-confirmation.test.ts`, `application/identity.test.ts`, `scheduling-identity.test.ts` | Unit + integration | written first | green | truth table of D14 and D18, own professional refused, solo practice only at in-person check-in, detach leaves the matched record untouched |
| 2.24, 2.25 | `scheduling-care-relationship.test.ts` | Integration | written first | green | real clinical policies on a test table: unconfirmed gives nothing, confirmation gives access, confirmed no-show counts, unconfirmed no-show does not, cancelled and pending do not |
| 2.26, 2.27 | `application/holds.test.ts`, `scheduling-holds.test.ts` | Unit + integration | written first | green | per-source bound, expiry (lazy and job), invalidation, conversion, capacity-1 rule, override then confirm gives 409 |
| 2.28, 2.29 | `application/availability.test.ts`, `application/series.test.ts`, `scheduling-availability.test.ts` | Unit + integration | written first | green | hours minus blocks, holidays and occupancy, buffer, dry run and commit, one conflict skipped, independent cancel |
| 2.30 | `platform/authz/calendar-scope.test.ts`, `application/scope.test.ts`, `scheduling-scope.test.ts` | Unit + integration | written first | green | own calendar, delegated calendar by professional, reception by location |
| 2.31 to 2.33 | `scheduling-calendar.test.ts`, `scheduling-lifecycle.test.ts`, audit coverage, `route-categories` | Integration | written first | green | feed has no clinical field, read-only matrix, every action in the catalogue has a scenario |
| (demo) | `db/seed/demo/schedule.test.ts` (13), `demo-seed.test.ts`, `demo-coverage.test.ts` | Unit + integration | written first (the coverage test failed on `slot_hold` until it got a reason) | green | every status present, children to pediatrics, nothing on the day off or inside the block, a self-booked visit opens the identity review |
| (export) | `scheduling-export.test.ts`, `export-registry.test.ts` | Integration + unit | RED from the existing guard (module without a contributor) | green | own organization only, no encrypted or clinical field |

### Test summary and verification (tip of `feat/stage-2-practice-core`, Node 24, pnpm 10.34.7, Docker running)

| Command | Result |
|---|---|
| `corepack pnpm install --frozen-lockfile` | exit 0 |
| `corepack pnpm typecheck` | exit 0 (contracts, api, web) |
| `corepack pnpm lint` | exit 0 |
| `corepack pnpm format:check` | exit 0 |
| `corepack pnpm test` | **165 files, 2149 tests passed** (it was 146 files, 1693 tests) |
| `corepack pnpm test:integration` | **90 files, 1386 tests passed** (it was 75 files, 1105 tests). The full run found one failure (`platform-catalogs`, see bugs); after the fix that file passes alone (18 tests) |
| `corepack pnpm build` | exit 0 |
| `corepack pnpm db:check` | "No migration drift." (migrations 0023 to 0027) |
| `corepack pnpm test:e2e` | **112 passed** (about 2.1 minutes). Two earlier attempts failed on a sign-in and on the Postgres health check while another worktree (`consultorio-wt-docs`) was running its own integration tests and containers on the same machine; run alone the suite passes |

### Bugs found by the tests and fixed in the same slice

- A CHECK on a nullable column was satisfied by NULL (`NULL > 0` is unknown, not false); the constraint now says `IS NOT NULL AND ...` and migration 0023 was regenerated before it was committed.
- An import cycle between holds and booking: the shared helpers (`typeOffered`, `SlotNoLongerAvailableError`) moved to `placement.ts`.
- Sessions in the integration worlds expired when a test moved the clock; the application takes a `schedulingClock` option so tests can move scheduling time without moving session time.
- The full integration suite found that `platform-catalogs` required every year of the shared holiday catalog to be full, while the operator suite adds a few holidays to 2031. The check now covers the seeded years 2026 to 2028.

### Decisions and deviations (all recorded; automatic mode)

1. **One conflict surface.** `slot_occupancy` is the only table the exclusion constraint lives on. Appointments and active holds are mirrored into it by SECURITY DEFINER triggers (`pg_temp` last in the search path, closed by default, EXECUTE granted explicitly). The constraint is DEFERRABLE so a reschedule can move an appointment inside one transaction.
2. **Lanes are capacity.** `professional.max_simultaneous` is the number of lanes; a re-lane is greedy and runs under the per-professional `FOR UPDATE` lock that serializes the writes of one professional. Public flows use capacity 1 (`requireNoActiveOverlap`).
3. **Buffer inside the range.** The occupied range is `[start, end + buffer)`: the exclusion constraint needs no special case and back-to-back appointments stay allowed.
4. **Holds expire lazily and by job.** Under the lock, stale holds are expired before a booking looks at the schedule (correct without the job); `hold.expire` (every 60 s through the new tenant-job ticker) keeps the table tidy.
5. **Reschedule is an event, not a status.** `appointment_event.kind = rescheduled`; the eight statuses stay as designed.
6. **Identity (D14, D18).** Initial value: confirmed unless an existing patient is matched online, or the booking actor is the appointment's own professional. Who may confirm: staff other than the appointment's professional; the sole active professional of a practice may self-confirm only through the in-person check-in action; the worklist refuses the own professional. The care-relationship trigger counts only confirmed appointments.
7. **Task 2.9 pulled forward** into S2.01 (weekly blocks need time zone conversion). The hours-for-a-range-of-dates feature (`professional_hours_exception`) is also in S2.01; the design lists it with working hours.
8. **Holiday catalog is soft-removed** (`removed_at`) so a mistaken holiday can be retracted without a release; an organization's own day off is separate (`tenant_day_off`). The operator API is platform-audited.
9. **Optimistic concurrency.** Every mutating appointment route takes `version`; a stale one is `409 stale_revision`. A taken slot is `409 slot_taken` with the conflict and `nextSlots`; an invalidated hold is `409 slot_no_longer_available`.
10. **ESLint boundaries.** The policy is expressed with `boundaries/dependencies` (`disallow` to another module's file unless it is `index.ts`); a `relationship` filter proved unnecessary because imports inside the same module are already allowed.
11. **Export contributor.** The existing guard (a test that every module registers an export contributor) failed for `scheduling`; `modules/scheduling/application/export-contributor.ts` exports types, appointments with their history, blocks, days off and special-hours periods. Slot holds, the occupancy index and the worklist are not exported (derived, transient, or an operational queue with encrypted detail).
12. **Demo agenda** is a pure function of the dataset and of "now" (`buildDemoSchedule`), so the calendar always shows today; the seed books through `bookAppointment` and `transitionAppointment` with permissive actors instead of inserting rows, which keeps every trigger and invariant in play. The one self-booked visit shows the identity review.
13. **Commit attribution.** No AI attribution lines were added to commits or to the PR, as the owner's standing rule requires.

### Attachment points for the scheduling web slices (S2.12 onward)

Routes (under `/api/v1`, session cookie, `Origin` checked; contracts in `packages/contracts/src/scheduling.ts` and `scheduling-config.ts`; the exact paths are in `apps/api/src/modules/scheduling/http/`):

- Calendar: `GET /appointments?from&to&professionalIds&locationId` returns `CalendarResponse` (`CalendarEntryDto`, administrative fields only, already filtered by the actor's calendar scope and locations); `GET /appointments/:id` returns `AppointmentDto` (including `identityConfirmation` and `version`).
- Booking and lifecycle: `POST /appointments` (`BookAppointmentRequest`); `GET /appointments/:id/history`; the actions are `POST /appointments/:id/{confirm,check-in,start,attend,no-show,approve,cancel,correct,reschedule,detach-patient}` (reassigning a professional is a `reschedule` that changes `professionalId`); each takes `version`. Conflicts: `409 slot_taken` (extension `SlotConflictExtension`: `conflict`, `nextSlots`), `409 slot_no_longer_available`, `409 stale_revision`; a read-only tenant gets `402 tenant_read_only` (except cancel).
- Availability and series: `GET /availability?professionalId&from&to&typeId` (`AvailabilityResponse`); `POST /appointments/series` (dry run and commit with a skip list); holds are `/slot-holds` (create, release, convert).
- Worklist: `GET /worklist` (filtered by the user's locations, `WORKLIST_KINDS`), `POST /worklist/:id/{resolve,dismiss,confirm-identity}`; permission `worklist.manage`.
- Settings: appointment types, schedule blocks, days off, holidays by year and per-professional hours periods (permission `scheduling.configure`).
- Web catalogs already in place: es-AR audit labels (`locales/es-AR/audit.json`) and `errors.slot_taken`, `errors.slot_no_longer_available` (`locales/es-AR/errors.json`). The scheduling screens need a new `scheduling.json` namespace.
- Demo: reception and owner see the full agenda, each professional sees their own calendar; the identity review item is in the worklist.

### Remaining

- S2.12 to S2.34 (scheduling web, clinical, documents, onboarding, gate and legacy removal).
- The frontend does not use the new routes yet; none of the scheduling API was exercised from a browser (the Playwright demo specs still pass against the extended seed).
- Reminders, the waitlist and public booking (Stage 3) will add worklist items through `worklist.openItem`; the kinds already exist.
- `slot_hold` has no demo row (listed with a reason in the coverage test).
- Nothing was verified in CI (never polled).

## Batch 9: Stage 2, slices S2.12 to S2.16 (the scheduling web)

Strict TDD. Branch `feat/stage-2-practice-core`, work-unit commits with the slice id, automatic mode, delivery `size:exception` as in batch 8, draft PR #15 (base `feat/stage-1-secure-core`), no merge, CI not polled. Only `apps/web`, one shared contracts file, docs and the openspec artifacts changed: no backend file was edited (a separate agent owns the backend review fixes).

### Commits (in order, after batch 8)

| Slice | Commits | Tasks |
|---|---|---|
| S2.12 Calendar view | `76949de` lifecycle table shared through contracts; `7799cda` API client keeps the 409 extensions; `9ee0297` `CalendarView` (day, week, month, list) and the ADR; `b74b34a` agenda page, filters, legend, URL state, navigation; `e63962b` Playwright at 360 and 1280 px | 2.34 to 2.36 |
| S2.13 Booking UI | `62f0beb` booking dialog, slot grid, conflict handling, optimistic move with undo, Playwright booking | 2.37 to 2.39 |
| S2.14 Appointment drawer | `60cfff1` drawer, arrival and identity step, cancel, move, correction, history, series review, Playwright full day | 2.40 to 2.42 |
| S2.15 Worklist, Today, Check-in | `d9d731c` worklist with badge, Today, Check-in, role matrix | 2.43, 2.44 |
| S2.16 Scheduling settings | `6539001` types, blocks, holidays, overbooking; `33268e5` operator holiday catalog | 2.45, 2.46 |
| Follow-ups found by the full e2e run | `3730786` the shell spec follows the new entries, tabs no longer widen the page at 360 px, the free-time search reaches past the seeded weeks; `060eb20` the booking specs use a pediatric time at the locations reception works at | (S2.12 to S2.16) |

### What was built

- **Calendar (`shared/ui/calendar`).** A custom grid behind a presentational API (`resources`, `events`, `backgrounds`, `closedDays`): day with a column per professional, week with a column per day, month with counts, and a list presentation that phones always use. All time arithmetic is in the zone of the location (`zoned-time.ts`, DST under test); overlaps share a column (`layoutOverlaps`, so overbooking is visible); keyboard: events are buttons, `Alt` + arrows move an appointment by 15 minutes or to the next column. Dragging with a mouse is optimistic. Status is an icon and a word, never a color.
- **Agenda page.** Day, week, month; location filter; professional chips; cancelled toggle; legend; state in the address (`?view&date&location&pros&cancelled&list&appointment`) so a reload or a shared link lands in the same place; a professional is always asked for by name (their own agenda) and sees colleagues only with the delegated-calendar permission; the `truncated` flag shows a non-blocking notice.
- **Booking.** From a time chosen on the grid only the patient is missing; from the button the dialog opens on the day and professional on screen; a taken time (`409 slot_taken`) shows the next free times one tap away; out-of-hours asks for a reason only for who holds the permission; a weekly series is reviewed in a table before anything exists (skip or go back).
- **Drawer.** Only the actions the lifecycle allows (the same table as the API, now in `@consultorio/contracts`) and the permissions cover; arrival with the identity step (staff wording, and the solo-practice wording for the appointment's own professional), cancel (who and why, note required for "other"), reschedule or reassign with free times and next times, correction (statuses limited by who may speak for the consultation, 403 explained), history with the rescheduled count, read-only mode (only cancelling stays on).
- **Worklist, Today, Check-in.** "Pendientes" (kind chips with counts, location filter, resolve, dismiss with confirmation, approve, confirm identity, correct the patient, differences table) with its count as a badge on the navigation; "Hoy" for professionals (who is next, one button to start, in progress, waiting, to arrive, done); "Llegadas" for reception (search, one-click arrival, identity pending opens the arrival step).
- **Settings.** Settings > Turnos: appointment types (create, edit sending only what changed, deactivate with confirmation, restrict to professionals), blocks (zone-aware, whole days or hours, weekly repetition, the appointments inside are listed and NOT touched, remove one or the series), holidays and days off (merged year view, add and remove the organization's own), overbooking (confirmation from two simultaneous appointments). Operator console: holiday catalog editor (a change reaches every organization with no release, proven end to end).
- **Shared fixes found on the way.** The API client dropped the whole problem when a 409 carried extra members (`slot_taken` with `nextSlots` was reported as a plain conflict): fixed with validated extensions. A flex/grid child widened the page past 360 px (`grid-cols-1`). Toast fade made axe read half-transparent colors (the specs use reduced motion).

### Path finding (the question of `/api/v1`)

The server has NO `/api/v1` prefix: `rg` over `apps/api/src` finds the routes registered as `/appointments`, `/availability`, `/worklist`, `/appointment-types`, `/schedule-blocks`, `/holidays`, `/days-off`, `/slot-holds` and `/staff` (batch 5 was right; batch 8's "under `/api/v1`" and the task text `POST /api/v1/appointments` repeat the original plan). The web calls `API_BASE = '/api'` and the proxy strips it, exactly as for every Stage 1 route, so every new call is `/api/appointments...` in the browser and `/appointments...` at the server. A `/api/v1` prefix, if it is ever added, is one constant in `buildServer` plus the proxy rule.

### TDD Cycle Evidence

RED means the test file was written before the production code it exercises (a missing module is the failure) and, where a run was seen failing, it is said so.

| Tasks | Test file(s) | Layer | Notes |
|---|---|---|---|
| 2.34 | `zoned-time.test.ts` (15), `calendar-layout.test.ts` (14), `CalendarView.test.tsx` (27), contracts `appointment-lifecycle.test.ts` | Unit + component + axe | RED first. A real bug showed as a failing drag test (the drop was measured after the press state was cleared) |
| 2.35 | `calendar-events.test.ts`, `appointment-actions.test.ts`, `period.test.ts`, `search.test.ts`, `time-zone.test.ts`, `use-calendar.test.tsx`, `calendar-page.test.tsx`, `api-client.test.ts` | Unit + hook + component | RED observed for the API client (3 failed: extensions lost). Page tests: 17 of 18 passed at the first run, the failing one was a test flaw (cache) |
| 2.36 | `calendar.responsive.spec.ts` | e2e 360 + 1280, axe | RED observed: 296 px of horizontal overflow at 360 px, then fixed |
| 2.37 | `booking-dialog.test.tsx` (12) | Component + axe | RED first; one race in the test fixed |
| 2.38 | `calendar-page.test.tsx` (moving), `CalendarView.test.tsx` | Component | Optimistic move, rollback with next times, undo with the new version |
| 2.39 | `calendar.booking.spec.ts` | e2e | At most 6 actions and 30 s asserted; the lost race shows the next times |
| 2.40, 2.41 | `appointment-drawer.test.tsx` (33), `booking-series.test.tsx` (6) | Component + axe | RED first; 32 of 33 passed at the first run (one test query too broad) |
| 2.42 | `calendar.day.spec.ts` | e2e | Reception books, confirms, checks in; the professional starts and attends; axe at each step |
| 2.43 | `worklist-items.test.ts` (6), `worklist-page.test.tsx` (16), `nav-badge.test.tsx` (5) | Unit + component | RED first; the badge name needed an explicit `aria-label` (inline spans lose the space) |
| 2.44 | `day-flow.test.ts`, `today-page.test.tsx` (9), `checkin-page.test.tsx` (7), `scheduling.roles.spec.ts`, `scheduling.responsive.spec.ts` | Unit + component + e2e | Role matrix: reception, professional, owner |
| 2.45 | `type-form.test.ts` (9), `overbooking.test.ts`, `block-form.test.ts`, `scheduling-settings.test.tsx` (26), `scheduling.settings.responsive.spec.ts` | Unit + component + e2e | RED first |
| 2.46 | `holidays.test.tsx` (8), `operator.holidays.spec.ts`, `operator.holidays.responsive.spec.ts` | Component + e2e | The operator adds a holiday and an organization reads it at once |

### Test summary and verification (tip of `feat/stage-2-practice-core`, Node 24, pnpm 10.34.7, Docker running)

| Command | Result |
|---|---|
| `corepack pnpm install --frozen-lockfile` | not needed: no dependency was added (the lockfile is unchanged) |
| `corepack pnpm typecheck` | exit 0 (contracts, api, web) |
| `corepack pnpm lint` | exit 0 |
| `corepack pnpm format:check` | exit 0 |
| `corepack pnpm test` | **190 files, 2443 tests passed** (it was 165 files, 2149 tests) |
| `corepack pnpm test:integration` | **90 files, 1386 tests**, same count as batch 8. The full run failed 8 tests in 3 files (`staff-lifecycle`, `jobs`, `no-delete`) on 30-second timeouts while the machine was saturated by other worktrees (Docker answered `docker info` in 110 s); those three files, re-run once on their own, passed (3 files, 62 tests) |
| `corepack pnpm build` | exit 0 |
| `corepack pnpm test:e2e` | **140 passed** on a fresh stack (it was 112; +28 specs: calendar 360 and 1280, booking, full day, roles, settings, operator holidays). Two earlier full runs failed: on a reused stack (state left by `auth` and `staff` specs, which expect a fresh one), on a slow lazy chunk (10 s) and on two of my specs fighting for the same free time; fixed (see commits `3730786` and `060eb20`) |

Browser checks beyond the suite: axe at 360 and 1280 px on the agenda (day, week, month), the booking dialog, the drawer, Hoy, Llegadas, Pendientes, every section of Settings > Turnos and the operator catalog.

### Decisions and deviations

1. **Q6: a custom grid, not react-big-calendar.** Measured, not guessed: react-big-calendar 1.20 in a scratch folder under jsdom + axe gave 2 critical violations in the day view and 2 in the week view, no per-location time zone (device zone; the workaround is a process-wide default), a 12-hour clock, no keyboard path to an empty slot, mouse-only drag. Record and numbers in `docs/adr/calendar.md`.
2. **Resize is not offered.** An appointment's end is derived from its type (spec), and the API has no way to set it; dragging an edge would promise something impossible. Task 2.38 says "move and resize": only move is built, with a keyboard equivalent.
3. **The legend uses its own badge.** The shared `StatusBadge` has another status set; scheduling has eight, each with its own icon and word (`STATUS_PRESENTATION`).
4. **The lifecycle table moved to `@consultorio/contracts`** (new `appointment-lifecycle.ts`) so the screens offer exactly what the API allows. The API keeps its own copy for now (its hand-written exhaustive test is the guard) to avoid editing backend files while another agent works there; switching it to the shared table is a three-line change.
5. **"Who am I" in the agenda.** `/auth/me` carries no professional id, so the screens find the signed-in professional in the staff directory by email (the directory shows a person their own email). If the directory is hidden for a role, the professional's own screens fall back to an empty state.
6. **Differences of an identity review.** The producer (online booking, Stage 3) does not exist yet; the card reads `detail.differences` (`field`, `submitted`, `onFile`) when present. Staff bookings carry none.
7. **Blocks over appointments.** The API does not list affected appointments, so the dialog reads the calendar feed for the block's window and lists them; creating needs the person to confirm they know the appointments stay as they are.
8. **Navigation.** The owner/admin layout also gets Agenda and Pendientes (the spec lets them manage appointments and see the worklist; the design table listed only dashboard/staff/reports/billing/settings), and the professional layout gets Agenda (the spec says they open their calendar). `NOT_BUILT_YET` keeps Borradores and Recetas out until Stage 2 clinical.
9. **Coordinator's contract notes honored without touching the backend.** Every mutating call sends the appointment's current `expectedVersion` (a `Versioned<>` type makes it a compile error to forget; the worklist and the Today buttons read the version just before sending); `truncated` is read through a local `CalendarFeed` schema that already accepts it; a `slot_taken` without the extension is handled everywhere; corrections to "in progress" or "attended" are offered only to the appointment's own professional and a 403 is explained.
10. **Tests with toasts use reduced motion** in the specs that run axe with a toast on screen.

### Remaining

- S2.17 to S2.34 (clinical schema and UI, documents, onboarding, gate, legacy removal).
- The booking dialog has no hold step yet (holds exist in the API; the public flow in Stage 3 uses them).
- Nothing was verified in CI (never polled).

## Stage 2 integration 1: scheduling review fixes and the documents track

Two finished parallel tracks were merged into `feat/stage-2-practice-core` (tip before: `835fdf3`), with `git merge --no-ff`, in this order. The per-track reports stay as they are and hold the detail of each track: `apply-progress-stage2-schedfix.md` (14 review findings, strict TDD evidence, contract changes) and `apply-progress-stage2-documents.md` (S2.25 to S2.28, strict TDD evidence, deviations 1 to 15, shared-file list).

### What was merged

| Order | Branch | Merge commit | Notes |
|---|---|---|---|
| 1 | `fix/stage-2-scheduling-review` (`2320671`, based on `28ba4cf`) | `31d2bba` | No textual conflict: the UI branch only touched `apps/web` and `packages/contracts/src/appointment-lifecycle.ts`, which the fixes did not. The contract changes broke the web at compile time, which is how the adaptations below were found |
| 2 | `feat/stage-2-documents` (`15963fb`, based on `9bd2379`) | `35a521f` | Textual conflicts in `_journal.json`, `application.ts`, `main.ts`, `worker.ts`, `queues.ts`, `export-contributors.ts` and `translate.ts` (see resolutions). The other shared files merged cleanly and are exercised by the suites |

### Conflict resolutions

- `migrations/meta/_journal.json`: both tracks appended at idx 23; kept the 23 to 27 of this branch, then the schedfix entry as idx 28 and the documents entry as idx 29, with `when` strictly increasing.
- `main/application.ts`: both `createScheduling` and `createDocuments` are built (each its own `const`), and both route sets are in `routes` (`scheduling.routes`, `documents.routes`).
- `main/main.ts` (`runWorker`): the worker receives the scheduling `tenantJobs` (`hold.expire` every minute) and the documents hooks (`documentWorker(...)`: `jobs` and `schedules`).
- `platform/jobs/worker.ts`: both option families coexist. `tenantJobs` (a job queued for every organization every N ms, scheduling) and `jobs` / `schedules` built from a `WorkerJobContext` (documents). `registerJobs` receives `audit.seal`, `audit.verify`, the tenant jobs and the module jobs. Converging the two mechanisms into one is a possible later cleanup, not done here.
- `platform/jobs/queues.ts`: `hold.expire`, `document.scan` and `document.cleanup` are all registered.
- `main/export-contributors.ts`: scheduling and documents contributors both registered.
- `web/shared/lib/translate.ts`: git sees this file as binary (a NUL character in the `MISSING` sentinel). Resolved by taking this branch's version and adding the `documents` namespace; the NUL is preserved.
- Merged without conflict but worth knowing: `contracts/index.ts`, `roles.ts`, `audit-actions.ts`, `tokens/kinds.ts`, `config.ts`, `test/support/fixtures.ts`, `definer-functions.test.ts`, `demo-coverage.test.ts`, `audit-scenarios.ts`, `i18n.ts`, the locale files, `PatientDetailPage.tsx`, `router.tsx` and `tasks.md`.

### Migrations: one linear sequence

| File | Journal idx | `when` | Origin |
|---|---|---|---|
| `0023_scheduling_config` to `0027_care_from_appointments` | 23 to 27 | unchanged | this branch |
| `0028_care_lock_order` | 28 | 1792206823184 | schedfix `0080_care_lock_order` (renumbered, SQL and snapshot content unchanged) |
| `0029_documents` | 29 | 1792208525251 | documents `0040_documents` (renumbered, SQL unchanged) |
| `0030_document_appointment_fk` | 30 | 1792224778157 | new, see below |

Snapshots: `0028_snapshot.json` already chained to `0027`. `0029_snapshot.json` was rebuilt as the `0028` snapshot plus the `public.document` table of the documents snapshot (its `prevId` is the id of `0028`); the old `0040_snapshot.json` is gone. `0030_snapshot.json` was generated by drizzle-kit. `pnpm db:check` reports no drift. Migrations 0000 to 0022 were not touched.

### Documents get a foreign key to the appointment (migration 0030, new behaviour, strict TDD)

`document.appointment_id` now references `appointment (tenant_id, id)` by the composite key (`document_appointment_fkey`); `encounter_id` stays without a foreign key until the clinical merge.

- RED: `documents-schema.test.ts` "links a document to an appointment of its own organization, and to no other" (an appointment of another tenant and a random id were accepted) and `documents-uploads.test.ts` "keeps the appointment the document came with, and refuses one of another patient" (a 200 for an appointment of another patient).
- GREEN: the migration, the schema declaration, and a check in `uploads.ts` that the appointment exists and belongs to the patient of the upload (404 `not_found` otherwise, so a bad id is never a 500 from the database).
- Gotcha found while writing the migration: `ALTER TABLE ... ADD CONSTRAINT FOREIGN KEY` validates the existing rows with a query that runs as the table owner, and `FORCE ROW LEVEL SECURITY` binds the owner on both `document` and `appointment`: their tenant policy casts an `app.tenant_id` nobody set to uuid and the migration failed with 22P02. The migration lifts FORCE on the two tables for that statement only, inside the migration transaction, and puts it back. Any future migration that adds a foreign key between two forced-RLS tables needs the same.
- The generated isolation suite caught the new key (`composite foreign key document_appointment_fkey`): the `document` fixture now takes an `appointment_id` override.
- Not enforced by the database: that the appointment's patient is the document's patient. The use case checks it; a composite key including the patient would need a new unique constraint on `appointment`.

### State machine: one lifecycle table

`apps/api/src/modules/scheduling/domain/appointment-state-machine.ts` no longer keeps its own transition table: `canTransition`, `isTerminal` and `canReschedule` are the shared functions of `packages/contracts/src/appointment-lifecycle.ts` (the screens read the same table). Its exhaustive hand-written test (every from/to pair, 13 allowed transitions, terminal statuses) is unchanged and passes.

### UI adaptations to the schedfix contracts

| Contract change | Adaptation | Proof |
|---|---|---|
| `CorrectStatusRequest` is `{ toStatus, reasonCode, note?, expectedVersion }` | The correct panel has a "Motivo de la corrección" select (the four codes, labels in `scheduling.json`) and an optional "Detalle (opcional)" textarea; the button stays off until a code is chosen; an empty note is left out of the request | `appointment-drawer.test.tsx` (3 correct tests, RED first), `e2e/calendar.day.spec.ts` now ends with a real correction by the professional |
| `WorklistAppointmentDto.version` | The worklist actions (confirm identity, detach patient, approve) send the version the card was listed with instead of reading the appointment first; a 409 `stale_revision` reloads the list and shows "Este turno cambió mientras lo miraba" | `worklist-page.test.tsx`: the `GET /appointments/:id` stubs are gone, so a stray read fails; new stale test |
| Cancel with `cancelledBy` other than `patient` is a 402 on a read-only tenant | In a read-only organization the cancel panel offers only "El paciente" in "Quién cancela" and says why (`aria-describedby`); with an active organization the three options remain | `appointment-drawer.test.tsx` (two new tests, RED first) |
| `scheduling.override_hold` (403 without it) | The UI never sends `overrideHold` (there is no hold step in the booking dialog yet, see batch 9 "Remaining"), so nothing can hit that 403 today. A 403 on a booking is shown by the generic message and the dialog stays open (characterization test, passes without a code change). The staff screen already lists the permission (schedfix). A UI that overrides a hold will need to hide the option from users without the permission | `booking-dialog.test.tsx` |
| `expectedVersion` required everywhere, `CalendarResponse.truncated`, `slot_taken` always with `nextSlots` | Already followed by the UI track (it sent the version everywhere, showed the truncation notice and handled a conflict without next slots) | existing tests |

### Other documents changed

- `design.md` (grantable toggles table) and `specs/authorization/spec.md` (grantable permissions requirement, plus a scenario) now list `scheduling.override_hold`; owner and admin hold it by default, reception and professional need a grant.

### Verification (tip of the branch, Node v24.22.0, pnpm 10.34.7, Docker running and shared with other worktrees)

| Command | Result |
|---|---|
| `corepack pnpm install --frozen-lockfile` | exit 0 (no dependency changed) |
| `corepack pnpm typecheck` | exit 0 (contracts, api, web) |
| `corepack pnpm lint` | exit 0 |
| `corepack pnpm format:check` | exit 0 |
| `corepack pnpm test` | **209 files, 2680 tests passed** |
| `corepack pnpm test:integration` | **102 files, 1540 tests**: 1535 passed and 4 skipped (the slow ClamAV suite) in the full run; 1 failed (the generated isolation test for the new `document_appointment_fkey`, a fixture gap described above). After the fixture fix the file passes alone (152 tests). No test needed a re-run for an infrastructure reason in this run |
| `corepack pnpm build` | exit 0 |
| `corepack pnpm db:check` | No migration drift (0000 to 0030) |
| `corepack pnpm test:e2e` | **140 passed** on a fresh stack on private ports (API 3790, web 4790; the ports were changed only in the working tree and reverted), `--workers=3`, desktop and mobile-360, axe on every screen |
| `docker build -f infra/Dockerfile` and a smoke run with the production configuration of the CI smoke test (private port 3187) | image built; `/health` answered `{"status":"ok"}` |

CI was not run or polled from here. Lighthouse was not run.

### Risks and follow-ups

- The `tenantJobs` and `jobs` / `schedules` worker hooks do the same kind of thing in two ways; they coexist now.
- `.env.example` still lacks `CLAMAV_HOST` and the scanner variables stay in `main/config-scanner.ts` (documents deviation 7); `.env` files were off limits for this run.
- `encounter_id` still has no foreign key: it arrives with the clinical merge (the next migration number is 0031 or later; the clinical and onboarding branches renumber at their merges).
- The e2e stack still has an in-memory storage whose upload URL a browser cannot reach and does not run the document jobs, so there is no Playwright spec for documents (documents deviation 13).
- Migration 0030 takes a short exclusive lock on `appointment` and `document` (it lifts and restores FORCE ROW LEVEL SECURITY). Harmless before the first deployment; plan it for a quiet moment afterwards.

## Stage 2 integration 2: clinical, onboarding and the plan, then the close of Stage 2 (S2.31 to S2.33)

Three finished branches were merged into `feat/stage-2-practice-core` (tip before: `8287601`) with `git merge --no-ff`, in this order, and then Part B (S2.31 to S2.33, adapted local-first) was built on top. The per-track reports stay as they are and hold the detail of each track: `apply-progress-stage2-clinical.md` (S2.17 to S2.24, decision D20 and the security review fixes), `apply-progress-stage2-onboarding.md` (S2.29, S2.30), `apply-progress-stage2-documents.md` and `apply-progress-stage2-schedfix.md` (merged in integration 1). Mode: automatic, strict TDD for new behavior, `size:exception` (work-unit commits, no merge to main, CI not polled).

### What was merged

| Order | Branch                                                        | Merge commit | Notes                                                                                                                                                                                                       |
| ----- | ------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `feat/stage-2-clinical` (`2192bc9`, based on the Stage 1 tip) | `071beba`    | Textual conflicts in `_journal.json`, `application.ts`, `export-contributors.ts`, `definer-functions.test.ts`, `demo-seed.test.ts`, `seed.ts`, `router.tsx`, `PatientDetailPage.tsx` and `translate.ts`      |
| 2     | `feat/stage-2-onboarding` (`b6bcc8e`, based on `28ba4cf`)     | `6d7f780`    | Conflicts in `_journal.json`, `application.ts`, `export-contributors.ts`, `router.tsx`, `translate.ts`, `docs/demo.md`, `playwright.config.ts` and `e2e/support/stack.ts`                                   |
| 3     | `docs/refine-stages-3-6` (`32ff16f`, docs only)               | `a27a5e5`    | No conflict: it only touches `tasks.md`; git merged the Stage 3 to 6 detail with the Stage 0 to 2 checkbox states of this branch (258 checked tasks before and after)                                       |

### Conflict resolutions

- `migrations/meta/_journal.json`: this branch's entries up to idx 30, then the new ones appended with strictly increasing `when` (see the sequence below).
- `main/application.ts`: `createScheduling`, `createDocuments`, `createClinical` and `createOnboarding` are all built, and `scheduling.routes`, `documents.routes`, `clinical.routes`, `onboarding.routes` are all registered; the options keep both `clinical` and `onboardingCapabilities`.
- `export-contributors.ts`, `definer-functions.test.ts`, `demo-seed.test.ts`, `seed.ts`: both sides kept (the clinical notes step now follows the agenda step in the seed).
- `router.tsx`: the scheduling routes (`/calendar`, `/today`, `/check-in`, `/worklist`), the clinical routes (`/notes/$noteId`, `/encounters/new`, `/drafts`) and the onboarding wizard guard.
- `PatientDetailPage.tsx`: the "Documentos" tab and the "Historia clínica" (`chart`) tab both exist; `TabId` has both.
- `web/shared/lib/translate.ts` (git sees it as binary because of the NUL in the `MISSING` sentinel): took this branch's version and added the `clinical` and `onboarding` namespaces; the NUL is preserved.
- `playwright.config.ts` and `e2e/support/stack.ts`: both tracks added `E2E_WEB_PORT`/`E2E_API_PORT`; kept one copy.
- `roles.test.ts` merged cleanly but was wrong: `GRANTABLE` has 7 entries, not 6 (found by running the test, then fixed).

### Migrations: one linear sequence

0000 to 0030 are untouched (`git diff` on them is empty).

| File                     | Journal idx | `when`        | Origin                                                                  |
| ------------------------ | ----------- | ------------- | ----------------------------------------------------------------------- |
| `0031_clinical`          | 31          | 1792227200000 | clinical `0060_clinical` (renumbered, SQL unchanged apart from a comment) |
| `0032_clinical_triggers` | 32          | 1792227201000 | clinical `0061_clinical_triggers` (renumbered)                          |
| `0033_clinical_d20`      | 33          | 1792227202000 | clinical `0062_clinical_d20` (renumbered)                               |
| `0034_encounter_links`   | 34          | 1792227670766 | NEW: composite foreign keys and the encounter guard (see D20 wiring)    |
| `0035_onboarding_state`  | 35          | 1792227671766 | onboarding `0070_onboarding_state` (renumbered)                         |

Snapshots: the track snapshots described their own base, so each one was rebuilt on this branch's chain: the difference between the track's snapshot and the one before it (tables that changed or were added) was applied on top of the previous snapshot of this chain, with a new `id` and `prevId` set to the previous `id`. `0034_snapshot.json` was generated by drizzle-kit. Checks: the journal `idx` are sequential, the `when` values strictly increase, the `prevId` chain is unbroken over 36 snapshots, and `pnpm db:check` reports "No migration drift."

### D20 wiring (strict TDD)

Both modules are in one application now, so the clinical module no longer receives a test double for the agenda:

- `scheduling.findCareSourceAppointment(tx, id)` (new, `application/care-source.ts`) is the port the composition root hands to `createClinical` (`options.clinical.appointments` is kept only as a test override). `open()` refuses, with a 403 and a deny audit entry naming the patient: an unknown appointment, or one of another patient or professional, or a cancelled or pending-approval one (`appointment_mismatch`), and one whose identity nobody confirmed (`appointment_identity_unconfirmed`, new). The care relationship itself needed no change: the scheduling trigger already feeds `care_relationship` from appointments with confirmed identity, and both the service and `encounter_guard` read `is_treating`, so an appointment with confirmed identity is a valid source and an unconfirmed one is not.
- Migration `0034_encounter_links`: composite FK `encounter (tenant_id, appointment_id)` to `appointment`, composite FK `document (tenant_id, encounter_id)` to `encounter`, and `encounter_guard` replaced: for a named appointment it needs the same patient and professional (otherwise 23503, like the note guard for a parent that does not match, which keeps the generated isolation suite meaningful) and a confirmed identity and a counting status (otherwise 42501). The gotcha of integration 1 applies: FORCE row level security is lifted on `document`, `encounter` and `appointment` for the length of the `ADD CONSTRAINT` statements and put back, inside the migration transaction.
- RED then GREEN: `clinical-appointments.test.ts` (8 cases) failed first with 5 of 8 red (the unconfirmed appointment was accepted, the foreign key did not exist, the encounter linked to a stranger's appointment). It covers the three cases asked for: confirmed identity then open is allowed (with and without naming the appointment, and the encounter carries the appointment); an unconfirmed booking (the professional booking themselves) is refused with a 403 and the deny audit, and it is allowed once reception confirms the identity at check-in; another professional's appointment is refused. Plus the database: the guard rejects another professional's or another patient's appointment (23503) and an unconfirmed one (42501), and the two foreign keys exist.
- Tests adapted to the FK: the fake `AppointmentLookup` maps in `clinical-notes-api` and `clinical-encounter-access` are gone (random appointment ids can no longer be inserted); the `encounter` and `document` fixtures honor the new overrides; `clinical-schema` and `documents-schema` assert the foreign keys.
- UI, the "Iniciar consulta" entry point. For the appointment's own professional (clinical write permission, confirmed identity, not read-only), `domain/consultation.ts` decides: a patient "En sala" gets the existing call-in button, which now also opens `/encounters/new?patientId=&appointmentId=` after the appointment moves to "En consulta"; an appointment in progress gets a link to the same page. Both in the drawer (agenda) and in "Hoy" (`StartConsultation`). Everyone else sees the unchanged buttons. The new-encounter page loads the appointment, shows "Turno: type", ties the encounter to it and starts the reason of the note from the type of the appointment (general and odontology templates); an appointment of another patient in the address is dropped with a message. Tests first for each: drawer (a table of who is offered it), Today (link and navigation), chart (prefill and foreign appointment).
- The demo seed opens its consultations from appointments (see S2.31).

### D21, the authorization spec and the onboarding link

- `GRANTABLE` has 7: `scheduling.override_hours`, `scheduling.override_hold`, `scheduling.register_past`, `scheduling.delegated_calendar`, `cash.operate`, `patients.administer`, `onboarding.manage`. `design.md` (grantable toggles table) and the authorization spec (grantable requirement and a scenario: running the first run needs its own permission; an admin holds it only by grant) were updated.
- Decision D21 (orchestrator, pending owner confirmation) is in `proposal.md` (new section "Stage 2 integration: decisions D20 and D21", which also records D20): during the first-run wizard an active owner may add the `professional` role to themselves exactly once, audited as `role.changed` with `via: onboarding`; the path closes when the wizard finishes. The authorization spec's "No self-assignment" requirement has the exception and a scenario; the tenant-onboarding spec's initial-roles requirement states the narrow path and a scenario for the closing. The code already behaved this way (the onboarding track tests it); nothing was changed in it.
- The clinical-records spec got the two new scenarios (identity unconfirmed, identity confirmed) and the extended requirement.
- "Ir a la agenda" and the checklist item "first appointment" link to `/calendar`, which is the real scheduling route (`router.tsx`). A new test, `app/onboarding-links.test.ts`, keeps every address the first run links to (`/calendar`, `/patients/new`, `/onboarding` and each `CHECKLIST_LINKS` entry) a route of the application. `MeResponse.needsWizard` is required and every builder compiles (typecheck is the proof; `meFor` sets it).

### S2.31: Stage 2 end to end and demo data

- **2.94 Demo seed** (`db/seed/demo/stage2.ts`, `seed.ts`, `snapshot.ts`, `reset.ts`): after the agenda and the first notes, the cardiologist and the pediatrician open encounters FROM the attended and in-progress appointments (D20), write and sign the notes (one visit stays in progress with its note as a draft, one signed note gets an addendum); then eight documents go through the real upload service, a direct put to the quarantine key (the browser's part) and the real scan job with the fake scanner: three administrative by reception, four clinical by the professionals attached to a visit (one linked to the encounter and the appointment) and one EICAR file that shows a rejection. The seed takes an optional `documents: { storage, scanner }`; the CLI `demo:seed`/`demo:reset` and the deployed reset pass the S3 storage when `S3_BUCKET` is set. `NO_SEED_DATA.document` is removed and `demo-coverage` proves every table has data. The reset removes the files from the bucket after the database reset succeeds and stores new ones (test: another organization's objects are untouched).
- **2.95 e2e**: the Playwright stack (`scripts/stack/start-stack.ts`) now starts MinIO (fixed host port through `--minio-port`/`E2E_MINIO_PORT`, because the web's Content Security Policy must name the storage origin: `CSP_CONNECT_SOURCES`), the queue client of the API and the worker with the document jobs and hold expiry. `stage2-solo.spec.ts` (360 px): the operator creates the organization, the owner takes the invitation from Mailpit, signs in, uses the quick setup, registers the first patient and books the first appointment; the time from the first sign-in is recorded as an annotation (5.2 seconds in the final run, budget 10 minutes). `stage2-center.spec.ts`: reception registers, books, confirms and checks in; the cardiologist calls the patient in from the agenda, the encounter opens tied to the appointment with the reason prefilled, writes, signs, adds an addendum, finishes the visit, uploads a lab result (scanned by the worker, shown "Disponible", downloaded) and the EICAR file (refused with its reason, no download button); reception does not see the clinical documents and uploads an identity copy; the API refuses reception the signed note; the owner of the demo organization is not sent to the wizard. Axe runs on every new screen. `calendar.day.spec.ts` follows the new call-in behavior.
- **A real defect found by the journey and fixed test-first**: `DocumentsTab` rendered the dialogs as siblings after a body that changes between the empty state and the list, so when the first uploaded file turned the empty list into a list, React rebuilt the upload dialog and the person lost the summary. A component test that makes the list go from empty to non-empty failed first; the dialogs now follow the body at a fixed position.
- **2.96 Reset timing with Stage 2 data**: `demo reset took 4,749 ms` (budget 30 s in CI, requirement 60 s), with the agenda, the consultations and the documents; the same run proves the logical content equal to a first seed.
- **2.97 Benchmark**: `pnpm --filter @consultorio/api bench:clinical`; `docs/perf/clinical-readable.md`. With 102,000 notes a patient's chart answers in 1.0 ms at p95 with the policies on (0.8 ms without), the drafts in 0.8 ms and a 2,000-entry chart in 25.7 ms; the plan is an index scan on the existing index. No index change was needed.

### S2.32: delivery pipeline and backups (local-first)

- **2.99** `pnpm backup:local` (`backup`, `verify`, `restore`; `apps/api/scripts/backup/`): a custom-format `pg_dump` run inside the database container, a checksummed copy of the bucket through the S3 API, a manifest written last; `verify`/`restore` refuse a changed backup before creating anything; a restore only ever creates a NEW database (an existing name is refused) and puts the objects in the named bucket. Tests: `manifest.test.ts` (5, unit) and `backup-restore.test.ts` (3, integration on throwaway Postgres and MinIO: isolation across two organizations on the restored copy, the same FORCE row level security and policies as the source, the PDF byte for byte, refusal over an existing database and of a tampered dump). It was also run for real against the compose services on private ports (`demo:seed` with a bucket, backup, verify, restore into `consultorio_restore` with 26 patients, 8 documents and 17 notes, the refusal over `consultorio`), then torn down. `docs/runbooks/backup-restore.md` has the production design (PITR, weekly dump, the KEK that must be escrowed apart) and the quarterly drill checklist.
- **2.98 deferred (owner action)**: the cloud account, region (Q1), registry and the GitHub environments do not exist, so no workflow was written that could not run. `docs/runbooks/deploy.md` records what is ready (image, smoke test, migrations as a one-off) and what the owner must provide. Nothing depends on it.

### S2.33: Stage 2 gate

| Item                                                                                                                | Result                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Everything the gate defines (typecheck, lint, format, unit, integration, build, db:check, e2e, Docker image, smoke) | Green, see "Verification"                                                                                                                                                                                                                                                                                                                                                                                        |
| 2.100 fresh-context review (`judgment-day`)                                                                         | **Not done by the executor** (an executor cannot open a fresh context). While integrating, the three areas were re-read and these were found and fixed: an encounter could name an appointment that did not exist or belonged to someone else (no foreign key, no guard), an unconfirmed appointment was not refused, the upload dialog defect and the stale `GRANTABLE` test. The independent review stays for the orchestrator to launch; its report goes in the PR |
| 2.101 `docs/legacy-parity.md`                                                                                       | Written; the owner's sign-off is pending                                                                                                                                                                                                                                                                                                                                                                         |
| Success: a solo professional books a first appointment within 10 minutes                                            | Met and automated: `stage2-solo.spec.ts`, 5.2 s of automation at 360 px                                                                                                                                                                                                                                                                                                                                          |
| Success: a center runs a full day                                                                                   | Met and automated: `stage2-center.spec.ts` (three roles; scheduling, clinical, documents), plus `calendar.day.spec.ts`                                                                                                                                                                                                                                                                                            |
| Success: reception books an existing patient in 30 s or less                                                        | `calendar.booking.spec.ts` (6 actions, 30 s) passes                                                                                                                                                                                                                                                                                                                                                              |
| Success: usable at 360 px, installable PWA                                                                          | `*.responsive.spec.ts` and `pwa.spec.ts` pass, axe on every journey                                                                                                                                                                                                                                                                                                                                              |
| Success: p75 load under 2.5 s on 4G                                                                                 | NOT verified locally: Lighthouse CI cannot start Chrome on this Windows machine (`spawn UNKNOWN` from chrome-launcher, also with the Playwright Chromium); it is a CI job and stays unverified here                                                                                                                                                                                                              |
| Success: 100% of clinical reads and writes audited, no signed entry editable, a non-clinical admin denied           | The clinical, audit-scenario and access suites pass (`clinical-*`, `audit-scenarios`)                                                                                                                                                                                                                                                                                                                            |
| Success: the demo resets in under a minute with data in every module                                                | 4.7 s with Stage 2 data; `demo-coverage`                                                                                                                                                                                                                                                                                                                                                                         |
| Success: legacy archived or removed                                                                                 | N/A in this repository (tasks 2.102 and 2.103); the parity document is written                                                                                                                                                                                                                                                                                                                                   |

### Verification

Node v24.22.0, pnpm 10.34.7 via corepack, Docker Desktop shared with other projects (their containers were not touched).

| Command                                                                         | After Part A (merges, D20, D21)                          | After Part B (tip of the branch)                                                   |
| ------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `corepack pnpm install --frozen-lockfile`                                       | exit 0                                                   | exit 0                                                                             |
| `typecheck` / `lint` / `format:check`                                           | exit 0                                                   | exit 0                                                                             |
| `corepack pnpm test`                                                            | 228 files, 2,984 tests passed                            | **229 files, 2,990 tests passed**                                                  |
| `corepack pnpm test:integration`                                                | 117 files, 1,805 passed, 4 skipped (the slow ClamAV suite) | **118 files, 1,811 passed, 4 skipped**                                           |
| `corepack pnpm build`                                                           | exit 0                                                   | exit 0                                                                             |
| `corepack pnpm db:check`                                                        | No migration drift                                       | No migration drift                                                                 |
| `test:e2e` (fresh stack, private ports, `--workers=3`)                          | 168 passed (ports 3410/4410)                             | **170 passed, 0 flaky** (ports 3430/4430, MinIO 9430)                              |
| Docker build and smoke (`/health`, production configuration of the CI smoke test) | built, `{"status":"ok"}` (private port)                  | built, `{"status":"ok"}` (private port)                                            |
| `pnpm demo:stack` and sign-in                                                   | started, signed in as the owner                          | started (MinIO on 9100), signed in as the cardiologist; stopped by the PID I started, containers gone |

No test needed a re-run for an infrastructure reason in the final runs. CI was not run or polled.

### TDD cycle evidence (new behavior)

| Task                        | Test                                                  | RED                                                                                                             | GREEN                                                  |
| --------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| D20 appointment source      | `clinical-appointments.test.ts`                       | 5 of 8 failed (no FK, no identity check, a stranger's appointment accepted)                                    | 8 of 8 after migration 0034, the lookup and the rule   |
| "Iniciar consulta"          | `appointment-drawer.test.tsx`, `today-page.test.tsx`  | 3 failed (no link, no navigation)                                                                               | green after `StartConsultation`                        |
| Prefill from the appointment | `clinical-chart.test.tsx`                            | 2 failed                                                                                                        | green after `NewEncounterPage`/`NewEncounterForm`      |
| Onboarding links            | `onboarding-links.test.ts`                            | a guard for an existing property: it passed at once                                                             | n/a                                                    |
| Grantable list              | `roles.test.ts`                                       | failed (7 is not 6)                                                                                             | green                                                  |
| Demo documents              | `demo-coverage` (entry removed), `demo-seed` (2 tests) | coverage failed: `document` has no data and no reason                                                          | green after `stage2.ts`                                |
| Reset takes the files out   | `demo-reset.test.ts`                                  | failed (14 objects instead of 7)                                                                                | green after the reset change                           |
| Upload dialog defect        | `documents.test.tsx`                                  | failed (summary lost)                                                                                           | green after the fix                                    |
| Backup and restore          | `manifest.test.ts`, `backup-restore.test.ts`          | **deviation**: the library was written before its tests (tooling); both passed at their first run and the drill was repeated for real on compose | green                          |
| Benchmark                   | script                                                | n/a (a measurement tool, checked at 5,000 and at 102,000 notes)                                                 | n/a                                                    |

### Deviations and decisions

1. The snapshot chain was rebuilt from each track's delta rather than regenerated, because drizzle-kit can only describe the current schema; the final `db:check` proves the last snapshot equals the schema.
2. The `AppointmentLookup` port now returns `identityConfirmed` and `counts`; the "unconfirmed" refusal is a separate reason from "mismatch" so the deny audit tells them apart. Opening an encounter WITHOUT naming the appointment for a patient with no clinical footprint and no relationship is still allowed under D20 (a brand-new patient); naming an unconfirmed appointment is refused. Closing that gap would be a product decision for the owner.
3. "Iniciar consulta" turns the call-in button of a professional into call-in plus navigation; reception and other roles keep the old button. The label stays "Iniciar consulta" because existing tests and the demo script use it.
4. The Playwright stack fixes the MinIO host port (default 9190 for the suite, 9100 for `demo:stack`) because the web build names the origin in its CSP; two runs on one machine need different `E2E_MINIO_PORT`.
5. The e2e stack is heavier (one more container, the worker with the document jobs); a run takes about 2.5 minutes with three workers.
6. `.gitignore` gained `/backups/`.

### Risks and follow-ups

- 2.100 (independent review) and the owner's sign-off of the legacy parity are open; D20 and D21 need the owner's confirmation.
- Lighthouse CI was not run here (see the gate table).
- The deployed demo reset now writes files to the real bucket under the demo organization's prefix with the fake scanner; confirm that is wanted when the demo is first deployed.
- Production still requires ClamAV with a bucket; the fake scanner is for development and the demo only.
- Migration 0034 takes a short exclusive lock on `document`, `encounter` and `appointment` (FORCE row level security is lifted and restored); plan it for a quiet moment after the first deployment, like 0030.
- The `tenantJobs` and `jobs`/`schedules` worker hooks still coexist (integration 1).
- CI never ran on this branch.

### Local run and demo (updated)

```bash
corepack pnpm install --frozen-lockfile
# the demo in one terminal (Docker is the only requirement); the banner prints the exact command for the web app
pnpm demo:stack
# in a second terminal:
CSP_CONNECT_SOURCES=http://localhost:9100 API_PROXY_TARGET=http://127.0.0.1:3000 pnpm --filter @consultorio/web dev
# open http://aillu.localhost:5173   (password for every account: Demo-Aillu-2026-clave)
#   propietaria@ administracion@ recepcion@ recepcion.norte@ cardiologia@ pediatria@ psicologia@  (all @demo.invalid)
# mail: the Mailpit address in the banner; platform console: http://platform.localhost:5173 (operator in the banner)

# your own data (survives restarts): pnpm infra:up; pnpm --filter @consultorio/api db:migrate; pnpm demo:seed; pnpm dev
# (with S3_BUCKET set, demo:seed also uploads and scans the demo documents)

pnpm backup:local                                   # back up the local database and bucket
pnpm backup:local verify backups/<folder>
pnpm backup:local restore backups/<folder> --into consultorio_restore --bucket consultorio-restore
pnpm --filter @consultorio/api bench:clinical       # the clinical RLS benchmark (100,000 notes)

# the browser suite, on private ports when another run holds the defaults
cd apps/web && pnpm exec vite build
E2E_WEB_PORT=4310 E2E_API_PORT=3310 E2E_MINIO_PORT=9310 pnpm exec playwright test --workers=3
```

A good path to show: `docs/demo.md`, item 5 "A day in the center".

## Judgment Day Stage 2, round 1

Two blind judges reviewed the Stage 2 branch (target `363aadd`). The findings confirmed by both (C1 to C9) and the ones raised by one judge (S1 to S10) were fixed in `feat/stage-2-practice-core` (tip before: `38ae16c`) with strict TDD: a failing test first, then the fix, one `fix(...)` commit per finding id (`JD-S2 <id>` in the message). Every suspect item was reproduced with a failing test before it was fixed, and every one of them reproduced, so none was left unfixed. Migrations 0000 to 0035 are untouched (SQL), except the comment of S10 in 0031 (see below). The new ones are 0036 to 0041, generated with `drizzle-kit generate --custom`: sequential `idx`, strictly increasing `when`, unbroken `prevId` chain, and `db:check` reports "No migration drift."

### What was fixed

| Id  | Fix                                                                                                                                                                                                                                                                                                                                                              | Test (RED, then GREEN)                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `rescheduleAppointment` resets `identity_confirmed` (and by/confirmation) when the professional changes to the actor's OWN profile, opens an `identity_review`, and flags `identityReset` in the history event and the audit entry. Covers a reception+professional user and a delegated calendar.                                                                | `lifecycle.test.ts` "reassigning a confirmed appointment" (3 RED); `scheduling-identity.test.ts` (the actor gets no care relationship)                      |
| C2  | Hide and reclassify of a CLINICAL document need authorship or a care relationship (both directions). Migration 0036 repeats it in `guard_document` for any change of `classification` away from clinical.                                                                                                                                                         | `documents-lifecycle.test.ts` "a colleague who reads a clinical document only through sharing" (2 RED: the API and direct SQL)                              |
| C3  | Migration 0037: triggers on `document` (insert as clinical, reclassify to clinical) call the existing `app.clinical_footprint_mark()`, plus a backfill. The note service reads the same database function, so the application agrees with the database.                                                                                                            | `documents-schema.test.ts` "a clinical document leaves a clinical footprint" (2 RED)                                                                        |
| C4  | The clinical documents export selects by `author_professional_id = me OR patient in treated`, like the notes exporter.                                                                                                                                                                                                                                           | `documents-export.test.ts` (RED: the author's document of an untreated patient was missing)                                                                 |
| C5  | `ObjectStorage.get` returns the `etag`; `move` takes `{ ifMatch }` (S3 `CopySourceIfMatch`, a digest in the fake) and throws `ObjectChangedError` for another object. The scan moves only the scanned object, scans again on a change, and checks the sha256 of the released object.                                                                              | `storage-contract.ts` (fake AND MinIO); `documents-scan.test.ts` "a file replaced between the scan and the release" (RED: the infected file was released)   |
| C6  | Upload `encounterId`: looked up in the caller's RLS scope, same patient, author or treating, otherwise `not_found` (it was a 500).                                                                                                                                                                                                                               | `documents-uploads.test.ts` (RED: 500)                                                                                                                      |
| C7  | `correctStatus`: the appointment's own professional cannot put a cancelled appointment back into a care-counting status (`scheduled`, `confirmed`, `checked_in`, `in_progress`, `attended`, and `no_show`, which also counts). Another member with `scheduling.checkin` revives it, flagged `revivedFromCancelled` in the history and the audit entry.             | `lifecycle.test.ts` "reviving a cancelled appointment" (7 RED); `scheduling-lifecycle.test.ts`                                                              |
| C8  | `app.lock_first_encounter(patient)`, an advisory transaction lock by organization and patient, in the `encounter_guard` trigger (migration 0038) and in `notes.open`; taken only when the author does not already treat the patient.                                                                                                                              | `clinical-encounter-access.test.ts` "serialized" (RED: the second professional got in after the first committed); a concurrent HTTP test                    |
| C9  | Migration 0039 marks the wizard finished for non-demo organizations that have staff or a professional. The application closes the self-added professional role 30 days after the organization was created (`isSelfRoleOpen`).                                                                                                                                    | `onboarding-api.test.ts` (30 days, RED); `onboarding-schema.test.ts` (runs the migration SQL in a rolled-back transaction)                                  |
| S1  | `Actor.ownProfessionalId` and `BookActor.ownProfessionalId`: the member's profile whatever its state. Every D14 decision (booking, confirm, detach, check-in, C1, C7) uses it. A failed profile lookup now rejects the request instead of answering "none". The clinical gate (`professionalId`) is unchanged.                                                     | `professional-gate.test.ts`, `guard.test.ts`, `identity.test.ts` "D14 does not depend on the clinical gate" (4 RED)                                         |
| S2  | Migration 0040: the lane capacity check runs when an occupancy is inserted, becomes active again, or changes lane or professional. An active appointment that stays put keeps its lane (the second option of the finding).                                                                                                                                        | `scheduling-schema.test.ts` (RED: raw 23514)                                                                                                                |
| S3  | `detachPatient` with `move_to_patient`: `fromPatientId` and `toPatientId` in the history event and the audit entry, and an `appointment.identity.confirmed` entry (`viaDetach`) for the new record. The route declares the new audit action.                                                                                                                      | `identity.test.ts`; `scheduling-identity.test.ts`                                                                                                           |
| S4  | Local restore: `--bucket` is required, cannot be the live bucket or the one the backup came from, and the bucket must be new or empty. All of it is checked before the database is created. The runbook says so.                                                                                                                                                 | `backup-restore.test.ts` (RED: it restored into the live bucket)                                                                                            |
| S5  | The platform catalog reader filters `removed_at`.                                                                                                                                                                                                                                                                                                                | `platform-catalogs.test.ts` (RED)                                                                                                                           |
| S6  | `GET /appointments/:id` and its history answer `not_found` (not 403) outside the viewer's calendars and locations.                                                                                                                                                                                                                                               | `scheduling-scope.test.ts` (RED); `scheduling-calendar.test.ts` updated                                                                                     |
| S7  | Migration 0041: restrictive `clinical_professionals_only` policy (FOR SELECT, the owner role is let through for the definer triggers) on `clinical_footprint`. The isolation fixtures read it as a professional.                                                                                                                                                  | `clinical-schema.test.ts` (2 RED)                                                                                                                           |
| S8  | A `pending_approval` item refuses a plain resolve or dismiss (409) and is no longer offered those actions. Approving the appointment resolves it (`approved`); cancelling it already dismissed it.                                                                                                                                                               | `scheduling-worklist.test.ts` (3 RED)                                                                                                                       |
| S9  | `weeklyOccurrences`: the end of each occurrence is the shifted start plus the length of the block.                                                                                                                                                                                                                                                               | `blocks.test.ts` (RED: equal start and end in the skipped hour)                                                                                             |
| S10 | Comment only in `0031_clinical.sql` (0061 to 0032). The same stale numbers in the `schema/clinical.ts` and `schema/documents.ts` comments were corrected too. Drizzle does not verify the SQL hash of an applied migration (it compares the timestamp) and the snapshots do not hold it, so nothing needed to be skipped; `db:check` still reports no drift.         | `db:check`; the whole integration suite migrates from zero                                                                                                  |

### Decisions and deviations

1. C7 includes `no_show` among the blocked statuses (it also counts for the care relationship in the trigger of migration 0028). Reviving a cancelled appointment straight into `in_progress` or `attended` is therefore possible for nobody: the own professional is refused by C7 and anybody else by the existing clinical rule. Another member revives it to `scheduled` (or `checked_in`), and it then progresses normally.
2. S6 covers the two reads named in the finding. The WRITE routes (`confirm`, `check-in`, `cancel`, `reschedule`, `correct`, ...) still answer 403 for a colleague's appointment and 404 for an unknown id, so they tell the same fact; they were not in the finding and their tests expect 403. The refusal of the two reads is no longer in the audit trail (a not found writes nothing). See the follow-ups.
3. C2: the database backstop covers the change of `classification`, as asked. Hiding a clinical document is enforced by the use case only.
4. C8 takes the lock only when the author does not already treat the patient, so the common path adds no contention.
5. C3 marks the footprint when the document row is written, not when the upload is confirmed, so an abandoned or rejected upload of a clinical document leaves it too. The footprint is a one-way "somebody started this record" marker.
6. S2 chose "check the capacity where an appointment is placed" over refusing the lowering: a lane-2 appointment of the past, or one that cannot be moved, would otherwise still break on a status change.
7. S7: an `INSERT ... ON CONFLICT` evaluates the reading policies, so the policy lets the owner role (`current_user = 'app_owner'`, the role of the definer triggers) through, like `document_classification` does. The runtime role reads the footprint only as a professional.
8. `ObjectStorage.get` returns an `etag`; the logo service (it returns a derived PNG) is typed without it.

### Verification

Node v24.22.0, pnpm via corepack, Docker Desktop shared with other projects (their containers were not touched; the containers the browser suite started were removed by their own cleanup).

| Command                                                      | Result                                                                                                                                                                                                      |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typecheck` / `lint` / `format:check`                        | exit 0                                                                                                                                                                                                      |
| `corepack pnpm test`                                         | **230 files, 3,022 tests passed**                                                                                                                                                                           |
| `corepack pnpm test:integration`                             | 119 files: 117 passed, 1 skipped (the slow ClamAV suite), **1 failed: `documents-scan.test.ts`**; see the note below. 1,833 tests passed, 4 skipped                                                       |
| `documents-scan.test.ts` + `definer-functions.test.ts` alone | re-run on its own after the failure: 26 of 26 passed (`documents-scan` alone: 21 of 21, twice)                                                                                                              |
| `corepack pnpm build`                                        | exit 0                                                                                                                                                                                                      |
| `corepack pnpm db:check`                                     | No migration drift                                                                                                                                                                                          |
| `test:e2e` (fresh stack, private ports 4471/3471/9471, `--workers=3`) | **170 passed**, 0 flaky                                                                                                                                                                         |

The one integration failure looks like a clock skew, not a defect of this round: "raises an alert once the document has waited more than an hour" sets `upload_completed_at = now() - 61 minutes` in the database container and reads the wait with the host clock, and the wait came out as 60 minutes (`expected 60 to be greater than or equal to 61`), which fits a container clock a little behind the host. That test leaves the fake scanner switched off when it fails, so the three tests after it in the file (including the new C5 test) failed as a consequence. The same file passes on its own. CI was not run or polled.

### Follow-ups (INFO items of the review, not fixed in this round)

- `cancelledBy: 'patient'` is client-asserted in a read-only organization (A10).
- Audit gaps on shared document reads and on reception metadata (A12).
- The fake scanner is allowed outside production (A14).
- No quota on unconfirmed uploads (A15).
- Backup consistency, encryption and path checks (A16).
- No database guard on identity transitions or on clinical document insert (B12).
- Overlap race of hours periods (B15).
- New from this round: the write routes of an appointment still tell "exists in a colleague's calendar" (403) from "does not exist" (404) (decision 2).

## Judgment Day Stage 2, round 2

Second round of the adversarial review of Stage 2, applied on top of `e3b5016`. Each fix is its own `fix(...)` commit tagged "JD-S2 R2-<id>"; every one started with a failing test.

### What was fixed

| Id    | Fix                                                                                                                                                                                                                                                                                                                                                       | Test                                                                                                                                                                                                                      |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-C1 | `weeklyOccurrences` (S9 regression): the end of each occurrence keeps its own local time (`addLocalDays(zone, end, 7 * week)`), so an all-day, an overnight and a Friday-to-Monday block end where they should across a daylight saving change. The length of the first occurrence is used only when the shifted end is not after the shifted start (the skipped hour). | `blocks.test.ts`: all-day across the spring and the fall change, overnight 22:00-06:00 across both, Friday 18:00 to Monday 08:00 (America/New_York; 5 RED). The S9 and "keeps the local hour" tests still pass                |
| R2-C2 | Migration 0042 replaces `app.guard_document()`: moving a clinical document to `hidden` needs `app.professional_id` to be the author or to treat the patient. No exception for the system user. Every earlier check is kept.                                                                                                                                | `documents-lifecycle.test.ts` "is refused by the database too: hiding a clinical document ..." (RED: a colleague who reads it through sharing hid it); covers the colleague, the system user and the author                |
| R2-C3 | `document.rescan_attempts` (migration 0043) counts the rounds in which the quarantined object changed after it was scanned. After `MAX_RESCANS` (5) the next change rejects the upload as `corrupt`, removes the object and raises the existing `document_scan_overdue` alert. `scan_attempts` is untouched (it counts scanner outages, which may be many).    | `documents-scan.test.ts` "gives up after a few scans of a file that keeps changing ..." (RED: stayed quarantined)                                                                                                          |
| R2-S1 | Reproduced. `viewsOthersCalendar` required a gated `professionalId`, so a delegated look by a member without a recorded matricula was never audited. It now compares with `ownProfessionalId ?? professionalId` and audits every non-administrative look at a calendar that is not the member's own. The feed uses the same function.                         | New `delegated-view.test.ts` (2 RED: gate closed with a profile; no profile at all)                                                                                                                                        |
| R2-S2 | Reproduced. `resolveProfessionalIds` looks the profile up for every member. `ownProfessionalId` is the profile whatever the roles; `professionalId` (the gate) still needs the professional role, an active profile and a valid matricula.                                                                                                                 | `professional-gate.test.ts` (2 RED); the "does not even look" test now expects one lookup and a null gate                                                                                                                  |
| R2-S3 | `isSelfRoleOpen` filters the `tenant` row by `current_setting('app.tenant_id')`. Not reproducible as a leak (the `tenant_isolation` policy already limits the table); defense in depth.                                                                                                                                                                   | The onboarding integration suites (no new test: nothing can fail)                                                                                                                                                          |

The flaky `documents-scan.test.ts` "raises an alert ..." now sets `upload_completed_at` from the process clock (the clock the job reads) instead of `now()` in the database container, and the file has an `afterEach` that switches the fake scanner back on, so a failure no longer leaves it off for the tests after it.

### Decisions and deviations

1. R2-C3 adds a column instead of reusing `scan_attempts`: that counter also drives the backoff of scanner outages and can legitimately be high, so a document that waited out an outage would be refused on its first swap.
2. R2-S2 costs one profile lookup per request for members who do not hold the professional role (owners, admin, reception). A failed lookup rejects those requests too, as it already did for professionals.
3. R2-C2 uses `OLD.status IS DISTINCT FROM 'hidden'` with `NEW.status = 'hidden'`; the existing transition rule already limits it to `available` to `hidden`.
4. New runbook: `docs/runbooks/sole-owner-professional-role.md` (see B-W3 below).

### Verification

| Command                                                               | Result                                                                      |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `typecheck` / `lint` / `format:check`                                 | exit 0                                                                      |
| `corepack pnpm test`                                                  | **231 files, 3,032 tests passed**                                           |
| `corepack pnpm test:integration`                                      | 118 files passed, 1 skipped (the slow ClamAV suite); 1,839 tests, 4 skipped |
| `corepack pnpm build`                                                 | exit 0                                                                      |
| `corepack pnpm db:check`                                              | No migration drift (journal 0042 and 0043, `when` increasing)               |
| `test:e2e` (fresh stack, private ports 4481/3481/9481, `--workers=3`) | **170 passed**, 0 flaky                                                      |

CI was not run or polled.

### Follow-ups (INFO items of the review, not fixed in this round)

- A-W3 / B-S4: the semantics of the 0039 backfill (which organizations count as "wizard finished") deserve a second look before the first real organization is migrated.
- B-W3: a sole owner past 30 days has no self-role path inside the product. The recovery path is in `docs/runbooks/sole-owner-professional-role.md` (invite a second owner, or an operator action with a second reviewer); a reviewed operator script does not exist yet.
- B-W4: the restore guard compares only the bucket name, not the endpoint or the account behind it.
- B-S3: a not-found read in another professional's calendar writes no audit entry, and the write routes of an appointment still answer 403 (see decision 2 of round 1).

## Stage 3 seam: S3.00 and S3.00b (tasks 3.1 to 3.10)

Branch `feat/stage-3-patient-engagement`, stacked on `feat/stage-2-practice-core`. Mode: automatic, strict TDD, `size:exception` (work-unit commits, no merge to main, CI not polled). The seam registers every shared piece once so that the five tracks (A messaging, B public booking, C waitlist, D teleconsultation, E integration) only add files. The per-track boundaries are in `docs/stage3-tracks.md`; the migration convention is in `docs/migration-ranges.md`.

### Commits (seam, in order; the Stage 2 Judgment Day fixes arrive through two merges)

| Slice  | Task  | Commit                | What                                                                                                                                                                              |
| ------ | ----- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S3.00  | 3.1   | `4a2c1b3`             | Provider settings (`WHATSAPP_PROVIDER`, `VIDEO_PROVIDER`, `BOT_CHALLENGE`, `WHATSAPP_APP_SECRET`, `VIDEO_ALLOWED_DOMAINS`, `ALLOW_LOCAL_PROVIDERS`, `LOCAL_PROVIDERS_CONSOLE`) and the production guard |
| S3.00  | 3.3   | `753bf05`             | Five permissions, 22 audit actions, one contracts file per module, per-module audit scenario files                                                                                |
| S3.00  | 3.2   | `265b6d4`             | `WhatsAppSender`, `VideoLinkProvider`, `BotChallenge` ports, three fakes, resolver slots                                                                                          |
| S3.00  | 3.4   | `355d31b`             | Nine queues and their read-only classification table                                                                                                                              |
| S3.00  | 3.5   | `3738e83`             | Appointment event bus and the scheduling publishers                                                                                                                               |
| S3.00  | 3.6   | `fc18519`             | Four module skeletons, `main/wiring/*`, adapter registry assembly, export contributors, fixture glob                                                                              |
| S3.00b | 3.8   | `d472816`             | Settings section registry, sections merged into `GET\|PATCH /settings`                                                                                                            |
| S3.00b | 3.7   | `7e1d57c`             | Migration ranges, `db:new`, `db:restamp`, journal check, `docs/migration-ranges.md`                                                                                               |
| S3.00b | 3.10  | `c9978af`             | Provider console shell (API and web)                                                                                                                                              |
| S3.00b | 3.9   | `9e99aff`             | Web registries: routes, nav, slots, translations, feature boundary lint, dev proxy                                                                                                |
| both   | extra | `ddbd82a`, `4fafe39`  | The remaining shared files pre-registered (see "Extra seam work"), `docs/stage3-tracks.md`, scheduling exports                                                                    |
| merge  |       | two `merge:` commits  | `origin/feat/stage-2-practice-core` at `e3b5016`, then at `e1124f9`                                                                                                               |

### Migration convention (the decision asked for)

Ranges are compatible with Drizzle's journal approach, so they are kept (Stage 3 is 0300-0399 split by track, as the plan says), with tools that handle the parts of drizzle-kit that are not.

- **Why compatible.** Drizzle's migrator ignores the number in a tag. It applies, in the order of `_journal.json`, the entries whose `when` is later than the newest one the database ran. `test/integration/migration-lanes.test.ts` proves it on a real Postgres: a jump from 0035 to 0320 migrates fine, and an entry merged later but stamped earlier is SKIPPED SILENTLY.
- **What is not compatible.** `drizzle-kit generate` names the next file by the last `idx`, takes the snapshot whose file NAME sorts last as the database state, and refuses two snapshots that continue the same parent. Two tracks that branch from one snapshot always produce that. So the tools run drizzle-kit in a scratch copy where the snapshots are ordered by the journal, and keep the chain in order.
- **Why not linear numbering.** Two branches that each take the next number produce two `00NN_snapshot.json` files: an add/add conflict git cannot merge. Ranges never do.
- **Tools.** `pnpm db:new <track> <name> [--number NNNN] [--custom]` (track names `3seam`, `3a` to `3e`, `4seam`, ... in `scripts/migration-journal.ts`) writes the next migration of the track from the schema changes, or an empty file, with the snapshot that continues the last one and a stamp later than every entry. `pnpm db:restamp` after every merge or rebase: raises stamps that do not rise (never entries below 0300), numbers `idx`, re-chains the snapshots in journal order, rebuilds the last snapshot from the schema. `pnpm db:check` also fails on `non_monotonic_when`, `duplicate_tag`, `duplicate_prefix`, `out_of_range_prefix`, `bad_tag`, `bad_idx`, `missing_sql`, `orphan_sql`, `missing_snapshot`, `broken_snapshot_chain`. `db:generate` now refuses and points to `db:new`.
- **Stages 0 to 2.** The sequence below 0300 stays linear and is numbered by drizzle-kit on the Stage 2 branch (now 0000 to 0043 after the Judgment Day fixes). It is never restamped. The seam has no tables, so Stage 3 added no migration yet: the first one is track A's 0320.
- Verified end to end by `check-migration-drift.test.ts`: two tracks create migrations from the same base, are merged out of order, `db:check` reports `broken_snapshot_chain` and `non_monotonic_when`, `restampFolder` repairs both and the check passes.

### Extra seam work (tasks listed under other slices, or not listed, that the seam needed to be complete)

1. **Settings sections are static in the contracts.** `SettingsDto` carries `notifications`, `onlineBooking`, `waitlist`, `teleconsultation`, `integrations` (defaults from the spec); the registry decides which are served and a missing one fails loudly. `integrations` has a wiring of its own (`main/wiring/integrations.ts`) because it belongs to the platform; changing the WhatsApp switch also audits `notification.integration.changed`.
2. **Module error catalogs.** Each module's contracts file exports `<MODULE>_ERRORS`, joined into `ERROR_CATALOG` (a duplicate code refuses to load); messages go in `errors.<module>.json`, merged by the locale loader into the `errors` namespace.
3. **Schema files pre-exported** (`notifications`, `channel-preference`, `usage-event`, `online-booking`, `booking-submission`, `waitlist`, `teleconsultation`) with a policy test that every schema file is in the index.
4. **No-delete allowlist and demo-coverage exemptions** accept one file per track (`test/policy/no-delete/*.json`, `test/integration/demo-coverage-exemptions/*.ts`).
5. **`db/seed/demo/contributors.ts`** (S3.16's registration point) exists and the seed runs it.
6. **The e2e stack** (`scripts/stack/start-stack.ts`) is composed with the same wiring, adapter registry, provider console and worker jobs as `main`.
7. **Scheduling `index.ts`** exports the use cases the capability modules call.
8. **Vite dev proxy** forwards `/public/t/*` and `/public/v/*` to the API (the pages the reminder and video links open); `docs/dev-setup.md` documents it.
9. **`patient_changed` event** in the event bus (moving an unconfirmed appointment to another patient record), in addition to the six listed.
10. Fixture helpers moved to `test/support/fixture-helpers.ts`; `import.meta.glob` is declared in `test/support/import-meta-glob.d.ts` (the API does not depend on `vite/client`).

### TDD cycle evidence

| Task | Tests                                                                                                                                                                  | RED                                                                                                                                                       | GREEN  | Notes                                                                                                                                                                            |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1  | `guard.test.ts` (12), `config-providers.test.ts` (9)                                                                                                                   | guard: module missing; config: tests failed until the schema and the docs existed                                                                        | passed | triangulated over environment x provider x flag                                                                                                                                  |
| 3.3  | `roles`, `audit-actions`, `access` additions, four module contract tests                                                                                               | 7 files failed                                                                                                                                            | passed |                                                                                                                                                                                  |
| 3.2  | three fake tests, resolver test                                                                                                                                        | modules missing                                                                                                                                           | passed |                                                                                                                                                                                  |
| 3.4  | `jobs.test.ts` classification (3 new), `job-queues.test.ts` (10, integration)                                                                                          | 3 failed                                                                                                                                                  | passed | the integration test was written with the queues present (installer characterization)                                                                                            |
| 3.5  | `appointment-events.test.ts` unit (9), integration (9), bus (6)                                                                                                        | unit: 8 of 9 failed with the publishers stashed; the bus tests were written together with the bus (the shell rejected the first file write): no separate RED | passed | a failing subscriber rolls the booking back (integration)                                                                                                                        |
| 3.6  | `wiring.test.ts` (9), `export-registry` (4 modules), `fixture-registry.test.ts` (4)                                                                                    | export registry: 4 failed; fixture registry: 4 failed; the wiring test was written together with the wiring: no separate RED                              | passed | the isolation suite still discovers the fixtures                                                                                                                                 |
| 3.7  | `migration-journal.test.ts` (13), `restamp.test.ts` (8), `new-migration.test.ts` (9), drift tests (6), `migration-lanes.test.ts` (2)                                    | restamp and new-migration: modules missing; the journal test was written with the journal module: no separate RED                                         | passed | bug found by running `db:restamp` on the committed folder (the key order of a snapshot counted as a change): fixed with a deep comparison and a test                              |
| 3.8  | registry (4), domain (18), contracts, integration `access-settings` (18)                                                                                               | registry and domain tests failed until implemented; the integration additions were written after the code                                                  | passed |                                                                                                                                                                                  |
| 3.9  | `registry.test.ts` (11), `registry-router.test.tsx` (6), `slots.test.tsx` (5), `locale-files.test.ts`, nav (5 new), three host tests, `feature-boundaries.test.ts` (3)   | boundary: the first attempt on virtual files failed (the project service does not know them), redone with fixture files                                    | passed |                                                                                                                                                                                  |
| 3.10 | policy enumeration (3), integration (5), web `providers.test.tsx` (8), wiring entries                                                                                  | enumeration: the console-on case failed first                                                                                                              | passed |                                                                                                                                                                                  |

### Deviations and decisions

1. **`.env.example` untouched** (`.env` files are off limits in this run). The provider variables are documented in `docs/dev-setup.md` and a test checks it, like the scanner variables. Task 3.1 says `.env.example` documents each: the owner can add them.
2. **Wiring is passed as `ApplicationOptions.wiring`, not `modules`.** `modules` stays the plain-route hook the Stage 1 tests use; `wiring` modules also bring adapters, sections, jobs and dev providers.
3. **The event bus is an instance per application**, not the module-level `publishAppointmentEvent` and `subscribeAppointmentEvents` functions of the task text, because tests build many applications in one process. Same semantics (synchronous, same transaction, a failing subscriber rolls the write back).
4. **Quiet hours** stay the Stage 1 top-level `quietHours` setting; the `notifications` section does not repeat them.
5. **`booking.purge` is classified `write`** as the task says: in a read-only tenant it is cancelled, so unverified submissions wait until the tenant recovers (the purge is by age, so nothing is lost).
6. **Production defaults of the providers** are `off` for WhatsApp and video and `turnstile` for the bot challenge, so an existing production configuration still starts; a simulator in production (or the console) needs `ALLOW_LOCAL_PROVIDERS=true`.
7. **The local adapters and the `local_whatsapp_*` tables** are track work (3.22, 3.38, 3.67); the seam registers only the demo fakes.
8. **The web feature boundary** applies to features added after Stage 2. The 67 existing cross-feature imports of Stages 1 and 2 are exempt through a named list in `packages/config/eslint/base.js`.
9. **The linear sequence is below 0300** (not 0000-0035 as first written), because the Stage 2 branch keeps receiving migrations.
10. **Contributed navigation entries have no stage**: they exist when their feature does. `ENABLED_STAGE` stays 2.

### Merges of the Stage 2 branch

- `e3b5016` (Judgment Day round 1; migrations 0036 to 0041): textual conflicts in `scheduling/application/identity.ts` and `lifecycle.ts`, where the event publishes sit next to the new worklist closing (`approve`) and the moved-patient audit details; both sides kept. The journal merged without conflict (the seam added no migration). Check: idx 0 to 41, stamps rising, snapshot chain intact, `db:check` clean.
- `e1124f9` (round 2; migrations 0042 and 0043, `resolveProfessionalIds` resolving `ownProfessionalId` for every member, the DST logic of `blocks.ts`): merged without conflict, including `blocks.ts`, where the `slot_freed` publish stays. Check: idx 0 to 43, `db:check` clean.
- After each merge the ranges documentation and tests were updated (`docs/migration-ranges.md`, the `stageRangeOf` expectations).

### Risks and follow-ups

- The patients module has no public API for matching and creating patients online (track B, task 3.43) nor for reading a patient's contact (track A): `modules/patients/index.ts` is the one declared exception to "tracks only add files" (new export lines).
- `tasks.md` puts `platform/public/token-router.ts` in track A, and B and C register handlers in it: B and C wait for A, as the plan says.
- Lighthouse and CI were not run here.
- `db:restamp` rewrites the stamps of unmerged migrations: a development database that ran the old stamp needs `pnpm infra:reset`.
- Drizzle-kit's interactive rename prompt (a table dropped and another added in one diff) can stall `db:new` in a non-interactive shell, as it already could for `db:check`.

### Verification (tip of the branch after both merges, Node v24.22.0, pnpm 10.34.7, Docker running and shared with other projects)

| Command | Result |
|---|---|
| `corepack pnpm install --frozen-lockfile` | exit 0 |
| `corepack pnpm typecheck` | exit 0 (contracts, api, web) |
| `corepack pnpm lint` / `format:check` | exit 0 |
| `corepack pnpm test` | **259 files, 3,303 tests passed** |
| `corepack pnpm test:integration` | **126 files passed, 1 skipped (the slow ClamAV suite); 1,933 tests passed, 4 skipped** |
| `corepack pnpm build` | exit 0 |
| `corepack pnpm db:check` | No migration drift (journal sound: idx 0 to 43, stamps rising, snapshot chain intact) |
| `test:e2e` (`vite build`, private ports 3470/4470/9470, `--workers=3`) | **170 passed** |

CI was not run or polled. Lighthouse was not run.

## Stage 3 integration 1: tracks 3A, 3B and 3D merged into the seam branch

The per-track detail (tasks, commits, TDD evidence, deviations) stays in each track's own file:

- Track A (notifications, reminders, WhatsApp): `apply-progress-stage3-track-a.md` (migrations 0320 to 0323)
- Track B (online booking): `apply-progress-stage3-track-b.md` (migrations 0340 to 0342)
- Track D (teleconsultation): `apply-progress-stage3-track-d.md` (migration 0370)

Track C (waitlist) is not merged yet.

### Merges (`git merge --no-ff`, in this order)

| Track | Tip merged | Merge commit | Conflicts |
|---|---|---|---|
| 3A | `7ad75a7` | `64cab12` | none |
| 3B | `3041909` | `7502975` | `_journal.json`, `check-migration-drift.test.ts`, `wiring.test.ts`, `kinds.ts`, `kinds.test.ts` |
| 3D | `f08d4d8` | `343558a` | `_journal.json`, `wiring.test.ts`, `kinds.ts`, `kinds.test.ts` |

### Resolutions

- **Journal**: kept every entry of both sides in merge order, then `db:restamp` (stamps raised for 0340 to 0342 and 0370, snapshots re-chained, last snapshot rebuilt). Final order: `0000` to `0043`, `0320`, `0321`, `0322`, `0323`, `0340`, `0341`, `0342`, `0370` (idx 0 to 51). `db:check` clean after each merge.
- **`wiring.test.ts`, `kinds.test.ts`, `check-migration-drift.test.ts`**: the seam's generic versions (the wiring test only requires that routes are added; the enabled-kinds test names the Stage 1 set plus the Stage 3 set; the drift test uses Stage 4 tracks as the example tracks). Track B's `config.providers.botChallenge` in the wiring context was kept.
- **`platform/tokens/kinds.ts`**: the union of the tracks. `appointment_confirm`, `appointment_cancel`, `notification_opt_out`, `whatsapp_opt_in` (A), `appointment_reschedule` with 366 days (B) and `video_join` (D) are enabled. `video_join` now lives **3 days** (was 3 hours): reminders issue the link 24 hours or more ahead and `issue` caps the lifetime at the kind. The pinning test in `video-join-address.test.ts` now expects window close plus 12 hours. `waitlist_offer` and `archive_release` stay disabled (track C and later).
- `patients/index.ts` (A and B export lines), `fixture-helpers.ts` (A's id suffix on emails), `security-headers.ts` (A's `referrer-policy` override), `shell.test.tsx`: merged without conflict, both sides kept.

### Fixes found by the verification (cross-track breakage)

1. `packages/contracts/src/errors.test.ts`: lint refused `Object.entries` over the union of module catalogs once they stopped being empty. The map is typed as plain catalogs now.
2. `notifications/application/revoke-links.ts`: track A revokes every appointment link when an appointment is cancelled, which made track B's manage page (that shows the appointment as cancelled) answer the blank 404. The manage link (`appointment_reschedule`) now survives a cancellation; a reschedule, reassignment or patient change still revokes it. Found by `booking-self-service.test.ts` ("shows an appointment that staff cancelled as cancelled").

### Referrer policy audit

Any public HTML page with a form must send `Referrer-Policy: same-origin`. The pages the API renders are the token pages (`/public/t/:token`, already `same-origin`, pinned by `notifications-tokens.test.ts`) and the video join page (`/public/v/:token`), which has **no form** (its CSP says `form-action 'none'`), so it keeps `no-referrer`; `video-join-public.test.ts` now asserts there is no `<form`. The public booking pages are the web app (`apps/web/index.html` carries `<meta name="referrer" content="same-origin">`), and `stage3-booking.spec.ts` passes on the real stack. No header change was needed.

### Verification (tip after the three merges and the fixes, Node v24, pnpm 10.34.7)

| Command | Result |
|---|---|
| `corepack pnpm install --frozen-lockfile` | exit 0 |
| `corepack pnpm typecheck` / `lint` / `format:check` | exit 0 |
| `corepack pnpm test` | **298 files, 3,780 tests passed** |
| `corepack pnpm test:integration` | **156 files passed, 1 skipped (ClamAV); 2,382 tests passed, 4 skipped** |
| `corepack pnpm build` | exit 0 |
| `corepack pnpm db:check` | No migration drift |
| `test:e2e` (ports 4580/3580/9580, `--workers=3`) | **181 passed** (`stage2-center.spec.ts:59` did not crash this time) |

### Risks and follow-ups

- A reminder lead time can be set up to 14 days (`lead-times.ts`), but `video_join` lives 3 days, so a link issued more than 3 days ahead of the window dies early. Either raise the kind to 15 days or issue the link at send time; decide before the Stage 3 gate.
- Track C (waitlist) still has to merge: `waitlist_offer` stays disabled in `kinds.ts` until then, and the C merge will touch the same shared test files.
- CI was not run here; Lighthouse was not run.

## Owner decisions D19/D20/D21 (2026-10-17)

The owner of the product reviewed the three decisions the orchestrator took in automatic mode and answered on 2026-10-17. Branch `feat/stage-2-practice-core` (draft PR #15), from tip `e1124f9`. Strict TDD: every behavior below has a test written first (the unit RED runs for the ceiling are in the first commit; the integration suites `professional-added-by-admin.test.ts` and `owner-professional.test.ts` were written before the services and routes they exercise).

### What changed per decision

**D19 (revised).** The owner and the admin bring professionals in; the 7-day review flag stays; the owners are notified; the residual risk is accepted.

- `GRANT_CEILING.admin` now includes `professional` (`packages/contracts/src/roles.ts`). The owner role stays out of an admin's reach in invitations, at invitation acceptance and in role changes.
- New audit action `professional.added_by_admin` (`via: invitation` or `via: role_grant`, `ownersNotified`). `access/application/professional-notice.ts` writes it inside the transaction of the change and reads the addresses of every active owner. The routes (`PUT /members/:id/roles` and `POST /staff/invitations`) send `renderProfessionalAddedEmail` after the commit. An actor who holds the owner role writes neither. A provider failure is logged and does not undo the change.
- Web: the invite dialog, the roles tab and the wizard team step offer the professional role to an admin and tell them the owners get an email.
- `proposal.md` records the accepted residual risk: clinical separation against a malicious admin is audited and notified rather than prevented.

**D20.** Confirmed exactly as implemented. The status in `proposal.md` changed from "pending owner confirmation" to "confirmed by owner 2026-10-17". No code change.

**D21 (revised).** An owner may act as a professional at any time, provided they complete the professional profile.

- `staff/application/owner-professional.ts` adds the role and saves the profile (name, specialty, matricula and jurisdiction) in the caller's transaction, audited as `role.changed` with `via: owner_professional_profile`.
- New `POST /staff/me/professional` (`OwnerProfessionalRequest` in contracts). The wizard profile step and the fast path use the same service.
- Removed: `isSelfRoleOpen`, `SELF_ROLE_WINDOW_DAYS`, the `onboarding_role_closed` refusal and their tests. `isWizardCompleted` stays because the wizard gate uses it. Migration 0039 is untouched and nothing depends on the window.
- Web: an owner "Atender como profesional" form in the Perfil profesional tab, and a shared `MatriculaFields` used by the wizard step, the fast path and that form.
- The runbook `docs/runbooks/sole-owner-professional-role.md` is removed: it only described the 30-day window.
- Non-owners still cannot self-assign roles, and an owner still cannot change their own roles through the role-change endpoint (both tested).

### The fast-path choice

The fast path (and the wizard's "yes, I am a professional" step) **requires the matricula and its jurisdiction before the role is active**, instead of granting the role and leaving the matricula as a checklist item. This matches "siempre y cuando llene el perfil de profesional con los datos" and is consistent with D1 (an unverified matricula is enough for clinical work; verification is needed only for e-prescription).

- `FastPathRequest.matricula` is optional in the shape only: an owner who already completed the profile is not asked again. When the fast path has to create the profile and the matricula is missing, nothing is created and the answer is a 400 naming `matricula` (`onboarding.matricula_required`).
- `ProfessionalStepRequest` (the yes branch) takes a required `MatriculaInput`; `matricula: null` is refused at the contract.
- A malformed matricula, or one held by another active professional, rolls the whole transaction back: no role, no profile, no audit entry (tested).
- The checklist item "matricula" stays for professionals added by someone else; the fast-path test no longer lists it as pending.
- The `tenant-onboarding` "Fast path" requirement changed accordingly (it used to say the short path MUST NOT require the matricula).

### Commits

| Commit    | Message                                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `35cc614` | feat(authz): admins may invite and grant the professional role, with an audit event and an email to the owners (D19 revised) |
| `755ac51` | feat(authz): an owner may act as a professional at any time by completing the profile (D21 revised)                          |
| `3ab0641` | docs(sdd): record owner decisions D19, D20 and D21 in the proposal, specs and design                                         |

### Deviations and risks

1. The notification is sent after the commit and is not retried: a provider outage loses the email, and the audit event remains. Stage 3 `notifications` could take over delivery with an outbox if the owner wants a guarantee.
2. The owner email goes out when the admin acts (invitation sent, role granted), not when the invitee accepts; an invitation that is never accepted still notifies the owners.
3. `professional.added_by_admin` is only written when the actor does not hold the owner role. An actor with both the owner and admin roles counts as an owner.
4. `POST /staff/me/professional` uses the `staff.manage` permission (owner and admin) and lets the service refuse non-owners with an audited denial, because no owner-only permission fits.
5. The 7-day review flag keys on the creation of the professional profile, so an owner who completes their profile later is flagged for 7 days when reception assigns patients to them. Accepted: it is the same signal as for any new professional.
6. The first full e2e run had one failure (`stage2-center.spec.ts` waiting for the 10:00 slot, a timeout) that passed alone and passed in the second full run. It looks like contention under three workers and is not related to this change. Both runs are reported.
7. `test:integration` had one suite-level failure in the first full run (`backup-restore.test.ts`, "socket hang up" while the shared Docker daemon was busy). The file passes alone (4 tests).

### Verification

| Command                                                       | Result                                                                                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `corepack pnpm install --frozen-lockfile`                     | up to date                                                                                                                            |
| `typecheck` / `lint` / `format:check`                         | exit 0                                                                                                                                |
| `corepack pnpm test`                                          | **231 files, 3,047 tests passed**                                                                                                     |
| `corepack pnpm test:integration`                              | 119 files passed, 1 skipped (ClamAV), 1,866 tests; `backup-restore.test.ts` failed once with a Docker socket error and passed alone  |
| `corepack pnpm build`                                         | exit 0                                                                                                                                |
| `corepack pnpm db:check`                                      | No migration drift (no new migration)                                                                                                 |
| `test:e2e` (fresh stack, ports 4590/3590/9590, `--workers=3`) | **170 passed** on the second full run; the first had 169 passed and one timeout in `stage2-center.spec.ts` that passed when run alone |

CI was not run or polled.

## Stage 3 integration 2: cross-track wiring, product gaps and the CI fixes

Branch `feat/stage-3-patient-engagement`, from `04048ea`. Automatic mode, strict TDD, `size:exception` (work-unit commits). Track C (the waitlist) is not merged yet; it runs in its own worktree and codes against `deliverWaitlistOffer`.

### Commits

| Item                          | Commit    | What                                                                                                                                                         |
| ----------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 7 token guard                 | `0928085` | Registering a token kind twice throws; an application resets the registry when it starts to be built                                                         |
| 8 `VIDEO_LOCAL_BASE_URL`      | `be61ec6` | Setting validated (https, no credentials, query or fragment), passed to the local video provider, documented                                                 |
| CI 1: Docker smoke            | `acb2bd4` | The job queue connects on its first enqueue, so the API boots and answers `/health` without a database; test boots the real entry point                      |
| CI 2: Lighthouse              | `07ec60e`, `53b6e28`, `680fab6` | Lazy slot pieces, error codes split from the schemas in contracts, lazy signed-in shell (see below)                                           |
| Merge of the Stage 2 base     | `aeb36eb`, `ea768af` | `f8db04c` merged (D19 revised, D20, D21 revised); three conflicts resolved by keeping both sides; `db:restamp` and `db:check` clean                  |
| 1 notifications to video      | `7a4db53` | Reminders and confirmations of a virtual appointment carry the join address; `video_join` lives 15 days                                                       |
| CI 3: e2e after D21           | `71696cb` | The Stage 3 specs give their professional a matricula                                                                                                         |
| CI 4: backup guard            | `4df3c68` | The empty-bucket check asks again on a network failure (bounded), still fails closed on anything else                                                         |
| 2 waitlist delivery           | `f8f8f41` | `deliverWaitlistOffer`, `offerQuietHoursEnd`, `message_offer` (migration `0390`), template and renderer changes                                              |
| 3 booking notifier            | `85650b2` | `createBookingNotifier`: booking confirmation through notifications, WhatsApp opt-in recorded; planner skips its own confirmation for online bookings        |
| 6 email after WhatsApp opt-out | `0388603` | `optOutChannel` queues an email reminder for each reminder an opt-out cancelled                                                                              |
| 5 scheduling                  | `22d2d3b` | `mode` in `CalendarEntryDto`, virtual marker, `today-appointment` slot with the join button, `actor_kind` patient for link actions                            |
| 4 staff UI                    | `0cca477` | Settings > Turnos online and its end-to-end test                                                                                                              |

### The exported delivery entry point (for track C)

```ts
// apps/api/src/modules/notifications/index.ts
export function deliverWaitlistOffer(
  tx: Tx,
  input: {
    offerId: string;
    patientId: string;
    professionalId: string;
    locationId: string;
    startsAt: Date;
    endsAt: Date;
    expiresAt: Date;
    offerTokenUrl: string;
  },
): Promise<{ channel: 'whatsapp' | 'email' | 'none'; messageId: string | null }>;

// also exported
export function offerQuietHoursEnd(tx: Tx, input: { locationId: string; at: Date }): Promise<Date | null>;
export function bindOfferDelivery(deps: OfferDeliveryDeps | undefined): void; // the process binds it; tests call it
```

- It queues the `waitlist_offer` message in the caller's transaction and the worker sends it (WhatsApp with an opt-in, otherwise email). It renders the existing `waitlist_offer` templates, which now carry the single-use link and the time the offer closes.
- `none` (nothing queued, `messageId: null`) means: inside quiet hours (offers are NOT exempt: waitlist spec "Opt-out and consent in offers"), read-only organization, demonstration organization, offer already expired, no queue bound in this process, or no channel the patient allows. The waitlist decides what to do next: with quiet hours, `offerQuietHoursEnd` says when they end (null outside them), so it can create the offer again then with an expiry that keeps the minimum lead time, or leave the slot to reception.
- The call is idempotent per offer and channel (dedupe key `waitlist_offer:<offerId>:<channel>`): asking twice returns the same message.
- A permanent WhatsApp failure falls back to email with the same link. The link lives in `message_offer`, apart from the message log (which stays metadata only), and the hourly `reminder.sweep` clears it an hour after the offer expired. A message whose offer expired before the job ran is cancelled with the new reason `offer_expired`.
- `waitlist_offer` stays disabled in `platform/tokens/kinds.ts` (track C enables it). The process-global binding means the API and the worker both call `bindOfferDelivery` (done in `createNotifications` and in the notifications worker wiring).

### Per item

1. **Notifications to teleconsultation.** `VideoJoinRegistry` (notifications) is created per application and per worker process, passed in the wiring contexts (`WiringContext.videoJoin`, `WorkerWiringContext.videoJoin`); teleconsultation registers its resolver in `create` and in its worker part. Reminders and confirmations of a virtual appointment name the mode and carry the platform address (email: text and link; WhatsApp: variables `mode` and `joinUrl`); `pending` says the link follows; `in_person` and `closed` say nothing. `video_join` is 15 days (reminders go out up to 14 days ahead); the pinning tests state it and a test sends a reminder 14 days ahead and opens its link. The console stand-in route stays behind `LOCAL_PROVIDERS_CONSOLE` (it already only existed there).
2. **Waitlist delivery.** See above.
3. **Track B.** `recordWhatsAppOptIn` records `channel_preference` with source `online_booking`. The booking confirmation goes through `createBookingNotifier` (wired in `main/wiring/online-booking.ts`): logged as a `confirmation` message of the appointment, to the address the visitor verified, once per appointment and time, at any hour, not to a patient who opted out of email, retried after a temporary failure (three attempts). `appointment_reschedule` was NOT added to the token router: the manage page is the web app (`/book/manage/:token`) and the email already points there. Staff reschedule revokes the manage link, staff cancel keeps it (integration 1 decision); both are pinned by tests now. Tasks 3.43 and 3.45 are done; 3.49 stays open until the C merge passes `waitlistPath` to `SlotPicker`.
4. **Staff UI.** Settings > Turnos online (`features/settings/online-booking`, permission `booking.manage`): see the commit. Found by the end-to-end test: the API refuses types and places on the link of the organization, so that link has none (the component tests had assumed otherwise).
5. **Scheduling.** `mode` in `CalendarEntryDto` (feed and detail); icon and word on the grid and a badge in the list; `today-appointment` slot, the teleconsultation join button beside virtual appointments; `actor_kind = patient` for confirm and cancel by link or WhatsApp reply, and for move and cancel from the manage page.
6. **Email after a WhatsApp opt-out.** It did NOT replace them: the cancelled reminders were simply gone. Fixed in `optOutChannel` (opt-out link, WhatsApp keyword and reception all use it). A patient with no other channel gets nothing and the sweep tells reception.
7. **Token registry guard.** Throws on a duplicate kind; `resetTokenHandlers()` is the explicit reset (called by `createApplication` and by tests).
8. **`VIDEO_LOCAL_BASE_URL`.** Done.

### CI fixes of PR #16

- **Docker smoke.** Notifications made the API hold a queue client and `main` started it at boot, so the image exited with `ECONNREFUSED 127.0.0.1:1`. `createLazyJobs` starts the queue on the first enqueue (a failed start is retried by the next one). Reproduced locally with `docker build -f infra/Dockerfile` and the CI environment: `/health` answers 200. `src/main/boot.test.ts` boots the real entry point with that environment.
- **Lighthouse.** Mobile profile, 3 runs per build on this machine: Stage 2 tip median LCP 2591 ms, Stage 3 tip 2777 ms (the CI failure reproduced), now 2439 ms. Files and bytes the login page loads: 26 files / 292 KB gzip at Stage 2, 40 / 317 KB at the Stage 3 tip, 28 / 258 KB now. Causes: slot pieces imported by `slots.tsx` (video panel, message log, channels panel and the Radix checkbox, switch and alert dialog they use); `errors.ts` and `audit-actions.ts` importing whole module contract files for a list of codes (`<module>-catalog.ts` now); and the signed-in shell and settings frame in the first bundle (lazy now, which also takes the menus and floating UI out of the login page). The budget is unchanged. Waitlist contracts (`waitlist.ts`, still imported by `errors.ts`) were left for track C to avoid a conflict: split `WAITLIST_ERRORS` and `WAITLIST_AUDIT_ACTIONS` into `waitlist-catalog.ts` after the C merge.
- **E2E after D21.** The Stage 3 specs create their professional with a matricula.
- **Backup guard.** `withTransientRetry` (reset, timeout, broken pipe, 5xx; four attempts) around the emptiness check of `restoreBackup`; a refusal, a missing bucket other than the one the restore creates, or a network that keeps failing still stops the restore.

### Merge of the Stage 2 base (`f8db04c`)

Conflicts: `main/application.ts` (the access module now also takes `email` and `origins`; the settings sections stay), `modules/access/index.ts` (both options), and this file (both sections kept). No migration came from Stage 2; `db:restamp` found nothing to change, `db:check` clean. The owner email of D19 was left as the base sends it (not routed through notifications).

### TDD evidence (RED first unless noted)

| Item | Tests | RED | Notes |
| ---- | ----- | --- | ----- |
| 7 | `token-registry.test.ts` (5), two wiring tests | module function missing | |
| 8 | `config-providers.test.ts` (+5), `wiring/teleconsultation.test.ts` | 6 failed | |
| CI 1 | `boot.test.ts`, `lazy-jobs.test.ts` (5) | boot: exited with ECONNREFUSED | |
| CI 4 | `retry.test.ts`, `bucket-guard.test.ts` (6) | modules missing | |
| 1 | `render.test.ts` (+7), `whatsapp.test.ts` (4), `video-join.test.ts` (8), `kinds.test.ts`, `video-join-address.test.ts` | render and kinds: failed first; the integration test `notifications-video.test.ts` (7) was written after the wiring existed | |
| 2 | `render.test.ts` (+5), `quiet-hours.test.ts` (+4), `notifications-offers.test.ts` (19), schema and isolation suites | render: 4 failed; the offers suite was written before `deliverWaitlistOffer` existed (compile failure) | |
| 3 | `notifications-booking-confirmation.test.ts` (9), `reminder-plan.test.ts`, `booking-self-service.test.ts` (+3) | planner test failed first | the staff reschedule and cancel tests pin existing behavior |
| 6 | `notifications-channel-fallback.test.ts` (8) | module missing | |
| 5 | `scheduling.test.ts` (contracts), `scheduling-calendar.test.ts`, `booking-self-service.test.ts` and `notifications-tokens.test.ts` (actor kind), `calendar-events.test.ts`, `CalendarView.test.tsx`, `join-button.test.tsx` (7), `today-page.test.tsx` | actor kind: 3 failed; mode: contracts failed | |
| 4 | `online-booking-settings.test.tsx` (22), `rules-form.test.ts`, `link-address.test.ts`, `stage3-booking-links.spec.ts` | a missing locale cache hid the new feature in the first run | the e2e found the organization link rule |

### Risks and follow-ups

- The WhatsApp `waitlist_offer` and reminder templates gained variables (`offerUrl`, `offerExpires`, `mode`, `joinUrl`); the Meta template approvals (deferred task) must include them.
- A virtual appointment whose link does not exist when the reminder goes out says "the link will be sent separately", and nothing sends it later. Reception can attach a manual link and resend (up to three times). A follow-up message when the room becomes ready is not built.
- `bindOfferDelivery` and the token registry are process-global state; every process that calls `deliverWaitlistOffer` or `optOutChannel` must build `createNotifications` (API) or the notifications worker part first.
- `Referrer-Policy`: the booking links screen opens no public HTML page; nothing changed.
- CI and Lighthouse on CI were not run or polled; Lighthouse was run locally (above).

### Verification

Node v24.22.0, pnpm 10.34.7, Docker running and shared with other agents.

| Command | Result |
|---|---|
| `corepack pnpm install --frozen-lockfile` | exit 0 |
| `corepack pnpm typecheck` / `lint` / `format:check` | exit 0 |
| `corepack pnpm test` | **309 files, 3,921 tests passed** |
| `corepack pnpm test:integration` | **162 files passed, 1 skipped (ClamAV); 2,469 tests passed, 4 skipped** (`backup-restore.test.ts` passed) |
| `corepack pnpm build` | exit 0 |
| `corepack pnpm db:check` | No migration drift (journal now ends with `0390`) |
| `test:e2e` (ports 4600/3600/9600, `--workers=3`) | **182 passed** (181 at integration 1, plus `stage3-booking-links.spec.ts`) |
| Docker image smoke test, as `.github/workflows/ci.yml` runs it | built `infra/Dockerfile`, ran with the CI environment: `/health` answered `{"status":"ok"}` |
| Lighthouse (`lhci collect`, local Chrome, 3 runs) | median LCP 2439 ms against the 2500 ms budget (Stage 2 tip on the same machine: 2591 ms) |

CI was not run or polled. Three containers of earlier end-to-end stacks, with no process left to own them, held port 9600 after a run was interrupted; they were removed before the full run.

## Stage 3 integration 3: track C merged and connected, the video link follow-up, and track E

Branch `feat/stage-3-patient-engagement`, from `6dffe72`. Automatic mode, strict TDD, `size:exception` (work-unit commits). Track C (the waitlist, `feat/stage-3-track-3c`, tip `9666e0e`, migration `0360`) is merged; track E (S3.16 to S3.18) is written on top of it.

### Commits

| Item | Commit | What |
| ---- | ------ | ---- |
| Merge of track C | `e5943ea` | `git merge --no-ff origin/feat/stage-3-track-3c`; five conflicts (see below); `db:restamp` re-chained the `0390` snapshot, `db:check` clean |
| Offers through notifications | `6ece457` | `main/wiring/waitlist.ts` delivers with `deliverWaitlistOffer` and defers with `offerQuietHoursEnd`; the email stand-in is gone; `waitlist-delivery-wiring.test.ts` |
| Video link follow-up | `632281b` | `video_link` message kind, `message.video_pending` (migration `0391`), `queueVideoLinkFollowUp`, registry hook, es-AR templates |
| Stage 3 demo seed | `ef94927` | `db/seed/demo/stage3/` (notifications, online booking, waitlist, teleconsultation, snapshot); exemption files of the seeded tables deleted |
| Public surface security | `5505dbb` | policy test, four files under `test/security/`, `docs/security/public-surface-stage3.md`, `docs/external-dependencies.md`; the statement-count balance of the confirmations |
| Stage 3 e2e | `e0e4b53` | `e2e/stage3-demo.spec.ts` (two tests); the seed leaves out closed days; the waitlist spec follows the offer email and D21 |
| Demo walkthrough | `4c4b290` | `docs/demo.md` |
| Guard | `7e2e065` | the waitlist wiring refuses to deliver in a process without the notifications module |
| Contributors test | `36e6ebd` | the contributors list registers the Stage 3 seed |
| Follow-up fix | `8036b81` | the reminder that promised the link is found by time and patient, not by version (a confirmation bumps the version) |
| e2e isolation | `51dca1c` | the BAJA acknowledgment is looked up by the patient's own number: the WhatsApp simulator is shared by every organization |

### Part A: the merge and the connection

- **Conflicts** (kept both sides): `kinds.ts` (took the 15-day `video_join` of integration 2 and the enabled `waitlist_offer` of track C), `audit-actions.ts` and `errors.ts` (the catalogs of notifications, online booking and teleconsultation moved to `*-catalog.ts` in integration 2, the waitlist's to `waitlist-catalog.ts` in track C), `_journal.json` (entries `0360` then `0390`) and `tasks.md` (3.49 ticked by track C). The files the brief expected to conflict (`kinds.test.ts`, `wiring.test.ts`, `shell.test.tsx`, `index.ts`, `token-page.ts`, `token-router.ts`) merged cleanly. One fixture of the waitlist web tests needed `mode` on `CalendarEntryDto` (a field integration 2 made required).
- **CONNECT AT MERGE**: both lines replaced. `deliver` is `deliverThroughNotifications`, a thin wrapper of `deliverWaitlistOffer` that fails the job when the process never bound the notifications module (otherwise every patient would be flagged unreachable); `quietHoursEnd` is `offerQuietHoursEnd`. Both processes that can reach the code build notifications: the API (`createNotifications` binds) and the worker (the notifications part binds in `jobs()`); the waitlist only delivers from the worker. `createEmailOfferDelivery`, its test and its use in `waitlist-fairness.test.ts` are removed (the channel rules are covered by `notifications-offers.test.ts` and the new test).
- **Integration test** (`test/integration/waitlist-delivery-wiring.test.ts`, 4 tests) drives the wired worker jobs of both modules over a real database: WhatsApp for an opted-in patient, email otherwise, put off in quiet hours and sent at the end of them, and quiet hours that begin after the match do not flag the entry as unreachable (a mutation check, removing the `quietHoursEnd` line, makes that last test fail).
- `waitlist_offer` is enabled in `kinds.ts`; task 3.49 (`waitlistPath` on `SlotPicker`) works end to end: `stage3-waitlist.spec.ts` follows the link from the page that has nothing free through the join and the accepted offer.

### Part B: the link that the reminder promised

A reminder or confirmation of a virtual appointment sent while the link was `pending` says "the link will be sent separately", and nothing sent it. Now:

- `message.video_pending` (migration `0391_video_link_followup`, track 3e) is set when a message is sent with the "link follows" note; the migration also adds `video_link` to the kind and WhatsApp-kind checks and `video_link_unavailable` to the cancel reasons.
- `VideoJoinRegistry` gained `linkReady(tx, appointmentId)` and `onLinkReady(listener)`. Teleconsultation announces from the `video.link.create` job (worker) and from `PUT .../video/manual-link` (API); notifications listens in both processes (`createNotifications` and the worker part) and calls `queueVideoLinkFollowUp`.
- `queueVideoLinkFollowUp` (`modules/notifications/application/video-follow-up.ts`): only for a live, virtual, future appointment that has a sent message with `video_pending` for its present time and patient; the channel is the first the patient allows (WhatsApp with opt-in, otherwise email, never both); `applyQuietHours` puts it off to the end of quiet hours, and when they would swallow the appointment reception gets a `reminder_not_sent` item; idempotent by the group `video_link:<appointment>:<version>` (any channel); not for read-only or demonstration organizations.
- At send time the message resolves the join address again; if there is no link by then (the room was replaced, the call is over) it is cancelled with `video_link_unavailable`. A move or cancellation of the appointment cancels it like any queued message.
- Templates: `video_link` email (subject "El enlace de su videoconsulta en ...", the address as a button) and WhatsApp (`video_link`, with `mode` and `joinUrl`); es-AR labels in `messaging.json`. The Meta template list in `docs/external-dependencies.md` includes it.
- Tests: `notifications-video-followup.test.ts` (14 tests: remembered/not remembered, sent after the room, once, not when the link was carried, not when no reminder went out, not when cancelled, WhatsApp, opt-out in between, quiet hours, manual link, link gone at send time), render/template/contract/registry unit tests, and the step in `stage3-demo.spec.ts`.

### Part C: track E

- **S3.16 seed** (`db/seed/demo/stage3/`): see tasks 3.71 to 3.73. Booking-link slugs are derived from the organization's slug through the product's own slug function (`createLinkService` with fixed bytes), so the demo address survives a reset: `aillu` is `/book/wfg3xazkdesq`, `norte` is `/book/mh4p4sxuiq7j`. The online bookings are written through the scheduling ports wrapped the way the public flow wraps them (one lane, source `online`, nobody as the booker). The waitlist is built through `createEntry` and `matchFreedSlot`, then the open offer is extended to two hours before its time so the demo keeps showing it. `ONLINE_PATIENTS` (2) is exported for the tests that count patients. The seed found one real bug of its own: it chose days that the calendar marks closed (Monday 2026-12-07 is a bridge holiday), which silently built nothing in the waitlist; closed days are skipped now, with a regression test that seeds on a Saturday evening.
- **S3.17 public surface** (`test/policy/public-routes.test.ts`, `test/security/*`, `docs/security/public-surface-stage3.md`): see tasks 3.74 to 3.76. Findings: (1) the confirmations of a booking and of a waitlist join differed by 6 and 7 statements between a new person and an existing patient (and by 3 more when WhatsApp was ticked); `platform/db/even-work.ts` evens them out and the spy test pins the constants; (2) the public forms ignore unknown fields rather than refusing them, which is safe (probed: tenant, status, source, role, patient and appointment ids never take effect) and is documented; (3) the response schemas of the 21 public routes hold no personal field. `auth-guard.ts` now records `routeDeclarations` (rate limit and response schemas per route) for the policy test.
- **S3.18**: `e2e/stage3-demo.spec.ts`; `docs/external-dependencies.md` (tasks 3.80 to 3.83 and what each needs); `docs/demo.md`. 3.78 (the fresh-context review) and the `sdd-init` re-run of 3.79 are left to the orchestrator: an executor cannot launch reviewers.

### Deviations and decisions

- No message previews in the seed (3.71): the log keeps metadata only by design.
- The security tests are four files, not one `public-probes.test.ts`.
- The statement balance uses constants (6 and 3 for booking, 7 and 3 for the waitlist) pinned by a test, not a counter inside the transaction: Drizzle has no hook to count, and a wrapper of the driver in production code would be worse than a constant that fails a test when it drifts. It evens the shape, not the duration (documented as an accepted residual).
- `appointment_reschedule` has no page of the token router (its page is the SPA at `/book/manage/:token`, backed by `/public/t/:token/...`), so the router answers it like an unknown link; probed.

### TDD evidence (RED first)

| Item | Tests | RED |
| ---- | ----- | --- |
| Offers through notifications | `waitlist-delivery-wiring.test.ts` (4) | 3 failed with the stand-in (email only, no log); the quiet-hours test fails without the `quietHoursEnd` line |
| Guard | `wiring/waitlist.test.ts` (+1) | `deliverThroughNotifications` missing |
| Video link follow-up | `notifications-video-followup.test.ts` (14), `render.test.ts` (+4), `whatsapp.test.ts` (+2), `video-join.test.ts` (+3), `notifications.test.ts` (contracts) | 11 of 13 failed before the module; the unit tests failed on the missing kind and template; the version bug (a confirmation made the follow-up disappear) was found by reading and pinned RED first |
| Seed | `demo-stage3.test.ts` (15) | whole file failed before the seed existed; the evening test failed with no offer and no call |
| Non-disclosure | `public-nondisclosure.test.ts` (11) | the statement counts differed by 6 and 9 (booking) and 7 (waitlist) |
| Surface | `public-surface.test.ts` (16), `public-tokens.test.ts` (16), `public-abuse.test.ts` (21), policy (+7) | the abuse and surface tests were written against assumptions the first run corrected (fields are ignored, not refused; the boot document is cacheable; the token router sets `same-origin` on all its pages) |
| e2e | `stage3-demo.spec.ts` (2) | failed at each wrong label until it passed; also caught `stage3-waitlist.spec.ts` broken by D21 and by the new offer email |

### Risks and follow-ups

- 3.78 (judgment-day on public routes, tokens and webhooks) is open. `docs/security/public-surface-stage3.md` is written to be the map for the reviewers.
- The rate-limit counters live in the process; with several API processes the bound multiplies (documented under "Known limits").
- The `video_link` WhatsApp template needs Meta approval like the others (deferred task 3.81).
- The follow-up is not sent for a demonstration organization (nothing is), and the quiet-hours case that swallows the appointment opens a worklist item instead of sending.
- `e2e` leaves testcontainers behind when the runner is killed; Ryuk removed them within seconds on this machine.

### Verification

Node v24.22.0, pnpm 10.34.7, Docker running and shared with other projects. Tip of the verified code: `51dca1c` (the commits after it change documents only).

| Command | Result |
|---|---|
| `corepack pnpm install --frozen-lockfile` | exit 0 |
| `corepack pnpm typecheck` / `lint` / `format:check` | exit 0 |
| `corepack pnpm test` | **320 files, 4,058 tests passed** |
| `corepack pnpm test:integration` | **177 files passed, 1 skipped (ClamAV); 2,740 tests passed, 4 skipped** (`backup-restore.test.ts` passed; one run at a time) |
| `corepack pnpm build` | exit 0 |
| `corepack pnpm db:check` | No migration drift (journal now ends with `0391`) |
| `test:e2e` (ports 4640/3640/9640, `--workers=3`, fresh stack) | **185 passed** (3.4 min). The first full run at `8036b81` had 183 passed and 2 failed: `stage3-booking` hit "No pudimos conectarnos" on the confirmation (an infrastructure blip; it passed alone and in the three-spec re-run) and `stage3-messaging` counted two BAJA acknowledgments, one of them from `stage3-demo` on the shared simulator (fixed by looking up the patient's own number, `51dca1c`) |
| Docker image smoke test, as `.github/workflows/ci.yml` runs it | built `infra/Dockerfile`, ran with the CI environment on port 3040: `/health` answered `{"status":"ok"}`; container and image removed |
| `pnpm demo:stack` | started (Postgres, MinIO, Mailpit, API, worker, two demo organizations, one operator); owner sign-in answered 200; the booking page `/book/wfg3xazkdesq` of `aillu` loaded (200) and its API listed the three professionals with the virtual type; stack and dev server stopped by process id, containers reaped by Ryuk |

CI was not run or polled. A first e2e run, before the new spec existed, found `stage3-waitlist.spec.ts` broken by D21 (the fast path now needs a matricula) and, once that was fixed, by the offer email now being the notifications one (`Lugar:` instead of `Dónde:`, and the organization's name contains "Consulta").

## Stage 3 gate

The gate of S3.18: "the Stage 3 demo runs locally end to end. Verify: the e2e spec plus a fresh review."

| Gate item | Result |
| --------- | ------ |
| `e2e/stage3-demo.spec.ts` passes on a fresh stack | **Yes**, in the full run (185 passed) and alone; the journey takes about 30 s |
| Full verification (install, typecheck, lint, format, unit, integration, build, `db:check`, e2e, image smoke test, `demo:stack`) | **Yes**, see "Stage 3 integration 3", "Verification" |
| Fresh-context review of public routes, tokens and webhooks (3.78) | **Open.** The orchestrator runs `judgment-day` on PR #16; `docs/security/public-surface-stage3.md` maps the surface |
| `docs/external-dependencies.md` updated (3.79) | **Done**; the `sdd-init` re-run is the orchestrator's |
| Deferred adapters 3.80 to 3.83 | Untouched, as designed (nothing waits for them) |

Success criteria of `proposal.md` that Stage 3 can show, and the evidence:

| Criterion | Evidence |
| --------- | -------- |
| The stage goal: a patient books online, receives a reminder by email and WhatsApp and confirms; a waiting patient is offered a freed slot; a virtual appointment gets a join link | `stage3-demo.spec.ts`, steps 1 to 5 (booking, approval, reminder in Mailpit and the simulator, confirmation by link, BAJA then email, the link of a video visit that followed its confirmation, the professional joining, a cancellation offered to the waitlist and accepted) |
| **0** unauthenticated endpoints outside the explicit public allowlist | `test/policy/public-routes.test.ts`: `findUnlistedPublicRoutes` is empty for the whole application, and the 21 routes under `/public/` and `/webhooks/` each declare a protection and a probing test; `test/security/*` probes them |
| Core flows usable at a 360 px width | axe and horizontal-overflow checks at 360 px on every public screen of the journey (booking steps, the pages of the links, the offer, the waitlist join) and at 1280 px on the staff screens |
| Reminders go out for 95% or more of the appointments that have contact data | The planner queues them at booking (`reminder-plan.test.ts`, `reminder-idempotency.test.ts`) and the hourly sweep plans any appointment that has none (`reminder-sweep.test.ts`); the journey shows them arriving on both channels. A rate over a population is not measurable until there is a real one |
| The demo tenant resets in under a minute with data in every module | `demo-coverage.test.ts`: the reset took 4.7 s with the Stage 3 data, and no tenant table is empty without a reason |
| Cross-tenant tests cover every data path | The generated isolation suite covers the new tables (`message.video_pending` is a column of an existing one); `test/tenancy` passes in the integration run |
| A single-tenant deployment runs from the same build | Unchanged; the image smoke test uses the multi-tenant configuration and `/health` answers |

Not claimed here: the Stage 1 and 2 criteria (10-minute first booking, 30-second reception booking, PWA and 4G load, clinical audit, legacy removal) were verified at their own gates, and the e2e suite that guards them passed.


## Judgment Day Stage 3, round 1

Two judges reviewed `7b6df20` (diff `f8db04c..7b6df20`) and found no critical issue. This section records the fixes of round 1 on branch `feat/stage-3-patient-engagement`: the 15 confirmed findings (C1 to C15), the two orchestrator decisions (D22, D23), the suspects and the CI failure. Every fix has a commit that names its finding ("JD-S3 <id>") and a test that failed before it (the exceptions are said below). Migrations used: `0392` to `0397` (the range `3e` has `0398` and `0399` left).

### Confirmed findings

| Id | Fix | Test |
| -- | --- | ---- |
| C1 | A WhatsApp reply is attributed to ONE organization: the one of the message it quotes (when that message went to the same number), else the ones that wrote within seven days. With several candidates "1" and "2" go to reception in each, and BAJA acts only in them, naming each organization in the acknowledgment (the idempotency key now includes the organization, or the second acknowledgment collapsed into the first). A "2" now honours the cancel deadline of the organization: past it the patient is told to contact the organization (`cancel_closed`) and reception gets an item. | `whatsapp-attribution.test.ts` |
| C2 | The pre-code check of future appointments is gone; the limits count the verified address after the code, under the lock of the professional. A deactivated record, a document at its cap and a link at its limit are answered like any booking (the appointment stands on a record of its own, without the document, with an identity review that says why: `inactive_patient`, `document_limit`, `link_limit`). The confirmation always goes to the verified address. Statement counts are kept equal across paths (`REVIEW_ITEM_STATEMENTS`). | `confirm-booking.test.ts`, `booking-submission.test.ts`, `public-nondisclosure.test.ts`, `notifications-booking-confirmation.test.ts` |
| C3 | A self-join with the document of a patient on file no longer records an offers agreement; the entry is manual contact only (`no_offers_opt_in`). | `waitlist-join.test.ts` |
| C4 | A correction that puts a cancelled, no-show or attended virtual appointment back among the appointments to come reopens its session with a new room (a manual link can be attached again). | `video-attendance.test.ts` |
| C5 | The move by link compares the local days of the place, takes the lock of the professional before reading the cap, and subtracts the appointment only when it is an online one. | `booking-manage-zone.test.ts` |
| C6 | The confirmation takes the lock of the professional before counting the day and the contact. | `confirm-booking.test.ts` (two at once) |
| C7 | A place in the monthly WhatsApp quota is reserved at prepare time under an advisory lock per professional and month, confirmed when the provider accepts, released when it does not carry the message; the month is the one of the time zone of the organization (migration `0396`: `confirmed_at`, `released_at`, with a column grant, since the table stays immutable otherwise). | `usage-metering.test.ts`, `usage.test.ts` |
| C8 | `prepareDelivery` checks quiet hours again for reminders, offers and video follow-ups (not for confirmations or manual resends): the message waits for the end of quiet hours when that comes before the appointment (or the expiry of the offer), and otherwise ends with `no_channel` plus a reception item (or `offer_expired`). | `notifications-quiet-send.test.ts`, `notifications-offers.test.ts` |
| C9 | `video_session.manual_link` and `message_offer.url` are field-encrypted with the key of the organization (`manual_link_enc`, `url_enc`, migrations `0394` and `0395`); rows written before are read as they are and replaced. The simulator's `local_whatsapp_message` is documented as development and demonstration only. | `video-manual-link-encryption.test.ts`, `notifications-offers.test.ts` |
| C10 | The two permissive lookup policies on `message` are replaced by three hardened `SECURITY DEFINER` functions that return tenant ids only (migration `0392`, allowlisted in `definer-functions.test.ts`). | `whatsapp-attribution.test.ts`, `definer-functions.test.ts` |
| C11 | `address_hash` is an HMAC-SHA256 keyed with `ADDRESS_HASH_PEPPER` (required in production, a public default elsewhere, prefix `h2:`); the hourly sweep rewrites old hashes when the patient still has that address and drops the ones that cannot be recognized. | `delivery-rules.test.ts`, `reminder-sweep.test.ts`, `config-providers.test.ts` |
| C12 | The local bot challenge is signed for the address that asked for the puzzle (`issue(ip)`), prunes by expiry, refuses new proofs when its memory is full instead of dropping live ones, and documents its per-process limits. | `bot-challenge-local/index.test.ts` |
| C13 | Numbers of any country are understood (`normalizeInboundNumber`); PARAR and NO MAS opt out too (B30). | `phone.test.ts`, `keywords.test.ts`, `whatsapp-attribution.test.ts` |
| C14 | Migration `0393` states the three CHECK constraints of `message` as NOT VALID and validates them in separate statements, proven on a populated table. | `migration-message-checks.test.ts` |
| C15 | `GET /public/v/:token` only looks (notice plus a button); the POST of the button, from the same origin, spends the use, records the opening and forwards. | `video-join-public.test.ts` and the e2e specs |

### Orchestrator decisions

- **D22.** A WhatsApp choice on a public form is a request. The booking asks the notifications module for a `whatsapp_opt_in` token (`requestWhatsAppOptIn`), the confirmation email carries the link to the verified address, and no preference is written until the patient follows it. The waitlist join does the same through `WhatsappOptInPort` (its own email after the answer; before this the waitlist wiring did not record the choice at all). Only for a patient the form registered.
- **D23.** The limits count the verified address and run after the lock (C2, C6). `booking_link.max_unconfirmed_appointments` (default 20, 0 to 500, migration `0397`) is editable through `PATCH /booking-links/:id` and in the edit dialog of the link.
- Both are written in `proposal.md` ("orchestrator decision in automatic mode, pending owner confirmation") with a requirement and scenarios in the specs of online-booking, notifications and waitlist.

### The CI failure

`waitlist-offer-link.test.ts`, "produces exactly one appointment when reception and the patient take the slot at once", failed with "offer undefined was not delivered". **Root cause, a test that carried state between rounds**: when reception wins a round, the entry of that round stays active (its offer is invalidated, the entry waits again). In the next round that older entry takes the freed slot by fairness, so the new entry the test looks at has no offer. Which side wins is a race, so it failed only on some runs. Reproduced deterministically (reception books first, then a second round) and fixed with `world.reset()` at the start of each round. The hint about quiet hours was checked and is **not** the cause: the waitlist module reads only its injected clock and the world pins it to 09:00 local, so the wall clock cannot reach the test (the failure also reproduces with the pinned clock). The delivery of an offer after quiet hours began is now covered anyway (`notifications-offers.test.ts`), and no test of the suite depends on the wall clock near quiet hours (the whole suite ran at night, inside quiet hours, with the same results).

### Suspects

| Id | Result |
| -- | ------ |
| A3-rest | Covered by D23 and C2 (tests of the link limit and the document cap). |
| A6 | Reproduced; fixed: `booking.suspicious` is written with a null address and browser, once per link and reason in ten minutes (the metric still counts every one). |
| A7 | Reproduced; fixed: the WhatsApp opt-in request is refused with `channel_opted_out` for a patient who opted out of email. Not done: logging the refusal as a message (message kinds are a closed set) and a dedicated audit action. |
| A8 | Reproduced; fixed: an online booking cancelled within 30 minutes of being made starts no match, and a slot gets at most five offers. |
| A10 | Reproduced; fixed: the manage DTO returns `null` for the professional and the type when the organization uses neutral wording (the page hides the row). |
| A-sugg | Reproduced; fixed: approving an online booking queues a confirmation whatever the lead times. |
| B3 | Reproduced; fixed: `bindOptOutListener` runs `closeEntriesOfOptedOutPatient` in the transaction of any recorded opt-out. |
| B5 | Fixed with C2: the reason travels encrypted in the review and approval items. |
| B6 | Reproduced; fixed: the hold is extended to the expiry of the code under the lock of the professional. |
| B9 | Fixed: the sweep reads every page of the horizon, keyset by `(starts_at, id)`, up to 20 pages. |
| B11 | Done: administrative exports of the history of choices, the message log (metadata), the usage, the waitlist entries and offers, the video sessions (a flag for the manual link, never the link) and the new link limit. |
| B12 | Reproduced; fixed: location and calendar scope on the waitlist list, detail, changes, creation and the to-call panel. |
| B13 | Not applied (tried, then reverted): the development demo stack and its end-to-end suite read the demo organization's confirmation from the local mail catcher by design, and in production the sender of a demo organization is already the fake, so no real address is reached. |
| B14 | Covered by D22. |
| B16 | Fixed: the fake email and WhatsApp senders keep the latest 1000. |
| B20 | Reproduced; fixed: `createOffer` locks the entry and returns null unless it is active. |
| B23 | Reproduced; fixed: `auth: 'public'` routes count in `tenant-public|<id>`. |
| B26 | Reproduced; fixed: the confirm and cancel links spend their use after the change, which runs in a savepoint. |
| B28 | Reproduced; fixed: a match with no professional takes the lock of every active professional, in order. |
| B30 | Fixed with C13. |
| B31 | Reproduced; fixed: the manual link is validated again when the patient or the professional follows it. |
| B32 | Fixed: `tokens.purge` deletes tokens a week after they expired, daily per organization. |

### Follow-ups (INFO, not fixed)

- Public hold and reschedule start times are not aligned to the grid of the professional.
- An orphaned confirmation row is cancelled with the wrong reason (`tenant_read_only`).
- The journal applies 0370 before 0360 (harmless).
- `local_whatsapp_*` has no tenant column and no row level security: it is the development simulator; documented in the schema and in `docs/dev-setup.md`.
- The refusal of A7 is not logged as a message or as an audit action of its own.
- The cap of five offers per slot leaves no item for reception when it is reached.
- Production now REQUIRES `ADDRESS_HASH_PEPPER` (32 characters or more): deployments must set it before this branch is released. Rotating it forgets which addresses failed and which numbers were written to.

### Verification

Run in the worktree after the last code change:

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm db:check` (migrations 0392 to 0397): all clean.
- `pnpm test` (unit): green.
- `pnpm --filter @consultorio/api test:integration`: 184 files passed (1 skipped), 2805 tests passed (4 skipped).
- `pnpm build`: green.
- `playwright test --workers=3` (ports 4680, 3680, 9680): 185 passed.
- Docker image: built from `infra/Dockerfile` and `GET /health` answered `{"status":"ok"}` with the production configuration including `ADDRESS_HASH_PEPPER`.

Notes:

- CI failure of the waitlist race test: the quiet-hours and wall-clock hint was checked and was not the cause. The `waitlist.offer` job failed with `KeyManagementError` in the end-to-end stack because the API and the job worker were given two different random KEKs; the stack now shares one. Separately, the demo spec had to follow three behaviours of this round: the WhatsApp opt-in link (D22), the 30-minute rule of A8 (the freed time now comes from an appointment that stood), and the new BAJA acknowledgement text.
- A round-1 integration run once failed 4 unit tests that did not repeat; integration runs were starved by containers of other agents and by a Docker outage, and were re-run in full afterwards.
- Incident: a `git stash pop` took another agent's lint-staged backup; recovered by saving the patch, resetting, reapplying it and dropping only the stash created here. No stash is used any more.

## Judgment Day Stage 3, round 2

Two judges reviewed `ac8751b`. This section records the fixes of round 2 on branch `feat/stage-3-patient-engagement`: the 8 confirmed findings (R2-C1 to R2-C8), the 11 suspects, and the INFO items. Every commit names its finding ("JD-S3 R2-<id>"). Strict TDD: each fix has a test that failed before it. Where a test could not fail first it is said below. One migration was used: `0398` (the range `3e` has `0399` left). No applied migration was edited.

### Confirmed findings

| Id | Fix | Test |
| -- | --- | ---- |
| R2-C1 | Drizzle runs all pending migrations in one transaction, so `VALIDATE CONSTRAINT` inside `0393` kept the ACCESS EXCLUSIVE lock of the `ADD CONSTRAINT`. `0393` is applied and is not edited. `runMigrations` (and so `db:migrate`) now validates every constraint a migration left `NOT VALID`, one statement at a time, outside the migrator's transaction (`validateDeferredConstraints`), and `docs/migration-ranges.md` says that a migration on a large table states the constraint `NOT VALID` and leaves the validation to the runner. The old test no longer claims that `0393` keeps writers going (it hid the problem by wrapping its own `BEGIN`/`COMMIT`). `0393` itself keeps the cost; it is harmless where `message` is still small. | `migrate-validation.test.ts` runs the real runner against a throwaway database with a check that sleeps while it is validated, and shows a writer inserting during the validation |
| R2-C2 | The bulk cancels (appointment cancelled or changed, opt-out, stale sweep) and the provider's failure report (`failAcceptedMessage`) now release the place of the quota. Besides, `usageCount` takes only places that are confirmed or reserved for a message that is still queued, so no path, present or future, can leak one. Migration `0398` confirms the places written before `0396` (`confirmed_at = counted_at` for messages the provider took) and releases the ones that leaked (cancelled or failed messages). | `usage-metering.test.ts` (one test per path), `migration-usage-backfill.test.ts` |
| R2-C3 | A real browser showed two defects. (1) The CSP `form-action 'self'` of the `ready` page is applied by Chromium to the 302 that follows the post: removed from the `ready` policy (the other pages keep `form-action 'none'`). (2) Not in the report: the route had no parser for `application/x-www-form-urlencoded`, which is what a browser posts, so the button answered **415** and never worked; only API clients (no content type) had been tested. The route now accepts that content type and reads nothing of the body. The `.invalid` provider address never resolves, and Playwright's `route` does not intercept the redirect target, so the test waits for the `requestfailed` event of the provider origin and requires `ERR_NAME_NOT_RESOLVED` (the browser got past the page's policy); a redirect refused by the policy fails as a blocked request or never fails. | `stage3-teleconsult.spec.ts` "the button of the join page takes a real browser to the call" (it failed with the old policy and, before the parser, with the 415), `video-join-public.test.ts` (posts as a browser does), `join-page.test.ts` |
| R2-C4 | The address rehash goes newest first, 1000 rows per run. The webhook (`attribute`) and `processInbound` also look for the unsalted hash until the log is done, so a BAJA from a patient whose last message predates the deploy finds its organization. | `whatsapp-attribution.test.ts` (3 tests), `reminder-sweep.test.ts` |
| R2-C5 | A detached booking reuses the document-less online record that the same verified address, name and birth date already have (`findOnlineRecordOfItsOwn`, looked up on every path so the work behind the answer is the same), and detached bookings count toward the link's unconfirmed limit. The per-address bounds already counted them (they count verified submissions). The visible answer is unchanged. | `confirm-booking.test.ts`, `public-nondisclosure.test.ts` (same amount of work) |
| R2-C6 | The scope is part of the list query (locations and calendars, `calendarProfessionalIds`, which agrees with `calendarAccess`), and an edit is checked on the merged professional and place. | `waitlist-entries.test.ts`, `calendar-scope.test.ts` |
| R2-C7 | The hourly sweep seals the plaintext offer links (`sealLegacyOfferUrls`) and, through a `housekeeping` hook that the composition root plugs in (the modules do not import each other), the manual video links (`sealLegacyManualLinks`). A closed session has its link dropped outright; expired offer links were already cleared. A one-off migration was not possible: sealing needs the key of each organization. | `video-manual-link-encryption.test.ts`, `notifications-offers.test.ts`, `reminder-sweep.test.ts` |
| R2-C8 | The proof of the local bot challenge is bound to `clientKeyOf(ip)` (an IPv6 /64, an IPv4 address): the key the rate limiter uses. | `bot-challenge-local/index.test.ts` |

### Suspects

| Id | Result |
| -- | ------ |
| A1 | **Reproduced, and it was a real oracle.** The confirmation email of a booking carried the link to accept WhatsApp only for a patient the form created. Now every submission that ticks WhatsApp gets a link, in booking (new, on file, a record that cannot take it) and waitlist (new, on file, inactive, entry refused as a duplicate); the emails are identical in text and html once the tokens and the date are masked. The token belongs to the **submission** and remembers `patientId` and whether the submission created them. Following it opts in only then; in any other case the page is the same and reception gets an `identity_review` of the appointment. `evenOut` for the WhatsApp branch is gone: every path does the same work. | `public-nondisclosure.test.ts` (booking and waitlist), `notifications-booking-confirmation.test.ts`, `booking-optin.test.ts`, `waitlist-join.test.ts` |
| A5 | Reproduced (a retried message holding the last place went to email); fixed: `whatsappQuotaAvailable` excludes the message's own place. | `usage-metering.test.ts` |
| A6 | Reproduced; fixed for the case the finding names: when nobody wrote in the last 7 days a BAJA reaches every organization that ever wrote (up to the cap), not only the last. The window case is unchanged (an organization that has not written for weeks is left alone, as its existing test says). | `whatsapp-attribution.test.ts` |
| A7 | Reproduced (a listener that fails poisons the transaction and rolled the opt-out back); fixed: the listener runs in a savepoint, its failure is reported (`onFailure`, by default one JSON error line on stderr) and the opt-out stands. | `notifications-optout-listener.test.ts` |
| A12 | Not an independent bug but a consequence of R2-C2: with the new count, rows from before `0396` (`confirmed_at` null) would stop counting. Migration `0398` backfills `confirmed_at = counted_at` (messages the provider took). The test of the migration fails without it. | `migration-usage-backfill.test.ts` |
| A15 | The seed and reset scripts never configured the pepper, so with `ADDRESS_HASH_PEPPER` set they hashed with the development default. Both call `useServerAddressPepper(config)` now; documented in `docs/dev-setup.md`. The scripts themselves are not run by a test: the unit test pins the helper. | `seed/demo/pepper.test.ts` |
| B5 | Reproduced with two transactions (a deadlock, `40P01`); fixed: `lockProfessional` is `FOR NO KEY UPDATE` (bookings still serialize, a row that only references the professional is let through) and `prepareDelivery` runs again, up to three times, if it is the victim of a deadlock. | `lock-ordering.test.ts` |
| B7 | Decision applied: entries close only when no channel is left for offers (`closeEntriesOfUnreachablePatient`, `reachOf`). The waitlist spec is aligned (requirement text, the "Opt-out leaves the list" scenario, a new one for one channel, and "Patient stops waitlist messages"). | `waitlist-fairness.test.ts` |
| B8 | Reproduced; fixed: among several candidates only the one that wrote last (`primary`) keeps the text of a reply; the others get the item with `reason: several_organizations` and no text. | `whatsapp-attribution.test.ts` |
| B10 | Reproduced; fixed: a BAJA from WhatsApp revokes the pending `whatsapp_opt_in` links of the patient (`revokeForSubject` for the ones staff sent, the new `revokeForPayload` for the ones of a submission). | `notifications-booking-confirmation.test.ts` |
| B11 | Reproduced (cancelled `no_channel`, no item); fixed: `video_link` is one of the kinds that open a `reminder_not_sent` or `reminder_not_delivered` item. | `notifications-video-followup.test.ts` |

### Follow-ups (INFO, recorded)

- `keepHoldUntil` is extended once per new code, and that is bounded by the per-address limits of the public flow.
- The header comment of `0392` says two functions and the migration defines three. It is not edited (applied); a corrective comment belongs to a later migration (`0399` is the last number of the range `3e`).
- D22 verifies the owner of the email, not of the phone number. Declared in the notifications spec ("WhatsApp opt-in from a public form").
- `0393` still validates inside the migrator's transaction; the new runner step covers the next migrations, not that one.
- `recipients.ts` (the "failed for good" check) still compares only the keyed hash; until the rehash finishes an old failure is not recognized for an address. It does not affect opt-outs.

### Verification

Run in the worktree after the last code change (ports 4780, 3780, 9780):

- `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm db:check`: clean.
- `pnpm test` (unit): 321 files, 4101 tests passed.
- `pnpm test:integration`: 188 files passed (1 skipped), 2841 tests passed (4 skipped).
- `pnpm build`: green.
- `playwright test --workers=3`: 186 passed (3.6 min; the new test of the join button is one of them).
- Docker image: built from `infra/Dockerfile` and `GET /health` answered `{"status":"ok"}` with a production configuration that includes `ADDRESS_HASH_PEPPER`.
- Not run here: the Lighthouse budget (CI) and the browser pass over `lighthouserc.json`; no web page changed in this round (only an e2e spec). `boot.test.ts` is part of the unit run above.
- Incident: none. The containers this agent started (e2e stack, test databases, the smoke container and image) were removed by name.

## Judgment Day Stage 3, round 4

Two judges reviewed `53e7dfd` (round 3). This section records the fixes of round 4 (the final round) on branch `feat/stage-3-patient-engagement`: W1 to W3 and T1 to T3, plus the two CI e2e failures of PR #16 (CI1, CI2). Every commit names its finding ("JD-S3 R4-<id>"). Strict TDD: each fix has a test that failed before it (the failing run is the one before the fix was written). One migration was used: `0399`, the last number of the range `3e`, which is now full. No applied migration was edited.

### Findings

| Id | Fix | Test |
| -- | --- | ---- |
| W1 | The hourly sweep ran the sealers (`sealLegacyOfferUrls` and every `housekeeping` hook) before the reminders, in the same transaction and without isolation, so a failing sealer rolled back the whole sweep. Now `sweepAppointments` runs first and each cleanup runs after it in a savepoint of its own (`tx.transaction`). A failure is reported the way the opt-out listener reports one (`onFailure`, by default one JSON error line on stderr) and only that cleanup's work is undone. | `reminder-sweep.test.ts` "plans the reminders even when a step throws": the first hook throws, the reminder is planned, the failure is reported once and the next hook still runs |
| W2 | `0398` lifts FORCE row level security on `message` and `whatsapp_usage_event` inside the migrator's single transaction, so its `ACCESS EXCLUSIVE` locks are held until the whole run ends. `0398` is applied and is not edited (it stays). The same backfill is now `backfillUsageConfirmation` in `apps/api/src/db/migrate.ts`, a step of `runMigrations` after `migrate()` and next to `validateDeferredConstraints`: idempotent, run on every boot, a batch of 500 rows per transaction, under the tenant context of each organization (`listTenantIds`, `set_config('app.tenant_id')`) as the owner, so the ordinary `tenant_isolation` policy applies and FORCE is never touched. Batches select `FOR UPDATE SKIP LOCKED`: the step never waits for a writer nor makes one wait, and a skipped row is done by the next boot. A database without the tables (the tests of the runner with their own folder) is skipped. `docs/migration-ranges.md` documents the hazard and the runner-step approach. `0398` cannot be made a no-op for databases that have not applied it without editing it. | `migrate-usage-backfill.test.ts`: confirms/releases/leaves live reservations, runs twice with the second run changing nothing, works through several batches (`batchSize: 1`), leaves FORCE on, and finishes while a writer holds the row lock of a qualifying row (that row is done by the next run) |
| W3 | `recordWhatsappUsage` now sets `confirmed_at = now` AND `released_at = NULL` when the provider accepts: an acceptance is billable whatever the local status. | `usage-metering.test.ts` "counts a message the provider accepted even after its place was released": prepare, opt-out cancels and releases, then the provider accepts: it counts |
| T1 | The webhook asked `whatsapp_reply_tenants` once per hash and merged the answers, so "the organization that wrote last first" was lost when the keyed and the unsalted hash were both in the log (and the cap was applied before the sort). New `SECURITY DEFINER` function `app.whatsapp_reply_tenants_any(text[], timestamptz, integer)` (migration `0399`): takes every hash at once, orders by the latest write under any of them and then applies the limit. Hardened like the others (pinned search path, `REVOKE ALL ... FROM PUBLIC`, `GRANT EXECUTE ... TO app_rw`) and on the allowlist of `definer-functions.test.ts`. | `whatsapp-attribution.test.ts` "puts the organization that wrote last first even when its messages still hold the old hash" (a mixed log: one organization keyed, the other unsalted and more recent) |
| T2 | `outstanding` (the appointment a "1" or "2" is about) now looks at the keyed hash only. A row the rehash has not reached has not been checked against the patient's number, so it can no longer confirm or cancel an appointment. Attribution and `written` still look for both hashes, so the reply reaches the organization and goes to reception as `needs_review`, and a BAJA still opts out. | `whatsapp-attribution.test.ts` "does not confirm or cancel on a row that still holds the old hash" (for "1" and "2") and "still opts the patient out through the old hash" |
| T3 | The `application/x-www-form-urlencoded` parser of the join button was registered on the whole teleconsultation scope, so it also let a form through to the staff video routes (which answered 400 instead of 415). The public join routes are now registered in a scope of their own (`app.register`), and the parser applies to them only. | `video-join-public.test.ts` (a staff route still answers 415 to a form; the public button still works), `stage3-teleconsult.spec.ts` (the real-browser join button, green) |
| CI1 | `e2e/pwa.spec.ts` "signing out leaves nothing": after "Cerrar sesión" the URL was `/login?redirect=%2Flogin&reason=expired`. `UserMenu.signOut` calls `clearSession()` and navigates; a request still in flight then gets a 401 and `onUnauthorized` ended a session that was already gone. `onUnauthorized` now acts only when the session query holds a session (read before it is set to null), and the router's handler does nothing when the person is already at `/login`. | `services.test.ts` (a 401 after `clearSession()` does not call the handler; a second 401 does not either; a mid-session 401 still does), `session-ended.test.ts` (the router goes to sign-in from `/patients`, and does nothing at `/login`) |
| CI2 | `e2e/stage3-messaging.spec.ts` (flaky): axe reported `color-contrast` on the title of a toast. The colors are not the cause: Sonner fades the CONTENT of a toast (`[data-sonner-toast] > *` has `transition: opacity .4s`, and a toast pushed behind a newer one fades its content out), so the opacity of the toast itself, which `settle()` waited on, says nothing about the text inside. The five specs that carried a copy of `settle` now call `settleToasts` (in `e2e/support/stack.ts`): every toast must be `data-mounted="true"` and none of the animations of its subtree may be running. The rule is still on. | the specs themselves (`pwa`, `stage3-messaging` and `stage3-teleconsult` run on the local stack) |

Optional items done: the misleading comment in `legacy-links.ts` (a closed session drops its sealed form too); a test that two callers of `lockProfessional` serialize (`lock-ordering.test.ts`). Not done: S2 (not reopening an `identity_review` that is already resolved): the worklist port only knows open items, so it needs a new port method and is not trivial.

### Verification

Run in the worktree after the last code change (ports 4840, 3840, 9840):

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm db:check`: clean (`0399` is the only new migration, no drift).
- `pnpm test` (unit): 322 files, 4105 tests passed.
- `pnpm test:integration`: 189 files passed (1 skipped), 2852 tests passed (4 skipped).
- `pnpm build`: green.
- `playwright test e2e/pwa.spec.ts e2e/stage3-messaging.spec.ts e2e/stage3-teleconsult.spec.ts --workers=2 --project=desktop`: 14 passed (the signing-out spec of `pwa`, the messaging journey with axe at 360 px and the real-browser join button are among them). The whole e2e suite was not rerun: only the toast wait of five specs and the sign-out redirect changed.
- Docker image built from `infra/Dockerfile`; the database was migrated twice with `db:migrate` (the second run exercises the idempotent backfill step), and `GET /health` answered `{"status":"ok"}` with a production configuration that includes `ADDRESS_HASH_PEPPER` and `CLAMAV_HOST` (KMS `aws`, `S3_BUCKET`, SMTP with starttls).
- Incident: a first launch of the e2e run and a second one overlapped and collided on the MinIO port; the second failed at start, the first ran normally, and the test containers were removed by the testcontainers reaper. The smoke containers (`s3fix-r4-api`, `s3fix-r4-pg`) and the image were removed by name.
