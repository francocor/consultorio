# Tasks: Health Practice SaaS (rewrite of Centro Medico Aillu)

> **Plan in one line**: 7 stages (0 to 6), about 139 reviewable PR slices of roughly 400 changed lines each. Stages 0, 1 and 2 are fully detailed below. Stages 3 to 6 are slice-level only and MUST be refined when their stage starts.

Change: `health-practice-saas` · Project: `appmedicocmaillu` · Artifact store: openspec · Delivery strategy: `ask-on-risk` · Strict TDD: off today (Stage 0 introduces the runner; every task still ships its own tests).

## Review Workload Forecast

Hand-written changed lines (additions + deletions, tests included). Lockfiles, seed data assets and the mechanical untrack/legacy deletions are counted separately because they are generated or mechanical.

| Stage | Scope | PR slices | Est. changed lines (hand-written) |
|---|---|---|---|
| 0 | Repo hygiene, skeleton, tooling, CI | 10 | ~2,500 |
| 1 | Secure core | 38 (1 is no-code) | ~13,500 |
| 2 | Practice core + legacy removal | 34 | ~12,000 |
| 3 | Patient engagement | 18 | ~6,500 |
| 4 | Revenue | 15 | ~5,500 |
| 5 | Compliance and portal | 12 | ~4,500 |
| 6 | Growth | 12 | ~4,500 |
| **Total** | | **~139** | **~49,000 (range 35,000 to 70,000)** |

| Field | Value |
|---|---|
| Estimated changed lines | ~49,000 hand-written (+ generated: pnpm lockfile; + mechanical: ~18k-file `node_modules` untrack, legacy removal) |
| 400-line budget risk | High (as one change). Medium per slice, because slices are sized to about 400 lines. |
| Chained PRs recommended | Yes |
| Suggested split | Stage by stage. Inside a stage, slices in the order listed (each slice is one PR). |
| Delivery strategy | ask-on-risk |
| Chain strategy | stacked-to-main (chosen by the owner) |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

Decisions the owner must make before `sdd-apply`:
1. **Chain strategy** (`stacked-to-main` or `feature-branch-chain`). With one developer and independent slices, `stacked-to-main` is faster. `feature-branch-chain` gives rollback control per stage.
2. **`size:exception` for three mechanical slices**: S0.01 (untracking about 18k `node_modules` files shows as tens of thousands of deleted lines), S0.02 (docs-only SDD artifacts) and S2.34 (legacy removal). A fourth, softer case is the `pnpm-lock.yaml` and the 100k common-password list: treat as generated/data assets outside the budget.
3. Whether a few UI-heavy slices may run up to about 500 lines when splitting them would produce a non-working state (flagged `(~450)` where it happens).

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|---|---|---|---|
| Stage 0 | Clean repo, workspace, CI, local environment | S0.01 to S0.10 | Base = `master` (stacked) or tracker branch (feature-branch-chain). S0.01 first, it is the security-relevant one. |
| Stage 1 | Two isolated branded tenants, role views, audit trail | S1.01 to S1.37 | Backend security core first (S1.01 to S1.26), web second (S1.27 to S1.35), demo + gate last. |
| Stage 2 | Solo professional books in 10 min; center runs a full day; legacy removed | S2.01 to S2.34 | Scheduling, then clinical, then documents, then onboarding, then gate. |
| Stages 3 to 6 | Engagement, revenue, compliance and portal, growth | S3.* to S6.* | Refine each stage before starting it. |

## How to read and apply this file

| Topic | Rule |
|---|---|
| Task id | `{stage}.{n}`, sequential inside a stage. The slice heading says which tasks belong to it. |
| Spec reference | `[CODE-NN]` = requirement NN of a capability, in the order the requirement appears in its `spec.md`. Codes: TEN tenancy, IDA identity-access, AUZ authorization, AUD audit-log, BRD tenant-branding, SHL app-shell-ux, CTR country-rules-ar, STF staff-professionals, PAT patients, DEM demo-tenant, SCH scheduling, CLN clinical-records, DOC documents, ONB tenant-onboarding Part A. The traceability table at the end expands every code. |
| Test | Each task ends with `Test:`. Unit tests are colocated (`*.test.ts`). Integration tests live in `apps/api/test/integration/`. Generated policy suites live in `apps/api/test/tenancy/` and `apps/api/test/policy/`. Web e2e lives in `apps/web/e2e/`. |
| Slice contract | Every slice states **Start** (what must already exist), **Done when**, **Verify** and, if different from the default, **Rollback**. |
| Default verify | `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm test:integration` green in CI, plus anything the slice adds. |
| Default rollback | `git revert` of the slice. Migrations are forward-only and expand-only (new tables, columns, functions), so reverting the app code leaves a compatible database. Contract (drop) migrations only ever appear in a later, explicit slice. |
| Commits | Work-unit commits inside a slice (behavior plus its tests), Conventional Commits, no AI attribution. Never commit by file type. |
| Parallel | One developer: "parallel" means order-independent, not simultaneous. Each slice lists **Depends**. Slices with no dependency between them can be reordered freely. |
| Legacy | The legacy reference app lives in the separate archived repository `francocor/AppmedicoCMAillu`. This repository holds no legacy code (see S2.34). |
| Design deviation (flagged) | Pure country validators (DNI, CUIT, matricula format) live in `packages/contracts/src/country/ar/` and are re-exported by `apps/api/src/country/ar/`, so web forms and API share one implementation. Apply may revisit. |

---

# Stage 0: Repo hygiene and toolchain

Goal: a clean repository and a green pipeline, with nothing product-shaped yet. Demo: `git status` is clean, `git ls-files` contains no `node_modules` or `.env`, CI is green.

## S0.01 Repo hygiene (~60 lines + mechanical deletions) `size:exception`

Start: current `master`. Done when: ignored files are untracked, local files are intact. Rollback: `git revert` (local files are never touched; secret rotation is forward-only and is NOT reverted).

- [ ] 0.1 **Owner action, manual, do first**: rotate every secret that is in `BackEnd/.env` of the legacy repository (database credentials, JWT secret, any API or SMTP keys) and anywhere they were reused. Treat them as compromised because they remain in the legacy repository history. Record "rotated, date" in the PR description, never the values. [IDA-10] Verify: owner confirms old credentials are revoked.
- [x] 0.2 Create root `.gitignore`: `node_modules/`, `.env`, `.env.*` with `!.env.example`, `dist/`, `coverage/`, `playwright-report/`, `test-results/`, `*.pem`, `*.pfx`, `*.p12`, `.DS_Store`, `.atl/` (default: ignore the skill-registry cache unless the owner wants it versioned). [IDA-10] Test: `git check-ignore -v .env node_modules` prints a rule for each.
- [x] 0.3 N/A: legacy lives in a separate repo (`francocor/AppmedicoCMAillu`, archived). This repository never tracked `node_modules` or `.env`, so there is nothing to untrack.
- [x] 0.4 N/A: legacy lives in a separate repo (`francocor/AppmedicoCMAillu`, archived). This repository history holds no legacy code, `node_modules` or secrets.

## S0.02 Commit the SDD artifacts (docs only) `size:exception`

Start: S0.01 merged. Done when: `openspec/` is tracked. Verify: `git ls-files openspec | head`. Counted outside the budget (documentation).

- [x] 0.5 Commit `openspec/` (config, change folder with proposal, specs, design, tasks) as `docs(sdd): add health-practice-saas planning artifacts`. Test: none.
- [x] 0.6 Decide `.atl/`: keep ignored (default) or commit `.atl/skill-registry.md` only. Test: none. **Decision (applied)**: kept ignored (default); `.atl/` is in `.gitignore`.

## S0.03 Workspace and shared config (~300 lines)

Start: S0.01. Depends: S0.01.

- [x] 0.7 Root `package.json` (private, `packageManager` pnpm, `engines.node >=24`, scripts `dev build typecheck lint format format:check test test:integration test:e2e`), `pnpm-workspace.yaml` (`apps/*`, `packages/*`; `BackEnd` and `FrontEnd` explicitly excluded), `.nvmrc`, `.editorconfig`, `.npmrc` (`engine-strict`). Test: `pnpm install` succeeds; `pnpm -r exec node -v` reports Node 24.
- [x] 0.8 `packages/config`: `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, ESM), `tsconfig.node.json`, `tsconfig.react.json`, `eslint/base.js` (typescript-eslint strict-type-checked, import order, `eslint-plugin-boundaries` scaffold), `prettier.config.js`. Test: `pnpm lint` and `pnpm typecheck` pass on the empty workspace.
- [x] 0.9 `packages/contracts`: `package.json`, `src/index.ts`, `src/health.ts` (Zod `HealthResponse`). Test: `health.test.ts` (written in task 0.16, once the runner exists) parses a valid and an invalid payload.

## S0.04 API skeleton (~350 lines)

Depends: S0.03.

- [x] 0.10 `apps/api/package.json`, `tsconfig.json`, `src/main/config.ts` (Zod-validated env: `NODE_ENV`, `DATABASE_URL`, `DEPLOYMENT_MODE` default `multi`, log level; secrets come only from the environment). [IDA-10] Test: invalid env throws a startup error that never prints secret values.
- [x] 0.11 `src/main/server.ts` `buildServer()` (Fastify, Zod type provider, pino with redaction of `authorization`, `cookie`, bodies), `src/platform/http/health.ts` (`/health` liveness, `/ready` checks DB), `src/main/main.ts` taking `api|worker` (worker is an idle stub that logs). Test: see 0.12.
- [x] 0.12 `src/platform/http/health.test.ts` with `fastify.inject`: `/health` 200; `/ready` 503 when the DB probe fails. Test: that file.

## S0.05 Web skeleton (~350 lines)

Depends: S0.03. Independent of S0.04.

- [x] 0.13 `apps/web`: Vite, React 19, TypeScript, Tailwind 4, `index.html`, `src/main.tsx`, `src/app/App.tsx` placeholder, `src/shared/lib/cn.ts`. Test: `pnpm --filter web build` succeeds.
- [x] 0.14 `vite.config.ts` with `vite-plugin-pwa` (minimal manifest, placeholder icons in `public/`) and a dev proxy of `/api` to the API port. Test: build emits `manifest.webmanifest` and a service worker.
- [x] 0.15 `src/app/App.tsx` renders a tenant-neutral placeholder shell and `index.html` sets `lang="es-AR"`. Its test `App.test.tsx` is written in task 0.16, once the runner exists. Test: see 0.16.

## S0.06 Test tooling (~350 lines)

Depends: S0.04, S0.05.

- [x] 0.16 Root `vitest.workspace.ts` and per-package Vitest configs (`api` node env, `web` jsdom env, `contracts` node env), v8 coverage reporting without a threshold, scripts `test` and `test:integration`. Add `packages/contracts/src/health.test.ts` (task 0.9) and `App.test.tsx` (task 0.15). Test: `pnpm test` runs all three packages green.
- [x] 0.17 Playwright in `apps/web`: `playwright.config.ts` with projects `mobile-360` (360x740) and `desktop`, `e2e/smoke.spec.ts` loading the built shell, `@axe-core/playwright` assertion with zero violations. Test: `pnpm test:e2e` green locally.
- [x] 0.18 `vitest-axe` helper `apps/web/src/shared/test/a11y.ts` used by component tests from Stage 1. Test: self-test on a known-bad fixture reports a violation.

## S0.07 Database foundation (~400 lines)

Depends: S0.06.

- [x] 0.19 `apps/api/drizzle.config.ts`, `src/db/schema/index.ts`, migration `src/db/migrations/0000_roles_and_extensions.sql`: roles `app_owner` (migrations) and `app_rw` (runtime, **not** table owner, no `BYPASSRLS`), schema `app` for helper functions, extensions `btree_gist`, `citext`, `pgcrypto`, `pg_trgm`, `unaccent`, default privileges for `app_rw`, `REVOKE CREATE ON SCHEMA public FROM PUBLIC`. [TEN-03] Test: integration asserts `app_rw` is neither owner nor superuser nor `BYPASSRLS`. Verified with `pnpm test:integration` against real Docker (Testcontainers Postgres 17): 3 files, 12 tests pass.
- [x] 0.20 `src/platform/db/pool.ts` (owner pool for migrations, `app_rw` pool for runtime) and `src/platform/db/tenant-context.ts` `withTenant(ctx, fn)` exactly as in the design (transaction-local `set_config` for `app.tenant_id`, `app.user_id`, `app.professional_id`). [TEN-02, TEN-03] Test: integration on a probe table inside the test: reads work inside `withTenant`, and outside it `current_setting('app.tenant_id')` raises (fails closed). Verified with `pnpm test:integration` against real Docker (Testcontainers Postgres 17): 3 files, 12 tests pass.
- [x] 0.21 `apps/api/test/support/postgres.ts` (Testcontainers Postgres 17 global setup: run migrations as `app_owner`, tests connect as `app_rw`) and `apps/api/test/tenancy/rls-catalog.test.ts`: every table with `tenant_id` must have `ENABLE` + `FORCE` RLS and at least one policy. The test proves itself by creating a deliberately bad table in a scratch schema and asserting it is flagged. [TEN-03] Test: that file. Verified with `pnpm test:integration` against real Docker (Testcontainers Postgres 17): 3 files, 12 tests pass.
- [x] 0.22 `scripts/check-migration-drift.ts` (fails when the Drizzle schema and the migration folder disagree), wired to `pnpm db:check`. Test: run against a clean tree passes; a hand-edited schema fails.

## S0.08 Local environment and image (~300 lines)

Depends: S0.03 (independent of S0.06 and S0.07 except the init script).

- [x] 0.23 `infra/Dockerfile` (multi-stage: deps, build, runtime on a Node 24 slim image, non-root user, tini, `HEALTHCHECK`), `.dockerignore`. Test: `docker build -f infra/Dockerfile .` succeeds and `docker run ... node dist/main.js api` answers `/health`. Verified: `docker build -f infra/Dockerfile -t consultorio-api .` succeeds; the container runs as `node` (non-root), `/health` answers 200 and the HEALTHCHECK reports healthy.
- [x] 0.24 `infra/docker-compose.yml`: `postgres:17` (mounts `infra/postgres/init/01-roles.sql`), `minio` (+ bucket-creation init), `mailpit`, `clamav` (with healthcheck and a memory note of about 1 GB), named volumes, optional `api` profile. Test: `docker compose config` validates; `docker compose up -d` reaches healthy. Verified: `pnpm infra:up` (compose with `--env-file .env`) reaches healthy; with `--profile scan --profile app` ClamAV and the api image are healthy too; `01-roles.sql` ran on a fresh volume (app_owner and app_rw, no superuser, no BYPASSRLS). ClamAV stays behind the `scan` profile so the default stack stays light. MinIO runs on the frozen Bitnami build because MinIO stopped publishing community images.
- [x] 0.25 Root `.env.example` listing every variable with safe placeholders and comments, no secrets. [IDA-10] Test: a unit test in `apps/api` loads `.env.example` through the config schema and passes.
- [x] 0.26 `docs/dev-setup.md`: prerequisites, `pnpm install`, `docker compose -f infra/docker-compose.yml up -d`, run commands, Mailpit and MinIO console URLs. Test: manual walkthrough from a clean clone listed in the PR checklist. **Clean-clone walkthrough PENDING** (owner, PR checklist).

## S0.09 CI pipeline and secret scanning (~300 lines)

Depends: S0.06, S0.07, S0.08.

- [x] 0.27 `.github/workflows/ci.yml`: pnpm install with cache, typecheck, lint and Prettier check, unit, integration (Docker available for Testcontainers), `docker build`, Playwright e2e, gitleaks, `pnpm audit --prod --audit-level=high`, migration drift check. Least-privilege `permissions`, concurrency cancel. Test: the workflow is green on the PR itself. `actionlint` passes; every job command was run locally except Docker-dependent ones. **Green-on-PR PENDING** (needs a push; nothing is pushed yet).
- [x] 0.28 `.gitleaks.toml` (default rules, allowlist `.env.example`), `lefthook.yml` pre-commit running `gitleaks protect --staged` and lint-staged. [IDA-10] Test: committing a fake AWS key locally is blocked; on a throwaway branch CI gitleaks fails. Local pre-commit block verified with a staged fake AWS key; `gitleaks git` over `master..HEAD` finds nothing. **CI check on a throwaway branch PENDING** (needs a push).
- [x] 0.29 `renovate.json` (group minor and patch updates, security updates immediate). Owner action: enable branch protection on `master` requiring the CI checks. Test: none (config). Config validated with `renovate-config-validator --strict`. **Owner action PENDING**: enable branch protection on `master` requiring the CI checks, and install the Renovate GitHub app.

## S0.10 Legacy marker, docs and tooling refresh (~150 lines)

Depends: S0.09.

- [x] 0.30 Root `README.md` (product overview, layout, links to `docs/dev-setup.md` and `openspec/`). Test: none.
- [x] 0.31 `docs/external-dependencies.md` skeleton (AFIP, WhatsApp Business, e-Rx provider, Mercado Pago, legal Q1 and Q7) filled in S1.00. Test: none.
- [x] 0.32 N/A: legacy lives in a separate repo (`francocor/AppmedicoCMAillu`, archived). No marker files are needed because there is no legacy code in this repository.
- [x] 0.33 Update `openspec/config.yaml` `testing` and `apply.test_command` (runner Vitest, layers unit/integration/e2e true, linter/type checker/formatter true) and re-run `sdd-init` to refresh the cached testing capabilities. Decide whether strict TDD turns on from Stage 1 (recommendation: on for domain and security code). Test: `sdd-init` reports the runner.
- [x] 0.34 Stage 0 gate: record the demo evidence (clean `git ls-files`, green pipeline link) in the PR. Test: checklist. Evidence recorded in `apply-progress.md` (clean `git ls-files`, local verification run). **Green pipeline link PENDING**: nothing is pushed, so CI has not run.

---

# Stage 1: Secure core

Goal: two isolated, branded tenants with role-specific views and an audit trail. Backend security core first (S1.01 to S1.26), then web (S1.27 to S1.36), then the stage gate. Demo: operator creates two tenants, owners invite staff, the audit viewer shows the trail, a branded theme applies per host.

## S1.00 External lead-time track (no code)

Runs in parallel with everything. Done when each dependency has an owner, a date and a status in `docs/external-dependencies.md`.

> Local-first note (owner decision, 2026-10-15): the real requests are deferred. S1.00 is done as documentation: every dependency has an owner and the status `deferred`, and the file names the fake adapter the code uses meanwhile. The dates are filled when the owner files each request.

- [x] 1.1 Start AFIP/ARCA certificate and homologation access request (needed by Stage 4). Record the date. Test: none.
- [x] 1.2 Start Meta WhatsApp Business verification for the platform WABA and choose the e-Rx provider (Q3) (needed by Stages 3 and 5). Test: none.
- [x] 1.3 Request legal review of hosting and the AAIP model clauses (Q1) and of governance-mode erasure (Q7, D13). Test: none.

## S1.01 Contracts, errors and permission catalog (~350 lines)

Depends: S0.07.

- [x] 1.4 `packages/contracts/src/errors.ts`: problem+json schema (RFC 9457), error code enum with i18n keys, `requestId`. [AUZ-16] Test: schema accepts and rejects fixtures.
- [x] 1.5 `packages/contracts/src/roles.ts`: roles (`owner`, `admin`, `professional`, `reception`, `patient`), `PERMISSIONS`, `ROLE_PERMISSIONS`, `GRANTABLE` (override hours, register past, delegated calendar, cash operate, patients administer). [AUZ-01, AUZ-05, AUZ-12] Test: `roles.test.ts` fails if any non-professional role or `GRANTABLE` contains `clinical.*`, and if `owner` or `admin` holds any clinical permission.
- [x] 1.6 `packages/contracts/src/route-category.ts`: read-only categories (the 9 allowlist items plus `write`). [TEN-11] Test: enum snapshot.
- [x] 1.7 `apps/api/src/platform/http/problem.ts`: Fastify error handler to problem+json, request-id plugin, uniform `denied()` helper (same body for forbidden and not found where the resource is tenant-scoped). [AUZ-16] Test: unknown error returns 500 without stack or internals; denied helper bodies are identical.
- [x] 1.8 Extend `main/config.ts`: `DEPLOYMENT_MODE`, `SINGLE_TENANT_SLUG`, `BASE_DOMAIN`, `PLATFORM_HOST`, cookie settings, KMS settings; fail fast. [TEN-06, IDA-10] Test: single mode without slug fails to start.

## S1.02 Country pack AR (~400 lines)

Depends: S1.01.

- [x] 1.9 `apps/api/src/platform/country/country-pack.ts` (interface per design section 6, `Result` type, registry `getCountryPack`) and an ESLint boundaries rule that only the registry may import `country/ar`. [CTR-01] Test: lint fixture importing `country/ar` directly fails.
- [x] 1.10 `packages/contracts/src/country/ar/identifiers.ts` (DNI normalization and validation, CUIT/CUIL mod-11) re-exported from `apps/api/src/country/ar/`. [CTR-02, CTR-03] Test: table-driven valid/invalid cases including check digits; property test that normalization is idempotent.
- [x] 1.11 `.../ar/matricula.ts` (format check per jurisdiction, format only) with the 24 jurisdictions. [CTR-06] Test: table of valid and invalid formats.
- [x] 1.12 `country/ar/{defaults,retention,personal-data,legal-adapters}.ts`: es-AR, ARS, `America/Argentina/Buenos_Aires`, 10-year retention, Ley 25.326 consent text keys and rights, declared (type-only) `InvoiceIssuer` and `PrescriptionProvider` ports in `packages/contracts/src/ports.ts`. [CTR-07, CTR-08, CTR-09, CTR-10] Test: defaults and retention constants; adapters are declared but not implemented.
- [x] 1.13 `db/schema/platform-catalogs.ts` + migration: `holiday_catalog(country, date, name, kind)` and `payer` (obras sociales and prepagas) as platform tables (no `tenant_id`, writable only by the operator role), plus seed loaders `db/seed/ar-holidays.ts` (2026 to 2028) and `db/seed/ar-payers.json`. [CTR-04, CTR-05] Test: loaders are idempotent; unique `(country, date, name)`.

## S1.03 Tenant schema, RLS helper, isolation suite (~400 lines)

Depends: S0.07, S1.01.

- [x] 1.14 `db/schema/_helpers.ts`: `tenantTable()` (UUIDv7 id, `tenant_id NOT NULL`, `UNIQUE (tenant_id, id)`, timestamps), `tenantPolicies(table)` SQL generator (`ENABLE` + `FORCE` + `tenant_isolation`), `platform/db/uuid.ts`. [TEN-01, TEN-03] Test: generated SQL snapshot; integration shows a cross-tenant read returns 0 rows.
- [x] 1.15 `db/schema/tenant.ts` + migration `0001_tenancy.sql`: `tenant` (slug, status, `read_only_since`, `is_demo` with an immutability trigger, `billing_exempt`, country, theme, settings), `location` (name, IANA `time_zone`, active), `tenant_feature`. [TEN-01, TEN-04] Test: changing `is_demo` after creation raises.
- [x] 1.16 `apps/api/test/support/fixtures.ts` (per-table fixture registry) and `apps/api/test/tenancy/isolation.generated.test.ts`: for every tenant table, tenant B reads 0 rows of tenant A and a cross-tenant composite FK insert fails; a table with no registered fixture fails the test. [TEN-03] Test: that file.

## S1.04 Host resolution and deployment mode (~300 lines)

Depends: S1.03.

- [x] 1.17 `modules/tenancy/application/resolve-tenant.ts` and `platform/http/tenant-host.ts` preHandler: multi mode resolves `{slug}.BASE_DOMAIN`; `PLATFORM_HOST` selects the operator context; unknown host returns the generic 404; single mode pins `SINGLE_TENANT_SLUG`. [TEN-02, TEN-06] Test: host matrix; spoofed `X-Tenant-Id` header ignored.
- [x] 1.18 Contracts guard `apps/api/test/policy/no-tenant-in-contracts.test.ts`: fails if any request schema in `packages/contracts` declares `tenantId`. [TEN-02] Test: that file.
- [x] 1.19 `platform/features.ts`: feature registry; `DEPLOYMENT_MODE=single` disables signup and subscription routes; the same build boots in both modes from env only. [TEN-06] Test: boot in both modes; signup route absent in single mode.
- [x] 1.20 `modules/tenancy/application/export-registry.ts`: `registerExportContributor(kind: 'administrative' | 'clinical', name, fn)`; a test asserts every module registers a contributor. This is only the hook for the cancellation export built in Stage 6. [TEN-08] Test: registry unit test.

## S1.05 Read-only policy skeleton (~300 lines)

Depends: S1.01, S1.04.

- [x] 1.21 `platform/read-only/index.ts`: route option `config.readOnly: Category`; an `onRoute` hook throws at boot when a route has no category; `onRequest` returns `402 tenant_read_only` for non-allowlisted routes of a read-only tenant; public booking and waitlist prefixes render the generic "not available" response instead. [TEN-11] Test: inject matrix, one case per category.
- [x] 1.22 `platform/read-only/jobs.ts` `assertTenantWritable(job, enqueuedAt)` (only `afip.issue` enqueued before `read_only_since` may run). [TEN-11] Test: unit cases.
- [x] 1.23 `apps/api/test/policy/route-categories.test.ts`: enumerates registered routes and fails if one has no category. [TEN-11] Test: that file.

## S1.06 Audit writer (~400 lines)

Depends: S1.03.

- [x] 1.24 `db/schema/audit.ts` + migration: `audit_event` partitioned by month with the columns from design section 3.6, indexes on tenant+time, tenant+patient, tenant+actor, RLS, `app_rw` gets only INSERT and SELECT, function `app.ensure_audit_partitions(n)`. [AUD-03, AUD-04] Test: partitions are created; grants verified.
- [x] 1.25 Triggers: reject `DELETE`; reject `UPDATE` except filling `seq`, `prev_hash`, `hash` from NULL by role `audit_sealer`. [AUD-04] Test: `app_rw` update and delete fail; sealer fills once and a second fill fails.
- [x] 1.26 `platform/audit/writer.ts` `audit(tx, event)` (same transaction, fail-closed) and `packages/contracts/src/audit-actions.ts` (typed action catalogue; metadata schema rejects clinical content keys). [AUD-01, AUD-02, AUD-03] Test: a forced audit failure aborts the business write (row absent).
- [x] 1.27 `platform/audit/deny.ts` `auditDeny()` on a separate connection in its own transaction. [AUD-01, AUD-02] Test: the deny row persists although the business transaction rolled back.
- [x] 1.28 Request context plugin filling actor, acting role, ip, user agent and request id into `RequestContext` for audit. [AUD-03] Test: inject check of captured fields.

## S1.07 Jobs platform and audit sealer (~400 lines)

Depends: S1.06.

- [x] 1.29 `platform/jobs/boss.ts` (pg-boss bootstrap, handlers only in the `worker` role), `enqueue(tx, name, payload)` in the caller's transaction, `defineJob()` wrapper that runs in `withTenant`, re-checks tenant status and is idempotent. [TEN-11] Test: integration: a job runs under tenant context; a job for a read-only tenant ends cancelled.
- [x] 1.30 `platform/audit/sealer.ts` + job `audit.seal` (singleton per tenant, every 5 s; assigns `seq` in `(occurred_at, id)` order; `hash = SHA-256(prev_hash || canonical row)`) and `canonicalize.ts`. [AUD-04] Test: chain is correct after concurrent interleaved inserts; re-run is idempotent.
- [x] 1.31 Job `audit.verify` nightly plus seal-lag and `audit_chain_break` metrics. [AUD-04] Test: tamper a row via the owner connection; verify reports the first bad `seq`.

## S1.08 Envelope encryption (~350 lines)

Depends: S1.03.

- [x] 1.32 `platform/crypto/aes-gcm.ts` (AES-256-GCM, random 96-bit nonce, AAD binding tenant, table, column, row id; versioned format). [IDA-05, PAT-06] Test: round trip; tamper and AAD mismatch throw; nonces never repeat.
- [ ] 1.33 `platform/crypto/key-management.ts` port + `adapters/local-kek/` (dev, test) + `adapters/aws-kms/` (encryption context carries tenant id). [IDA-05] Test: local adapter; AWS adapter against a mocked client.
- [ ] 1.34 `db/schema/tenant-key.ts` + migration; `platform/crypto/tenant-keys.ts` (create DEK at tenant creation, unwrap cache with TTL, `encryptField`/`decryptField`). [IDA-05, PAT-06] Test: tenant A cannot decrypt tenant B data; cache expiry; creation is idempotent.

## S1.09 Identity schema and password policy (~350 lines)

Depends: S1.03, S1.08.

- [ ] 1.35 `db/schema/identity.ts` + migration: `user` (global, citext email, `password_hash`, encrypted `totp_secret`, `first_sign_in_at`, `failed_logins`, `locked_until`), `membership` (tenant, roles, status), `session`, `login_challenge`, `recovery_code`. `user` is readable only through membership of the current tenant or the login lookup function `app.lookup_user_for_login(email)` (SECURITY DEFINER, minimal columns). [IDA-02, TEN-01] Test: tenant B context cannot read tenant A's users.
- [ ] 1.36 `modules/identity/domain/password-policy.ts` and the bundled list `apps/api/assets/common-passwords-100k.txt` loaded at boot (data asset, outside the line budget); optional breached-password range check behind a flag. [IDA-03] Test: rejects common passwords, accepts a passphrase, length boundaries.
- [ ] 1.37 `modules/identity/infrastructure/argon2.ts` (`@node-rs/argon2`) with `verifyOrDummy` so unknown users take the same path. [IDA-02] Test: unknown and known users call the same verify path (spy count).

## S1.10 Sessions and login (~400 lines)

Depends: S1.09, S1.06.

- [ ] 1.38 `modules/identity/application/sessions.ts` and `platform/http/session-cookie.ts`: opaque 256-bit token, SHA-256 at rest, `HttpOnly; Secure; SameSite=Lax`, idle 12 h and absolute 7 days (staff), rotation on login and privilege change, `active_tenant_id`. [IDA-07] Test: expiry with a fake clock; rotation on login.
- [ ] 1.39 Routes `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `GET|DELETE /auth/sessions` with contracts in `packages/contracts/src/auth.ts`; host and session tenant mismatch returns 401; unknown identifiers get identical responses. [IDA-02, IDA-07, TEN-02] Test: integration login, logout, revoke, mismatch.
- [ ] 1.40 `platform/http/auth-guard.ts` (every route requires a session unless it is declared public under the allowed prefixes of design 4.5) and `csrf-origin.ts` (`Origin` check on non-GET). [IDA-01] Test: boot-time test enumerates routes and fails on an unauthenticated route outside the allowlist; cross-origin POST returns 403.
- [ ] 1.41 Audit hooks `auth.login.success|failure`, `auth.logout`, `auth.session.revoked`. [IDA-09] Test: events present with required fields.

## S1.11 Lockout and throttling (~350 lines)

Depends: S1.10.

- [ ] 1.42 `modules/identity/application/lockout.ts`: counter, lock after 10 consecutive failures for 15 minutes (configurable), exponential backoff per account and IP, lock checked before credentials, `recordFailure(kind)` reusable by 2FA. [IDA-04] Test: 10 failures lock; the 11th with the correct password is still 401 generic; unlock after the window.
- [ ] 1.43 `platform/http/rate-limit.ts` (`@fastify/rate-limit` per IP and per tenant, store behind an interface). [IDA-04, IDA-01] Test: 429 after the limit; separate buckets per tenant.
- [ ] 1.44 Audit `auth.account.locked|unlocked`, `auth.login.locked`; identical response body and timing class for unknown identifiers. [IDA-09, IDA-04] Test: unknown versus known account responses equal.

## S1.12 Action tokens and transactional email (~350 lines)

Depends: S1.03.

- [ ] 1.45 `db/schema/action-token.ts` + `platform/tokens/index.ts`: `issue(kind, subject, opts)` returns the raw token once; SHA-256 at rest; `redeem()` is an atomic `UPDATE ... RETURNING` with max uses, expiry per kind and optional session binding; canonical kind registry (only account kinds enabled now). [IDA-08, STF-01] Test: single use under concurrency, expired, wrong kind, hash at rest.
- [ ] 1.46 `platform/mail/email-sender.ts` port, `adapters/smtp/` (Mailpit locally, SES SMTP in production), `adapters/fake-email/` (in memory), es-AR templates for invitation and reset. The native SES API adapter arrives with `notifications` in Stage 3. [IDA-08] Test: fake captures messages; SMTP adapter against Mailpit (integration).

## S1.13 Two-factor authentication (~400 lines)

Depends: S1.11, S1.08, S1.12.

- [ ] 1.47 `modules/identity/application/totp.ts` (`@oslojs/otp`): enrollment with encrypted secret, verify with +-1 step, last-used-step replay block. [IDA-05] Test: RFC 6238 vectors, replay rejected, drift window.
- [ ] 1.48 Recovery codes: generate 10, store hashed, single use, regenerate. [IDA-05] Test: reuse fails; hashes only at rest.
- [ ] 1.49 Login 2FA flow: `login_challenge` (5 min, max 5 attempts), `POST /auth/2fa`, wrong or reused code counts toward lockout, mandatory for professionals and owners/admins with a 7-day grace from `first_sign_in_at`, then an enrollment-scoped session; optional for reception unless `settings.require_2fa`. [IDA-05, IDA-04] Test: role x grace x enrolled matrix; an enrollment-scoped session gets 403 `two_factor_enrollment_required` everywhere else.
- [ ] 1.50 Audit `auth.2fa.enrolled|verified|failed|recovery_used`. [IDA-09] Test: events emitted.

## S1.14 Password reset and invitation acceptance (~350 lines)

Depends: S1.12, S1.13.

- [ ] 1.51 `POST /auth/password-reset/request` (always the same response, email only) and `/complete` (token 30 min, single use, policy check, revokes all sessions, does not bypass 2FA, audited). [IDA-08] Test: non-enumeration, reuse fails, sessions revoked.
- [ ] 1.52 Admin-triggered reset `POST /users/:id/password-reset` only sends the email and never sets a password. [IDA-08, AUZ-03] Test: no endpoint accepts a password for another user.
- [ ] 1.53 `POST /auth/invitations/accept {token, password}`: creates the user or links an existing user to a new membership with the invited roles, within the inviter's ceiling. [STF-01, ONB-01] Test: roles granted equal roles invited; expired token fails.

## S1.15 Authorization engine (~400 lines)

Depends: S1.01, S1.10.

- [ ] 1.54 `platform/authz/can.ts`: `can(actor, action, resource)` combining RBAC from the catalog with grants limited to `GRANTABLE`; `Actor` type. [AUZ-02, AUZ-15] Test: unit table of role x action; unknown action denies.
- [ ] 1.55 `platform/authz/guard.ts`: route option `config.permission`; a route with neither a permission nor `public` fails at boot; denials call `auditDeny()` and use the uniform response. [AUZ-02, AUZ-16] Test: `apps/api/test/policy/route-role-matrix.test.ts` generated from the catalog.
- [ ] 1.56 Admin-denied harness: a test iterating every registered route tagged `clinical.*` asserting 403 for owner/admin plus a deny audit row; proven now with a fixture route, and it covers real routes automatically from Stage 2. [AUZ-04, AUZ-06] Test: that harness.
- [ ] 1.57 `platform/authz/professional-gate.ts`: derive `professionalId` only from an active professional profile with a recorded valid matricula; an owner who is also a professional gets it through the profile only. [AUZ-04] Test: unit with stubbed repo.
- [ ] 1.58 Default deny for the `patient` actor class on all staff routes (patient sessions do not exist yet). [AUZ-14] Test: patient actor denied everywhere.

## S1.16 Sharing-scope predicate (~300 lines)

Depends: S1.15.

- [ ] 1.59 `platform/authz/sharing-scope.ts`: `readable(entry, actor, ctx)` per design 4.2 (author, treating, `author_only`, prescriptions never follow sharing, inclusion list `sharedTemplates`); `treating()` behind a port. [AUZ-11, AUZ-09] Test: see 1.60.
- [ ] 1.60 Table-driven and fast-check tests (author, treating, shared, `author_only`, D17 prescription, psychology excluded by default, new templates never auto-added) and a helper marking shared reads `reason = 'shared'`. [AUZ-11] Test: that file.

## S1.17 SQL clinical backstop and care tables (~400 lines)

Depends: S1.16, S1.03.

- [ ] 1.61 `db/schema/care.ts` + migration: `care_assignment`, `care_relationship` (patient, professional, qualifying appointments, encounters, assigned, generated `active`); trigger from `care_assignment`. Appointment and encounter triggers arrive in Stage 2. [AUZ-09, AUZ-10] Test: assignment makes the relationship active.
- [ ] 1.62 SQL `app.clinical_readable(patient_id, author_professional_id, visibility, template_kind)` and `clinicalPolicies(table)` helper creating the RESTRICTIVE `clinical_professionals_only` and `clinical_scope` policies; extend `withTenant` to load sharing settings once per transaction. [AUZ-04, AUZ-11] Test: see 1.63.
- [ ] 1.63 Integration tests on a test-only table `test_clinical_item`: admin sees 0 rows; non-treating professional 0; treating 1; `author_only`; sharing on and off; prescription excluded (D17); and a property test that the TS predicate (1.59) and the SQL function agree on random actor/entry combinations. [AUZ-04, AUZ-09, AUZ-11] Test: that file.

## S1.18 Access module: grants, settings, locations (~400 lines)

Depends: S1.15, S1.04.

- [ ] 1.64 `db/schema/access.ts` + migration: `permission_grant` (`CHECK (permission NOT LIKE 'clinical.%')`, scope jsonb), `membership_location`. [AUZ-12, AUZ-13] Test: inserting a `clinical.*` grant fails at the DB.
- [ ] 1.65 `modules/access`: grant and revoke API (owner/admin only), role-change rules (no self-escalation, no granting above own ceiling, last owner protected, sessions rotated on change), audited. [AUZ-03, AUZ-12] Test: each prohibited path returns 403 with a deny audit row.
- [ ] 1.66 Org settings API `GET|PATCH /api/v1/settings`: `reception_sees_clinical_metadata`, `clinicalSharing` (default `sharedTemplates`, psychology only by explicit audited choice), `require_2fa`, quiet hours default; every change audited. [AUZ-07, AUZ-11] Test: sharing toggle audited; psychology needs the explicit flag.
- [ ] 1.67 Location HTTP API (`/api/v1/locations` create, edit, deactivate) and membership-location assignment with a reception location filter helper. [TEN-04, AUZ-13] Test: reception only sees its locations; deactivate keeps history.

## S1.19 Staff and professionals (~400 lines)

Depends: S1.18, S1.14, S1.02.

- [ ] 1.68 `db/schema/staff.ts` + migration: `professional` (status, matricula, jurisdiction, `matricula_status`, `verified_by_operator`, `max_simultaneous`, specialties) and `professional_hours` (weekday, start, end, location). A DB trigger blocks `matricula_status = verified` outside an operator context. [STF-03, STF-06, STF-04] Test: tenant users cannot set `verified`.
- [ ] 1.69 `modules/staff` profile service: matricula validated through CountryPack, editing it resets to `unverified`, uniqueness, multiple specialties. [STF-03, STF-04, TEN-05] Test: edit resets status; duplicate matricula rejected.
- [ ] 1.70 Staff lifecycle API: invite (role ceiling, `staff_invitation` token + email), directory with role-based visibility, deactivate and reactivate (never delete, revoke sessions), location assignment; all audited. [STF-01, STF-02, STF-05, STF-07, STF-08] Test: reception cannot invite; deactivation revokes sessions.
- [ ] 1.71 `PUT /professionals/:id/hours` validating overlaps in the location time zone. [STF-06] Test: overlap rejected; edit audited.

## S1.20 Patients core (~400 lines)

Depends: S1.15, S1.02, S1.03.

- [ ] 1.72 `db/schema/patients.ts` + migration: `patient` (partial unique `(tenant_id, national_id_type, national_id) WHERE national_id IS NOT NULL`), `patient_version`, `patient_representative`; RLS tenant-only because demographics are organization-wide. [PAT-01, PAT-02, PAT-11, PAT-12, AUZ-08] Test: two patients without document allowed; duplicate document rejected.
- [ ] 1.73 `modules/patients` API: create, edit, deactivate (never delete), DNI normalization through CountryPack, duplicate returns 409 with an existing-patient summary, every update writes a `patient_version` and an audit event. [PAT-01, PAT-02, PAT-10, PAT-11] Test: duplicate flow; history contains both versions.
- [ ] 1.74 `GET /patients?q=` search by name and document (`pg_trgm` + `unaccent`), paginated, minimal columns. [PAT-04] Test: accent-insensitive; 10k seeded rows answer within a generous bound.
- [ ] 1.75 Minors and representatives: representative record with relation and contact, majority age from CountryPack, `majority_review_on`. [PAT-12] Test: minor requires a representative; the date is computed.

## S1.21 Coverage, consent and rights (~350 lines)

Depends: S1.20.

- [ ] 1.76 `payer_plan` and `patient_coverage` schema + API (member number, validity, primary flag). [PAT-05] Test: one primary per patient; invalid dates rejected.
- [ ] 1.77 `data_processing_consent` (text version key from CountryPack, granted at, recorded by, revoked at) + API and a mandatory prompt at patient creation. [PAT-08, CTR-10] Test: revocation allowed in a read-only tenant.
- [ ] 1.78 `patient_rights_request` (access, rectification) + staff API; rectification goes through the versioned update. [PAT-09] Test: allowed in read-only (category 6).

## S1.22 Anamnesis, safety flags, assignment (~400 lines)

Depends: S1.20, S1.17, S1.08.

- [ ] 1.79 `db/schema/anamnesis.ts`: encrypted versioned `anamnesis` with `clinicalPolicies`; save endpoint for professionals only. [PAT-06, AUZ-04] Test: reception and admin get 403 plus a deny audit row; RLS returns 0 rows.
- [ ] 1.80 `modules/patients/application/safety-flags.ts`: recompute codes from the structured anamnesis in the same transaction; no endpoint writes `patient.safety_flags`, and a trigger rejects direct updates outside the system function. [PAT-07] Test: no route or contract exposes a setter; reception sees only the "see professional" label.
- [ ] 1.81 Care assignment API `POST|DELETE /patients/:id/assignments` (professional self-assign or `patients.administer`), audited. [AUZ-10] Test: assignment grants access; removal revokes it only when no other source exists.
- [ ] 1.82 Contracts guard: `PatientSummaryDto` never carries clinical detail. [PAT-06, AUZ-06] Test: DTO snapshot plus a reception GET of anamnesis returning 403.

## S1.23 Audit viewer and report (~350 lines)

Depends: S1.07, S1.15.

- [ ] 1.83 `modules/audit` API `GET /audit-events` (filters actor, action, patient, resource, outcome, date; cursor pagination; owner/admin; metadata only). [AUD-06, AUD-07] Test: tenant B cannot see A's events; no clinical content in responses.
- [ ] 1.84 Patient access report `GET /patients/:id/access-report` and streamed CSV/JSON export, the export itself audited. [AUD-07, AUD-01] Test: report lists reads and writes for the patient.
- [ ] 1.85 Job `audit.partitions` (ensure the next 3 months) and `docs/runbooks/audit-retention.md` (move partitions older than 2 years to cold storage, retain 10 years, never delete). [AUD-05] Test: partitions exist ahead of time; no code path deletes audit rows.
- [ ] 1.86 `apps/api/test/policy/audit-coverage.test.ts`: every mandatory event has an integration scenario registered, and a mutating route without an audit assertion tag fails. [AUD-01] Test: that file.

## S1.24 Object storage port and S3 adapter (~300 lines)

Depends: S0.08.

- [ ] 1.87 `platform/storage/object-storage.ts` port (put, get stream, head, presigned POST, move within tenant prefix) with key convention `t/{tenantId}/...`; `adapters/s3/` (AWS SDK v3, MinIO compatible) and an in-memory fake. [DOC-03, BRD-04] Test: integration against MinIO; keys outside the tenant prefix are refused.

## S1.25 Branding API (~350 lines)

Depends: S1.24, S1.18.

- [ ] 1.88 `modules/tenancy/branding/contrast.ts`: OKLCH lightness auto-adjust until WCAG 4.5:1, returns `primary_requested`, `primary_effective` and a warning. [BRD-03] Test: property test that the result is always at least 4.5:1, hue preserved, idempotent.
- [ ] 1.89 `PUT /api/v1/branding` (name, short name, primary color, radius, heading font from a curated set) with permission `branding.manage`, audited before and after. [BRD-01, BRD-05] Test: reception denied; audit holds the diff.
- [ ] 1.90 Logo upload: PNG, JPEG or WebP only, magic-byte sniff, 512 KB cap, dimension cap, re-encode with `sharp` to strip metadata, store through the port; SVG rejected. [BRD-04] Test: polyglot, oversize and SVG fixtures rejected.
- [ ] 1.91 Public `GET /api/v1/boot` by host (name, theme tokens, logo URL, locale, feature flags, deployment mode; no PII) and per-host `GET /manifest.webmanifest`. [BRD-02, SHL-03, SHL-09] Test: unauthenticated response contains only whitelisted keys; two hosts return different themes.

## S1.26 Operator console API (~400 lines)

Depends: S1.14, S1.08, S1.07.

- [ ] 1.92 `db/schema/operator.ts` + migration: `operator_user`, `platform_audit_event` (append-only, sealed like tenant audit), `support_grant` (tenant-approved, time-boxed, non-clinical), role `app_operator` with privileges on tenant and platform tables only. [TEN-07] Test: privilege test shows `app_operator` cannot SELECT any clinical or patient table.
- [ ] 1.93 `modules/operator`: password plus mandatory TOTP without grace, separate `osid` cookie, routes only on `PLATFORM_HOST` (404 elsewhere). [TEN-07, TEN-02] Test: tenant users cannot reach `/operator/*`.
- [ ] 1.94 `POST /operator/tenants {name, ownerEmail, isDemo?}`: auto-generated slug (random suffix on collision), tenant key, default settings, owner `staff_invitation`; `is_demo` settable only here. `POST /operator/tenants/:id/demo-reset` for demo tenants. All audited at platform level. [ONB-01, TEN-01, DEM-01] Test: slug collision invisible to the caller; `isDemo` cannot change later.
- [ ] 1.95 Support access: using a `support_grant` requires an active unexpired grant and is audited per use. [TEN-07] Test: no grant means denied; expired grant denied.

## S1.27 Web foundation (~400 lines)

Depends: S0.05, S1.10, S1.25.

- [ ] 1.96 `apps/web/src/app/{router.tsx,providers.tsx}` (TanStack Router and Query) and `shared/lib/api-client.ts` (fetch, problem+json parsing, request id capture, 401 redirect, 402 sets the read-only state); query cache cleared on logout and tenant switch. [SHL-06, SHL-09] Test: client unit tests per status class.
- [ ] 1.97 i18n: `app/i18n.ts` (i18next), `locales/es-AR/{common,auth,errors}.json`, error-code to message mapping, `shared/lib/format.ts` (`Intl` es-AR, location time zone, money); ESLint rule against literal JSX strings in the web preset of `packages/config`. [SHL-05] Test: lint fixture with a literal string fails; formatter tests.
- [ ] 1.98 Boot payload loader and theme injection before first paint (`index.html` inline script, `app/theme-boot.ts`, neutral fallback). [BRD-02] Test: Vitest checks CSS variables; Playwright asserts variables set at `DOMContentLoaded`.
- [ ] 1.99 Lint rule forbidding `persistQueryClient` and storage of query data. [SHL-09] Test: lint fixture fails.

## S1.28 Shared UI and UX states (~400 lines)

Depends: S1.27.

- [ ] 1.100 Run `ui-ux-pro-max --design-system "health clinic SaaS scheduling" -p "Aillu"`, record the result in `docs/design-system.md`, define tokens in `apps/web/src/styles/tokens.css` (slate neutral, blue/teal primary, Inter with tabular numbers, radius up to 8 px, dark mode) and the "Aillu" demo preset in `shared/ui/themes/consultorio.ts`. [BRD-01, SHL-07] Test: contrast check of all token pairs.
- [ ] 1.101 Add shadcn components into `apps/web/src/shared/ui` (Button, Input, Label, Dialog, Sheet, Select, Tabs, Toast, Table, Skeleton, Badge, Card, rhf Form wrappers). [SHL-07] Test: component smoke tests with axe.
- [ ] 1.102 State components `EmptyState`, `ErrorState` (retry plus request id), `ForbiddenState`, `OfflineBanner`, `ReadOnlyBanner`, `TwoFactorRequiredState`, `LoadingSkeleton`, plus `StatusBadge` (icon and text) and `SafetyFlag`. [SHL-06, SHL-07] Test: Testing Library plus axe per component.
- [ ] 1.103 Accessibility utilities: 44 px touch target class, focus ring tokens, `prefers-reduced-motion`. [SHL-07, SHL-02] Test: Playwright smoke at 360 px with axe.

## S1.29 AppShell, navigation and guards (~400 lines)

Depends: S1.28.

- [ ] 1.104 `app/nav/nav-config.ts` derived from the permission set returned by `GET /auth/me` (professional, reception, owner/admin layouts from design section 8) and `app/guards.tsx` `RequirePermission`. [SHL-01, AUZ-02] Test: unit per role.
- [ ] 1.105 `app/AppShell.tsx`: collapsible sidebar on desktop, bottom navigation with at most 5 items plus "More" at 360 px, header with tenant name and logo, user menu; scaffolds of the minimal `/portal` and `/book/{slug}` shells. [SHL-01, SHL-02] Test: Playwright nav items per role at 360 and 1280 px.
- [ ] 1.106 Banner wiring (read-only, offline, 2FA enrollment required) and the `FirstRunSlot` component that renders nothing until Stage 2. [SHL-08, SHL-06] Test: each state renders on the matching signal.

## S1.30 PWA (~250 lines)

Depends: S1.29.

- [ ] 1.107 `vite.config.ts` PWA: precache the app shell only, `navigateFallback`, runtime `NetworkOnly` for `/api` and `/files`, manifest from the per-host endpoint, update prompt. [SHL-03, SHL-09] Test: unit check of the generated Workbox config.
- [ ] 1.108 Playwright: manifest valid and service worker registered; offline shows the banner and never serves cached `/api` data. [SHL-03, SHL-09] Test: that spec.
- [ ] 1.109 `lighthouserc.json` budget (mobile 4G profile, LCP under 2.5 s, performance at least 0.85) and a CI job. [SHL-04] Test: CI job fails when the budget is broken.

## S1.31 Auth screens (~400 lines)

Depends: S1.29, S1.13, S1.14.

- [ ] 1.110 `features/auth/*`: login, TOTP step, recovery-code entry, forgot and reset password, invitation accept with password-policy hints; generic error copy. [IDA-02, IDA-08, STF-01] Test: component tests.
- [ ] 1.111 2FA enrollment (QR via `qrcode`, manual key, confirm code, recovery codes shown once with copy/download), grace banner, sessions page with revoke. [IDA-05, IDA-07] Test: component tests.
- [ ] 1.112 Playwright journeys: login to 2FA to landing; generic lockout message; reset flow reading Mailpit's API; axe on each screen at 360 px. [IDA-02, IDA-04, IDA-08] Test: those specs.

## S1.32 Staff screens (~400 lines)

Depends: S1.31, S1.19, S1.18.

- [ ] 1.113 `features/staff/*`: directory, invite dialog (role ceiling), deactivate, location assignment, professional profile form (matricula with jurisdiction, specialties, "unverified" badge), grantable-permission editor (clinical toggles absent). [STF-01, STF-03, STF-04, STF-05, STF-07, AUZ-12] Test: component tests.
- [ ] 1.114 `features/staff/components/WeeklyHours.tsx` per location (mobile friendly) and `features/settings/locations`. [STF-06, TEN-04] Test: validation messages in Spanish.
- [ ] 1.115 Playwright: owner invites reception; reception opening the staff page sees the forbidden state. [STF-02] Test: that spec.

## S1.33 Patient screens (~400 lines)

Depends: S1.31, S1.20, S1.21, S1.22.

- [ ] 1.116 `features/patients/*`: `PatientPicker` (DNI or name), list, create form with shared Zod DNI/CUIT validation, duplicate-409 flow, deactivate, consent capture prompt. [PAT-01, PAT-02, PAT-04, PAT-08, PAT-10] Test: component tests.
- [ ] 1.117 Patient detail: demographics, coverage, representative, rights requests, version history, `SafetyFlag` ("see professional" for non-professionals), assignment actions. [PAT-05, PAT-07, PAT-09, PAT-11, PAT-12, AUZ-10] Test: component tests.
- [ ] 1.118 Anamnesis form (professional only). Test: Playwright, reception sees no anamnesis, professional does; axe. [PAT-06]

## S1.34 Audit and settings screens (~350 lines)

Depends: S1.31, S1.23, S1.25, S1.18.

- [ ] 1.119 `features/audit/*`: filterable event table, patient access report, export button. [AUD-06, AUD-07] Test: component tests.
- [ ] 1.120 `features/settings/branding` (live contrast warning showing requested and effective colors, logo upload, preview) and `features/settings/security` (require 2FA, reception-metadata toggle, sharing toggle with explicit psychology confirmation). [BRD-01, BRD-03, BRD-05, AUZ-07, AUZ-11] Test: component tests.
- [ ] 1.121 Playwright: a branding change applies after reload without flash; a second tenant keeps its own theme. [BRD-02] Test: that spec.

## S1.35 Operator console UI (~300 lines)

Depends: S1.26, S1.31.

- [ ] 1.122 `features/operator/*` (platform host only): operator login with TOTP, tenant list, create-tenant form (owner email, demo toggle at creation only), demo reset button. [TEN-07, ONB-01, DEM-01] Test: Playwright creates a tenant and the owner invitation appears in Mailpit.

## S1.36 Demo tenant scaffold (~400 lines)

Depends: S1.26, S1.19, S1.21.

- [ ] 1.123 `db/seed/demo/` deterministic seed runner `seedDemoTenant(tx, tenantId, clock)` (seeded RNG, fixed faker seed): one user per role with role-labelled sign-in, several locations, multi-specialty professionals, reception, patients with coverage, the "Aillu" theme. [DEM-01, DEM-02, DEM-04, DEM-06] Test: two runs produce identical logical content.
- [ ] 1.124 Migration with `demo_reset(tenant_id)` (`SECURITY DEFINER`, own role, raises unless `is_demo`) that removes demo rows including the demo audit chain; job `demo.reset` re-seeds; writes platform audit `demo.chain_reset` with the last sealed hash; demo credentials rotated on each reset. [DEM-05, DEM-06, DEM-07, TEN-10] Test: refuses a non-demo tenant; tenant roles cannot call it; real tenants' chain still verifies after a reset.
- [ ] 1.125 `main/adapter-resolver.ts`: per-tenant adapter selection that throws when `tenant.is_demo` and the adapter is not a fake; registry of all ports (email, object storage, key management now). [DEM-03] Test: iterates every registered port.
- [ ] 1.126 `apps/api/test/policy/no-delete.test.ts`: static scan failing on any `DELETE` or `.delete(` against tenant tables outside the 4 listed exceptions (allowlist file with justification). [TEN-10] Test: that file.
- [ ] 1.127 Reset timing test (realistic dataset, budget 30 s in CI against the 60 s requirement) and a "module without seed data" gap check. [DEM-05, DEM-04] Test: that file.

## S1.37 Stage 1 gate (~200 lines)

Depends: all S1 slices.

- [ ] 1.128 `apps/web/e2e/stage1-demo.spec.ts`: two tenants with different branding, role-specific views, audit trail visible. [TEN-01, BRD-02] Test: that spec.
- [ ] 1.129 `docs/security/asvs-l2-stage1.md` checklist with evidence links, then a fresh-context security review (`judgment-day`) of identity, authz, RLS, audit; fix findings before Stage 2. Test: review report attached to the PR.
- [ ] 1.130 Re-run `sdd-init`; decide strict TDD for Stage 2 apply. Test: none.

---

# Stage 2: Practice core

Goal: a solo professional books a first appointment within 10 minutes; a multi-professional center runs a full day; legacy is removed. Order: scheduling backend (S2.01 to S2.11), scheduling web (S2.12 to S2.16), clinical backend (S2.17 to S2.21), clinical web (S2.22 to S2.24), documents (S2.25 to S2.28), onboarding (S2.29, S2.30), gate (S2.31 to S2.34). Note: payment collection is Stage 4.

## S2.01 Appointment types, blocks, days off (~350 lines)

Depends: Stage 1.

- [ ] 2.1 `db/schema/scheduling-config.ts` + migration: `appointment_type` (duration, buffer, virtual, requires approval, color, active), `schedule_block`, `tenant_day_off`; register fixtures. [SCH-02, SCH-07] Test: isolation suite covers the tables.
- [ ] 2.2 `modules/scheduling` API for types, blocks, days off (permission `scheduling.configure`, deactivate not delete, audited). [SCH-02, SCH-07, SCH-14] Test: integration CRUD plus denials.
- [ ] 2.3 `application/holidays.ts` merging `holiday_catalog` with `tenant_day_off`, and the operator catalog API `/operator/holidays` (platform audit). [SCH-07, CTR-05] Test: moved holiday needs no release; operator-only.

## S2.02 Appointment and occupancy schema (~400 lines)

Depends: S2.01.

- [ ] 2.4 `db/schema/scheduling.ts` + migration: `appointment` (all design 3.3 columns incl. `version`, `identity_confirmed`), `appointment_event`, `slot_hold`, `slot_occupancy` with the `btree_gist` exclusion constraint (`tenant_id`, `professional_id`, `lane`, `during`) and a constraint trigger `lane <= max_simultaneous`. [SCH-03, SCH-04, SCH-05] Test: constraint rejects an overlap in one lane.
- [ ] 2.5 Triggers keeping `slot_occupancy` in sync (active for pending_approval, scheduled, confirmed, checked_in, in_progress, attended and active holds; no_show and cancelled free it). [SCH-04, SCH-11] Test: transition table toggles `active` correctly.
- [ ] 2.6 Concurrency test: N parallel connections book the same professional and slot, exactly one wins and the rest get `23P01`; back-to-back is allowed; buffer counts inside the range. [SCH-04] Test: that file.

## S2.03 Lane assignment domain and time zones (~350 lines)

Depends: S2.02.

- [ ] 2.7 `modules/scheduling/domain/lanes.ts`: `assignLane` and greedy `relane` (pure). [SCH-04] Test: unit tables.
- [ ] 2.8 Property tests (fast-check): random interval sets never exceed capacity, no overlap per lane, `relane` fits whenever feasible. [SCH-04] Test: that file.
- [ ] 2.9 `domain/time.ts`: location time zone conversions with DST gap and overlap handling (use a maintained library such as luxon). [SCH-08] Test: spring-forward and fall-back cases in a DST zone.

## S2.04 Booking service (~400 lines)

Depends: S2.03, S2.01.

- [ ] 2.10 `application/book-appointment.ts` inside `withTenant`: read-only check, lock the professional row `FOR UPDATE`, expire stale holds, validate working hours, blocks, holidays, overlap at another location, past-date rule (`scheduling.register_past`), out-of-hours override with reason (`scheduling.override_hours`), lane assignment, `23P01` mapped to `409 slot_taken`. [SCH-03, SCH-04, SCH-06] Test: unit with ports stubbed.
- [ ] 2.11 `domain/free-slots.ts` used for the 409 body (next free slots). [SCH-03, SCH-04] Test: next slots exclude blocks and occupancy.
- [ ] 2.12 `POST /api/v1/appointments` with contracts in `packages/contracts/src/scheduling.ts`; writes `appointment_event` and audit `appointment.created`. [SCH-03, SCH-06, SCH-07, SCH-14] Test: integration: golden path, overlap, capacity 2, out-of-hours with and without grant, block, holiday, other-location overlap, buffer.

## S2.05 Lifecycle: statuses, reschedule, cancel (~400 lines)

Depends: S2.04.

- [ ] 2.13 `domain/appointment-state-machine.ts`: the 8 statuses and the transition table. [SCH-11] Test: exhaustive pair test (every from/to combination).
- [ ] 2.14 `application/transition.ts` plus routes to confirm, check in, start, attend, no-show and cancel (reason, actor kind); writes `appointment_event`; optimistic `version`. [SCH-10, SCH-11] Test: integration per transition; `attended` is terminal.
- [ ] 2.15 `POST /appointments/:id/reschedule` and reassign (revalidate, version check, event kind `rescheduled`/`reassigned`, hook to rotate `video_room` and revoke tokens). [SCH-09] Test: version conflict returns 409; rescheduled count derivable from events.
- [ ] 2.16 Cancellation allowed in a read-only tenant, scheduling and rescheduling refused. [SCH-10, SCH-15] Test: read-only inject matrix.

## S2.06 Reception worklist (~300 lines)

Depends: S2.02.

- [ ] 2.17 `db/schema/worklist.ts`: `worklist_item` with the 6 canonical kinds, subject, location, status, encrypted detail, resolver; no delete. [SCH-13] Test: isolation suite; invalid kind rejected.
- [ ] 2.18 `modules/scheduling/worklist/index.ts` `openItem`/`resolve` and routes `GET /worklist`, `POST /worklist/:id/resolve|dismiss` (permission `worklist.manage`, filtered by the user's locations, audited). [SCH-13, AUZ-13] Test: location filtering; idempotent open.
- [ ] 2.19 Activate `eslint-plugin-boundaries` for `modules/*` (cross-module imports only through `index.ts`). Test: lint fixture that reaches into another module's internals fails.

## S2.07 Identity confirmation (D14, D18) (~350 lines)

Depends: S2.06, S2.05.

- [ ] 2.20 `domain/identity-confirmation.ts`: initial value rules (existing patient plus online match or booking actor equals the appointment's professional), eligibility to confirm, solo condition (exactly one active professional and no other active membership) behind a port. [SCH-03, SCH-11, PAT-03] Test: truth table.
- [ ] 2.21 Booking path sets `identity_confirmed = false` when required and opens an `identity_review` item; `POST /worklist/:id/confirm-identity` refuses the appointment's own professional. [PAT-03] Test: matrix of who may confirm.
- [ ] 2.22 Check-in confirmation: staff other than the professional sets `staff`; the sole professional may set `self_confirmed` only through the in-person check-in action, audited as `appointment.identity.self_confirmed`, evaluated in the same transaction. [SCH-11] Test: reception, other professional, own professional with and without other staff; a staff member joining later keeps earlier self-confirmations valid.
- [ ] 2.23 `POST /appointments/:id/detach-patient` (move to a new patient or cancel; the matched record is untouched). [PAT-03] Test: matched patient unchanged.

## S2.08 Care relationship triggers (D2, D14, D15) (~350 lines)

Depends: S2.02, S1.17.

- [ ] 2.24 Migration: trigger on `appointment` and function `app.recompute_care_relationship` counting only statuses scheduled, confirmed, checked_in, in_progress, attended, no_show with `identity_confirmed = true` (never pending_approval or cancelled). The encounter trigger comes with the clinical schema (task 2.52). [AUZ-09, SCH-11] Test: see 2.25.
- [ ] 2.25 Integration matrix with the `test_clinical_item` fixture and real RLS: unconfirmed online match gives no access; confirmation gives access; confirmed no-show counts; unconfirmed no-show does not; pending_approval and cancelled do not; reassignment moves the relationship. [AUZ-09, SCH-11] Test: that file.

## S2.09 Slot holds (~300 lines)

Depends: S2.04.

- [ ] 2.26 `application/holds.ts`: create (staff origin now, public in Stage 3), per-source bound (release oldest), expiry, staff override marks the hold `invalidated`, conversion to appointment; job `hold.expire` (marks `expired`, no waitlist trigger). [SCH-05] Test: unit and integration.
- [ ] 2.27 Capacity-1 helper for public flows (`requireNoActiveOverlap`) and the `409 slot_no_longer_available` path after an override. [SCH-05, SCH-04] Test: integration of override then confirm.

## S2.10 Availability and recurring series (~350 lines)

Depends: S2.04.

- [ ] 2.28 `GET /api/v1/availability?professionalId&from&to&typeId` computing hours minus blocks minus holidays minus occupancy in the location time zone. [SCH-01, SCH-06] Test: per-scenario cases including buffer.
- [ ] 2.29 `POST /appointments/series` as dry run plus commit with a skip list; each occurrence validated independently and individually reschedulable and cancellable. [SCH-12] Test: the two spec scenarios (one conflict, cancel one occurrence).

## S2.11 Scheduling authorization, audit, read-only (~300 lines)

Depends: S2.05.

- [ ] 2.30 Register scheduling permissions (`book`, `view`, `configure`, `override_hours`, `register_past`, `delegated_calendar`) and enforce delegated-calendar scope in `can`. [SCH-14, AUZ-12] Test: professional edits only their own calendar unless delegated.
- [ ] 2.31 Read-only categories on every scheduling route; booking in a read-only tenant returns 402, cancellation succeeds. [SCH-15] Test: `route-categories` stays green; inject matrix.
- [ ] 2.32 Audit action catalogue `appointment.*` and registration in the audit-coverage test. [SCH-14] Test: coverage test green.
- [ ] 2.33 `GET /appointments?from&to&professionalIds&locationId` calendar feed with administrative data only; reception filtered by membership locations. [SCH-01, SCH-14] Test: response contains no clinical fields.

## S2.12 Calendar view (~400 lines)

Depends: S2.11, Stage 1 web.

- [ ] 2.34 `shared/ui/calendar/CalendarView.tsx`: presentational wrapper over react-big-calendar (day, week, month, resource columns per professional, location time zone, keyboard-accessible list fallback). Record the Q6 decision (polish versus a custom grid) in `docs/adr/calendar.md`. [SCH-01] Test: component tests for resource columns.
- [ ] 2.35 `features/calendar/{api,containers}`: query keys, `useCalendar` hook (range, location and professional filters), status legend with `StatusBadge` (never color only). [SCH-01] Test: hook tests.
- [ ] 2.36 Playwright at 360 px: day view default on mobile with an agenda list. [SCH-01, SHL-02] Test: that spec.

## S2.13 Booking UI (~400 lines)

Depends: S2.12, S2.10.

- [ ] 2.37 `features/calendar/components/BookingDialog` with `PatientPicker`, `SlotGrid`, type select, out-of-hours override reason, and handling of `409 slot_taken` with next slots. [SCH-03, SCH-06] Test: component tests.
- [ ] 2.38 Drag to move and resize, optimistic with rollback on 409 and an undo toast. [SCH-09] Test: component test of rollback.
- [ ] 2.39 Playwright: reception books an existing patient in 30 seconds or less (step count asserted); overlap conflict message. [SCH-03] Test: that spec.

## S2.14 Appointment drawer (~400 lines)

Depends: S2.13, S2.07.

- [ ] 2.40 `AppointmentDrawer`: only valid transitions shown, check-in step with identity confirmation (ID document prompt, solo self-confirm wording), cancel with reason, reschedule, event history. [SCH-11, SCH-10, SCH-09] Test: component tests per status.
- [ ] 2.41 Recurring series UI with a conflict review table (skip or abort). [SCH-12] Test: component test.
- [ ] 2.42 Playwright full day: book, confirm, check in, start, attend; axe. [SCH-11] Test: that spec.

## S2.15 Worklist, Today and Check-in views (~350 lines)

Depends: S2.14, S2.06.

- [ ] 2.43 `features/worklist/*`: list by location, kind filters, nav badge, resolve and dismiss; `identity_review` shows submitted versus on-file differences. [SCH-13] Test: component tests.
- [ ] 2.44 Professional "Today" view and reception "Check-in" view. [SHL-01, SCH-11] Test: Playwright role matrix.

## S2.16 Scheduling settings UI (~400 lines)

Depends: S2.12.

- [ ] 2.45 `features/settings/scheduling`: appointment types, blocks, days off, overbooking `max_simultaneous` per professional (at least 2 requires confirmation), holiday viewer. [SCH-02, SCH-04, SCH-07] Test: component tests.
- [ ] 2.46 `features/operator/holidays` catalog editor. [SCH-07, CTR-05] Test: Playwright as operator.

## S2.17 Clinical schema and immutability triggers (~400 lines)

Depends: S1.17, S1.22, S2.08.

- [ ] 2.47 `db/schema/clinical.ts` + migration: `encounter`, `clinical_note`, `note_version`, `addendum`, all with `clinicalPolicies`, composite FKs, `REVOKE DELETE`. [CLN-01, CLN-03, CLN-04, CLN-05] Test: isolation suite; `app_rw` cannot delete.
- [ ] 2.48 Triggers: signed content immutable, `visibility` change blocked after draft, `addendum` insert-only, `entered_in_error` keeps content. [CLN-03, CLN-04, AUZ-11] Test: each rejected as `app_rw`.
- [ ] 2.49 Encounter trigger feeding `care_relationship` (extends task 2.24). [AUZ-09] Test: an encounter creates the relationship.
- [ ] 2.50 Register clinical tables in the isolation fixtures and audit-coverage registry. [TEN-03, CLN-12] Test: both suites green.

## S2.18 Draft and sign (~400 lines)

Depends: S2.17.

- [ ] 2.51 `modules/clinical/domain/note.ts` state machine and `application/save-draft.ts` (encrypt with the tenant DEK, `draft_revision` compare-and-set, `409 stale_revision`). [CLN-03] Test: stale save rejected.
- [ ] 2.52 `application/sign-note.ts`: insert `note_version` with SHA-256 content hash, status `signed`, audit `clinical.note.signed`; author only, professional gate required. [CLN-03, CLN-05] Test: second sign fails; hash matches content.
- [ ] 2.53 Routes `POST /encounters`, `PUT /encounters/:id/note/draft`, `POST /notes/:id/sign`, `GET /notes/:id` (decrypt and audit every read) with permission `clinical.note.write|read`. [CLN-01, CLN-02, CLN-12] Test: golden path.
- [ ] 2.54 Access tests: owner/admin get 403 plus a deny audit row, reception denied, direct SQL returns 0 rows, other professional without relationship denied; the admin-denied harness (task 1.56) now covers real routes. [CLN-02] Test: that file.

## S2.19 Addenda, errors, history (~400 lines)

Depends: S2.18.

- [ ] 2.55 `application/add-addendum.ts`: treating professionals only; kinds `correction` and `rectification`; a read-only tenant allows `rectification` only (D16); shared readers get 403 plus a deny audit. [CLN-04, TEN-11] Test: scenarios from the spec.
- [ ] 2.56 `mark-entered-in-error` (author or another treating professional, reason required, content kept, hidden from the default timeline). [CLN-04] Test: content still readable in history.
- [ ] 2.57 `GET /notes/:id/versions` returning signed versions and addenda in order with hashes. [CLN-05] Test: order and hashes.
- [ ] 2.58 Shared-read audit with reason `shared`. [CLN-12, AUZ-11] Test: audit row has the reason.

## S2.20 Specialty templates (~400 lines)

Depends: S2.18.

- [ ] 2.59 `packages/contracts/src/clinical-templates/` Zod schemas for general, psychology, physiotherapy, nutrition and odontogram payloads plus the template registry. [CLN-06, CLN-07, CLN-08, CLN-09, CLN-10] Test: valid and invalid fixtures per template.
- [ ] 2.60 `modules/clinical/domain/templates.ts`: validate content by `templateKind` on save and sign; default `sharedTemplates` consumption. [CLN-06] Test: unknown kind rejected.
- [ ] 2.61 Odontogram data model (FDI numbering, surfaces, conditions) validation. [CLN-07] Test: invalid tooth number rejected.
- [ ] 2.62 Psychology exclusion from default sharing verified end to end. [CLN-08] Test: psychology note invisible to a sharing-scope reader by default.

## S2.21 Timeline, search, retention (~400 lines)

Depends: S2.19.

- [ ] 2.63 `GET /patients/:id/clinical/timeline` (newest first, `entered_in_error` hidden unless requested, only readable entries, link to anamnesis). [CLN-11, CLN-02] Test: hidden by default; shown on request.
- [ ] 2.64 `GET /patients/:id/clinical/search?q=&from=&to=`: decrypt in memory, normalize (NFD, lowercase), substring match, cap of 2,000 entries, audit per entry returned. [CLN-02, CLN-11, CLN-12] Test: accent-insensitive; beyond the cap requires a range; one DEK unwrap per request.
- [ ] 2.65 pino redaction test proving clinical routes never log bodies. [CLN-11, SHL-09] Test: log capture.
- [ ] 2.66 Retention: clinical data stays readable in a read-only tenant and after deactivation; register the clinical export contributor (per professional). [CLN-13, TEN-08] Test: read-only tenant can read; `REVOKE DELETE` verified.

## S2.22 Clinical editor UI (~400 lines)

Depends: S2.21, S2.15.

- [ ] 2.67 `features/clinical/components/ClinicalEditor` (template-driven, react-hook-form with contract schemas, debounced autosave with a "Saved" indicator, stale-revision prompt, sign confirmation warning about immutability). [CLN-01, CLN-03] Test: component tests.
- [ ] 2.68 Encounter screen opened from Today and the appointment drawer; `author_only` toggle available at creation and while draft only. [CLN-03, CLN-02] Test: toggle disabled after signing.
- [ ] 2.69 Playwright: autosave, stale 409 with two tabs, signed note locked. [CLN-03] Test: that spec.

## S2.23 Specialty UIs and odontogram (~400 lines)

Depends: S2.22.

- [ ] 2.70 `features/clinical/templates/{psychology,physiotherapy,nutrition}` components. [CLN-08, CLN-09, CLN-10] Test: component tests.
- [ ] 2.71 `Odontogram` component (SVG, keyboard accessible, FDI, mobile friendly). [CLN-07] Test: component plus axe.

## S2.24 Chart, search and addenda UI (~350 lines)

Depends: S2.22.

- [ ] 2.72 Patient chart tab: timeline, anamnesis link, `entered_in_error` styling, versions drawer. [CLN-11, CLN-05] Test: component tests.
- [ ] 2.73 `ClinicalSearch` (per patient, date range, snippets) and the professional's "Drafts" view. [CLN-02, CLN-11] Test: component tests.
- [ ] 2.74 Addendum and entered-in-error dialogs (reason required); reception and admin see the forbidden state. [CLN-04, CLN-02] Test: Playwright role matrix.

## S2.25 Malware scanner and file sniffing (~300 lines)

Depends: S1.24.

- [ ] 2.75 `platform/scanning/malware-scanner.ts` port, `adapters/clamav/clamd-client.ts` (INSTREAM over TCP, timeouts, chunking) and a fake scanner that flags the EICAR string. [DOC-02] Test: unit against a fake clamd server; integration with the compose ClamAV (slow tag).
- [ ] 2.76 `platform/files/sniff.ts`: magic-byte detection for PDF, JPEG, PNG, WebP, text and DOCX; reject executables, scripts and archives. [DOC-02] Test: polyglot and renamed-executable fixtures.

## S2.26 Upload pipeline (~400 lines)

Depends: S2.25, S2.17.

- [ ] 2.77 `db/schema/documents.ts` + migration (status `quarantined|available|rejected|hidden`, sha256, scan result, category, encounter/appointment link, replacement link) with RLS and classification. [DOC-01, DOC-04, DOC-05] Test: isolation suite.
- [ ] 2.78 `POST /documents/uploads` returning a presigned POST (20 MB `content-length-range`, content type), at most 10 files per request, tenant and uploader from the session, key `t/{tenantId}/quarantine/{uuid}`; a patient of another tenant returns not found. [DOC-01, DOC-02, DOC-03] Test: 11 files rejected, cross-tenant 404.
- [ ] 2.79 Job `document.scan`: sniff, hash, stream to ClamAV, fail closed with backoff and an alert after 1 hour; clean moves to `t/{tenantId}/docs/{uuid}` and becomes `available`; infected or wrong type becomes `rejected` and the uploader is notified. [DOC-02, DOC-06] Test: EICAR rejected, scanner down stays quarantined, renamed executable rejected.

## S2.27 Download and lifecycle (~400 lines)

Depends: S2.26.

- [ ] 2.80 `POST /documents/:id/download-link` and `GET /files/:token` per design 5.6 (token kind `document_download`, bound to the session, 5 minutes, single use, authz re-run at redemption, `nosniff`, `no-store`, sanitized disposition). [DOC-03] Test: expiry, reuse, other session, access lost meanwhile.
- [ ] 2.81 Classification rules: clinical documents follow clinical read rules, administrative ones are visible to reception, `reception_sees_clinical_metadata` exposes metadata only, admins never see clinical documents. [DOC-04, AUZ-07, AUZ-06] Test: role matrix.
- [ ] 2.82 Replace and hide (original retained, never deleted), duplicate detection by sha256 per patient (warning), cleanup job `document.cleanup` for abandoned uploads (marks rows abandoned, may delete orphan objects, never table rows). [DOC-05, DOC-06] Test: replace keeps the original; duplicate warning.
- [ ] 2.83 Lists return metadata only; `REVOKE DELETE` on `document`. [DOC-03, DOC-07] Test: list payload has no content fields.

## S2.28 Documents UI (~300 lines)

Depends: S2.27.

- [ ] 2.84 `features/documents/*`: multi-file upload with progress and Spanish rejection reasons, patient document list with status chips ("Scanning"), download via the link flow, hide and replace. [DOC-01, DOC-03, DOC-05] Test: component tests.
- [ ] 2.85 Documents export contributor and retention note. [DOC-07, TEN-08] Test: registry test lists documents.

## S2.29 Onboarding backend (~400 lines)

Depends: S1.26, S2.01, S1.19.

- [ ] 2.86 `db/schema/onboarding.ts` (step progress, wizard completed, checklist dismissed) and `modules/onboarding` API `GET|PUT /onboarding/state` limited to owner (and explicitly granted admins). [ONB-03, ONB-07] Test: professional, reception and patient denied.
- [ ] 2.87 Tenant defaults and initial roles: country AR, time zone, es-AR, first user owner; the "are you a professional?" step creates the owner's professional profile or leaves them without clinical access. [ONB-02, AUZ-04] Test: both scenarios of the spec.
- [ ] 2.88 `POST /onboarding/fast-path`: creates a location, Monday to Friday hours and a 30-minute default appointment type, no matricula required. [ONB-04] Test: ready to book afterwards.
- [ ] 2.89 `application/checklist.ts` computing items from real data (location, hours, type, first patient, first appointment, matricula, invite staff, branding) and hiding items of unavailable capabilities. [ONB-05] Test: item completes from data without a click.
- [ ] 2.90 Staff invitation from the first run (inviter's ceiling, plan-impact hook that does nothing until subscriptions) and audit of tenant creation, wizard changes and dismissal; `/auth/me` returns `needsWizard`. [ONB-06, ONB-07, ONB-01] Test: invitation grants only the invited role; first sign-in lands in the wizard.

## S2.30 Onboarding UI (~400 lines)

Depends: S2.29, S2.16.

- [ ] 2.91 `features/onboarding/*` wizard: profile and branding, first location, professionals and invitations, working hours, appointment types; resumable, inline Spanish validation, required steps block completion, skippable optional steps, fast-path chooser. [ONB-03, ONB-04, ONB-08] Test: component tests.
- [ ] 2.92 `FirstRunChecklist` in the AppShell slot (owner/admin only, dismissible, reachable from Help, items link to the screen that completes them). [ONB-05, SHL-08, ONB-08] Test: component tests.
- [ ] 2.93 Playwright at 360 px: resume at step 3, skip branding keeps the default, reception sees no checklist, non-owner is denied the wizard. [ONB-03, ONB-05, ONB-07] Test: that spec.

## S2.31 Stage 2 end-to-end and demo data (~400 lines)

Depends: S2.30, S2.28, S2.24, S2.16.

- [ ] 2.94 Demo seed extension `db/seed/demo/stage2.ts`: appointments in all 8 statuses, encounters, notes, odontogram, documents (fake PDFs through the fake scanner), worklist items, completed onboarding; every module registers a seed contributor. [DEM-04, DEM-02] Test: gap check fails for a module without a contributor.
- [ ] 2.95 `e2e/stage2-solo.spec.ts` (operator creates tenant, owner invitation from Mailpit, fast path, register patient, book, all at 360 px with a recorded timing under 10 minutes) and `e2e/stage2-center.spec.ts` (multi-professional full day). [ONB-04, SCH-03] Test: those specs.
- [ ] 2.96 Reset timing re-test with Stage 2 data. [DEM-05] Test: under 60 s.
- [ ] 2.97 Benchmark `clinical_readable` with 100k seeded notes; record the result in `docs/perf/clinical-readable.md` and fix the index if the target is missed (design risk table). Test: benchmark script.

## S2.32 Delivery pipeline and backups (~300 lines)

Depends: S2.31. May slip to Stage 3 without blocking the Stage 2 gate. Blocked by decision Q1 (region).

- [ ] 2.98 `.github/workflows/deploy.yml`: push the image to ECR and deploy staging on `master`, run migrations as a one-off task first, tags deploy to production behind a manual approval environment. Infrastructure provisioning is out of scope here and is documented in `docs/runbooks/deploy.md`. Test: dry-run on a fork.
- [ ] 2.99 `docs/runbooks/backup-restore.md` (PITR, weekly logical dump, quarterly restore drill). Test: drill checklist.

## S2.33 Stage 2 gate (~150 lines)

Depends: S2.31.

- [ ] 2.100 Fresh-context review (`judgment-day`) of scheduling concurrency, clinical access and the documents pipeline; fix findings. Test: review report attached.
- [ ] 2.101 `docs/legacy-parity.md` mapping legacy domains (auth, pacientes, profesionales, turnos, horarios, atencion, historias clinicas, asistencias) to the new features; facturacion and recetas stay reference-only until Stages 4 and 5 and remain recoverable from the legacy repository. Owner signs off. Test: checklist.

## S2.34 Legacy removal (N/A: legacy lives in a separate repo)

Not applicable: the legacy reference app lives in the separate archived repository `francocor/AppmedicoCMAillu`, so there is nothing to tag or remove in this repository. Tasks 2.102 and 2.103 are closed as N/A.

- [x] 2.102 N/A: legacy lives in a separate repo (`francocor/AppmedicoCMAillu`, archived). There is no legacy code here to tag.
- [x] 2.103 N/A: legacy lives in a separate repo (`francocor/AppmedicoCMAillu`, archived). There is no legacy code here to remove.

---

# Stage 3: Patient engagement (to be refined before apply)

Goal: a patient books online, receives a WhatsApp reminder and confirms. Depends on Stage 2 (scheduling, worklist, tokens) and on the WhatsApp Business verification started in S1.00. Not refined: file names, task counts and line estimates are provisional.

| Slice | Covers | Key tasks |
|---|---|---|
| S3.01 Notifications core (~400) | `notifications` | Message and template schema; native SES `EmailSender` adapter; channel policy in code (email-only kinds); send pipeline with `reminder.send`; tenant status re-check (cancelled with `tenant_read_only`, `demo_tenant`). |
| S3.02 Reminder scheduling (~400) | `notifications` | Jobs at T-24h dropping stale versions; quiet hours in the location time zone; worklist producers `reminder_not_sent` and `reminder_not_delivered`. |
| S3.03 Public action tokens (~400) | `notifications`, tokens | All token kinds from design 4.5; `/public/t/{token}` routes for confirm, cancel, reschedule, opt-out; revocation on reschedule. Depends: S3.01. |
| S3.04 WhatsApp adapter (~400) | `notifications` | Meta Cloud API sender on the platform WABA, templates, webhook with `X-Hub-Signature-256`, delivery status, inbound opt-out keywords, `reply_to_review`. Depends: S3.01, WhatsApp verification. |
| S3.05 Opt-in and metering (~350) | `notifications` | `channel_preference`; opt-in only via booking form, staff in person, or the emailed `whatsapp_opt_in` link; message metering and 80%/100% owner warnings. |
| S3.06 Messaging UI (~350) | `notifications` | `features/settings/messaging`, per-appointment message log, demo shows fake-adapter messages. |
| S3.07 Public availability and holds (~400) | `online-booking` | Public availability, per-professional links, Turnstile, capacity-1 public holds with per-source bound; generic "not available" page for read-only tenants. Depends: S2.09. |
| S3.08 Submission and OTP (~400) | `online-booking` | `booking_submission`, `otp_challenge`, `booking.purge` (retention exception 4), confirm creating the appointment and patient. |
| S3.09 Match and approval (~400) | `online-booking`, `patients` | D14 identity review on a document match, `pending_approval` worklist item, self-service reschedule and cancel, calendar file. |
| S3.10 Public booking UI (~400) | `online-booking` | `/book/{slug}` shell, slot picker, form, OTP, confirmation, 360 px, axe. |
| S3.11 Waitlist core (~400) | `waitlist` | Entries; triggers on cancellation, reschedule away and block removal; matching; offers with expiry. |
| S3.12 Waitlist offers and self-join (~400) | `waitlist`, `online-booking` | Offer token accept/decline, `waitlist_manual_contact` items, self-join with OTP. |
| S3.13 Waitlist UI (~350) | `waitlist` | Staff waitlist management and public join page. |
| S3.14 Teleconsultation backend (~400) | `teleconsultation` | `VideoLinkProvider` (Jitsi as a Service), random room rotating on reschedule or reassignment, `/public/v/{token}` redirector with join window, authenticated professional join. |
| S3.15 Teleconsultation UI (~300) | `teleconsultation` | Virtual appointment type, join button, link in reminders. |
| S3.16 Demo seed (~300) | `demo-tenant` | Engagement data (messages through the fake adapter, public booking sample, waitlist, virtual appointments). |
| S3.17 Public-route hardening (~300) | `identity-access`, `online-booking` | Public route allowlist test extension, rate-limit tuning, OTP abuse limits, pen-test checklist. |
| S3.18 Stage 3 gate (~200) | all | Demo e2e (book online, WhatsApp reminder, confirm), fresh review of public routes. |

Dependencies: S3.01 first; S3.02 to S3.06 follow it; S3.07 to S3.10 are independent of S3.01 to S3.06 except for opt-in capture (S3.05); S3.11 to S3.13 after S3.09; S3.14 and S3.15 independent after S3.03.

---

# Stage 4: Revenue (to be refined before apply)

Goal: reception closes the day's cash register and issues an invoice. Depends on Stage 2 and the AFIP certificate and homologation access started in S1.00.

| Slice | Covers | Key tasks |
|---|---|---|
| S4.01 Pricing (~400) | `billing-payments` | Private and payer price lists, plan coverage pricing, appointment type price. |
| S4.02 Charges (~400) | `billing-payments` | `charge` and `charge_line`, capture from check-in (D8), reception permission `cash.operate`. |
| S4.03 Payments and cash (~400) | `billing-payments` | Payments, methods, cash sessions per location, close and discrepancy. |
| S4.04 Billing UI (~400) | `billing-payments` | Charge capture, payment, cash register screens at 360 px. |
| S4.05 Exports (~350) | `billing-payments` | `export.build` for CSV, xlsx and PDF; administrative export contributor. |
| S4.06 Report read models (~400) | `reports-dashboard` | No-show rate = no-show / (attended + no-show), rescheduled from `appointment_event`, revenue, occupancy. |
| S4.07 Reports UI (~400) | `reports-dashboard` | Dashboard with lazily loaded charts. |
| S4.08 Invoice model (~400) | `e-invoicing-afip` | `invoice`, `invoice_line`, many-to-many invariant under `SELECT FOR UPDATE`, immutability triggers, credit notes. |
| S4.09 AFIP adapter (~400) | `e-invoicing-afip` | WSAA token cache per certificate, WSFEv1 client, encrypted certificate storage, per-POS environment. |
| S4.10 Issue job (~450) | `e-invoicing-afip` | `afip.issue` with reconcile-before-retry, `delivery_state`, backoff, outage flagging by age, manual entry for owner/admin. |
| S4.11 Invoice PDF and delivery (~350) | `e-invoicing-afip` | `@react-pdf/renderer` in the worker, QR, email delivery. |
| S4.12 Invoicing UI (~400) | `e-invoicing-afip` | Issue, state badges, credit notes, manual invoice. |
| S4.13 Fakes and homologation (~300) | `e-invoicing-afip`, `demo-tenant` | Deterministic fake issuer for demo, homologation smoke test, demo seed for revenue. |
| S4.14 Read-only interactions (~250) | `tenancy` | `afip.issue` jobs enqueued before `read_only_since` keep running; exports and reads allowed. |
| S4.15 Stage 4 gate (~200) | all | Demo e2e (close cash register, issue invoice in homologation); fresh review of money invariants. |

Dependencies: S4.01 to S4.03 sequential; S4.08 to S4.12 can start after S4.02; S4.06 after S4.03.

---

# Stage 5: Compliance and patient portal (to be refined before apply)

Goal: a patient signs consent and downloads a prescription from the portal. Depends on Stage 4 for invoices in the portal, and on the e-Rx provider chosen in S1.00 (Q3).

| Slice | Covers | Key tasks |
|---|---|---|
| S5.01 Matricula verification (~300) | `staff-professionals`, operator | Operator verification, no self-verification, audited. |
| S5.02 Consent templates (~400) | `informed-consent` | Versioned templates, generic label read model (title only for reception when the setting is on, never for non-clinical admin). |
| S5.03 Consent signing (~400) | `informed-consent` | Signature tied to template version and hash, staff-assisted signing, revocation (allowed in read-only). |
| S5.04 e-Rx backend (~450) | `e-prescription` | `PrescriptionProvider` port and adapter, `eRx.issue` gated on verified matricula, reads excluded from sharing (D17). |
| S5.05 e-Rx UI (~350) | `e-prescription` | Prescriptions view and issue flow. |
| S5.06 Portal identity (~400) | `patient-portal`, `identity-access` | `portal_identity`, `portal_link`, invitation activation. |
| S5.07 Portal sign-in (~400) | `identity-access` | Two-attribute registration, email OTP, `psid` session (30 min idle, 12 h absolute), same-response rules. |
| S5.08 Portal read models (~400) | `patient-portal`, `authorization` | Appointments, documents, consents, prescriptions, invoices; no clinical note content (D11); formal copy request; patient access limited to own data. |
| S5.09 Portal downloads and minors (~350) | `patient-portal`, `documents` | Session-bound downloads for patients; majority review of representative links. |
| S5.10 Portal UI (~450) | `patient-portal` | `/portal` shell, patient picker, header names the subject. |
| S5.11 Demo seed (~250) | `demo-tenant` | Consent, prescriptions (fake), portal accounts. |
| S5.12 Stage 5 gate (~200) | all | Demo e2e; fresh review of portal isolation and consent integrity. |

Dependencies: S5.06 to S5.10 sequential; S5.02 to S5.05 independent of the portal until S5.08.

---

# Stage 6: Growth (to be refined before apply)

Goal: a stranger signs up, pays and uses the product the same day. Depends on Stage 5, Mercado Pago account and the Q2 amount-change spike.

| Slice | Covers | Key tasks |
|---|---|---|
| S6.01 Plans and subscription model (~400) | `subscriptions` | Plans, entitlements, subscription states and transition table, exempt tenants without a subscription row. |
| S6.02 Self-service signup (~400) | `tenant-onboarding` Part B | Turnstile, email verification, auto-generated slug, `signup.purge`, reuse of the Stage 2 wizard. |
| S6.03 Mercado Pago adapter (~400) | `subscriptions` | Preapproval, webhooks with signature and idempotency, spike on amount change with the one-off payment fallback. |
| S6.04 Trial, dunning, read-only (~400) | `subscriptions`, `tenancy` | `trial.end`, `dunning.step`, derived `tenant.status`, a provider outage never advances dunning. |
| S6.05 Usage and statements (~400) | `subscriptions` | `usage.snapshot` of active professional days, proration, statement published at least 3 days before collection. |
| S6.06 Overage cap (~300) | `subscriptions`, `notifications` | Message quota, owner warnings, cap and email fallback. |
| S6.07 Subscription UI (~400) | `subscriptions` | Owner views, plan impact on invitations, operator subscription and support views. |
| S6.08 Cancellation and export (~450) | `tenancy` | `cancelling` to `cancelled`, split export (administrative to the owner, clinical per professional), all registered contributors. |
| S6.09 Retention archive (~400) | `tenancy` | Per-tenant archive key under a dedicated CMK, Object Lock governance mode for 10 years, integrity checks and test restore, `legal-erasure` role. |
| S6.10 Break-glass release (~350) | `tenancy` | Operator approves but cannot read, automated `archive.release`, 72-hour link, audited. |
| S6.11 Production readiness (~300) | all | Backup drill, runbooks, alerts, legal sign-offs (Q1, Q7). |
| S6.12 Stage 6 gate (~200) | all | Demo e2e (signup, payment, use); final security review. |

Dependencies: S6.01 first; S6.02 and S6.03 follow; S6.04 to S6.07 after S6.03; S6.08 to S6.10 sequential and independent of billing UI.

---

# Traceability: Stage 0 to 2 capabilities

Every requirement of the capabilities delivered in Stages 0 to 2 maps to at least one task. "Deferred" means the requirement is only completed in a later stage; the task ids listed are what exists before then.

### Summary of deferrals

| Requirement | What exists before the deferral | Completed in |
|---|---|---|
| TEN-09 Retention archive after cancellation | Nothing in Stages 0 to 2 (the export hook of task 1.20 is the only groundwork) | S6.09 |
| TEN-08 Tenant cancellation export | Export contributor registry (1.20) and contributors from clinical (2.66) and documents (2.85) | S6.08 |
| IDA-06 Patient email one-time-code sign-in | Default deny for the patient actor class (1.58) | S5.06, S5.07 |
| AUZ-14 Patient access limited to own data | Default deny (1.58) | S5.08 |
| PAT-03 Identity review of matched bookings | Worklist kind, confirm, detach (2.20 to 2.23) | Online producer in S3.09 |
| PAT-12 Minors and representatives | Representative record (1.75) | Portal link review in S5.09 |
| CTR-09 Legal adapters declared | Types declared (1.12) | Implementations in S4.09 and S5.04 |
| DEM-04 Realistic coverage across modules | Stage 1 and 2 data (1.123, 2.94) plus the gap check (1.127) | Each later stage adds its own seed slice |

### tenancy (TEN)

| Req | Name | Tasks |
|---|---|---|
| TEN-01 | Organization as the tenant boundary | 1.14, 1.15, 1.94, 1.128 |
| TEN-02 | Tenant identity derived only from the session | 0.20, 1.17, 1.18, 1.39, 1.93 |
| TEN-03 | Cross-tenant isolation on every data path | 0.19, 0.20, 0.21, 1.14, 1.16, 2.50 |
| TEN-04 | Locations within an organization | 1.15, 1.67, 1.114 |
| TEN-05 | Multi-specialty organizations | 1.69 |
| TEN-06 | Single-tenant deployment by configuration | 1.8, 1.17, 1.19 |
| TEN-07 | Platform operator has no default clinical access | 1.92, 1.93, 1.95, 1.122 |
| TEN-08 | Tenant cancellation export | 1.20, 2.66, 2.85 (hook only; deferred, see above) |
| TEN-09 | Retention archive after cancellation | Deferred to S6.09 (no Stage 0 to 2 task) |
| TEN-10 | Retention exceptions are explicit and exhaustive | 1.124, 1.126 |
| TEN-11 | Read-only tenant and its allowlist | 1.6, 1.21, 1.22, 1.23, 1.29, 2.55 |

### identity-access (IDA)

| Req | Name | Tasks |
|---|---|---|
| IDA-01 | Authentication required by default | 1.40, 1.43 |
| IDA-02 | Credential-based login | 1.35, 1.37, 1.39, 1.110, 1.112 |
| IDA-03 | Password policy | 1.36 |
| IDA-04 | Account lockout and throttling | 1.42, 1.43, 1.44, 1.49, 1.112 |
| IDA-05 | Two-factor authentication | 1.32, 1.33, 1.34, 1.47, 1.48, 1.49, 1.111 |
| IDA-06 | Passwordless patient sign-in by email one-time code | Deferred to S5.07 (default deny at 1.58) |
| IDA-07 | Session management | 1.38, 1.39, 1.111 |
| IDA-08 | Audited, non-enumerating password reset | 1.45, 1.46, 1.51, 1.52, 1.110, 1.112 |
| IDA-09 | Authentication events audited | 1.41, 1.44, 1.50 |
| IDA-10 | Secrets are never committed or exposed | 0.1, 0.2, 0.3, 0.10, 0.25, 0.28, 1.8 |

### authorization (AUZ)

| Req | Name | Tasks |
|---|---|---|
| AUZ-01 | Fixed role set | 1.5 |
| AUZ-02 | Server-side enforcement on every request | 1.54, 1.55, 1.104 |
| AUZ-03 | No self-assignment or silent escalation of roles | 1.52, 1.65 |
| AUZ-04 | Clinical notes readable by health professionals only | 1.56, 1.57, 1.62, 1.63, 1.79, 2.87 |
| AUZ-05 | Clinical permissions are locked to health professionals | 1.5 |
| AUZ-06 | Reception cannot read clinical note content | 1.56, 1.82, 2.81 |
| AUZ-07 | Organization setting "reception sees clinical metadata" | 1.66, 1.120, 2.81 |
| AUZ-08 | Demographics are organization-wide | 1.72 |
| AUZ-09 | Professional clinical access follows the care relationship | 1.59, 1.61, 1.63, 2.24, 2.25, 2.49 |
| AUZ-10 | Explicit patient assignment | 1.61, 1.81, 1.117 |
| AUZ-11 | One clinical visibility model (sharing scope) | 1.59, 1.60, 1.62, 1.63, 1.66, 1.120, 2.48, 2.58 |
| AUZ-12 | Grantable non-clinical permissions | 1.5, 1.64, 1.65, 1.113, 2.30 |
| AUZ-13 | Membership in locations | 1.64, 1.67, 2.18 |
| AUZ-14 | Patient access limited to own data | 1.58 (default deny); full in S5.08 |
| AUZ-15 | Default deny and least privilege | 1.54 |
| AUZ-16 | Denials are uniform and non-leaking | 1.4, 1.7, 1.55 |

### audit-log (AUD)

| Req | Name | Tasks |
|---|---|---|
| AUD-01 | Mandatory events | 1.26, 1.27, 1.84, 1.86 |
| AUD-02 | Synchronous, fail-closed writing | 1.26, 1.27 |
| AUD-03 | Entry content | 1.24, 1.26, 1.28 |
| AUD-04 | Append-only and tamper-evident | 1.24, 1.25, 1.30, 1.31 |
| AUD-05 | Retention of at least 10 years | 1.85 |
| AUD-06 | Tenant-scoped access to the log | 1.83, 1.119 |
| AUD-07 | Searchable and exportable log | 1.83, 1.84, 1.119 |

### tenant-branding (BRD)

| Req | Name | Tasks |
|---|---|---|
| BRD-01 | Configurable organization identity | 1.89, 1.100, 1.120 |
| BRD-02 | Branding applies across surfaces | 1.91, 1.98, 1.121, 1.128 |
| BRD-03 | Accessible color choices | 1.88, 1.120 |
| BRD-04 | Logo upload safety | 1.87, 1.90 |
| BRD-05 | Branding changes restricted and audited | 1.89, 1.120 |

### app-shell-ux (SHL)

| Req | Name | Tasks |
|---|---|---|
| SHL-01 | Single layout driven by role | 1.104, 1.105, 2.44 |
| SHL-02 | Mobile-first responsive layout | 1.103, 1.105, 2.36 |
| SHL-03 | Installable PWA | 1.91, 1.107, 1.108 |
| SHL-04 | Performance budget | 1.109 |
| SHL-05 | Spanish (Argentina) UI with externalized strings | 1.97 |
| SHL-06 | Clear empty, loading and error states | 1.96, 1.102, 1.106 |
| SHL-07 | Accessibility baseline | 1.100, 1.101, 1.102, 1.103 |
| SHL-08 | Guided first run hook | 1.106, 2.92 |
| SHL-09 | Sensitive data not exposed through the shell | 1.91, 1.96, 1.99, 1.107, 1.108, 2.65 |

### country-rules-ar (CTR)

| Req | Name | Tasks |
|---|---|---|
| CTR-01 | Country module isolation | 1.9 |
| CTR-02 | DNI validation and normalization | 1.10 |
| CTR-03 | CUIT/CUIL validation | 1.10 |
| CTR-04 | Payer catalog (obras sociales and prepagas) | 1.13 |
| CTR-05 | Holiday catalog | 1.13, 2.3, 2.46 |
| CTR-06 | Professional registration (matricula) rules | 1.11 |
| CTR-07 | Locale, currency and time-zone defaults | 1.12 |
| CTR-08 | Retention rule | 1.12 |
| CTR-09 | Legal adapters declared | 1.12 (types only; implementations in S4.09, S5.04) |
| CTR-10 | Personal data law alignment | 1.12, 1.77 |

### staff-professionals (STF)

| Req | Name | Tasks |
|---|---|---|
| STF-01 | Staff invitation and lifecycle | 1.45, 1.53, 1.70, 1.110, 1.113 |
| STF-02 | Only authorized users manage staff | 1.70, 1.115 |
| STF-03 | Professional profile | 1.68, 1.69, 1.113 |
| STF-04 | Matricula uniqueness and validation state | 1.68, 1.69, 1.113 |
| STF-05 | Multi-location assignment | 1.70, 1.113 |
| STF-06 | Weekly working hours per location | 1.68, 1.71, 1.114 |
| STF-07 | Staff directory visibility | 1.70, 1.113 |
| STF-08 | Staff changes audited | 1.70 |

### patients (PAT)

| Req | Name | Tasks |
|---|---|---|
| PAT-01 | Patient registry | 1.72, 1.73, 1.116 |
| PAT-02 | Deduplication by document | 1.72, 1.73, 1.116 |
| PAT-03 | Identity review of matched bookings | 2.20, 2.21, 2.23 (online producer deferred to S3.09) |
| PAT-04 | Search and listing | 1.74, 1.116 |
| PAT-05 | Payer coverage | 1.76, 1.117 |
| PAT-06 | Anamnesis is clinical data | 1.32, 1.34, 1.79, 1.82, 1.118 |
| PAT-07 | Safety alerts without clinical detail | 1.80, 1.117 |
| PAT-08 | Data-processing consent | 1.77, 1.116 |
| PAT-09 | Access and rectification rights | 1.78, 1.117 |
| PAT-10 | No hard deletion; deactivation instead | 1.73, 1.116 |
| PAT-11 | Patient data changes versioned and audited | 1.72, 1.73, 1.117 |
| PAT-12 | Minors and representatives | 1.72, 1.75, 1.117 |

### demo-tenant (DEM)

| Req | Name | Tasks |
|---|---|---|
| DEM-01 | Demo tenant is a normal, isolated organization | 1.94, 1.122, 1.123 |
| DEM-02 | Fake data only | 1.123, 2.94 |
| DEM-03 | Demo tenants use only fake adapters | 1.125 |
| DEM-04 | Realistic coverage across modules | 1.123, 1.127, 2.94 |
| DEM-05 | Reset on demand under one minute | 1.124, 1.127, 2.96 |
| DEM-06 | Demo credentials and access are safe | 1.123, 1.124 |
| DEM-07 | Demo resets and the retention rule | 1.124 |

### scheduling (SCH)

| Req | Name | Tasks |
|---|---|---|
| SCH-01 | Calendar views | 2.28, 2.33, 2.34, 2.35, 2.36 |
| SCH-02 | Appointment types | 2.1, 2.2, 2.45 |
| SCH-03 | Booking an appointment | 2.4, 2.10, 2.11, 2.12, 2.20, 2.37, 2.39, 2.95 |
| SCH-04 | Conflict detection and overbooking policy | 2.4, 2.5, 2.6, 2.7, 2.8, 2.10, 2.11, 2.27, 2.45 |
| SCH-05 | Slot holds | 2.4, 2.26, 2.27 |
| SCH-06 | Working hours and out-of-hours bookings | 2.10, 2.12, 2.28, 2.37 |
| SCH-07 | Blocks and holidays | 2.1, 2.2, 2.3, 2.12, 2.45, 2.46 |
| SCH-08 | Time zones and daylight saving | 2.9 |
| SCH-09 | Rescheduling | 2.15, 2.38, 2.40 |
| SCH-10 | Cancellation | 2.14, 2.16, 2.40 |
| SCH-11 | Attendance lifecycle | 2.5, 2.13, 2.14, 2.20, 2.22, 2.24, 2.25, 2.40, 2.42, 2.44 |
| SCH-12 | Recurring appointments | 2.29, 2.41 |
| SCH-13 | Reception worklist | 2.17, 2.18, 2.43 |
| SCH-14 | Scheduling authorization and audit | 2.2, 2.12, 2.30, 2.32, 2.33 |
| SCH-15 | Read-only tenant behavior | 2.16, 2.31 |

### clinical-records (CLN)

| Req | Name | Tasks |
|---|---|---|
| CLN-01 | Encounter notes | 2.47, 2.53, 2.67 |
| CLN-02 | Clinical access restriction | 2.53, 2.54, 2.63, 2.64, 2.68, 2.73, 2.74 |
| CLN-03 | Draft, signing and immutability | 2.47, 2.48, 2.51, 2.52, 2.67, 2.68, 2.69 |
| CLN-04 | Addenda and corrections | 2.47, 2.48, 2.55, 2.56, 2.74 |
| CLN-05 | Version history | 2.47, 2.52, 2.57, 2.72 |
| CLN-06 | Specialty templates | 2.59, 2.60 |
| CLN-07 | Odontogram template | 2.59, 2.61, 2.71 |
| CLN-08 | Psychology template | 2.59, 2.62, 2.70 |
| CLN-09 | Physiotherapy template | 2.59, 2.70 |
| CLN-10 | Nutrition template | 2.59, 2.70 |
| CLN-11 | Patient clinical timeline and anamnesis link | 2.63, 2.64, 2.65, 2.72, 2.73 |
| CLN-12 | Audit of clinical access | 2.50, 2.53, 2.58, 2.64 |
| CLN-13 | Retention and availability | 2.66 |

### documents (DOC)

| Req | Name | Tasks |
|---|---|---|
| DOC-01 | Upload and association | 1.87 (storage port), 2.77, 2.78, 2.84 |
| DOC-02 | Type and size validation | 2.75, 2.76, 2.78, 2.79 |
| DOC-03 | Private storage and short-lived access | 1.87, 2.78, 2.80, 2.83, 2.84 |
| DOC-04 | Classification and access rules | 2.77, 2.81 |
| DOC-05 | Immutability, replacement and removal | 2.77, 2.82, 2.84 |
| DOC-06 | Duplicate detection and interrupted uploads | 2.79, 2.82 |
| DOC-07 | Retention, export and tenant lifecycle | 2.83, 2.85 (export deferred to S6.08) |

### tenant-onboarding Part A (ONB)

| Req | Name | Tasks |
|---|---|---|
| ONB-01 | Operator-created tenants | 1.53, 1.94, 1.122, 2.90 |
| ONB-02 | Tenant defaults and initial roles | 2.87 |
| ONB-03 | Setup wizard | 2.86, 2.91, 2.93 |
| ONB-04 | Fast path for solo professionals | 2.88, 2.91, 2.95 |
| ONB-05 | First-run checklist | 2.89, 2.92, 2.93 |
| ONB-06 | Staff invitation from the first run | 2.90 |
| ONB-07 | First-run authorization and audit | 2.86, 2.90, 2.93 |
| ONB-08 | Mobile experience and language | 2.91, 2.92 |

Coverage result: 138 requirements across the 14 Stage 0 to 2 capabilities (95 Stage 1, 43 Stage 2 including ONB Part A). All map to at least one task; 2 (TEN-09, IDA-06) have no Stage 0 to 2 implementation task by design and are scheduled in S6.09 and S5.07. Stage 3 to 6 capabilities are traced when their stages are refined.

---

# Review Workload Forecast (final)

| Stage | PR slices | Est. changed lines | Notes |
|---|---|---|---|
| 0 | 10 | ~2,500 | Plus S0.01 mechanical deletions and S0.02 docs (`size:exception`). Lockfile generated. |
| 1 | 38 | ~13,500 | 1 slice is no-code. About 20 backend slices carry RLS or migrations. |
| 2 | 34 | ~12,000 | Plus S2.34 legacy removal (`size:exception`, mechanical). |
| 3 | 18 | ~6,500 | Provisional. |
| 4 | 15 | ~5,500 | Provisional. |
| 5 | 12 | ~4,500 | Provisional. |
| 6 | 12 | ~4,500 | Provisional. |
| **Total** | **139** | **~49,000** (range 35,000 to 70,000) | |

Estimates assume slices of about 400 lines. Risk of a slice exceeding 400: highest in UI slices (S1.31 to S1.34, S2.13, S2.14, S2.22) and in S4.10. Mitigation: split on the natural seam recorded in the slice, never by file type.

Chained PRs recommended: Yes
400-line budget risk: High
Decision needed before apply: Yes
Chain strategy: pending

Questions that need an answer before the first apply batch: chain strategy; `size:exception` for S0.01, S0.02 and S2.34; whether `.atl/` is versioned.
