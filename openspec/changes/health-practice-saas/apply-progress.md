# Apply progress: health-practice-saas

Mode: Standard for Stage 0; **Strict TDD from Stage 1** (`strict_tdd: true` in `openspec/config.yaml`). Artifact store: openspec. Delivery for Stage 0: chained PRs, `stacked-to-main` (merged). Delivery for Stage 1 (overnight run, owner decision "speed and automation"): ONE stage branch `feat/stage-1-secure-core` with work-unit commits per slice, one draft PR to `main` with `size:exception`, merged at the end of the stage.

## Cumulative status

Stage 0: tasks 0.2 to 0.34 done and merged. Task 0.1 (rotate secrets) is a manual owner action and is NOT done.

Stage 1: slices S1.00 to S1.08 done (tasks 1.1 to 1.34, 34 of 34). Next: S1.09 (identity schema and password policy). See "Batch 3: Stage 1, slices S1.00 to S1.08" at the end of this file.

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

### Remaining

Slices S1.09 to S1.37 (tasks 1.35 onward). Next: **S1.09 Identity schema and password policy** (tasks 1.35 to 1.37 in `tasks.md`).
