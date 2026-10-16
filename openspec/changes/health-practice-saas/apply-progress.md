# Apply progress: health-practice-saas

Mode: Standard for Stage 0; **Strict TDD from Stage 1** (`strict_tdd: true` in `openspec/config.yaml`). Artifact store: openspec. Delivery for Stage 0: chained PRs, `stacked-to-main` (merged). Delivery for Stage 1 (overnight run, owner decision "speed and automation"): ONE stage branch `feat/stage-1-secure-core` with work-unit commits per slice, one draft PR to `main` with `size:exception`, merged at the end of the stage.

## Cumulative status

Stage 0: tasks 0.2 to 0.34 done and merged. Task 0.1 (rotate secrets) is a manual owner action and is NOT done.

Stage 1: slices S1.00 to S1.26 done (tasks 1.1 to 1.95, 95 of the 130 tasks of Stage 1). Next: S1.27 (web foundation). See "Batch 3: Stage 1, slices S1.00 to S1.08", "Batch 4: Stage 1, slices S1.09 to S1.17" and "Batch 5: Stage 1, slices S1.18 to S1.26" at the end of this file.

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
