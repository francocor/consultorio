# Apply progress: health-practice-saas

Mode: Standard (strict TDD off during Stage 0; `strict_tdd` turns on from Stage 1, see `openspec/config.yaml`). Artifact store: openspec. Delivery: chained PRs, `stacked-to-main`, local branches only (nothing pushed, no PRs opened).

## Cumulative status

Stage 0: tasks 0.2 to 0.34 done. Task 0.1 (rotate secrets in `BackEnd/.env`) is a manual owner action and is NOT done. Docker-dependent verification has been run and passes. Only push-dependent and owner steps remain PENDING (see "Pending verification").

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
