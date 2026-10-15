# Apply progress: health-practice-saas

Mode: Standard (strict TDD off during Stage 0; `strict_tdd` turns on from Stage 1, see `openspec/config.yaml`). Artifact store: openspec. Delivery: chained PRs, `stacked-to-main`, local branches only (nothing pushed, no PRs opened).

## Cumulative status

Stage 0: tasks 0.2 to 0.34 done. Task 0.1 (rotate secrets in `BackEnd/.env`) is a manual owner action and is NOT done. Several verification steps are PENDING because they need Docker or a push (see "Pending verification").

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

| Slice | Branch (stacked on previous) | Commits | Tasks | Hand-written lines (lockfile and snapshots excluded) |
|---|---|---|---|---|
| S0.06 Test tooling (+ audit fixes 1 to 5) | `feat/s0-06-test-tooling` (from `feat/s0-05-web-skeleton`) | `c07d6fd7` build pnpm 10; `90f529e1` fix api logs/readiness; `255e23b5` feat api problem+json; `9fadc84a` build lint rules; `93675336` test Vitest workspace; `4408b6d8` test Playwright; `65549a73` test vitest-axe; `99753610` docs tasks | 0.16, 0.17, 0.18 | about 667 (over budget, see risks) |
| S0.07 Database foundation | `feat/s0-07-database-foundation` | `7946997a` Drizzle foundation; `8cbf9266` withTenant; `50ef2e55` RLS catalog; `c4034725` drift check; `28a23a3f` docs tasks | 0.19, 0.20, 0.21, 0.22 | about 730 (over budget, see risks) |
| S0.08 Local environment and image (+ audit fix 6) | `feat/s0-08-local-env-and-image` | `f35c5aec` esbuild bundle; `99317ac9` Dockerfile; `abe5c3c3` compose; `1906f38b` .env.example; `8bbd9407` dev-setup; `021785d3` docs tasks | 0.23, 0.24, 0.25, 0.26 | about 383 |
| S0.09 CI and secret scanning | `feat/s0-09-ci-and-secret-scanning` | `22f6dbfb` ci; `b7ebaaf0` gitleaks + lefthook; `a34562a8` renovate; `2a4d01ca` docs tasks | 0.27, 0.28, 0.29 | about 182 |
| S0.10 Legacy marker, docs, tooling refresh | `docs/s0-10-readme-legacy-markers` | `2ee8225e` README + external deps; `69643e40` LEGACY markers; `d0ea6eb3` ignore agent skills; `33693bb5` config refresh; plus the docs commit that adds this file | 0.30, 0.31, 0.32, 0.33, 0.34 | about 94 |

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

### Pending verification (could not run here)

1. `pnpm test:integration` (roles, `withTenant`, RLS catalog): needs the Docker daemon for Testcontainers. Fails here with "Could not find a working container runtime strategy". Run it once Docker Desktop is up.
2. `docker build -f infra/Dockerfile -t consultorio-api .` and `docker run ... api` answering `/health`; `docker compose -f infra/docker-compose.yml up -d` reaching healthy (images `minio/minio`, `minio/mc`, `axllent/mailpit` use `:latest`; healthcheck commands are the documented ones but untested).
3. CI green on a PR and the gitleaks job on a throwaway branch: needs a push.
4. Branch protection on `master` and the Renovate app: owner actions.
5. Clean-clone walkthrough of `docs/dev-setup.md` (task 0.26): owner, PR checklist.
6. Task 0.1: rotate the secrets (owner).

### Batch 2 deviations from design and tasks

1. Root `vitest.workspace.ts` (task 0.16) is replaced by `test.projects` in the root `vitest.config.ts`: Vitest 5 no longer uses workspace files. Root `pnpm test` is `vitest run`.
2. The drift check lives in `apps/api/scripts/check-migration-drift.ts` (not root `scripts/`) because it needs the api's `drizzle-kit`. Root `pnpm db:check` delegates to it.
3. Role creation is not inside migration 0000. Roles are cluster-level and need privileges the migration owner lacks, so `infra/postgres/init/01-roles.sql` creates them (compose init and the Testcontainers setup both run it) and migration 0000 verifies and grants. The file's dev passwords are local only.
4. `createWithTenant(db)` returns `withTenant(ctx, fn)` instead of a module-level `db`, so tests can use their own pool. Same behavior as the design.
5. ClamAV is behind the compose profile `scan` so the default `up -d` stays light (about 1 GB RAM and slow first start).
6. `@consultorio/contracts` is a devDependency of `@consultorio/api` (bundled into `dist/main.js`), so `pnpm deploy --prod` ships only third-party runtime dependencies. The API build is an esbuild script rather than tsup.
7. `minimumReleaseAge: 1440` (one day) was added to `pnpm-workspace.yaml` as a supply-chain guard; the design does not mandate it. It rejected a vitest release published 8 hours earlier, so the api pin is `^5.0.4`/`^5.0.0` style ranges.
8. `strict_tdd: true` and `apply.tdd: true` are set in `openspec/config.yaml` for Stage 1 onward (task 0.33 recommendation: test-first for domain and security code). The orchestrator may revert this if the owner prefers standard mode.
9. AutoSkills was run (as allowed): it installed 14 skills (typescript-advanced-types, nodejs-backend-patterns, nodejs-best-practices, vitest, zod, drizzle, react-best-practices, composition-patterns, tailwind-css-patterns, playwright-best-practices, vite, frontend-design, accessibility, seo) for claude-code, opencode and codex. It wrote untracked `.agents/`, `.claude/skills/` and `skills-lock.json` into the repo and refreshed the ignored `.atl/skill-registry.md`. They are NOT committed; they are excluded from Prettier, ESLint and the Docker context.
10. Slice sizes exceed the 400-line budget: S0.06 about 667 (the pnpm 10 upgrade, logging/problem+json fixes, lint rules and tests were folded in) and S0.07 about 730 (tests and Testcontainers support are most of it). Each is split into work-unit commits that can be promoted to separate PRs if the owner wants.

## Risks and follow-ups

- Task 0.1: the secrets in `BackEnd/.env` remain in git history and must be rotated by the owner before anything is pushed or merged. History rewrite is out of scope.
- Nothing is pushed. CI, branch protection and Renovate have not run.
- The pre-commit hook needs `gitleaks` installed locally (Windows: `winget install Gitleaks.Gitleaks`); without it every commit is blocked on purpose. The hook was installed by `pnpm install` (`prepare` script).
- `gitleaks-action` may require a license for GitHub organization accounts (free for personal accounts).
- The integration tests were written but not executed against a container; the SQL and RLS behavior were checked on PGlite only. Treat the first real run as a verification step.
- A full-history `gitleaks detect` will report the old committed secrets; PR-range scans do not.

## Repository migration (clean repository, working name `consultorio`)

Stage 0 was replayed into a new repository, with the product working name `consultorio` (it was `aillu` while the work happened in the repository of the legacy app).

- The legacy `BackEnd/` and `FrontEnd/` apps, the legacy root `package-lock.json`, `node_modules` and any `.env` are not part of this repository. The legacy reference app lives in the separate archived repository `francocor/AppmedicoCMAillu`. Nothing legacy was copied, so the old secrets are not in this history. They still must be rotated (task 0.1).
- Slices S0.01 to S0.10 were replayed in order with the same Conventional Commit messages and dates. Two differences: S0.01 only adds `.gitignore` (there is nothing to untrack), and the S0.10 legacy marker commit, which only added `LEGACY.md` files inside the legacy folders, became a pointer to the legacy repository that also removes the legacy exclusions from the ESLint, Prettier, Docker, workspace and Renovate configs. The `LEGACY.md` markers named above do not exist here.
- Workspace scope `@aillu/*` is now `@consultorio/*`, and the other `aillu` identifiers (image `consultorio-api`, bucket `consultorio-files`, database `consultorio`, compose project `consultorio`) were renamed the same way. Commands and names quoted in this file use the new names.
- Commit hashes quoted in this file belong to the source repository and do not exist here.
- Tasks that only manage in-repo legacy (0.3, 0.4, 0.32 and S2.34) are marked "N/A: legacy lives in a separate repo".
