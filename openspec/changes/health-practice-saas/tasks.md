# Tasks: Health Practice SaaS (rewrite of Centro Medico Aillu)

> **Plan in one line**: 7 stages (0 to 6), about 147 reviewable PR slices of roughly 400 changed lines each. Every stage is fully detailed below. Stages 3 to 6 are local-first (every external provider has a working local adapter, real adapters are deferred tasks) and are organized in parallel tracks per stage.

Change: `health-practice-saas` · Project: `appmedicocmaillu` · Artifact store: openspec · Delivery strategy: `ask-on-risk` · Strict TDD: off today (Stage 0 introduces the runner; every task still ships its own tests).

## Review Workload Forecast

Hand-written changed lines (additions + deletions, tests included). Lockfiles, seed data assets and the mechanical untrack/legacy deletions are counted separately because they are generated or mechanical.

| Stage | Scope | PR slices | Est. changed lines (hand-written) |
|---|---|---|---|
| 0 | Repo hygiene, skeleton, tooling, CI | 10 | ~2,500 |
| 1 | Secure core | 38 (1 is no-code) | ~13,500 |
| 2 | Practice core + legacy removal | 34 | ~12,000 |
| 3 | Patient engagement (detailed; local WhatsApp, video and bot-challenge adapters) | 20 | ~7,400 |
| 4 | Revenue (detailed; local AFIP issuer) | 18 | ~7,050 |
| 5 | Compliance and portal (detailed; local e-Rx provider) | 14 | ~5,150 |
| 6 | Growth (detailed; local Mercado Pago and archive) | 13 | ~4,950 |
| **Total** | | **~147** | **~52,500 (range 38,000 to 75,000)** |

Stages 3 to 6 also carry deferred real-provider adapters (3.80 to 3.83, 4.68, 4.69, 5.53, 5.54, 6.50 to 6.52, about 2,200 lines together). They are separate small PRs, are not in the totals above and block no slice, gate or demo.

| Field | Value |
|---|---|
| Estimated changed lines | ~52,500 hand-written (+ generated: pnpm lockfile; + mechanical: ~18k-file `node_modules` untrack, legacy removal) |
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
| Stage 3 | Online booking, reminders over email and a WhatsApp simulator, waitlist, teleconsultation | S3.00 to S3.18 | Seams first (S3.00, S3.00b), then tracks A messaging, B public booking, C waitlist, D teleconsultation in parallel, then S3.16 to S3.18. Deferred real adapters: S3.D. |
| Stage 4 | Pricing, charges, cash register, reports, invoices through a local AFIP | S4.00 to S4.17 | Seams first (S4.00), then tracks A billing, B reports, C invoicing in parallel, then S4.15 to S4.17. Deferred real adapter: S4.D. |
| Stage 5 | Matricula verification, consent, e-prescription through a local provider, patient portal | S5.00 to S5.13 | Seams first (S5.00), then compliance (S5.01 to S5.05, S5.11) and portal (S5.06 to S5.10) in parallel, then S5.12, S5.13. Deferred real adapter: S5.D. |
| Stage 6 | Signup, subscriptions through a local Mercado Pago, cancellation export, local archive | S6.00 to S6.12 | Seams first (S6.00), then subscriptions, signup and retention in parallel, then S6.11, S6.12. Deferred real adapters: S6.D. |

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
- [x] 1.33 `platform/crypto/key-management.ts` port + `adapters/local-kek/` (dev, test) + `adapters/aws-kms/` (encryption context carries tenant id). [IDA-05] Test: local adapter; AWS adapter against a mocked client.
- [x] 1.34 `db/schema/tenant-key.ts` + migration; `platform/crypto/tenant-keys.ts` (create DEK at tenant creation, unwrap cache with TTL, `encryptField`/`decryptField`). [IDA-05, PAT-06] Test: tenant A cannot decrypt tenant B data; cache expiry; creation is idempotent.

## S1.09 Identity schema and password policy (~350 lines)

Depends: S1.03, S1.08.

- [x] 1.35 `db/schema/identity.ts` + migration: `user` (global, citext email, `password_hash`, encrypted `totp_secret`, `first_sign_in_at`, `failed_logins`, `locked_until`), `membership` (tenant, roles, status), `session`, `login_challenge`, `recovery_code`. `user` is readable only through membership of the current tenant or the login lookup function `app.lookup_user_for_login(email)` (SECURITY DEFINER, minimal columns). [IDA-02, TEN-01] Test: tenant B context cannot read tenant A's users.
- [x] 1.36 `modules/identity/domain/password-policy.ts` and the bundled list `apps/api/assets/common-passwords-100k.txt` loaded at boot (data asset, outside the line budget); optional breached-password range check behind a flag. [IDA-03] Test: rejects common passwords, accepts a passphrase, length boundaries.
- [x] 1.37 `modules/identity/infrastructure/argon2.ts` (`@node-rs/argon2`) with `verifyOrDummy` so unknown users take the same path. [IDA-02] Test: unknown and known users call the same verify path (spy count).

## S1.10 Sessions and login (~400 lines)

Depends: S1.09, S1.06.

- [x] 1.38 `modules/identity/application/sessions.ts` and `platform/http/session-cookie.ts`: opaque 256-bit token, SHA-256 at rest, `HttpOnly; Secure; SameSite=Lax`, idle 12 h and absolute 7 days (staff), rotation on login and privilege change, `active_tenant_id`. [IDA-07] Test: expiry with a fake clock; rotation on login.
- [x] 1.39 Routes `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `GET|DELETE /auth/sessions` with contracts in `packages/contracts/src/auth.ts`; host and session tenant mismatch returns 401; unknown identifiers get identical responses. [IDA-02, IDA-07, TEN-02] Test: integration login, logout, revoke, mismatch.
- [x] 1.40 `platform/http/auth-guard.ts` (every route requires a session unless it is declared public under the allowed prefixes of design 4.5) and `csrf-origin.ts` (`Origin` check on non-GET). [IDA-01] Test: boot-time test enumerates routes and fails on an unauthenticated route outside the allowlist; cross-origin POST returns 403.
- [x] 1.41 Audit hooks `auth.login.success|failure`, `auth.logout`, `auth.session.revoked`. [IDA-09] Test: events present with required fields.

## S1.11 Lockout and throttling (~350 lines)

Depends: S1.10.

- [x] 1.42 `modules/identity/application/lockout.ts`: counter, lock after 10 consecutive failures for 15 minutes (configurable), exponential backoff per account and IP, lock checked before credentials, `recordFailure(kind)` reusable by 2FA. [IDA-04] Test: 10 failures lock; the 11th with the correct password is still 401 generic; unlock after the window.
- [x] 1.43 `platform/http/rate-limit.ts` (`@fastify/rate-limit` per IP and per tenant, store behind an interface). [IDA-04, IDA-01] Test: 429 after the limit; separate buckets per tenant.
- [x] 1.44 Audit `auth.account.locked|unlocked`, `auth.login.locked`; identical response body and timing class for unknown identifiers. [IDA-09, IDA-04] Test: unknown versus known account responses equal.

## S1.12 Action tokens and transactional email (~350 lines)

Depends: S1.03.

- [x] 1.45 `db/schema/action-token.ts` + `platform/tokens/index.ts`: `issue(kind, subject, opts)` returns the raw token once; SHA-256 at rest; `redeem()` is an atomic `UPDATE ... RETURNING` with max uses, expiry per kind and optional session binding; canonical kind registry (only account kinds enabled now). [IDA-08, STF-01] Test: single use under concurrency, expired, wrong kind, hash at rest.
- [x] 1.46 `platform/mail/email-sender.ts` port, `adapters/smtp/` (Mailpit locally, SES SMTP in production), `adapters/fake-email/` (in memory), es-AR templates for invitation and reset. The native SES API adapter arrives with `notifications` in Stage 3. [IDA-08] Test: fake captures messages; SMTP adapter against Mailpit (integration).

## S1.13 Two-factor authentication (~400 lines)

Depends: S1.11, S1.08, S1.12.

- [x] 1.47 `modules/identity/application/totp.ts` (`@oslojs/otp`): enrollment with encrypted secret, verify with +-1 step, last-used-step replay block. [IDA-05] Test: RFC 6238 vectors, replay rejected, drift window.
- [x] 1.48 Recovery codes: generate 10, store hashed, single use, regenerate. [IDA-05] Test: reuse fails; hashes only at rest.
- [x] 1.49 Login 2FA flow: `login_challenge` (5 min, max 5 attempts), `POST /auth/2fa`, wrong or reused code counts toward lockout, mandatory for professionals and owners/admins with a 7-day grace from `first_sign_in_at`, then an enrollment-scoped session; optional for reception unless `settings.require_2fa`. [IDA-05, IDA-04] Test: role x grace x enrolled matrix; an enrollment-scoped session gets 403 `two_factor_enrollment_required` everywhere else.
- [x] 1.50 Audit `auth.2fa.enrolled|verified|failed|recovery_used`. [IDA-09] Test: events emitted.

## S1.14 Password reset and invitation acceptance (~350 lines)

Depends: S1.12, S1.13.

- [x] 1.51 `POST /auth/password-reset/request` (always the same response, email only) and `/complete` (token 30 min, single use, policy check, revokes all sessions, does not bypass 2FA, audited). [IDA-08] Test: non-enumeration, reuse fails, sessions revoked.
- [x] 1.52 Admin-triggered reset `POST /users/:id/password-reset` only sends the email and never sets a password. [IDA-08, AUZ-03] Test: no endpoint accepts a password for another user.
- [x] 1.53 `POST /auth/invitations/accept {token, password}`: creates the user or links an existing user to a new membership with the invited roles, within the inviter's ceiling. [STF-01, ONB-01] Test: roles granted equal roles invited; expired token fails.

## S1.15 Authorization engine (~400 lines)

Depends: S1.01, S1.10.

- [x] 1.54 `platform/authz/can.ts`: `can(actor, action, resource)` combining RBAC from the catalog with grants limited to `GRANTABLE`; `Actor` type. [AUZ-02, AUZ-15] Test: unit table of role x action; unknown action denies.
- [x] 1.55 `platform/authz/guard.ts`: route option `config.permission`; a route with neither a permission nor `public` fails at boot; denials call `auditDeny()` and use the uniform response. [AUZ-02, AUZ-16] Test: `apps/api/test/policy/route-role-matrix.test.ts` generated from the catalog.
- [x] 1.56 Admin-denied harness: a test iterating every registered route tagged `clinical.*` asserting 403 for owner/admin plus a deny audit row; proven now with a fixture route, and it covers real routes automatically from Stage 2. [AUZ-04, AUZ-06] Test: that harness.
- [x] 1.57 `platform/authz/professional-gate.ts`: derive `professionalId` only from an active professional profile with a recorded valid matricula; an owner who is also a professional gets it through the profile only. [AUZ-04] Test: unit with stubbed repo.
- [x] 1.58 Default deny for the `patient` actor class on all staff routes (patient sessions do not exist yet). [AUZ-14] Test: patient actor denied everywhere.

## S1.16 Sharing-scope predicate (~300 lines)

Depends: S1.15.

- [x] 1.59 `platform/authz/sharing-scope.ts`: `readable(entry, actor, ctx)` per design 4.2 (author, treating, `author_only`, prescriptions never follow sharing, inclusion list `sharedTemplates`); `treating()` behind a port. [AUZ-11, AUZ-09] Test: see 1.60.
- [x] 1.60 Table-driven and fast-check tests (author, treating, shared, `author_only`, D17 prescription, psychology excluded by default, new templates never auto-added) and a helper marking shared reads `reason = 'shared'`. [AUZ-11] Test: that file.

## S1.17 SQL clinical backstop and care tables (~400 lines)

Depends: S1.16, S1.03.

- [x] 1.61 `db/schema/care.ts` + migration: `care_assignment`, `care_relationship` (patient, professional, qualifying appointments, encounters, assigned, generated `active`); trigger from `care_assignment`. Appointment and encounter triggers arrive in Stage 2. [AUZ-09, AUZ-10] Test: assignment makes the relationship active.
- [x] 1.62 SQL `app.clinical_readable(patient_id, author_professional_id, visibility, template_kind)` and `clinicalPolicies(table)` helper creating the RESTRICTIVE `clinical_professionals_only` and `clinical_scope` policies; extend `withTenant` to load sharing settings once per transaction. [AUZ-04, AUZ-11] Test: see 1.63.
- [x] 1.63 Integration tests on a test-only table `test_clinical_item`: admin sees 0 rows; non-treating professional 0; treating 1; `author_only`; sharing on and off; prescription excluded (D17); and a property test that the TS predicate (1.59) and the SQL function agree on random actor/entry combinations. [AUZ-04, AUZ-09, AUZ-11] Test: that file.

## S1.18 Access module: grants, settings, locations (~400 lines)

Depends: S1.15, S1.04.

- [x] 1.64 `db/schema/access.ts` + migration: `permission_grant` (`CHECK (permission NOT LIKE 'clinical.%')`, scope jsonb), `membership_location`. [AUZ-12, AUZ-13] Test: inserting a `clinical.*` grant fails at the DB.
- [x] 1.65 `modules/access`: grant and revoke API (owner/admin only), role-change rules (no self-escalation, no granting above own ceiling, last owner protected, sessions rotated on change), audited. [AUZ-03, AUZ-12] Test: each prohibited path returns 403 with a deny audit row.
- [x] 1.66 Org settings API `GET|PATCH /api/v1/settings`: `reception_sees_clinical_metadata`, `clinicalSharing` (default `sharedTemplates`, psychology only by explicit audited choice), `require_2fa`, quiet hours default; every change audited. [AUZ-07, AUZ-11] Test: sharing toggle audited; psychology needs the explicit flag.
- [x] 1.67 Location HTTP API (`/api/v1/locations` create, edit, deactivate) and membership-location assignment with a reception location filter helper. [TEN-04, AUZ-13] Test: reception only sees its locations; deactivate keeps history.

## S1.19 Staff and professionals (~400 lines)

Depends: S1.18, S1.14, S1.02.

- [x] 1.68 `db/schema/staff.ts` + migration: `professional` (status, matricula, jurisdiction, `matricula_status`, `verified_by_operator`, `max_simultaneous`, specialties) and `professional_hours` (weekday, start, end, location). A DB trigger blocks `matricula_status = verified` outside an operator context. [STF-03, STF-06, STF-04] Test: tenant users cannot set `verified`.
- [x] 1.69 `modules/staff` profile service: matricula validated through CountryPack, editing it resets to `unverified`, uniqueness, multiple specialties. [STF-03, STF-04, TEN-05] Test: edit resets status; duplicate matricula rejected.
- [x] 1.70 Staff lifecycle API: invite (role ceiling, `staff_invitation` token + email), directory with role-based visibility, deactivate and reactivate (never delete, revoke sessions), location assignment; all audited. [STF-01, STF-02, STF-05, STF-07, STF-08] Test: reception cannot invite; deactivation revokes sessions.
- [x] 1.71 `PUT /professionals/:id/hours` validating overlaps in the location time zone. [STF-06] Test: overlap rejected; edit audited.

## S1.20 Patients core (~400 lines)

Depends: S1.15, S1.02, S1.03.

- [x] 1.72 `db/schema/patients.ts` + migration: `patient` (partial unique `(tenant_id, national_id_type, national_id) WHERE national_id IS NOT NULL`), `patient_version`, `patient_representative`; RLS tenant-only because demographics are organization-wide. [PAT-01, PAT-02, PAT-11, PAT-12, AUZ-08] Test: two patients without document allowed; duplicate document rejected.
- [x] 1.73 `modules/patients` API: create, edit, deactivate (never delete), DNI normalization through CountryPack, duplicate returns 409 with an existing-patient summary, every update writes a `patient_version` and an audit event. [PAT-01, PAT-02, PAT-10, PAT-11] Test: duplicate flow; history contains both versions.
- [x] 1.74 `GET /patients?q=` search by name and document (`pg_trgm` + `unaccent`), paginated, minimal columns. [PAT-04] Test: accent-insensitive; 10k seeded rows answer within a generous bound.
- [x] 1.75 Minors and representatives: representative record with relation and contact, majority age from CountryPack, `majority_review_on`. [PAT-12] Test: minor requires a representative; the date is computed.

## S1.21 Coverage, consent and rights (~350 lines)

Depends: S1.20.

- [x] 1.76 `payer_plan` and `patient_coverage` schema + API (member number, validity, primary flag). [PAT-05] Test: one primary per patient; invalid dates rejected.
- [x] 1.77 `data_processing_consent` (text version key from CountryPack, granted at, recorded by, revoked at) + API and a mandatory prompt at patient creation. [PAT-08, CTR-10] Test: revocation allowed in a read-only tenant.
- [x] 1.78 `patient_rights_request` (access, rectification) + staff API; rectification goes through the versioned update. [PAT-09] Test: allowed in read-only (category 6).

## S1.22 Anamnesis, safety flags, assignment (~400 lines)

Depends: S1.20, S1.17, S1.08.

- [x] 1.79 `db/schema/anamnesis.ts`: encrypted versioned `anamnesis` with `clinicalPolicies`; save endpoint for professionals only. [PAT-06, AUZ-04] Test: reception and admin get 403 plus a deny audit row; RLS returns 0 rows.
- [x] 1.80 `modules/patients/application/safety-flags.ts`: recompute codes from the structured anamnesis in the same transaction; no endpoint writes `patient.safety_flags`, and a trigger rejects direct updates outside the system function. [PAT-07] Test: no route or contract exposes a setter; reception sees only the "see professional" label.
- [x] 1.81 Care assignment API `POST|DELETE /patients/:id/assignments` (professional self-assign or `patients.administer`), audited. [AUZ-10] Test: assignment grants access; removal revokes it only when no other source exists.
- [x] 1.82 Contracts guard: `PatientSummaryDto` never carries clinical detail. [PAT-06, AUZ-06] Test: DTO snapshot plus a reception GET of anamnesis returning 403.

## S1.23 Audit viewer and report (~350 lines)

Depends: S1.07, S1.15.

- [x] 1.83 `modules/audit` API `GET /audit-events` (filters actor, action, patient, resource, outcome, date; cursor pagination; owner/admin; metadata only). [AUD-06, AUD-07] Test: tenant B cannot see A's events; no clinical content in responses.
- [x] 1.84 Patient access report `GET /patients/:id/access-report` and streamed CSV/JSON export, the export itself audited. [AUD-07, AUD-01] Test: report lists reads and writes for the patient.
- [x] 1.85 Job `audit.partitions` (ensure the next 3 months) and `docs/runbooks/audit-retention.md` (move partitions older than 2 years to cold storage, retain 10 years, never delete). [AUD-05] Test: partitions exist ahead of time; no code path deletes audit rows.
- [x] 1.86 `apps/api/test/policy/audit-coverage.test.ts`: every mandatory event has an integration scenario registered, and a mutating route without an audit assertion tag fails. [AUD-01] Test: that file.

## S1.24 Object storage port and S3 adapter (~300 lines)

Depends: S0.08.

- [x] 1.87 `platform/storage/object-storage.ts` port (put, get stream, head, presigned POST, move within tenant prefix) with key convention `t/{tenantId}/...`; `adapters/s3/` (AWS SDK v3, MinIO compatible) and an in-memory fake. [DOC-03, BRD-04] Test: integration against MinIO; keys outside the tenant prefix are refused.

## S1.25 Branding API (~350 lines)

Depends: S1.24, S1.18.

- [x] 1.88 `modules/tenancy/branding/contrast.ts`: OKLCH lightness auto-adjust until WCAG 4.5:1, returns `primary_requested`, `primary_effective` and a warning. [BRD-03] Test: property test that the result is always at least 4.5:1, hue preserved, idempotent.
- [x] 1.89 `PUT /api/v1/branding` (name, short name, primary color, radius, heading font from a curated set) with permission `branding.manage`, audited before and after. [BRD-01, BRD-05] Test: reception denied; audit holds the diff.
- [x] 1.90 Logo upload: PNG, JPEG or WebP only, magic-byte sniff, 512 KB cap, dimension cap, re-encode with `sharp` to strip metadata, store through the port; SVG rejected. [BRD-04] Test: polyglot, oversize and SVG fixtures rejected.
- [x] 1.91 Public `GET /api/v1/boot` by host (name, theme tokens, logo URL, locale, feature flags, deployment mode; no PII) and per-host `GET /manifest.webmanifest`. [BRD-02, SHL-03, SHL-09] Test: unauthenticated response contains only whitelisted keys; two hosts return different themes.

## S1.26 Operator console API (~400 lines)

Depends: S1.14, S1.08, S1.07.

- [x] 1.92 `db/schema/operator.ts` + migration: `operator_user`, `platform_audit_event` (append-only, sealed like tenant audit), `support_grant` (tenant-approved, time-boxed, non-clinical), role `app_operator` with privileges on tenant and platform tables only. [TEN-07] Test: privilege test shows `app_operator` cannot SELECT any clinical or patient table.
- [x] 1.93 `modules/operator`: password plus mandatory TOTP without grace, separate `osid` cookie, routes only on `PLATFORM_HOST` (404 elsewhere). [TEN-07, TEN-02] Test: tenant users cannot reach `/operator/*`.
- [x] 1.94 `POST /operator/tenants {name, ownerEmail, isDemo?}`: auto-generated slug (random suffix on collision), tenant key, default settings, owner `staff_invitation`; `is_demo` settable only here. `POST /operator/tenants/:id/demo-reset` for demo tenants. All audited at platform level. [ONB-01, TEN-01, DEM-01] Test: slug collision invisible to the caller; `isDemo` cannot change later.
- [x] 1.95 Support access: using a `support_grant` requires an active unexpired grant and is audited per use. [TEN-07] Test: no grant means denied; expired grant denied.

## S1.27 Web foundation (~400 lines)

Depends: S0.05, S1.10, S1.25.

- [x] 1.96 `apps/web/src/app/{router.tsx,providers.tsx}` (TanStack Router and Query) and `shared/lib/api-client.ts` (fetch, problem+json parsing, request id capture, 401 redirect, 402 sets the read-only state); query cache cleared on logout and tenant switch. [SHL-06, SHL-09] Test: client unit tests per status class.
- [x] 1.97 i18n: `app/i18n.ts` (i18next), `locales/es-AR/{common,auth,errors}.json`, error-code to message mapping, `shared/lib/format.ts` (`Intl` es-AR, location time zone, money); ESLint rule against literal JSX strings in the web preset of `packages/config`. [SHL-05] Test: lint fixture with a literal string fails; formatter tests.
- [x] 1.98 Boot payload loader and theme injection before first paint (`index.html` inline script, `app/theme-boot.ts`, neutral fallback). [BRD-02] Test: Vitest checks CSS variables; Playwright asserts variables set at `DOMContentLoaded`.
- [x] 1.99 Lint rule forbidding `persistQueryClient` and storage of query data. [SHL-09] Test: lint fixture fails.

## S1.28 Shared UI and UX states (~400 lines)

Depends: S1.27.

- [x] 1.100 Run `ui-ux-pro-max --design-system "health clinic SaaS scheduling" -p "Aillu"`, record the result in `docs/design-system.md`, define tokens in `apps/web/src/styles/tokens.css` (slate neutral, blue/teal primary, Inter with tabular numbers, radius up to 8 px, dark mode) and the "Aillu" demo preset in `shared/ui/themes/consultorio.ts`. [BRD-01, SHL-07] Test: contrast check of all token pairs.
- [x] 1.101 Add shadcn components into `apps/web/src/shared/ui` (Button, Input, Label, Dialog, Sheet, Select, Tabs, Toast, Table, Skeleton, Badge, Card, rhf Form wrappers). [SHL-07] Test: component smoke tests with axe.
- [x] 1.102 State components `EmptyState`, `ErrorState` (retry plus request id), `ForbiddenState`, `OfflineBanner`, `ReadOnlyBanner`, `TwoFactorRequiredState`, `LoadingSkeleton`, plus `StatusBadge` (icon and text) and `SafetyFlag`. [SHL-06, SHL-07] Test: Testing Library plus axe per component.
- [x] 1.103 Accessibility utilities: 44 px touch target class, focus ring tokens, `prefers-reduced-motion`. [SHL-07, SHL-02] Test: Playwright smoke at 360 px with axe.

## S1.29 AppShell, navigation and guards (~400 lines)

Depends: S1.28.

- [x] 1.104 `app/nav/nav-config.ts` derived from the permission set returned by `GET /auth/me` (professional, reception, owner/admin layouts from design section 8) and `app/guards.tsx` `RequirePermission`. [SHL-01, AUZ-02] Test: unit per role.
- [x] 1.105 `app/AppShell.tsx`: collapsible sidebar on desktop, bottom navigation with at most 5 items plus "More" at 360 px, header with tenant name and logo, user menu; scaffolds of the minimal `/portal` and `/book/{slug}` shells. [SHL-01, SHL-02] Test: Playwright nav items per role at 360 and 1280 px.
- [x] 1.106 Banner wiring (read-only, offline, 2FA enrollment required) and the `FirstRunSlot` component that renders nothing until Stage 2. [SHL-08, SHL-06] Test: each state renders on the matching signal.

## S1.30 PWA (~250 lines)

Depends: S1.29.

- [x] 1.107 `vite.config.ts` PWA: precache the app shell only, `navigateFallback`, runtime `NetworkOnly` for `/api` and `/files`, manifest from the per-host endpoint, update prompt. [SHL-03, SHL-09] Test: unit check of the generated Workbox config.
- [x] 1.108 Playwright: manifest valid and service worker registered; offline shows the banner and never serves cached `/api` data. [SHL-03, SHL-09] Test: that spec.
- [x] 1.109 `lighthouserc.json` budget (mobile 4G profile, LCP under 2.5 s, performance at least 0.85) and a CI job. [SHL-04] Test: CI job fails when the budget is broken.

## S1.31 Auth screens (~400 lines)

Depends: S1.29, S1.13, S1.14.

- [x] 1.110 `features/auth/*`: login, TOTP step, recovery-code entry, forgot and reset password, invitation accept with password-policy hints; generic error copy. [IDA-02, IDA-08, STF-01] Test: component tests.
- [x] 1.111 2FA enrollment (QR via `qrcode`, manual key, confirm code, recovery codes shown once with copy/download), grace banner, sessions page with revoke. [IDA-05, IDA-07] Test: component tests.
- [x] 1.112 Playwright journeys: login to 2FA to landing; generic lockout message; reset flow reading Mailpit's API; axe on each screen at 360 px. [IDA-02, IDA-04, IDA-08] Test: those specs.

## S1.32 Staff screens (~400 lines)

Depends: S1.31, S1.19, S1.18.

- [x] 1.113 `features/staff/*`: directory, invite dialog (role ceiling), deactivate, location assignment, professional profile form (matricula with jurisdiction, specialties, "unverified" badge), grantable-permission editor (clinical toggles absent). [STF-01, STF-03, STF-04, STF-05, STF-07, AUZ-12] Test: component tests.
- [x] 1.114 `features/staff/components/WeeklyHours.tsx` per location (mobile friendly) and `features/settings/locations`. [STF-06, TEN-04] Test: validation messages in Spanish.
- [x] 1.115 Playwright: owner invites reception; reception opening the staff page sees the forbidden state. [STF-02] Test: that spec.

## S1.33 Patient screens (~400 lines)

Depends: S1.31, S1.20, S1.21, S1.22.

- [x] 1.116 `features/patients/*`: `PatientPicker` (DNI or name), list, create form with shared Zod DNI/CUIT validation, duplicate-409 flow, deactivate, consent capture prompt. [PAT-01, PAT-02, PAT-04, PAT-08, PAT-10] Test: component tests.
- [x] 1.117 Patient detail: demographics, coverage, representative, rights requests, version history, `SafetyFlag` ("see professional" for non-professionals), assignment actions. [PAT-05, PAT-07, PAT-09, PAT-11, PAT-12, AUZ-10] Test: component tests.
- [x] 1.118 Anamnesis form (professional only). Test: Playwright, reception sees no anamnesis, professional does; axe. [PAT-06]

## S1.34 Audit and settings screens (~350 lines)

Depends: S1.31, S1.23, S1.25, S1.18.

- [x] 1.119 `features/audit/*`: filterable event table, patient access report, export button. [AUD-06, AUD-07] Test: component tests.
- [x] 1.120 `features/settings/branding` (live contrast warning showing requested and effective colors, logo upload, preview) and `features/settings/security` (require 2FA, reception-metadata toggle, sharing toggle with explicit psychology confirmation). [BRD-01, BRD-03, BRD-05, AUZ-07, AUZ-11] Test: component tests.
- [x] 1.121 Playwright: a branding change applies after reload without flash; a second tenant keeps its own theme. [BRD-02] Test: that spec.

## S1.35 Operator console UI (~300 lines)

Depends: S1.26, S1.31.

- [x] 1.122 `features/operator/*` (platform host only): operator login with TOTP, tenant list, create-tenant form (owner email, demo toggle at creation only), demo reset button. [TEN-07, ONB-01, DEM-01] Test: Playwright creates a tenant and the owner invitation appears in Mailpit.

## S1.36 Demo tenant scaffold (~400 lines)

Depends: S1.26, S1.19, S1.21.

- [x] 1.123 `db/seed/demo/` deterministic seed runner `seedDemoTenant(tx, tenantId, clock)` (seeded RNG, fixed faker seed): one user per role with role-labelled sign-in, several locations, multi-specialty professionals, reception, patients with coverage, the "Aillu" theme. [DEM-01, DEM-02, DEM-04, DEM-06] Test: two runs produce identical logical content.
- [x] 1.124 Migration with `demo_reset(tenant_id)` (`SECURITY DEFINER`, own role, raises unless `is_demo`) that removes demo rows including the demo audit chain; job `demo.reset` re-seeds (realized as the operator console's port and `pnpm demo:reset`, both run `resetDemoTenant`; a scheduled job needs an operator-role pool in the worker and is deferred to the deployment stage); writes platform audit `demo.chain_reset` with the last sealed hash; demo credentials rotated on each reset. [DEM-05, DEM-06, DEM-07, TEN-10] Test: refuses a non-demo tenant; tenant roles cannot call it; real tenants' chain still verifies after a reset.
- [x] 1.125 `main/adapter-resolver.ts`: per-tenant adapter selection that throws when `tenant.is_demo` and the adapter is not a fake; registry of all ports (email, object storage, key management now). [DEM-03] Test: iterates every registered port.
- [x] 1.126 `apps/api/test/policy/no-delete.test.ts`: static scan failing on any `DELETE` or `.delete(` against tenant tables outside the 4 listed exceptions (allowlist file with justification). [TEN-10] Test: that file.
- [x] 1.127 Reset timing test (realistic dataset, budget 30 s in CI against the 60 s requirement) and a "module without seed data" gap check. [DEM-05, DEM-04] Test: that file.

## S1.37 Stage 1 gate (~200 lines)

Depends: all S1 slices.

- [x] 1.128 `apps/web/e2e/stage1-demo.spec.ts`: two tenants with different branding, role-specific views, audit trail visible. [TEN-01, BRD-02] Test: that spec.
- [x] 1.129 `docs/security/asvs-l2-stage1.md` checklist with evidence links, then a fresh-context security review (`judgment-day`) of identity, authz, RLS, audit; fix findings before Stage 2. Test: review report attached to the PR. (Done: a self-review recorded in the checklist, then the independent fresh-context review of the backend, whose ten findings are fixed or already satisfied, each with a test written first, see apply-progress batch 7 and the checklist section "Independent security review". Decision D19 is pending the owner's confirmation.)
- [x] 1.130 Re-run `sdd-init`; decide strict TDD for Stage 2 apply. Test: none.

---

# Stage 2: Practice core

Goal: a solo professional books a first appointment within 10 minutes; a multi-professional center runs a full day; legacy is removed. Order: scheduling backend (S2.01 to S2.11), scheduling web (S2.12 to S2.16), clinical backend (S2.17 to S2.21), clinical web (S2.22 to S2.24), documents (S2.25 to S2.28), onboarding (S2.29, S2.30), gate (S2.31 to S2.34). Note: payment collection is Stage 4.

## S2.01 Appointment types, blocks, days off (~350 lines)

Depends: Stage 1.

- [x] 2.1 `db/schema/scheduling-config.ts` + migration: `appointment_type` (duration, buffer, virtual, requires approval, color, active), `schedule_block`, `tenant_day_off`; register fixtures. [SCH-02, SCH-07] Test: isolation suite covers the tables.
- [x] 2.2 `modules/scheduling` API for types, blocks, days off (permission `scheduling.configure`, deactivate not delete, audited). [SCH-02, SCH-07, SCH-14] Test: integration CRUD plus denials.
- [x] 2.3 `application/holidays.ts` merging `holiday_catalog` with `tenant_day_off`, and the operator catalog API `/operator/holidays` (platform audit). [SCH-07, CTR-05] Test: moved holiday needs no release; operator-only.

## S2.02 Appointment and occupancy schema (~400 lines)

Depends: S2.01.

- [x] 2.4 `db/schema/scheduling.ts` + migration: `appointment` (all design 3.3 columns incl. `version`, `identity_confirmed`), `appointment_event`, `slot_hold`, `slot_occupancy` with the `btree_gist` exclusion constraint (`tenant_id`, `professional_id`, `lane`, `during`) and a constraint trigger `lane <= max_simultaneous`. [SCH-03, SCH-04, SCH-05] Test: constraint rejects an overlap in one lane.
- [x] 2.5 Triggers keeping `slot_occupancy` in sync (active for pending_approval, scheduled, confirmed, checked_in, in_progress, attended and active holds; no_show and cancelled free it). [SCH-04, SCH-11] Test: transition table toggles `active` correctly.
- [x] 2.6 Concurrency test: N parallel connections book the same professional and slot, exactly one wins and the rest get `23P01`; back-to-back is allowed; buffer counts inside the range. [SCH-04] Test: that file.

## S2.03 Lane assignment domain and time zones (~350 lines)

Depends: S2.02.

- [x] 2.7 `modules/scheduling/domain/lanes.ts`: `assignLane` and greedy `relane` (pure). [SCH-04] Test: unit tables.
- [x] 2.8 Property tests (fast-check): random interval sets never exceed capacity, no overlap per lane, `relane` fits whenever feasible. [SCH-04] Test: that file.
- [x] 2.9 `domain/time.ts`: location time zone conversions with DST gap and overlap handling (use a maintained library such as luxon). [SCH-08] Test: spring-forward and fall-back cases in a DST zone.

## S2.04 Booking service (~400 lines)

Depends: S2.03, S2.01.

- [x] 2.10 `application/book-appointment.ts` inside `withTenant`: read-only check, lock the professional row `FOR UPDATE`, expire stale holds, validate working hours, blocks, holidays, overlap at another location, past-date rule (`scheduling.register_past`), out-of-hours override with reason (`scheduling.override_hours`), lane assignment, `23P01` mapped to `409 slot_taken`. [SCH-03, SCH-04, SCH-06] Test: unit with ports stubbed.
- [x] 2.11 `domain/free-slots.ts` used for the 409 body (next free slots). [SCH-03, SCH-04] Test: next slots exclude blocks and occupancy.
- [x] 2.12 `POST /api/v1/appointments` with contracts in `packages/contracts/src/scheduling.ts`; writes `appointment_event` and audit `appointment.created`. [SCH-03, SCH-06, SCH-07, SCH-14] Test: integration: golden path, overlap, capacity 2, out-of-hours with and without grant, block, holiday, other-location overlap, buffer.

## S2.05 Lifecycle: statuses, reschedule, cancel (~400 lines)

Depends: S2.04.

- [x] 2.13 `domain/appointment-state-machine.ts`: the 8 statuses and the transition table. [SCH-11] Test: exhaustive pair test (every from/to combination).
- [x] 2.14 `application/transition.ts` plus routes to confirm, check in, start, attend, no-show and cancel (reason, actor kind); writes `appointment_event`; optimistic `version`. [SCH-10, SCH-11] Test: integration per transition; `attended` is terminal.
- [x] 2.15 `POST /appointments/:id/reschedule` and reassign (revalidate, version check, event kind `rescheduled`/`reassigned`, hook to rotate `video_room` and revoke tokens). [SCH-09] Test: version conflict returns 409; rescheduled count derivable from events.
- [x] 2.16 Cancellation allowed in a read-only tenant, scheduling and rescheduling refused. [SCH-10, SCH-15] Test: read-only inject matrix.

## S2.06 Reception worklist (~300 lines)

Depends: S2.02.

- [x] 2.17 `db/schema/worklist.ts`: `worklist_item` with the 6 canonical kinds, subject, location, status, encrypted detail, resolver; no delete. [SCH-13] Test: isolation suite; invalid kind rejected.
- [x] 2.18 `modules/scheduling/worklist/index.ts` `openItem`/`resolve` and routes `GET /worklist`, `POST /worklist/:id/resolve|dismiss` (permission `worklist.manage`, filtered by the user's locations, audited). [SCH-13, AUZ-13] Test: location filtering; idempotent open.
- [x] 2.19 Activate `eslint-plugin-boundaries` for `modules/*` (cross-module imports only through `index.ts`). Test: lint fixture that reaches into another module's internals fails.

## S2.07 Identity confirmation (D14, D18) (~350 lines)

Depends: S2.06, S2.05.

- [x] 2.20 `domain/identity-confirmation.ts`: initial value rules (existing patient plus online match or booking actor equals the appointment's professional), eligibility to confirm, solo condition (exactly one active professional and no other active membership) behind a port. [SCH-03, SCH-11, PAT-03] Test: truth table.
- [x] 2.21 Booking path sets `identity_confirmed = false` when required and opens an `identity_review` item; `POST /worklist/:id/confirm-identity` refuses the appointment's own professional. [PAT-03] Test: matrix of who may confirm.
- [x] 2.22 Check-in confirmation: staff other than the professional sets `staff`; the sole professional may set `self_confirmed` only through the in-person check-in action, audited as `appointment.identity.self_confirmed`, evaluated in the same transaction. [SCH-11] Test: reception, other professional, own professional with and without other staff; a staff member joining later keeps earlier self-confirmations valid.
- [x] 2.23 `POST /appointments/:id/detach-patient` (move to a new patient or cancel; the matched record is untouched). [PAT-03] Test: matched patient unchanged.

## S2.08 Care relationship triggers (D2, D14, D15) (~350 lines)

Depends: S2.02, S1.17.

- [x] 2.24 Migration: trigger on `appointment` and function `app.recompute_care_relationship` counting only statuses scheduled, confirmed, checked_in, in_progress, attended, no_show with `identity_confirmed = true` (never pending_approval or cancelled). The encounter trigger comes with the clinical schema (task 2.52). [AUZ-09, SCH-11] Test: see 2.25.
- [x] 2.25 Integration matrix with the `test_clinical_item` fixture and real RLS: unconfirmed online match gives no access; confirmation gives access; confirmed no-show counts; unconfirmed no-show does not; pending_approval and cancelled do not; reassignment moves the relationship. [AUZ-09, SCH-11] Test: that file.

## S2.09 Slot holds (~300 lines)

Depends: S2.04.

- [x] 2.26 `application/holds.ts`: create (staff origin now, public in Stage 3), per-source bound (release oldest), expiry, staff override marks the hold `invalidated`, conversion to appointment; job `hold.expire` (marks `expired`, no waitlist trigger). [SCH-05] Test: unit and integration.
- [x] 2.27 Capacity-1 helper for public flows (`requireNoActiveOverlap`) and the `409 slot_no_longer_available` path after an override. [SCH-05, SCH-04] Test: integration of override then confirm.

## S2.10 Availability and recurring series (~350 lines)

Depends: S2.04.

- [x] 2.28 `GET /api/v1/availability?professionalId&from&to&typeId` computing hours minus blocks minus holidays minus occupancy in the location time zone. [SCH-01, SCH-06] Test: per-scenario cases including buffer.
- [x] 2.29 `POST /appointments/series` as dry run plus commit with a skip list; each occurrence validated independently and individually reschedulable and cancellable. [SCH-12] Test: the two spec scenarios (one conflict, cancel one occurrence).

## S2.11 Scheduling authorization, audit, read-only (~300 lines)

Depends: S2.05.

- [x] 2.30 Register scheduling permissions (`book`, `view`, `configure`, `override_hours`, `register_past`, `delegated_calendar`) and enforce delegated-calendar scope in `can`. [SCH-14, AUZ-12] Test: professional edits only their own calendar unless delegated.
- [x] 2.31 Read-only categories on every scheduling route; booking in a read-only tenant returns 402, cancellation succeeds. [SCH-15] Test: `route-categories` stays green; inject matrix.
- [x] 2.32 Audit action catalogue `appointment.*` and registration in the audit-coverage test. [SCH-14] Test: coverage test green.
- [x] 2.33 `GET /appointments?from&to&professionalIds&locationId` calendar feed with administrative data only; reception filtered by membership locations. [SCH-01, SCH-14] Test: response contains no clinical fields.

## S2.12 Calendar view (~400 lines)

Depends: S2.11, Stage 1 web.

- [x] 2.34 `shared/ui/calendar/CalendarView.tsx`: presentational wrapper over react-big-calendar (day, week, month, resource columns per professional, location time zone, keyboard-accessible list fallback). Record the Q6 decision (polish versus a custom grid) in `docs/adr/calendar.md`. [SCH-01] Test: component tests for resource columns. (Done: a custom grid instead of react-big-calendar, decided in `docs/adr/calendar.md` from a measured spike: axe failures in the day and week views, no location time zone, no keyboard path. The wrapper API stays presentational and swappable.)
- [x] 2.35 `features/calendar/{api,containers}`: query keys, `useCalendar` hook (range, location and professional filters), status legend with `StatusBadge` (never color only). [SCH-01] Test: hook tests. (Done: the legend uses its own icon + word badge for the eight statuses, because the shared `StatusBadge` has a different status set.)
- [x] 2.36 Playwright at 360 px: day view default on mobile with an agenda list. [SCH-01, SHL-02] Test: that spec.

## S2.13 Booking UI (~400 lines)

Depends: S2.12, S2.10.

- [x] 2.37 `features/calendar/components/BookingDialog` with `PatientPicker`, `SlotGrid`, type select, out-of-hours override reason, and handling of `409 slot_taken` with next slots. [SCH-03, SCH-06] Test: component tests.
- [x] 2.38 Drag to move and resize, optimistic with rollback on 409 and an undo toast. [SCH-09] Test: component test of rollback. (Done: drag to move, with `Alt` + arrows as the keyboard equivalent. Resize is NOT offered: the end of an appointment is derived from its type, and the API cannot set it.)
- [x] 2.39 Playwright: reception books an existing patient in 30 seconds or less (step count asserted); overlap conflict message. [SCH-03] Test: that spec.

## S2.14 Appointment drawer (~400 lines)

Depends: S2.13, S2.07.

- [x] 2.40 `AppointmentDrawer`: only valid transitions shown, check-in step with identity confirmation (ID document prompt, solo self-confirm wording), cancel with reason, reschedule, event history. [SCH-11, SCH-10, SCH-09] Test: component tests per status.
- [x] 2.41 Recurring series UI with a conflict review table (skip or abort). [SCH-12] Test: component test.
- [x] 2.42 Playwright full day: book, confirm, check in, start, attend; axe. [SCH-11] Test: that spec.

## S2.15 Worklist, Today and Check-in views (~350 lines)

Depends: S2.14, S2.06.

- [x] 2.43 `features/worklist/*`: list by location, kind filters, nav badge, resolve and dismiss; `identity_review` shows submitted versus on-file differences. [SCH-13] Test: component tests. (Done: `identity_review` shows `detail.differences` when the producer fills it; staff bookings carry none until online booking in Stage 3.)
- [x] 2.44 Professional "Today" view and reception "Check-in" view. [SHL-01, SCH-11] Test: Playwright role matrix.

## S2.16 Scheduling settings UI (~400 lines)

Depends: S2.12.

- [x] 2.45 `features/settings/scheduling`: appointment types, blocks, days off, overbooking `max_simultaneous` per professional (at least 2 requires confirmation), holiday viewer. [SCH-02, SCH-04, SCH-07] Test: component tests.
- [x] 2.46 `features/operator/holidays` catalog editor. [SCH-07, CTR-05] Test: Playwright as operator.

## S2.17 Clinical schema and immutability triggers (~400 lines)

Depends: S1.17, S1.22, S2.08.

- [x] 2.47 `db/schema/clinical.ts` + migration: `encounter`, `clinical_note`, `note_version`, `addendum`, all with `clinicalPolicies`, composite FKs, `REVOKE DELETE`. [CLN-01, CLN-03, CLN-04, CLN-05] Test: isolation suite; `app_rw` cannot delete.
- [x] 2.48 Triggers: signed content immutable, `visibility` change blocked after draft, `addendum` insert-only, `entered_in_error` keeps content. [CLN-03, CLN-04, AUZ-11] Test: each rejected as `app_rw`. (Done in migration 0061; errors use the codes 23000 for immutability, 23503 for a mismatch with the parent and 42501 for the wrong actor; deletes and truncates are refused even for the owner, except the demo reset.)
- [x] 2.49 Encounter trigger feeding `care_relationship` (extends task 2.24). [AUZ-09] Test: an encounter creates the relationship. (Done: an encounter counts at once; an entry marked in error stops counting, so a note opened on the wrong patient does not keep access. Deviation from the text, recorded in apply-progress-stage2-clinical.md.)
- [x] 2.50 Register clinical tables in the isolation fixtures and audit-coverage registry. [TEN-03, CLN-12] Test: both suites green.

## S2.18 Draft and sign (~400 lines)

Depends: S2.17.

- [x] 2.51 `modules/clinical/domain/note.ts` state machine and `application/save-draft.ts` (encrypt with the tenant DEK, `draft_revision` compare-and-set, `409 stale_revision`). [CLN-03] Test: stale save rejected.
- [x] 2.52 `application/sign-note.ts`: insert `note_version` with SHA-256 content hash, status `signed`, audit `clinical.note.signed`; author only, professional gate required. [CLN-03, CLN-05] Test: second sign fails; hash matches content.
- [x] 2.53 Routes `POST /encounters`, `PUT /encounters/:id/note/draft`, `POST /notes/:id/sign`, `GET /notes/:id` (decrypt and audit every read) with permission `clinical.note.write|read`. [CLN-01, CLN-02, CLN-12] Test: golden path.
- [x] 2.54 Access tests: owner/admin get 403 plus a deny audit row, reception denied, direct SQL returns 0 rows, other professional without relationship denied; the admin-denied harness (task 1.56) now covers real routes. [CLN-02] Test: that file.

## S2.19 Addenda, errors, history (~400 lines)

Depends: S2.18.

- [x] 2.55 `application/add-addendum.ts`: treating professionals only; kinds `correction` and `rectification`; a read-only tenant allows `rectification` only (D16); shared readers get 403 plus a deny audit. [CLN-04, TEN-11] Test: scenarios from the spec.
- [x] 2.56 `mark-entered-in-error` (author or another treating professional, reason required, content kept, hidden from the default timeline). [CLN-04] Test: content still readable in history.
- [x] 2.57 `GET /notes/:id/versions` returning signed versions and addenda in order with hashes. [CLN-05] Test: order and hashes.
- [x] 2.58 Shared-read audit with reason `shared`. [CLN-12, AUZ-11] Test: audit row has the reason.

## S2.20 Specialty templates (~400 lines)

Depends: S2.18.

- [x] 2.59 `packages/contracts/src/clinical-templates/` Zod schemas for general, psychology, physiotherapy, nutrition and odontogram payloads plus the template registry. [CLN-06, CLN-07, CLN-08, CLN-09, CLN-10] Test: valid and invalid fixtures per template.
- [x] 2.60 `modules/clinical/domain/templates.ts`: validate content by `templateKind` on save and sign; default `sharedTemplates` consumption. [CLN-06] Test: unknown kind rejected. (Done by the contract registry: the service calls `validateDraftContent` and `validateSignContent` of `@consultorio/contracts`, the same schemas the form uses, so there is no separate `domain/templates.ts`.)
- [x] 2.61 Odontogram data model (FDI numbering, surfaces, conditions) validation. [CLN-07] Test: invalid tooth number rejected.
- [x] 2.62 Psychology exclusion from default sharing verified end to end. [CLN-08] Test: psychology note invisible to a sharing-scope reader by default.

## S2.21 Timeline, search, retention (~400 lines)

Depends: S2.19.

- [x] 2.63 `GET /patients/:id/clinical/timeline` (newest first, `entered_in_error` hidden unless requested, only readable entries, link to anamnesis). [CLN-11, CLN-02] Test: hidden by default; shown on request.
- [x] 2.64 `GET /patients/:id/clinical/search?q=&from=&to=`: decrypt in memory, normalize (NFD, lowercase), substring match, cap of 2,000 entries, audit per entry returned. [CLN-02, CLN-11, CLN-12] Test: accent-insensitive; beyond the cap requires a range; one DEK unwrap per request.
- [x] 2.65 pino redaction test proving clinical routes never log bodies. [CLN-11, SHL-09] Test: log capture.
- [x] 2.66 Retention: clinical data stays readable in a read-only tenant and after deactivation; register the clinical export contributor (per professional). [CLN-13, TEN-08] Test: read-only tenant can read; `REVOKE DELETE` verified.

## S2.22 Clinical editor UI (~400 lines)

Depends: S2.21, S2.15.

- [x] 2.67 `features/clinical/components/ClinicalEditor` (template-driven, react-hook-form with contract schemas, debounced autosave with a "Saved" indicator, stale-revision prompt, sign confirmation warning about immutability). [CLN-01, CLN-03] Test: component tests.
- [x] 2.68 Encounter screen opened from Today and the appointment drawer; `author_only` toggle available at creation and while draft only. [CLN-03, CLN-02] Test: toggle disabled after signing. (Done: the encounter screen is `/notes/:id`, opened from the patient chart, the drafts view and `/encounters/new?patientId=&appointmentId=`, which is the link Today and the appointment drawer will use once scheduling lands.)
- [x] 2.69 Playwright: autosave, stale 409 with two tabs, signed note locked. [CLN-03] Test: that spec.

## S2.23 Specialty UIs and odontogram (~400 lines)

Depends: S2.22.

- [x] 2.70 `features/clinical/templates/{psychology,physiotherapy,nutrition}` components. [CLN-08, CLN-09, CLN-10] Test: component tests.
- [x] 2.71 `Odontogram` component (SVG, keyboard accessible, FDI, mobile friendly). [CLN-07] Test: component plus axe.

## S2.24 Chart, search and addenda UI (~350 lines)

Depends: S2.22.

- [x] 2.72 Patient chart tab: timeline, anamnesis link, `entered_in_error` styling, versions drawer. [CLN-11, CLN-05] Test: component tests.
- [x] 2.73 `ClinicalSearch` (per patient, date range, snippets) and the professional's "Drafts" view. [CLN-02, CLN-11] Test: component tests.
- [x] 2.74 Addendum and entered-in-error dialogs (reason required); reception and admin see the forbidden state. [CLN-04, CLN-02] Test: Playwright role matrix.

## S2.25 Malware scanner and file sniffing (~300 lines)

Depends: S1.24.

- [x] 2.75 `platform/scanning/malware-scanner.ts` port, `adapters/clamav/clamd-client.ts` (INSTREAM over TCP, timeouts, chunking) and a fake scanner that flags the EICAR string. [DOC-02] Test: unit against a fake clamd server; integration with the compose ClamAV (slow tag).
- [x] 2.76 `platform/files/sniff.ts`: magic-byte detection for PDF, JPEG, PNG, WebP, text and DOCX; reject executables, scripts and archives. [DOC-02] Test: polyglot and renamed-executable fixtures.

## S2.26 Upload pipeline (~400 lines)

Depends: S2.25, S2.17.

- [x] 2.77 `db/schema/documents.ts` + migration (status `quarantined|available|rejected|hidden`, sha256, scan result, category, encounter/appointment link, replacement link) with RLS and classification. [DOC-01, DOC-04, DOC-05] Test: isolation suite.
- [x] 2.78 `POST /documents/uploads` returning a presigned POST (20 MB `content-length-range`, content type), at most 10 files per request, tenant and uploader from the session, key `t/{tenantId}/quarantine/{uuid}`; a patient of another tenant returns not found. [DOC-01, DOC-02, DOC-03] Test: 11 files rejected, cross-tenant 404.
- [x] 2.79 Job `document.scan`: sniff, hash, stream to ClamAV, fail closed with backoff and an alert after 1 hour; clean moves to `t/{tenantId}/docs/{uuid}` and becomes `available`; infected or wrong type becomes `rejected` and the uploader is notified. [DOC-02, DOC-06] Test: EICAR rejected, scanner down stays quarantined, renamed executable rejected.

## S2.27 Download and lifecycle (~400 lines)

Depends: S2.26.

- [x] 2.80 `POST /documents/:id/download-link` and `GET /files/:token` per design 5.6 (token kind `document_download`, bound to the session, 5 minutes, single use, authz re-run at redemption, `nosniff`, `no-store`, sanitized disposition). [DOC-03] Test: expiry, reuse, other session, access lost meanwhile.
- [x] 2.81 Classification rules: clinical documents follow clinical read rules, administrative ones are visible to reception, `reception_sees_clinical_metadata` exposes metadata only, admins never see clinical documents. [DOC-04, AUZ-07, AUZ-06] Test: role matrix.
- [x] 2.82 Replace and hide (original retained, never deleted), duplicate detection by sha256 per patient (warning), cleanup job `document.cleanup` for abandoned uploads (marks rows abandoned, may delete orphan objects, never table rows). [DOC-05, DOC-06] Test: replace keeps the original; duplicate warning.
- [x] 2.83 Lists return metadata only; `REVOKE DELETE` on `document`. [DOC-03, DOC-07] Test: list payload has no content fields.

## S2.28 Documents UI (~300 lines)

Depends: S2.27.

- [x] 2.84 `features/documents/*`: multi-file upload with progress and Spanish rejection reasons, patient document list with status chips ("Scanning"), download via the link flow, hide and replace. [DOC-01, DOC-03, DOC-05] Test: component tests.
- [x] 2.85 Documents export contributor and retention note. [DOC-07, TEN-08] Test: registry test lists documents.

## S2.29 Onboarding backend (~400 lines)

Depends: S1.26, S2.01, S1.19.

- [x] 2.86 `db/schema/onboarding.ts` (step progress, wizard completed, checklist dismissed) and `modules/onboarding` API `GET|PUT /onboarding/state` limited to owner (and explicitly granted admins). [ONB-03, ONB-07] Test: professional, reception and patient denied. (Done: `onboarding_state` in migration 0035, `GET|PUT /onboarding/state`, `POST /onboarding/complete`, new permission `onboarding.manage` held by the owner and grantable to an admin; a required step is never skipped or declared done by a click.)
- [x] 2.87 Tenant defaults and initial roles: country AR, time zone, es-AR, first user owner; the "are you a professional?" step creates the owner's professional profile or leaves them without clinical access. [ONB-02, AUZ-04] Test: both scenarios of the spec. (Done: `POST /onboarding/professional` adds the professional role to the owner's own membership through one narrow, audited path, closed once the wizard is finished, and saves the profile; a malformed matricula adds nothing.)
- [x] 2.88 `POST /onboarding/fast-path`: creates a location, Monday to Friday hours and a 30-minute default appointment type, no matricula required. [ONB-04] Test: ready to book afterwards. (Done: `POST /onboarding/fast-path` fills only the gaps, so a repeat creates nothing twice; a first booking was proven through the real API.)
- [x] 2.89 `application/checklist.ts` computing items from real data (location, hours, type, first patient, first appointment, matricula, invite staff, branding) and hiding items of unavailable capabilities. [ONB-05] Test: item completes from data without a click. (Done: `domain/checklist.ts` over `application/facts.ts`; items of unavailable capabilities are not listed.)
- [x] 2.90 Staff invitation from the first run (inviter's ceiling, plan-impact hook that does nothing until subscriptions) and audit of tenant creation, wizard changes and dismissal; `/auth/me` returns `needsWizard`. [ONB-06, ONB-07, ONB-01] Test: invitation grants only the invited role; first sign-in lands in the wizard. (Done: `GET /onboarding/invitation-impact` is the plan-impact hook, `/auth/me` carries `needsWizard`; the invitation itself is the existing `POST /staff/invitations` with its role ceiling.)

## S2.30 Onboarding UI (~400 lines)

Depends: S2.29, S2.16.

- [x] 2.91 `features/onboarding/*` wizard: profile and branding, first location, professionals and invitations, working hours, appointment types; resumable, inline Spanish validation, required steps block completion, skippable optional steps, fast-path chooser. [ONB-03, ONB-04, ONB-08] Test: component tests. (Done: wizard at `/onboarding` with the quick setup, six steps and a review; the sign-in lands there.)
- [x] 2.92 `FirstRunChecklist` in the AppShell slot (owner/admin only, dismissible, reachable from Help, items link to the screen that completes them). [ONB-05, SHL-08, ONB-08] Test: component tests. (Done: card in the shell slot and a dialog from the account menu; the settings link is on the Settings header.)
- [x] 2.93 Playwright at 360 px: resume at step 3, skip branding keeps the default, reception sees no checklist, non-owner is denied the wizard. [ONB-03, ONB-05, ONB-07] Test: that spec. (Done: `e2e/onboarding.spec.ts`, three journeys at 360 px with axe at every step.)

## S2.31 Stage 2 end-to-end and demo data (~400 lines)

Depends: S2.30, S2.28, S2.24, S2.16.

- [x] 2.94 Demo seed extension `db/seed/demo/stage2.ts`: appointments in all 8 statuses, encounters, notes, odontogram, documents (fake PDFs through the fake scanner), worklist items, completed onboarding; every module registers a seed contributor. [DEM-04, DEM-02] Test: gap check fails for a module without a contributor. (Done: `db/seed/demo/stage2.ts` seeds consultations opened from appointments (signed, in progress, an addendum) and eight documents that go through the real upload and the fake scanner, one of them refused; `NO_SEED_DATA.document` is gone; the seed takes a `documents` dependency, the reset empties the bucket. The gap check is the existing `demo-coverage` test. Appointments in all statuses, worklist items and the completed onboarding were already seeded.)
- [x] 2.95 `e2e/stage2-solo.spec.ts` (operator creates tenant, owner invitation from Mailpit, fast path, register patient, book, all at 360 px with a recorded timing under 10 minutes) and `e2e/stage2-center.spec.ts` (multi-professional full day). [ONB-04, SCH-03] Test: those specs. (Done: `e2e/stage2-solo.spec.ts` at 360 px records the time from the first sign-in to the first booked appointment (5.2 seconds of automation in the final run; the budget is 10 minutes) and `e2e/stage2-center.spec.ts` runs a full day across roles with documents; the Playwright stack now runs MinIO and the worker. Found and fixed a real defect: the upload dialog lost its summary when the first file turned the empty list into a list.)
- [x] 2.96 Reset timing re-test with Stage 2 data. [DEM-05] Test: under 60 s. (Done: the reset budget test runs with the Stage 2 data and the documents: 4.7 s against the 60 s requirement.)
- [x] 2.97 Benchmark `clinical_readable` with 100k seeded notes; record the result in `docs/perf/clinical-readable.md` and fix the index if the target is missed (design risk table). Test: benchmark script. (Done: `pnpm --filter @consultorio/api bench:clinical`; with 102,000 notes a chart answers in about 1 ms and a 2,000-entry chart in 26 ms at p95, so no index change; `docs/perf/clinical-readable.md`.)

## S2.32 Delivery pipeline and backups (~300 lines)

Depends: S2.31. May slip to Stage 3 without blocking the Stage 2 gate. Blocked by decision Q1 (region).

- [ ] 2.98 `.github/workflows/deploy.yml`: push the image to ECR and deploy staging on `master`, run migrations as a one-off task first, tags deploy to production behind a manual approval environment. Infrastructure provisioning is out of scope here and is documented in `docs/runbooks/deploy.md`. Test: dry-run on a fork. (DEFERRED, owner action: needs the cloud account, region (Q1), registry and environments; nothing depends on it. `docs/runbooks/deploy.md` records what is ready and what the owner must provide.)
- [x] 2.99 `docs/runbooks/backup-restore.md` (PITR, weekly logical dump, quarterly restore drill). Test: drill checklist. (Done for the local environment: `pnpm backup:local` with `verify` and `restore`, a restore drill test on throwaway containers, `docs/runbooks/backup-restore.md` with the production design and the quarterly drill checklist. The cloud PITR and the weekly dump are the design the infrastructure must meet; they wait for 2.98.)

## S2.33 Stage 2 gate (~150 lines)

Depends: S2.31.

- [ ] 2.100 Fresh-context review (`judgment-day`) of scheduling concurrency, clinical access and the documents pipeline; fix findings. Test: review report attached. (PENDING, for the orchestrator: a fresh-context review cannot be run by the executor. The executor read the three areas again while integrating and found the defects recorded in apply-progress "Stage 2 integration 2"; the independent `judgment-day` review is still to be run and its report attached.)
- [ ] 2.101 `docs/legacy-parity.md` mapping legacy domains (auth, pacientes, profesionales, turnos, horarios, atencion, historias clinicas, asistencias) to the new features; facturacion and recetas stay reference-only until Stages 4 and 5 and remain recoverable from the legacy repository. Owner signs off. Test: checklist. (Document written: `docs/legacy-parity.md`. The owner's sign-off is pending.)

## S2.34 Legacy removal (N/A: legacy lives in a separate repo)

Not applicable: the legacy reference app lives in the separate archived repository `francocor/AppmedicoCMAillu`, so there is nothing to tag or remove in this repository. Tasks 2.102 and 2.103 are closed as N/A.

- [x] 2.102 N/A: legacy lives in a separate repo (`francocor/AppmedicoCMAillu`, archived). There is no legacy code here to tag.
- [x] 2.103 N/A: legacy lives in a separate repo (`francocor/AppmedicoCMAillu`, archived). There is no legacy code here to remove.

---

# Stage 3: Patient engagement

Goal: a patient books online, receives a reminder by email and WhatsApp and confirms; a waiting patient is offered a freed slot; a virtual appointment gets a join link. Everything runs locally: Mailpit for email, a WhatsApp simulator, a local video-room provider and a local bot challenge. Order: seams (S3.00, S3.00b), four parallel tracks, then integration (S3.16 to S3.18). Real providers live in the deferred slice S3.D and never block a gate. Depends on Stage 2 (scheduling, holds, availability, worklist, reschedule hook) and on the Stage 1 tokens, mail, jobs and read-only platform.

> Codes for Stages 3 to 6 (same rule as above: NN is the position of the requirement in its `spec.md`): NTF notifications, OBK online-booking, WTL waitlist, TLC teleconsultation, BIL billing-payments, RPT reports-dashboard, INV e-invoicing-afip, ERX e-prescription, CNS informed-consent, POR patient-portal, SUB subscriptions. tenant-onboarding Part B continues the ONB numbering: ONB-09 to ONB-15. The traceability section at the end expands every code.

### Local-first provider rules (apply to Stages 3 to 6; owner decision 2026-10-17)

| Topic | Rule |
|---|---|
| Port and adapters | A port lives in `modules/<module>/application/ports.ts` (or `platform/<name>/` when several modules use it). Adapters live in `apps/api/src/adapters/<provider>-<kind>/index.ts`. Each port gets a `-fake` adapter (in memory and deterministic; fills the demo slot of the resolver and the unit tests) and a `-local` adapter (a working simulator persisted in Postgres, so the API and the worker share state; fills the customer slot while `<NAME>_PROVIDER=local`). Both are registered with `fake()` in `main/adapter-resolver.ts`, because neither has any effect outside the process. |
| Contract suite | One shared suite per port (`adapters/<provider>/<port>.contract.ts`). Fake, local and, later, real adapters must all pass it. |
| Simulator controls | `/operator/dev/<provider>/*` routes plus a tab in `features/operator/dev/` change the simulator mode (outage, timeout after success, rejection, delivery receipts, inbound replies). They exist only when `LOCAL_PROVIDERS_CONSOLE=true` and are absent otherwise (route-enumeration test). |
| Production guard | `main/config.ts` refuses to start with `NODE_ENV=production` and any `*_PROVIDER=local`, unless `ALLOW_LOCAL_PROVIDERS=true` (documented as demo or staging only). Simulated documents carry a visible "simulated" mark. |
| Deferred tasks | A task tagged `deferred: needs owner credentials/contract` is never a dependency of a slice, a gate or a demo. It must pass the same contract suite as the local adapter. |
| Removed from the plan | Legal and lead-time work (hosting review Q1, governance-mode erasure Q7, AFIP certificate request, WABA verification, e-Rx contract, Mercado Pago account) is not a task here. It is an owner action tracked in `docs/external-dependencies.md`. |

### Parallel tracks (Stage 3)

| Track | Slices | New files live in | Migration range | Locale files |
|---|---|---|---|---|
| Seams | S3.00, S3.00b | every shared file, touched once | 0300-0319 | none |
| A Messaging | S3.01 to S3.06 | `modules/notifications`, `adapters/whatsapp-*`, `features/settings/messaging`, `features/operator/dev/whatsapp` | 0320-0339 | `messaging.json`, `errors.notifications.json` |
| B Public booking | S3.07 to S3.10 | `modules/online-booking`, `adapters/bot-challenge-*`, `features/public-booking` | 0340-0359 | `booking.json`, `errors.online-booking.json` |
| C Waitlist | S3.11 to S3.13 | `modules/waitlist`, `features/waitlist` | 0360-0369 | `waitlist.json`, `errors.waitlist.json` |
| D Teleconsultation | S3.14, S3.15 | `modules/teleconsultation`, `adapters/video-*`, `features/teleconsultation` | 0370-0379 | `teleconsultation.json`, `errors.teleconsultation.json` |
| E Integration | S3.16 to S3.18 | `db/seed/demo/stage3`, `test/policy`, `e2e` | 0390-0399 | none |

- Run order: S3.00 and S3.00b first (one branch each, they can overlap). Then A (S3.01 to S3.06), B (S3.07, S3.08) and D (S3.14, S3.15) run at the same time. S3.09 and S3.10 wait for S3.01 and S3.03. C waits for S3.01, S3.03, S3.05 (A) and S3.08 (B). E starts when A to D are merged.
- Shared files that still need a merge step (S3.00 and S3.00b pre-register everything else): `db/migrations/meta/_journal.json` and its snapshots (run `pnpm db:restamp` after every rebase), `platform/tokens/kinds.ts` (each track flips only its own `enabled` lines, so Git merges them), `db/seed/demo/contributors.ts` (only S3.16 edits it).
- Tracks never edit another track's module. Cross-module calls go through `index.ts` (boundaries rule) and the appointment event bus of task 3.5.

## S3.00 Platform seams (~450)

Start: Stage 2 gate merged (at least S2.06 worklist, S2.09 holds, S2.10 availability and the reschedule hook of task 2.15). Done when: the four module skeletons are wired, every shared registry already has its Stage 3 entries, and nothing behaves differently yet. Verify: default, plus the adapter resolver test iterating every port (the three new ones included) and `export-registry.test.ts` listing the new modules. Rollback: default (empty routes and unused ports).

- [x] 3.1 `apps/api/src/platform/local-providers/guard.ts` and `main/config.ts`: add `WHATSAPP_PROVIDER` (`local|meta|off`), `VIDEO_PROVIDER` (`local|jaas|off`), `BOT_CHALLENGE` (`local|turnstile`), `WHATSAPP_APP_SECRET`, `VIDEO_ALLOWED_DOMAINS`, `ALLOW_LOCAL_PROVIDERS`, `LOCAL_PROVIDERS_CONSOLE`; startup fails when production selects a local provider without the allow flag; `.env.example` documents each. [DEM-03] Test: `guard.test.ts` matrix (environment x provider x demo flag); the `.env.example` config test stays green.
- [x] 3.2 Ports and demo fakes: `modules/notifications/application/ports.ts` (`WhatsAppSender`: `send({templateKey, to, vars, idempotencyKey})`, `verifyWebhook(rawBody, headers)`, `parseEvents(body)`), `modules/teleconsultation/application/ports.ts` (`VideoLinkProvider`: `createRoom(opaqueId)`, `joinUrl(room)`), `platform/bot-challenge/bot-challenge.ts` (`BotChallenge`: `issue()`, `verify(proof, ip)`); in-memory `adapters/whatsapp-fake/`, `adapters/video-fake/` (static URL), `adapters/bot-challenge-fake/` (always passes); extend `AdapterPorts` and `ADAPTER_PORTS` in `main/adapter-resolver.ts` with `whatsapp`, `videoLink`, `botChallenge`. [DEM-03, NTF-09] Test: `adapter-resolver.test.ts` iterates every port; a non-fake demo slot throws at startup.
- [x] 3.3 Contracts and catalogs, written once: skeleton files `packages/contracts/src/{notifications,online-booking,waitlist,teleconsultation}.ts` exported from `index.ts`; permissions in `roles.ts` (`notifications.manage` owner/admin, `notifications.log.read` owner/admin/reception, `booking.manage` owner/admin, `waitlist.manage` owner/admin/reception/professional, `teleconsultation.join` professional); Stage 3 audit actions in `audit-actions.ts` (`notification.optout.recorded|optin.recorded|resend|integration.changed`, `booking.link.enabled|disabled|regenerated`, `booking.online.created`, `booking.suspicious`, `waitlist.entry.created|updated|closed`, `waitlist.offer.created|accepted|declined|expired`, `waitlist.priority.overridden`, `video.link.created|opened|revoked|joined|manual_attached`). [NTF-10, OBK-08, WTL-06, TLC-05] Test: `roles.test.ts` invariants (no `clinical.*` outside professional, `GRANTABLE` unchanged) and `audit-actions.test.ts` (metadata schema rejects clinical keys) stay green.
- [x] 3.4 Queues in `platform/jobs/queues.ts`: `reminder.plan`, `reminder.send`, `reminder.sweep`, `otp.send`, `booking.purge`, `waitlist.match`, `waitlist.offer`, `waitlist.expire`, `video.link.create` (`hold.expire` already exists from Stage 2); classify them in `platform/read-only/jobs.ts` (all cancel in a read-only tenant). Token kinds stay disabled until the owning slice flips its own `enabled` line. [TEN-11] Test: integration — `installJobs` creates every queue; the classification table test in `platform/read-only/jobs.test.ts`.
- [x] 3.5 `platform/events/appointment-events.ts`: typed `AppointmentEvent` (`created`, `rescheduled`, `reassigned`, `status_changed`, `cancelled`, `slot_freed`, each with appointment id, professional, location, type, start and end, source, `version`), `publishAppointmentEvent(tx, event)` and `subscribeAppointmentEvents(handler)`: synchronous and in the same transaction, so a failing subscriber rolls the business write back. Publish calls go into `modules/scheduling/application/{book-appointment,transition,reschedule}.ts` and block removal (reuse the Stage 2 reschedule hook when it exists). [NTF-02, WTL-02, TLC-03] Test: integration `appointment-events.test.ts` — each scheduling action publishes exactly one event; `slot_freed` fires on cancel, reschedule away and block removal but never on hold expiry.
- [x] 3.6 Module skeletons: `modules/{notifications,online-booking,waitlist,teleconsultation}/index.ts` (`createX(options)` returning `{ routes }` and `registerXExportContributors`), `main/wiring/{notifications,online-booking,waitlist,teleconsultation}.ts` plus `main/wiring/index.ts` passed to `ApplicationOptions.modules` in `main/main.ts`; contributors registered in `main/export-contributors.ts`; the fixture registry becomes a glob over `apps/api/test/support/fixtures/*.ts`. [TEN-08] Test: `export-registry.test.ts` and `compose.test.ts` green with the four new directories; the isolation suite still discovers fixtures.

## S3.00b Tooling and web seams (~350)

Start: Stage 2 gate merged; task 3.10 needs task 3.1. Parallel with S3.00. Done when: a new migration can be created in a track range, modules can register settings sections, and a new web feature appears in routes, nav, slots and i18n without editing a shared file. Verify: default plus `pnpm --filter @consultorio/web build`. Rollback: default.

- [x] 3.7 Migration lanes: `apps/api/scripts/new-migration.ts <track> <name>` creates a custom migration in the track range (ranges in `docs/migration-ranges.md`: Stage 3 is 0300-0399, Stage 4 0400-0499, Stage 5 0500-0599, Stage 6 0600-0699) and appends the journal entry with a `when` later than every existing one; `scripts/restamp-migrations.ts` (`pnpm db:restamp`) re-stamps `when` in merge order after a rebase; `check-migration-drift.ts` also fails on a non-monotonic `when`, a duplicate tag or an out-of-range prefix. Reason: Drizzle's migrator only applies entries newer than the last applied one, so a branch with an older `when` would be skipped silently on an existing database. [TEN-03] Test: `new-migration.test.ts` and `restamp.test.ts` on a temp journal; the drift test fails on a non-monotonic journal.
- [x] 3.8 `platform/settings-sections.ts`: a module registers a Zod section with defaults; `modules/access` merges registered sections into `GET|PATCH /api/v1/settings` and audits `setting.changed`. Sections declared now: `notifications` (`reminderLeadHours`, `quietHours`, `hideProfessional`, `hideAppointmentType`), `onlineBooking` (`minLeadHours`, `horizonDays`, `dailyCap`, `rescheduleDeadlineHours`, `requireApproval`), `waitlist` (`entryExpiryDays`, `offerWindowMinutes`, `minOfferLeadMinutes`, `maxActiveEntries`), `teleconsultation` (`joinOpensMinutes`, `noShowAfterMinutes`), `integrations` (`whatsapp`, `video`). [NTF-08, OBK-02, WTL-01, TLC-02] Test: unknown section rejected; defaults applied; each change audited; reception denied.
- [x] 3.9 Web registries in `apps/web/src/app/registry.ts`: `import.meta.glob('../features/**/routes.tsx')` and `'../features/**/nav.ts'` feed `router.tsx` and `nav/nav-config.ts`; `app/slots.ts` slot registry with `appointment-drawer`, `patient-detail-tab` and `settings-section` (the Stage 2 `AppointmentDrawer` and the Stage 1 patient detail and settings pages render their slots); `app/i18n.ts` loads `locales/es-AR/*.json` and `errors.<module>.json` by glob; an ESLint boundary lets a feature import another feature only through its `index.ts`. [SHL-01, SHL-05] Test: registry test with two fixture features; the i18n missing-key test stays green; a lint fixture breaking the boundary fails.
- [x] 3.10 Provider console shell: `platform/local-providers/dev-routes.ts` (registers `/operator/dev/*` only when `LOCAL_PROVIDERS_CONSOLE=true`, behind the operator session; `GET /operator/dev/providers` lists active adapters and their modes) and `features/operator/dev/ProvidersPage.tsx` with a tab registry the later slices extend. [DEM-03] Test: the route-enumeration test passes in both modes; a non-operator gets 404; component test renders the tab list.

## S3.01 Notifications core (~400) [Track A]

Start: S3.00. Done when: a reminder row is sent through Mailpit locally and through the demo fake for a demo tenant, with the right status and reason. Verify: default plus `apps/api/test/integration/notifications-send.test.ts`. Rollback: default (no producer yet, so nothing sends).

- [x] 3.11 `db/schema/notifications.ts` + migration `0320_notifications_core.sql`: `message` (tenant, appointment, patient, professional for quota, kind, channel, status `queued|sent|delivered|read|failed|cancelled`, `cancel_reason`, `provider_message_id`, `dedupe_key` UNIQUE with tenant), `message_attempt`; `tenantPolicies`, fixtures in `test/support/fixtures/notifications.ts`. [NTF-06, NTF-10] Test: isolation suite covers both tables; a second row with the same dedupe key is rejected.
- [x] 3.12 `modules/notifications/domain/channel-policy.ts` (pure): email-only kinds (codes, invitations, resets, portal notices, consent requests, invoices, subscription notices), WhatsApp only for reminder, confirmation and waitlist offer and only with a recorded opt-in, fallback order, unreachable contacts skipped. [NTF-01, NTF-04, NTF-06] Test: truth table plus a property test that a non-appointment kind never selects WhatsApp.
- [x] 3.13 `domain/content.ts` and `application/render.ts` with es-AR templates in `modules/notifications/assets/es-AR/`: the render input type has no clinical fields (compile-time check), neutral wording when `hideProfessional` or `hideAppointmentType` is on, only first name, date, time, location, professional and (if allowed) type, organization name from branding. [NTF-05] Test: snapshots per template, neutral wording case, two tenants render their own names, a `@ts-expect-error` test for the type guard.
- [x] 3.14 `application/send-message.ts` and job `reminder.send` (`defineJob`): idempotent by dedupe key; re-checks the tenant at run time (`cancelled`/`tenant_read_only`, demo tenant gets `cancelled`/`demo_tenant` through the demo fake); transient errors retried up to 3 times with growing delay and never past the appointment start; a permanent failure marks the contact unreachable, falls back to the other permitted channel, and with none left opens the worklist item `reminder_not_delivered` through the scheduling `openItem`. [NTF-06, NTF-09, NTF-02] Test: integration — transient failure then success sends once; both channels fail opens the item; read-only tenant cancels; demo tenant cancels.

## S3.02 Reminder scheduling (~400) [Track A]

Start: S3.01 and the event bus (3.5). Done when: booking, moving and cancelling an appointment keep the reminder queue correct without any call from scheduling code. Verify: default plus `reminder-plan.test.ts`. Rollback: default; turning off every lead time in `settings.notifications` stops reminders without a deploy.

- [x] 3.15 `application/plan-reminders.ts`, a subscriber on appointment events (job `reminder.plan` when work is heavy): computes up to three lead times from `settings.notifications.reminderLeadHours` in the location time zone, enqueues `reminder.send` with `startAfter`, cancels reminders of an older appointment `version` on reschedule, reassignment, cancel and attended, skips overdue leads, and sends the confirmation immediately for a last-minute booking. [NTF-02] Test: integration — default 24 h reminder; reschedule replaces; cancel prevents; booking 3 h before start sends only the confirmation.
- [x] 3.16 `domain/quiet-hours.ts` (pure, uses the Stage 2 `domain/time.ts`): default 21:00-08:00 in the location zone, a reminder due inside it moves to the end if that is still before the appointment, otherwise it is skipped and the worklist item `reminder_not_sent` opens; confirmations that answer an action, codes and transactional email are exempt. [NTF-02] Test: the two spec scenarios (07:00 appointment deferred to 08:00; 07:30 appointment with a 1 h lead skipped) plus a DST-day case.
- [x] 3.17 Worklist producers: job `reminder.sweep` (hourly) opens `reminder_not_sent` for appointments whose patient has no reachable channel (all opted out, no email, WhatsApp off with no email) through `openItem` (idempotent), and the appointment feed marks them "no automated reminders". [NTF-02, NTF-04] Test: opted-out patient appears once; fixing the contact closes the need on the next sweep.
- [x] 3.18 Retry-safety test `apps/api/test/integration/reminder-idempotency.test.ts`: a worker killed after the provider accepted the message but before the status write sends no second message on retry. [NTF-02] Test: that file.

## S3.03 Public action tokens (~400) [Track A]

Start: S3.01. Done when: a confirmation link in a reminder confirms the appointment, and every invalid link looks the same. Verify: default plus `public-routes` allowlist test. Rollback: default (kinds flip back to `enabled: false`).

- [x] 3.19 `platform/public/token-router.ts`: `GET|POST /public/t/:token` with a handler registry `registerTokenHandler(kind, handler)`; unknown, expired, used and tampered tokens return one identical generic body and timing class; the page shows only date, time, location and professional; rate limited; route category declared. [NTF-03, IDA-01] Test: guessed token body equals expired token body; the boot-time public allowlist test passes.
- [x] 3.20 `modules/notifications/http/token-handlers.ts`: `appointment_confirm` (status `confirmed`, confirmation time recorded), `appointment_cancel` (cancelled by the patient, honors the organization deadline and the late-cancellation flag of scheduling), `notification_opt_out` (per patient and channel); flip those kinds to `enabled: true` in `platform/tokens/kinds.ts`; tokens issued while rendering reminders with links from `PublicOrigins`. [NTF-03, NTF-04] Test: confirm works; link after the start says "no longer valid"; cancel after the deadline says contact the organization; opt-out link scoped to one patient and channel.
- [x] 3.21 Revocation and read-only: a subscriber revokes the previous appointment tokens on reschedule, reassignment and cancel (`revokeBySubject`); in a read-only tenant confirm and reschedule are refused while cancel and opt-out still work (allowlist category 6). [TEN-11, NTF-03] Test: old link dead after reschedule; read-only inject matrix per kind.

## S3.04 WhatsApp simulator and webhooks (~400) [Track A]

Start: S3.01. Done when: a reminder sent over WhatsApp shows in the simulator, delivery receipts and replies arrive through the real signed webhook, and a reply "1" confirms the appointment. Verify: default plus `whatsapp-loop.test.ts`. Rollback: default (`WHATSAPP_PROVIDER=off`).

- [x] 3.22 `adapters/whatsapp-local/` + migration `0322_local_whatsapp.sql` (platform tables `local_whatsapp_message`, `local_whatsapp_control`, no `tenant_id`, never selected in production): implements `WhatsAppSender`, assigns provider ids, rejects unapproved template keys, treats numbers with the reserved test prefix as "not on WhatsApp", supports modes `ok|down|reject_template`; registered in the customer slot when `WHATSAPP_PROVIDER=local`. [NTF-01, NTF-06] Test: `whatsapp.contract.ts` runs against fake and local (Postgres store); mode switching test.
- [x] 3.23 `modules/notifications/http/whatsapp-webhook.ts`, `POST /webhooks/whatsapp`: raw-body capture, `X-Hub-Signature-256` HMAC-SHA256 with `WHATSAPP_APP_SECRET`, idempotent by event id, tenant derived from the matched outbound message or the sender identity (never from the body), status transitions (`sent`, `delivered`, `read`, `failed`), unknown senders ignored without creating records; allowed in a read-only tenant (category 9). [NTF-07, TEN-11] Test: invalid signature changes nothing; replayed event counted once; unknown sender ignored.
- [x] 3.24 Simulator controls `/operator/dev/whatsapp/*` (list messages, mark delivered, read or failed, send an inbound reply, mark a number unreachable, set mode); every simulated event is signed locally and POSTed to the real webhook so the verification path is exercised. [NTF-07] Test: integration `whatsapp-loop.test.ts` — reminder, delivered receipt, reply "1" confirms the appointment through the webhook.
- [x] 3.25 `application/inbound.ts`: keywords `STOP`/`BAJA` opt out of WhatsApp with one acknowledgment; fixed replies `1` (confirm) and `2` (cancel) applied only when the reply matches one outstanding message unambiguously; shared phone number or unclear text changes nothing and opens `reply_to_review`; "SI" never creates an opt-in. [NTF-03, NTF-04] Test: spec scenarios — BAJA, "maybe tomorrow", two patients on one number, "SI" without opt-in.

## S3.05 Opt-in and usage metering (~350) [Track A]

Start: S3.04. Done when: opt-in and opt-out follow the spec in every source, and each accepted WhatsApp message counts once against its professional. Verify: default plus `usage-metering.test.ts`. Rollback: default.

- [x] 3.26 `db/schema/channel-preference.ts` + migration `0321_channel_preference.sql` and `application/preferences.ts`: opt-out effective immediately (queued messages of that channel become `cancelled`/`opted_out`), staff cannot re-enable a channel the patient opted out of, opt-in sources `online_booking|staff|patient_email_link`, a WhatsApp message never opts in; routes for staff to record an in-person opt-in or opt-out; audit `notification.optin.recorded|optout.recorded`. [NTF-04, NTF-10] Test: staff re-enable refused; opt-out cancels queued messages; every source stores time, source and staff member.
- [x] 3.27 Opt-in by email: enable token kind `whatsapp_opt_in`, route `POST /patients/:id/whatsapp-opt-in-request` (reception, email only), handler in the token router. [NTF-04] Test: scenario "opt-in by email link"; a patient without email is refused.
- [x] 3.28 `db/schema/usage-event.ts` + migration `0323_whatsapp_usage.sql` (`whatsapp_usage_event`: message, professional, counted_at, period) written only when the provider accepts the message, also in single mode; `GET /notifications/usage` (per professional, counts only); a `QuotaPolicy` port whose default allows everything and only counts (Stage 6 plugs the plan quota in); owner email at 80% and 100% once per period. [NTF-08, SUB-09] Test: usage per professional; a rejected message is not counted; email is not counted; threshold fires once per period.
- [x] 3.29 Integration switch: `settings.integrations.whatsapp=false` makes reminders email only and opens `reminder_not_sent` for patients without email; the change is audited `notification.integration.changed`. [NTF-08, NTF-10] Test: scenario "WhatsApp switched off".

## S3.06 Messaging UI (~400) [Track A]

Start: S3.05, S3.00b. Done when: staff configure reminders, see each appointment's message log and a developer can drive the WhatsApp simulator from the browser. Verify: default plus `e2e/stage3-messaging.spec.ts`. Rollback: default.

- [x] 3.30 `features/settings/messaging/*` (route and nav through `routes.tsx` and `nav.ts`): up to three lead times, quiet hours, neutral wording toggles, WhatsApp switch, usage per professional with the 80% and 100% states; Spanish inline validation in `locales/es-AR/messaging.json`. [NTF-02, NTF-05, NTF-08] Test: component tests plus axe.
- [x] 3.31 `features/settings/messaging/components/MessageLog.tsx` mounted in the `appointment-drawer` slot: per-channel status, failure reason, and a manual resend button limited to 3 per appointment that refuses an opted-out channel (`POST /appointments/:id/messages/resend`). [NTF-06, NTF-10] Test: component tests; integration — opt-out refusal and the fourth resend refused.
- [x] 3.32 Patient channels panel in the `patient-detail-tab` slot: opt-in and opt-out state per channel, "record in-person opt-in", "send WhatsApp opt-in by email", the re-enable control disabled with an explanation when the patient opted out. [NTF-04] Test: component tests.
- [x] 3.33 `features/operator/dev/WhatsAppSimulator.tsx` (phone-style view of outbound messages, delivery buttons, reply box) and `e2e/stage3-messaging.spec.ts` at 360 px: reminder in Mailpit and in the simulator, confirm by link, reply "BAJA" cancels the pending reminder; axe. [NTF-02, NTF-03, NTF-04, NTF-07] Test: that spec.

## S3.07 Public availability and holds (~400) [Track B]

Start: S3.00, S2.09, S2.10. Done when: an anonymous visitor sees only bookable slots through a link and can hold one. Verify: default plus `public-availability.test.ts`. Rollback: default (links disabled by default).

- [x] 3.34 `db/schema/online-booking.ts` + migration `0340_online_booking_links.sql`: `booking_link` (tenant, optional professional, slug unique across the platform, enabled, regenerated_at) and an expand column `appointment_type.online_bookable`; fixtures. [OBK-01, OBK-02] Test: isolation suite; duplicate slug rejected.
- [x] 3.35 `modules/online-booking/application/links.ts` and staff routes `POST|PATCH /booking-links` (permission `booking.manage`): enable, disable, regenerate (the old link stops at once and shows the generic "not available" page), choose professionals, locations and types; audit `booking.link.*`. [OBK-01] Test: regenerated link dead; hidden professional cannot be requested by id.
- [x] 3.36 `http/public-availability.ts`: `GET /public/:slug/booking/availability` and `/public/:slug/p/:professionalSlug` reuse scheduling availability with capacity forced to 1, minimum lead time, horizon, optional daily cap, only online-bookable types (virtual ones only with a configured video provider), location time zone label, 30 s cache, no reason for unavailability; tenant from the slug only; read-only tenant gets the generic page. [OBK-01, OBK-02, OBK-09] Test: lead time and horizon scenarios, overbooked capacity hidden, forged tenant field ignored.
- [x] 3.37 `application/public-holds.ts`, `POST /public/:slug/booking/holds` calling the scheduling holds with origin `public` and `requireNoActiveOverlap`: 10 minute expiry, per-source bound (hashed IP, user agent and anonymous session id), a staff override invalidates it, expiry never triggers the waitlist; bot challenge verified first. [OBK-03, OBK-05] Test: two visitors, one wins; second hold releases the first; expiry frees the slot.
- [x] 3.38 `adapters/bot-challenge-local/`: signed proof-of-work (`GET /public/challenge` issues an HMAC-signed puzzle, the client posts the solution), replay-proof, short lived; customer slot when `BOT_CHALLENGE=local`. [OBK-05] Test: `bot-challenge.contract.ts` on fake and local; wrong, expired and replayed solutions rejected.

## S3.08 Submission and OTP (~400) [Track B]

Start: S3.07. Done when: a submitted form creates no patient and no appointment until the emailed code is verified, and unverified data disappears after 24 hours. Verify: default plus `booking-submission.test.ts`. Rollback: default.

- [x] 3.39 `db/schema/booking-submission.ts` + migration `0341_booking_submission.sql`: `booking_submission` (kind `booking|waitlist_join`, `payload_enc` with the tenant DEK, email, status, hold id, `purge_after`) and `otp_challenge` (purpose, email, code hash, attempts, sends, expires_at); RLS and fixtures. [OBK-04, OBK-08] Test: isolation suite; raw SQL shows no plaintext payload.
- [x] 3.40 `POST /public/:slug/booking/holds/:id/submission`: validates the DNI with the country pack, requires the data-processing consent, optional mobile, unticked WhatsApp choice, optional free-text reason with a warning, no clinical question; creates the unverified submission; enqueues `otp.send` to the submitted email only (6 digits, 10 minutes, 5 attempts, 3 sends per email per hour; quiet-hours exempt). [OBK-04, OBK-05] Test: code goes only to the submitted address; missing consent and invalid DNI refused; flooding and guessing limits.
- [x] 3.41 `application/abuse.ts`: per-source and per-link rate limits, at most 3 future online appointments per contact or DNI, a daily booking cap, generic messages, suspicious activity recorded for the admin (`booking.suspicious`) and counted in a metric. [OBK-05] Test: slot hoarding refused with the contact-us message; forged tenant or role fields ignored.
- [x] 3.42 Job `booking.purge` (hourly): hard-deletes `booking_submission` rows still unverified after 24 h (retention exception 4, listed in the `no-delete` allowlist) and expired `otp_challenge` rows; never touches verified rows or patients. [OBK-08, TEN-10] Test: only unverified rows older than 24 h are deleted; no patient exists for them.

## S3.09 Match, approval and self-service (~400) [Track B]

Start: S3.08, S3.03 (token router), S3.01. Done when: verified bookings create appointments with the D14 rules, and a patient can cancel or reschedule from the emailed link. Verify: default plus `confirm-booking.test.ts`. Rollback: default (disable the link).

- [ ] 3.43 `application/confirm-booking.ts`, `POST /public/:slug/booking/holds/:id/confirm {otp}` in one transaction: verify the code, re-run the booking checks, convert the hold, then either create a patient (`origin=online`, identity confirmed) or attach to the document match with `identity_confirmed=false` without overwriting the record and open the `identity_review` item with the differences; record the consent and, if ticked, the WhatsApp opt-in `online_booking`; `pending_approval` plus a worklist item when approval is required; identical response either way. [OBK-04, PAT-03, NTF-04] Test: spec scenarios — new patient, existing patient not revealed, stranger with a victim's DNI gets no care relationship, approval required, unverified expires. **PARTIAL (apply-progress-stage3-track-b.md)**: the booking, D14 rules, approval, consent and audit are done; recording the WhatsApp opt-in as `online_booking` waits for track A (S3.05 `channel_preference`): online-booking calls the `BookingNotifier.recordWhatsAppOptIn` port, which A fills.
- [x] 3.44 Self-service change: enable `appointment_reschedule`, `GET /public/t/:token/slots` and `POST` reschedule (same constraints as a new booking, previous slot released only when the new one is confirmed, default 12 h deadline, afterwards the page says to contact the organization); cancel through the link publishes the waitlist trigger. [OBK-07, NTF-03] Test: cancel before and after the deadline; reschedule onto a taken slot keeps the original.
- [ ] 3.45 `application/ics.ts` (calendar file with no clinical content) and the immediate `booking_confirmation` message through notifications (exempt from quiet hours). [OBK-04] Test: `.ics` snapshot; confirmation sent once through the verified channel. **PARTIAL (apply-progress-stage3-track-b.md)**: `application/ics.ts` is done; the confirmation goes out as an email from this module until track A (S3.01) provides `booking_confirmation` through notifications, then the notifier is swapped.
- [x] 3.46 Audit and read-only: `appointment.created` with `source=online` and the verified contact channel only; read-only tenant shows the generic page for booking and join while token cancel keeps working. [OBK-08, OBK-09] Test: audit row fields; read-only inject matrix.

## S3.10 Public booking UI (~400) [Track B]

Start: S3.09, S3.00b. Done when: a visitor completes the whole flow at 360 px. Verify: default plus `e2e/stage3-booking.spec.ts`. Rollback: default.

- [x] 3.47 `features/public-booking/*` (`/book/:slug`, `/book/:slug/p/:professionalSlug`, `/book/manage/:token`): branded `BookingShell`, professional and type choice, `SlotPicker` with time-zone label and next-slot alternatives, generic "not available" page; `locales/es-AR/booking.json`. [OBK-01, OBK-02, OBK-07] Test: component tests plus axe.
- [x] 3.48 Form with consent, optional mobile, unticked WhatsApp checkbox, privacy note on the reason field, `BotChallenge` widget solving the local puzzle in a Web Worker, OTP step, hold countdown and one confirmation screen for new and existing patients. [OBK-03, OBK-04, OBK-05] Test: component tests including Spanish validation messages.
- [ ] 3.49 Fallback to the waitlist when nothing is free (link to the S3.12 flow) and the manage page for reschedule and cancel. [OBK-06, OBK-07] Test: component tests. **PARTIAL (apply-progress-stage3-track-b.md)**: the manage page (reschedule and cancel) is done; the fallback to the waitlist shows the contact message and a link slot that stays empty until track C (S3.12, S3.61) provides the join page.
- [x] 3.50 `e2e/stage3-booking.spec.ts` at 360 px: visitor books, reads the code from the Mailpit API, sees the confirmation; two browser contexts race for one slot; a disabled link shows the generic page; axe on every step. [OBK-01, OBK-03, OBK-04] Test: that spec.

## S3.11 Waitlist core (~400) [Track C]

Start: S3.01, S3.00 (events). Done when: freed slots find matching entries. Verify: default plus `waitlist-matching.test.ts`. Rollback: default.

- [x] 3.51 `db/schema/waitlist.ts` + migration `0360_waitlist.sql`: `waitlist_entry` (patient, type, optional professional and location, weekdays, time ranges, earliest and latest date, expiry default 60 days, status `active|paused|offered|closed`, close reason, `manual_contact_only`, offers opt-in time and source, channels, priority) and `waitlist_offer` (entry, slot key, status `open|accepted|declined|expired|invalidated`, expiry, response time), UNIQUE (entry, slot key), no delete. [WTL-01, WTL-06] Test: isolation suite; one active entry per patient, type, professional and location; no duplicate offer per slot.
- [x] 3.52 `modules/waitlist/application/entries.ts` and routes `POST|GET|PATCH /waitlist`, pause, resume, close (permission `waitlist.manage`): limit of 5 active entries, duplicate rejected with the existing entry shown, `manual_contact_only` when no channel is reachable or no offers opt-in was recorded, close reasons `fulfilled|expired|cancelled|patient_opted_out`, audit. [WTL-01, WTL-05] Test: duplicate, no channel, limit and no-opt-in scenarios.
- [x] 3.53 `domain/matching.ts` (pure): filter by professional, location, type duration, date range and time preferences, order by waiting time with audited priority overrides, skip patients with an overlapping appointment, minimum offer lead time (1 h) and quiet-hours deferral decision. [WTL-02, WTL-04] Test: table tests plus a property test that no offer falls outside the preferences.
- [x] 3.54 Trigger: subscriber on `slot_freed` enqueues `waitlist.match`; the job re-validates the slot with scheduling rules; a direct booking invalidates open offers for that slot; hold expiry never triggers. [WTL-02] Test: integration for cancel, reschedule away and block removal; hold expiry does not trigger; direct booking invalidates.

## S3.12 Waitlist offers and self-join (~400) [Track C]

Start: S3.11, S3.03, S3.05, S3.08. Done when: an offer is delivered, accepted through its link and booked exactly once. Verify: default plus `waitlist-offers.test.ts`. Rollback: default.

- [x] 3.55 `application/offers.ts` and jobs `waitlist.offer` and `waitlist.expire`: one open offer per slot, expiry the shorter of 30 minutes and the lead time before the start, `waitlist_offer` token kind enabled, delivery through notifications (offers opt-in required, WhatsApp also needs its opt-in, quiet-hours deferral when the lead time still holds, otherwise `waitlist_manual_contact` item), next entry on decline or expiry, flag after three consecutive expired offers. [WTL-03, WTL-04] Test: accepted in time, expires, shortened by proximity, nobody accepts, quiet-hours cases.
- [x] 3.56 Token handler `waitlist_offer`: accept books through scheduling `bookAppointment` (source `waitlist_offer`; identity unconfirmed when the entry joined by public self-join attached to an existing patient), closes the entry as fulfilled; decline keeps the entry; acceptance after expiry rejected with the entry kept; reception and patient racing for one slot produce one appointment. [WTL-03, OBK-06] Test: concurrent acceptance; acceptance after expiry.
- [ ] 3.57 Self-join: `POST /public/:slug/waitlist`, `.../submission` and OTP verify on `booking_submission(kind=waitlist_join)`; the entry is created only after verification; the offers opt-in is mandatory; bound of active entries; same non-disclosing response; read-only tenant gets the generic page. [OBK-06, WTL-01] Test: join, missing opt-in refused, unverified request purged.
- [ ] 3.58 Opt-out and fairness: a reply "BAJA" to an offer stops every active entry's automated offers; an opted-out channel is skipped; no offers in a read-only tenant; each offer, response, override and closure audited; response time and fill outcome stored for the reports; no second offer for the same patient and slot. [WTL-04, WTL-06] Test: spec scenarios including the duplicate-offer one.

## S3.13 Waitlist UI (~350) [Track C]

Start: S3.12, S3.10. Done when: reception manages entries and the public can join. Verify: default plus `e2e/stage3-waitlist.spec.ts`. Rollback: default.

- [ ] 3.59 `features/waitlist/*`: list with filters, add dialog with `PatientPicker` and an explicit offers opt-in checkbox (staff records it), pause, edit preferences, close with reason; "close this entry?" prompt in a slot of the booking dialog after a matching direct booking. [WTL-01, WTL-05] Test: component tests plus axe.
- [ ] 3.60 Reception panel for the `waitlist_manual_contact` worklist kind: freed slot plus matching entries to call, entries flagged after three expired offers. [WTL-02, WTL-03] Test: component test.
- [ ] 3.61 Public join page `features/public-booking/waitlist/*` (consent, offers opt-in, channels, OTP) and `e2e/stage3-waitlist.spec.ts`: cancel an appointment, offer arrives in Mailpit, accept by link, appointment booked, entry closed. [OBK-06, WTL-03] Test: that spec.

## S3.14 Teleconsultation backend (~400) [Track D]

Start: S3.00, Stage 2 appointment types and `appointment.video_room`. Done when: a virtual appointment gets a platform join link that opens the provider room only inside the window. Verify: default plus `video-links.test.ts`. Rollback: default (`integrations.video=false` leaves `link_pending` with manual links).

- [x] 3.62 `db/schema/teleconsultation.ts` + migration `0370_video_session.sql`: `video_session` (appointment, status `ready|link_pending|closed`, manual link, provider, `first_opened_at`, `last_opened_at`); the room name stays in the existing `appointment.video_room`. [TLC-01, TLC-04, TLC-06] Test: isolation suite.
- [x] 3.63 `application/video-links.ts` and job `video.link.create`, driven by appointment events: creates the room with an opaque identifier only (128-bit random name, no patient data to the provider), rotates it on reschedule and reassignment, closes it on cancel, no-show, attended and when the type becomes in person; retries, then `link_pending` with an alert; integration off means no provider call. [TLC-01, TLC-03, TLC-04] Test: provider payload spy has no personal data; reschedule rotates the room; reassigned professional is denied.
- [x] 3.64 `/public/v/:token` (`http/public-join.ts`, token kind `video_join` enabled): join window from 15 minutes before to 60 minutes after the end; outside it a server-rendered es-AR page (branded) shows the allowed time and never the provider address; inside it records "link opened" and redirects (302); the same address wraps a manual link; the page states that a third-party video service is used and that the product does not record. [TLC-02, TLC-05] Test: early, late and in-window opens; provider address absent from the early response; notice present.
- [x] 3.65 Professional join and manual fallback: `POST /appointments/:id/video/join` (assigned professional only, in the window, audit `video.link.joined`), `PUT /appointments/:id/video/manual-link` (https and `VIDEO_ALLOWED_DOMAINS` only), reception and admin see only "virtual" and "has link"; the calendar feed never carries the link. [TLC-02, TLC-04, TLC-05] Test: other professional denied; unsafe link rejected; cross-tenant 404; calendar feed has no link.
- [x] 3.66 Attendance support: "patient opened the link" flag for professional and reception, no automatic status change, no-show allowed after `noShowAfterMinutes`, audit events without the token in clear text. [TLC-06, TLC-05] Test: spec scenarios — patient never joins, no automatic attendance, audit without secrets.
- [x] 3.67 `adapters/video-local/` (`VIDEO_PROVIDER=local`): builds `${VIDEO_LOCAL_BASE_URL}/${room}` (default `https://meet.jit.si`, which needs no account; a self-hosted Jitsi can be set later), adds URL parameters that start muted and unrecorded; customer slot when local. [TLC-01, TLC-05] Test: `video.contract.ts` on fake and local; resolver wiring test.

## S3.15 Teleconsultation UI (~300) [Track D]

Start: S3.14, Stage 2 calendar. Done when: a professional joins from the appointment and a patient receives the platform link in the reminder. Verify: default plus `e2e/stage3-teleconsult.spec.ts`. Rollback: default.

- [x] 3.68 `features/teleconsultation/*` in the `appointment-drawer` slot: virtual marker (no link) on calendar entries, `link_pending` alert with the manual link dialog, integration state in the scheduling settings type form. [TLC-01, TLC-04] Test: component tests.
- [x] 3.69 Professional "Join" action visible only inside the window, "patient opened the link" indicator, Today view button; reminders for virtual appointments carry the platform join address through a `VideoJoinUrlResolver` registered by the module, and a virtual appointment without a link sends no reminder unless the text says the link follows. [TLC-02, TLC-04, NTF-02] Test: component tests; integration for the reminder text.
- [x] 3.70 `e2e/stage3-teleconsult.spec.ts`: book a virtual appointment, patient opens the link early (sees the opening time), inside the window the redirect reaches the local provider URL, professional joins; axe on the join page at 360 px. [TLC-02, TLC-05] Test: that spec.

## S3.16 Demo seed (~300) [Track E]

Start: tracks A to D merged. Done when: the demo tenant shows engagement data and resets in under a minute. Verify: default plus the gap check. Rollback: default.

- [ ] 3.71 `db/seed/demo/stage3/notifications.ts`: messages in every status (demo sends are `cancelled`/`demo_tenant`, with previews rendered from the templates), channel preferences, usage events; registered in `db/seed/demo/contributors.ts`. [DEM-04, DEM-02, DEM-03] Test: gap check passes; resolver gives demo tenants only fakes.
- [ ] 3.72 `db/seed/demo/stage3/{online-booking,waitlist,teleconsultation}.ts`: booking links per professional, a pending online booking with its `identity_review` item, waitlist entries with an open offer, virtual appointments with static fake links. [DEM-04] Test: two seed runs give identical logical content.
- [ ] 3.73 Reset timing with Stage 3 data stays under 60 s; `demo.reset` removes the new tables' rows. [DEM-05, DEM-07] Test: timing test.

## S3.17 Public-route hardening (~300) [Track E]

Start: tracks A to D merged. Done when: every public surface is enumerated, limited and probed. Verify: default plus `test/policy/public-routes.test.ts`. Rollback: default.

- [ ] 3.74 `apps/api/test/policy/public-routes.test.ts`: enumerates `/public/*` and `/webhooks/*`; each route declares its protection (rate limit plus bot challenge, OTP, token or signature), uses generic errors and a response schema without personal data. [OBK-05, NTF-07, IDA-01] Test: that file.
- [ ] 3.75 Rate-limit tuning and non-disclosure: per-email and per-IP buckets, generic 429 message, structured abuse log; the existing-patient and new-patient confirmation paths execute the same number of queries (spy count). [OBK-04, OBK-05] Test: spy-count equality; limits per bucket.
- [ ] 3.76 `apps/api/test/security/public-probes.test.ts` and `docs/security/public-surface-stage3.md`: forged tenant fields, tampered tokens, replayed OTP, mass assignment, oversized bodies. [OBK-05, NTF-03] Test: probes green.

## S3.18 Stage 3 gate (~200) [Track E]

Start: S3.16, S3.17. Done when: the Stage 3 demo runs locally end to end. Verify: the e2e spec plus a fresh review. Rollback: default.

- [ ] 3.77 `e2e/stage3-demo.spec.ts`: public booking, reminder in Mailpit and in the WhatsApp simulator, confirm by link, a cancellation offered to the waitlist and accepted. [OBK-04, NTF-02, NTF-03, WTL-03] Test: that spec.
- [ ] 3.78 Fresh-context review (`judgment-day`) of public routes, tokens and webhooks; fix findings. Test: review report attached to the PR.
- [ ] 3.79 Update `docs/external-dependencies.md` (WhatsApp, video, bot challenge: local adapter in use, real adapter deferred) and re-run `sdd-init`. Test: none.

## S3.D Deferred real-provider adapters (no gate depends on them)

Start: the owner supplies the account or contract for that provider (nothing else waits for it). Done when: the adapter passes the shared contract suite of its port and can be selected with `<NAME>_PROVIDER`. Verify: the contract suite plus recorded provider fixtures; any live smoke test is tagged for staging only. Rollback: set the variable back to `local`. Each task is its own small PR.

- [ ] 3.80 deferred: needs owner credentials/contract (AWS SES account and verified domain). `adapters/ses/` native SES API `EmailSender` with bounce and complaint handling. [NTF-06] Test: `email.contract.ts` plus a mocked client.
- [ ] 3.81 deferred: needs owner credentials/contract (Meta WABA verification and approved templates). `adapters/whatsapp-meta/` Cloud API sender and webhook parsing. [NTF-01, NTF-07] Test: `whatsapp.contract.ts` plus recorded payload fixtures.
- [ ] 3.82 deferred: needs owner credentials/contract (Jitsi as a Service account). `adapters/jitsi-jaas/` JWT rooms with recording disabled. [TLC-01, TLC-05] Test: `video.contract.ts` plus JWT claims test.
- [ ] 3.83 deferred: needs owner credentials/contract (Cloudflare Turnstile keys). `adapters/bot-challenge-turnstile/`. [OBK-05] Test: `bot-challenge.contract.ts` with a mocked verify endpoint.

---

# Stage 4: Revenue

Goal: reception closes the day's cash register and issues an invoice, and the owner reads the dashboard. The invoice goes through a local AFIP simulator that issues a CAE, keeps the number sequence, reconciles after a timeout and can simulate an outage. Order: seams (S4.00), three parallel tracks (billing, reports, invoicing), then integration (S4.15 to S4.17). Depends on Stage 1 (object storage, jobs, crypto, audit), Stage 2 (check-in, locations, appointment events) and Stage 3 (waitlist recovery metric, notification kinds). The real ARCA adapter is the deferred slice S4.D and blocks nothing.

Permissions: `payments.read`, `payments.write` (record payments, capture charges), `cash.operate` and `reports.read` already exist. `billing.manage` stays the owner-only platform subscription permission of Stage 6. S4.00 adds `pricing.manage`, `charges.void`, `payments.refund`, `invoicing.issue`, `invoicing.configure`, `invoicing.credit_note` and `invoicing.manual` (owner and admin; `invoicing.issue` also reception; none clinical).

### Parallel tracks (Stage 4)

| Track | Slices | New files live in | Migration range | Locale files |
|---|---|---|---|---|
| Seams | S4.00 | every shared file, touched once | 0400-0409 | none |
| A Billing | S4.01 to S4.05 | `modules/billing`, `platform/exports`, `features/billing`, `features/cash` | 0410-0429 | `billing.json`, `cash.json`, `errors.billing.json` |
| B Reports | S4.06, S4.07, S4.14 | `modules/reports`, `features/reports` | 0430-0439 | `reports.json`, `errors.reports.json` |
| C Invoicing | S4.08 to S4.13 | `modules/invoicing`, `country/ar/afip`, `adapters/afip-*`, `features/invoicing`, `features/operator/dev/afip` | 0440-0469 | `invoicing.json`, `errors.invoicing.json` |
| D Integration | S4.15 to S4.17 | `db/seed/demo/stage4`, `test/policy`, `e2e` | 0490-0499 | none |

- Run order: S4.00 first. Then A (S4.01), B (S4.06) and C (S4.08, S4.09) start together: S4.06 reads only Stage 2 and 3 data, and S4.08 and S4.09 need no charge data. S4.10 waits for S4.02 (charge lines). S4.14 waits for S4.03 and S4.10. S4.13 waits for S4.04 and S4.11. D starts when A, B and C are merged.
- Shared files that still need a merge step: `_journal.json` and snapshots (`pnpm db:restamp`), `db/seed/demo/contributors.ts` (only S4.16). The reports module reads billing and invoice tables only through their `index.ts` read functions, never their tables.

## S4.00 Seams and money (~450)

Start: Stage 3 gate merged (S3.00b tooling is reused). Done when: the three module skeletons are wired, the money type is shared by API and web, the PDF helper renders a golden file, and the AFIP port is in the adapter resolver. Verify: default plus the adapter resolver test iterating every port. Rollback: default.

- [ ] 4.1 `packages/contracts/src/money.ts`: `Money` as integer ARS cents, `addMoney`, `allocateProportional` with a deterministic rounding rule (largest remainder, ties to the earliest line), `parseArs` and `formatArs` ("$ 1.234,50"); web `shared/lib/format.ts` uses it. [BIL-16] Test: property tests (allocation always sums to the total, never negative), format snapshot for `1234.5`.
- [ ] 4.2 `AFIP_PROVIDER` (`local|afip|off`) in `main/config.ts` and the guard of task 3.1; `invoiceIssuer` added to `AdapterPorts` and `ADAPTER_PORTS`; `adapters/afip-fake/` placeholder implementing the Stage 1 `InvoiceIssuer` (filled in task 4.41). [CTR-09, DEM-03] Test: `adapter-resolver.test.ts` iterates every port including `invoiceIssuer`.
- [ ] 4.3 Contracts and catalogs: skeleton files `packages/contracts/src/{billing,reports,invoicing}.ts`; permissions `pricing.manage`, `charges.void`, `payments.refund`, `invoicing.issue`, `invoicing.configure`, `invoicing.credit_note`, `invoicing.manual` in `roles.ts`; audit actions `billing.price.changed|override`, `charge.captured|voided|flagged`, `payment.recorded|override|refunded`, `cash.opened|closed|adjusted`, `export.requested`, `invoice.requested|issued|rejected|retried|manual|credit_note`, `invoicing.config.changed|credential.changed`, `report.accessed`. [BIL-12, BIL-15, INV-12, RPT-11] Test: `roles.test.ts` and `audit-actions.test.ts` invariants stay green; reception holds no `charges.void`, `payments.refund`, `pricing.manage`, `invoicing.credit_note` or `invoicing.manual`.
- [ ] 4.4 Queues `afip.issue`, `fiscal.credential_watch`, `invoice.pdf`, `invoice.deliver`, `export.build` in `platform/jobs/queues.ts` (`afip.issue` classified as the one job that still runs in a read-only tenant when enqueued earlier); module skeletons and wiring for `billing`, `invoicing`, `reports` with their export contributors; `platform/files/file-resources.ts`, a registry so `/files/:token` serves documents, exports and invoice PDFs (the Stage 2 documents handler registers `document`). [TEN-11, TEN-08, DOC-03] Test: `export-registry.test.ts` green; token redemption test for an unknown resource kind fails closed.
- [ ] 4.5 `platform/pdf/render.ts`: shared `@react-pdf/renderer` helper for the worker (es-AR fonts, header with branding, "simulated" watermark option). [INV-11, BIL-11] Test: golden-file test with fixed metadata; watermark present when asked.
- [ ] 4.6 Web seams: `shared/ui/MoneyInput.tsx`, the `appointment-drawer` and `patient-detail-tab` slot entries for billing, nav entries for Billing, Cash, Reports and Invoicing through `nav.ts`, a "simulated billing" banner component driven by the boot payload flag `localProviders`. [BIL-16, SHL-01] Test: component tests plus axe; nav test per role.

## S4.01 Pricing (~400) [Track A]

Start: S4.00. Done when: a price quote for any appointment resolves deterministically. Verify: default plus `price-resolution.test.ts`. Rollback: default.

- [ ] 4.7 `db/schema/billing-pricing.ts` + migration `0410_pricing.sql`: `price` (appointment type, optional professional, specialty, location, payer plan; `amount_cents`, `effective_from`, active), `tenant_payer` (organization list seeded from the platform `payer` catalog, active flag), `payer_plan_price` (payer-covered, copago and plus per type and plan, effective date); policies and fixtures. [BIL-01, BIL-02] Test: isolation suite; negative amounts rejected.
- [ ] 4.8 `modules/billing/domain/price-resolution.ts` (pure): specificity order professional, specialty, location, general; latest `effective_from` not in the future; payer plan before private; returns patient portion, payer portion, distinct copago and plus lines and a snapshot, or `NoPrice`. [BIL-01, BIL-02, BIL-03] Test: spec scenarios (private price, professional override, copago split, plus as its own line, no price) and a property test that patient plus payer equals the total.
- [ ] 4.9 Routes `GET|POST|PATCH /billing/prices` and `/billing/payers` (copy from the catalog, activate, deactivate) with permission `pricing.manage`; deactivated payers are not offered for new charges but old charges still render; audit. [BIL-01, BIL-02, BIL-12, BIL-15] Test: integration CRUD; reception denied with a deny audit row; deactivated payer scenario.
- [ ] 4.10 `GET /billing/price-quote?appointmentId=` returns the resolved quote without side effects for the UI. [BIL-01] Test: quote equals what capture later stores.

## S4.02 Charges (~400) [Track A]

Start: S4.01, S2 check-in. Done when: a charge can be captured from check-in and voided under the rules. Verify: default plus `capture-charge.test.ts`. Rollback: default.

- [ ] 4.11 `db/schema/billing-charges.ts` + migration `0412_charges.sql`: `charge` (appointment, patient, professional, location, payer or private, price snapshot, status `pending|partially_paid|paid|voided`, review flag, void reason) with a partial unique index on the appointment while not voided, `charge_line` (description, portion `patient|payer`, `amount_cents`, `invoiced_cents`) with a check `invoiced_cents <= amount_cents`; `REVOKE DELETE`. [BIL-03, BIL-04, BIL-05] Test: isolation suite; second active charge rejected; delete denied as `app_rw`.
- [ ] 4.12 `application/capture-charge.ts` and `POST /billing/charges`, `POST /billing/charges/:id/lines` (permission `payments.write`): allowed for `checked_in`, `in_progress`, `attended`; refused before check-in and for no-show unless the late-fee setting adds an explicit fee line; a missing price needs an explicit amount (audited `billing.price.override`); second capture points to the existing charge. [BIL-03, BIL-04] Test: all spec scenarios of "Charge capture per appointment" and "Price lookup finds no matching price".
- [ ] 4.13 Subscriber on appointment events: an appointment that becomes `no_show` or `cancelled` with an active charge flags the charge for review and never voids or refunds it. [BIL-04] Test: integration for both statuses.
- [ ] 4.14 `application/void-charge.ts`, `POST /billing/charges/:id/void {reason}` (permission `charges.void`): refused while payments exist (refund first) or while an invoice is issued (credit note first, through the `InvoiceLookup` port of `invoicing`, a stub until task 4.45); audited. [BIL-05, BIL-12] Test: spec scenarios — unpaid void, with payments, with an issued invoice.
- [ ] 4.15 Access rules and DTOs: a professional sees only charges of their own appointments, reception only its locations, admin all, nobody sees clinical fields (contract snapshot), cross-tenant ids answer as not found. [BIL-12, BIL-13, BIL-15] Test: cross-professional denial, cross-tenant 404, DTO snapshot.

## S4.03 Payments and cash (~400) [Track A]

Start: S4.02. Done when: payments, refunds and the cash register behave as specified and closed registers cannot change. Verify: default plus `cash-register.test.ts`. Rollback: default.

- [ ] 4.16 `db/schema/billing-payments.ts` + migration `0414_payments_cash.sql`: `payment` (charge, method `cash|debit|credit|transfer|wallet|payment_link`, `amount_cents`, `paid_at`, recorded by, `idempotency_key` UNIQUE with tenant, optional `external_ref` UNIQUE per tenant, cash session, override reason), `payment_reversal` (append-only refund or reversal), `cash_session` (location, open and close data, expected, counted, difference and reason) with a partial unique index of one open session per location; triggers make closed sessions and their entries immutable; no column can hold a card number. [BIL-06, BIL-08, BIL-09, BIL-10] Test: isolation suite; second open register rejected; update of a closed row rejected as `app_rw`.
- [ ] 4.17 `application/record-payment.ts` and routes: partial and multiple payments, overpayment rejected unless the user confirms a credit balance, payer portion tracked as a receivable and never as a patient payment, retried identical submission gives one payment, repeated voucher number needs an audited override with a reason, cash needs the open register of the location, status derived from payments and refunds. [BIL-06, BIL-07, BIL-09] Test: spec scenarios (partial, overpayment, payer portion, retry, same voucher).
- [ ] 4.18 `application/refund.ts` (permission `payments.refund`): reversal never exceeds the original net of earlier reversals, reason required; a correction after close is a reversal plus a new entry in the open register, linked to the original. [BIL-08, BIL-10] Test: refund over the paid amount rejected; correction leaves the closed register unchanged.
- [ ] 4.19 `application/cash-register.ts` and routes (permission `cash.operate`, reception limited to its locations): open with opening cash, close with counted cash, a difference needs a reason, summary by method with refunds, expected, counted and difference. [BIL-09, BIL-15] Test: open-and-close day (expected 35000, difference 0), difference with reason, no open register blocks cash and offers to open, second register refused.

## S4.04 Billing and cash UI (~450) [Track A]

Start: S4.03, S4.00 web seams. Done when: reception runs a desk day at 360 px. Verify: default plus `e2e/stage4-cash.spec.ts`. Rollback: default. May run to about 450 lines because splitting leaves the desk flow half working.

- [ ] 4.20 `features/billing/*`: charge capture in the `appointment-drawer` slot at check-in, quote display, explicit-amount flow when there is no price, line list, void dialog with reason, status chips (icon and text), review flag; `locales/es-AR/billing.json`. [BIL-04, BIL-05, BIL-16] Test: component tests plus axe.
- [ ] 4.21 Payment dialog with `MoneyInput`, method, partial payment, overpayment confirmation, voucher duplicate override with reason, a client-generated idempotency key per submit, payer receivable view. [BIL-06, BIL-07] Test: component tests including the double-click case.
- [ ] 4.22 `features/cash/*`: open and close register, daily summary by method, difference reason, correction after close, location filter; `locales/es-AR/cash.json`. [BIL-09, BIL-10] Test: component tests.
- [ ] 4.23 `e2e/stage4-cash.spec.ts` at 360 px: check in, capture, partial payment, close the register with a difference reason; reception sees the forbidden state on void and refund; amounts read "$ 1.234,50". [BIL-04, BIL-06, BIL-09, BIL-12, BIL-16] Test: that spec.

## S4.05 Exports (~350) [Track A]

Start: S4.03. Done when: a user exports charges, payments and the payer settlement in three formats and every export is audited. Verify: default plus golden-file tests. Rollback: default.

- [ ] 4.24 `platform/exports/export-job.ts` and job `export.build`: CSV (UTF-8 with BOM, quoted), xlsx (`exceljs`), PDF (task 4.5 helper); result stored at `t/{tenantId}/exports/{uuid}`, downloaded through the `/files/:token` registry (session bound, 5 minutes); an empty result shows an explicit empty state and produces no file; audit `export.requested` with filters. [BIL-11, RPT-10] Test: golden files per format; empty period returns the empty state.
- [ ] 4.25 `modules/billing/application/export-charges.ts`: charges, payments and payer receivables by period, location, professional and payer; payer settlement grouped by payer with DNI, date, service and amount; a column whitelist keeps clinical content out. [BIL-11] Test: OSDE-only settlement; no note, diagnosis or prescription text in any column.
- [ ] 4.26 `registerBillingExportContributors` (administrative: charges, payments, cash sessions) in the billing `index.ts`, registered in `main/export-contributors.ts`. [TEN-08, BIL-11] Test: registry test lists billing; contributor output has no clinical data.
- [ ] 4.27 Read-only behavior of Stage 4 billing routes: reads and exports allowed (categories 1 and 4), writes return 402 with the account-state message. [BIL-14, TEN-11] Test: `route-categories.test.ts` stays green; inject matrix (payment refused, export of last month works).

## S4.06 Operational report read models (~400) [Track B]

Start: S4.00 and Stage 3 data. Done when: the operational numbers match their source records for any filter. Verify: default plus `operational-report.test.ts`. Rollback: default.

- [ ] 4.28 `modules/reports/domain/filters.ts` (date range, location, professional, specialty, payer; inverted range and spans over 366 days rejected) and `application/scope.ts` role scoping (owner and admin all, professional own, reception own locations without revenue by professional, patient none) with `reports.read`. [RPT-04, RPT-06] Test: validation messages; scope matrix.
- [ ] 4.29 `application/operational.ts`: counts per status (the 8 statuses), occupancy of available slots, new versus returning patients, slots recovered through the waitlist (accepted `waitlist_offer`), rescheduled count from `appointment_event`, and no-show rate = no-show / (attended + no-show) with cancelled and not-yet-final appointments excluded and counted. [RPT-01] Test: 88 attended and 12 no-show gives 12%; 30 cancellations do not move it; 10 moved appointments counted as attended plus a rescheduled figure of 10; excluded count shown.
- [ ] 4.30 `GET /reports/operational` and drill-down `GET /reports/operational/records` (administrative columns only), tenant from the session (a foreign id in the query is ignored), audit `report.accessed` for patient-level rows. [RPT-05, RPT-07, RPT-11] Test: drill-down rows sum to the total; foreign tenant id ignored; response schema has no clinical field.
- [ ] 4.31 Migration `0430_report_indexes.sql` (appointment by tenant, start and status; `appointment_event` by tenant, kind and time) and `docs/perf/reports.md` with a 50k-appointment benchmark (target p95 under 1 s). [RPT-01] Test: benchmark script.

## S4.07 Reports dashboard UI (~400) [Track B]

Start: S4.06, S4.00 web seams. Done when: owner, professional and reception each see their own dashboard at 360 px. Verify: default plus `e2e/stage4-reports.spec.ts`. Rollback: default.

- [ ] 4.32 `features/reports/*`: filter bar that shows the applied filters, a `ReportWidget` container with independent loading, empty, error and retry states, operational widgets, Recharts lazy-loaded with `React.lazy`, each chart with a table alternative and non-color encodings, no horizontal page scroll at 360 px; `locales/es-AR/reports.json`. [RPT-08, RPT-09, RPT-04] Test: component tests including one failing widget; axe.
- [ ] 4.33 Export buttons (CSV, xlsx, PDF) through task 4.24 with filters and timestamp; read-only banner never blocks reads or exports. [RPT-10, RPT-12] Test: component tests; scope test (professional export has only their rows).
- [ ] 4.34 `e2e/stage4-reports.spec.ts`: owner dashboard, professional own figures, reception operations and cash only, revenue by professional denied for reception, no horizontal scroll at 360 px. [RPT-06, RPT-08] Test: that spec.

## S4.08 Fiscal configuration and credentials (~450) [Track C]

Start: S4.00. Done when: an owner can configure the fiscal identity and upload a certificate that is stored encrypted and never shown again. Verify: default plus `fiscal-config.test.ts`. Rollback: default (`integrations.einvoicing` off).

- [ ] 4.35 `db/schema/invoicing-config.ts` + migration `0440_fiscal_config.sql`: `fiscal_profile` (CUIT, tax condition `monotributo|responsable_inscripto|exento`, business name, address, start of activities, enabled), `point_of_sale` (number, environment `homologation|production`, active), `fiscal_credential` (certificate and key encrypted with the tenant DEK, `not_after`, state, fingerprint); policies and fixtures. [INV-01, INV-02] Test: isolation suite; raw SQL shows ciphertext only.
- [ ] 4.36 `modules/invoicing/application/fiscal-config.ts` and routes (permission `invoicing.configure`): CUIT check digit through the country pack, invoicing unavailable until the profile and at least one point of sale are complete, environment per point of sale; with `AFIP_PROVIDER=local` the effective environment is forced to `homologation` and every screen says "simulated". [INV-01] Test: incomplete configuration blocks issuing; invalid CUIT rejected; two points of sale with different environments.
- [ ] 4.37 `PUT /invoicing/credentials` using Node `crypto.X509Certificate`: checks that certificate and key match and the CUIT is in the subject, stores them encrypted, computes the state `valid|expiring|expired|invalid` (expiring under 30 days), never returns them (log redaction included); job `fiscal.credential_watch` emails the owner at 30 days or fewer; `pnpm dev:afip-cert` generates a self-signed test certificate for local use. [INV-02] Test: state table with fake clock; credential absent from every response and log capture; warning email.
- [ ] 4.38 Enable and disable e-invoicing per organization (`settings.integrations.einvoicing`, owner and admin only); disabling never touches existing invoices; configuration changes audited. [INV-12, INV-13] Test: disabled blocks issuing and keeps old invoices readable.

## S4.09 Invoice type rules and the local AFIP issuer (~450) [Track C]

Start: S4.00. Done when: the same contract suite passes against the fake and the local issuer, and the local issuer reproduces numbering, idempotency, rejection and outage. Verify: default plus `invoice-issuer.contract.test.ts`. Rollback: default (`AFIP_PROVIDER=off`).

- [ ] 4.39 `apps/api/src/country/ar/afip/invoice-type.ts` (pure, reached only through the country pack registry): monotributo issues C; responsable inscripto issues A to a responsable inscripto and B to anyone else; a forbidden type is refused; recipient data per type (A needs CUIT and condition, B and C identification per amount threshold); a payer can be the recipient of its own portion using the payer CUIT from the catalog. [INV-03, INV-04, CTR-09] Test: table-driven spec scenarios.
- [ ] 4.40 `adapters/afip-local/` + migration `0442_local_afip.sql` (platform tables `local_afip_voucher`, `local_afip_request`, `local_afip_control`, no `tenant_id`, never read in production): `issue` is idempotent by key, numbers are sequential per CUIT, point of sale and type, the CAE is 14 digits with a 10 day expiry, rejections mimic AFIP (bad recipient CUIT, amount mismatch), `findIssued` reconciles, modes `ok|down|slow|timeout_after_authorize|reject_next`. [INV-05, INV-09] Test: Postgres store integration; mode switching.
- [ ] 4.41 `adapters/afip-fake/` (in memory, deterministic CAE, for the demo slot and unit tests) and the shared suite `adapters/invoice-issuer.contract.ts`: idempotency (same key, one voucher), sequence per point of sale, rejection shape, timeout then `findIssued`, outage. [INV-05, INV-09, DEM-03] Test: the suite runs on fake and local.
- [ ] 4.42 Resolver wiring (`AFIP_PROVIDER=local` fills the customer slot) and simulator controls `/operator/dev/afip/*` plus `features/operator/dev/AfipSimulator.tsx` (set mode, list vouchers, reset): absent unless the console flag is on, refused in production. [DEM-03, INV-09] Test: route-enumeration in both modes; component test.

## S4.10 Invoice model and credit notes (~450) [Track C]

Start: S4.02, S4.08. Done when: invoices can be created over charge lines, can never over-invoice, and cannot change once issued. Verify: default plus `invoice-invariants.test.ts`. Rollback: default.

- [ ] 4.43 `db/schema/invoicing.ts` + migration `0444_invoices.sql`: `invoice` (type, point of sale, number, CAE and expiry, status `pending|issued|rejected|manual`, `delivery_state`, unique idempotency key, recipient snapshot, credit-note link, reason, previous attempt), `invoice_line` (charge line, amount); unique (tenant, point of sale, type, number); a trigger rejects any update of `issued` and `manual` rows; another keeps `charge_line.invoiced_cents` in step; `REVOKE DELETE`. [INV-05, INV-06, INV-08] Test: isolation suite; updating an issued invoice rejected as `app_rw`.
- [ ] 4.44 `application/create-invoice.ts`: `SELECT ... FOR UPDATE` on the charge lines, the sum of pending, issued and manual lines minus credit notes never exceeds the line amount, one invoice over lines of several charges of one recipient, one line in several parts, a payer invoice equal to the payer portion only; inserts the invoice as `pending` and enqueues `afip.issue` in the same transaction. [INV-04, INV-05] Test: spec scenarios (double invoicing refused, two charges one invoice, two parts then a third refused) plus a concurrent-attempt property test.
- [ ] 4.45 `application/credit-note.ts` (permission `invoicing.credit_note`): matching type A, B or C, partial or total, cumulative amount never above the original, reason required, own CAE through the issuer, updates the invoiced balance, implements `InvoiceLookup` for the void rule of task 4.14. [INV-07, BIL-05] Test: total note; cumulative limit; reception denied with a deny audit row.
- [ ] 4.46 Rejected attempts and no-void rule: a rejection stores the AFIP message, carries no CAE and releases the lines; a retry creates a new attempt linked to the old one; deleting or voiding an authorized invoice is refused and the credit note flow is offered. [INV-08, INV-06] Test: rejection scenario; attempt to void an authorized invoice.

## S4.11 Issue job and outage handling (~450) [Track C]

Start: S4.09, S4.10. Done when: an invoice survives an outage and a timeout without ever being issued twice. Verify: default plus `afip-issue-job.test.ts` against every simulator mode. Rollback: default.

- [ ] 4.47 `modules/invoicing/jobs/afip-issue.ts` (`defineJob('afip.issue')`): before every retry reconciles with `findIssued` and the last authorized number, then issues with the idempotency key; success writes `issued` with number, CAE and expiry, a rejection writes `rejected` with the message, an outage or unknown outcome keeps `pending` with `delivery_state` `queued|retrying|awaiting_reconciliation` and backs off from 1 minute to 6 hours. [INV-05, INV-09] Test: integration over modes `down`, `timeout_after_authorize` (exactly one voucher), `reject_next`.
- [ ] 4.48 Outage visibility: a pending invoice older than `settings.invoicing.outageThresholdHours` (default 24) is flagged by its age, never given a new state; `GET /invoices?status=pending` returns the age; payments and the cash register are never blocked; the user message says it will be issued when the service recovers. [INV-09, INV-05] Test: threshold flag; cash operations unaffected during an outage.
- [ ] 4.49 Manual entry `POST /invoices/manual` (permission `invoicing.manual`): type, point of sale, number, CAE (14 digits), date, recipient and amount; unique per type, point of sale and number; saved as `manual`, immutable, linked to charge lines; reception denied and audited; offered after an expired credential or a prolonged outage. [INV-10, INV-02] Test: register while the simulator is down; reception denied; duplicate number rejected.
- [ ] 4.50 Read-only: `assertTenantWritable('afip.issue', enqueuedAt)` lets a job enqueued before `read_only_since` run to `issued` or `rejected`; creating invoices and credit notes returns 402; existing invoices stay readable. [INV-13, TEN-11] Test: queued invoice still submitted in a read-only tenant; new invoice refused.

## S4.12 Invoice PDF and delivery (~350) [Track C]

Start: S4.11. Done when: an issued invoice has a PDF with QR and an email delivery with no clinical content. Verify: default plus `invoice-render.test.ts`. Rollback: default.

- [ ] 4.51 `application/render-invoice.ts` with the task 4.5 helper: AFIP fields, CAE and expiry, the AFIP QR payload (`https://www.afip.gob.ar/fe/qr/?p=` plus base64url JSON with version, date, CUIT, point of sale, type, number, amount, currency, recipient document and CAE), generic service wording from the appointment type's invoice description, a "documento de prueba sin validez fiscal" mark for homologation and the local provider; es-AR with AFIP terminology. [INV-11, INV-01, INV-14] Test: QR payload decodes to the invoice data; no clinical text; mark present when simulated.
- [ ] 4.52 Jobs `invoice.pdf` (stores `t/{tenantId}/invoices/{uuid}.pdf`) and `invoice.deliver` (email only through the notifications channel policy, no clinical content, WhatsApp never chosen); `GET /invoices/:id/pdf-link` issues a session-bound 5 minute link. [INV-11] Test: delivery text has no clinical word list hit; channel policy refuses WhatsApp for `invoice`.
- [ ] 4.53 `listInvoicesForPatient(patientId)` in the invoicing `index.ts`: only invoices addressed to the patient (payer invoices excluded), every read audited; used by the portal in Stage 5. [INV-11, INV-12] Test: payer invoice not listed; audit row.

## S4.13 Invoicing UI (~450) [Track C]

Start: S4.11, S4.04. Done when: reception issues an invoice from a charge and the owner handles the outage path at 360 px. Verify: default plus `e2e/stage4-invoicing.spec.ts`. Rollback: default. May run to about 450 lines.

- [ ] 4.54 `features/invoicing/*` settings: fiscal profile, points of sale with an environment badge, credential upload and state, enable switch, "simulated billing" banner; `locales/es-AR/invoicing.json`. [INV-01, INV-02, INV-14] Test: component tests plus axe.
- [ ] 4.55 Issue flow from a charge: line selection, the type shown by the rules (not selectable beyond them), recipient form for type A, payer as recipient, state badges `pending|issued|rejected|manual` (the retry sub-state is never shown), pending list with age and the prolonged-outage flag with the manual entry dialog. [INV-03, INV-04, INV-05, INV-09, INV-10] Test: component tests.
- [ ] 4.56 Credit note dialog (owner and admin), PDF download, and `e2e/stage4-invoicing.spec.ts`: issue (CAE and test mark visible), simulator `down` leaves it pending, recovery issues it once, reception cannot create a credit note. [INV-05, INV-07, INV-09, INV-12] Test: that spec.

## S4.14 Financial and cash reports (~400) [Track B]

Start: S4.03, S4.10, S4.07. Done when: money figures reproduce from payments, refunds and credit notes. Verify: default plus `financial-report.test.ts`. Rollback: default.

- [ ] 4.57 `application/financial.ts`: charged (voided excluded and shown apart), collected, outstanding and payer receivables grouped by period, location, professional, payer and type; refunds and credit notes as reductions; reads invoices only through `invoicing/index.ts`. [RPT-02] Test: invoices 100000 with a credit note of 20000 give net 80000; voided charge excluded; drill-down sums.
- [ ] 4.58 `application/cash-report.ts`: per location and day opening, payments by method, refunds, expected, counted, difference and reason from closed and open registers. [RPT-03] Test: day with a 1000 ARS difference shows its reason.
- [ ] 4.59 `features/reports/financial/*` widgets and export, server-side scope (professional own revenue, reception cash of its locations, revenue by professional denied). [RPT-02, RPT-03, RPT-06, RPT-10] Test: component tests; role matrix extension of the Playwright spec.

## S4.15 Read-only, money invariants and audit coverage (~300) [Track D]

Start: A, B and C merged. Done when: every Stage 4 route has a category and the money rules hold under random input. Verify: default plus the named tests. Rollback: default.

- [ ] 4.60 Read-only audit of all Stage 4 routes: category present, billing writes and invoice creation 402, reads, exports, reports and PDF links allowed. [BIL-14, INV-13, RPT-12, TEN-11] Test: `route-categories.test.ts` plus an inject matrix per route.
- [ ] 4.61 `apps/api/test/policy/money-invariants.test.ts` (fast-check): payments never exceed the patient portion without a confirmed credit, reversals never exceed the net payment, invoice lines never exceed charge lines, credit notes never exceed the invoice, expected cash equals opening plus cash in minus cash out. [BIL-06, BIL-08, INV-05, INV-07] Test: that file.
- [ ] 4.62 Audit coverage and redaction: Stage 4 actions registered in `audit-coverage.test.ts`; log capture proves no card data, certificates or keys are logged. [BIL-15, INV-12] Test: both files.

## S4.16 Demo seed (~300) [Track D]

Start: A, B and C merged. Done when: the demo shows revenue data and resets in under a minute. Verify: default plus the gap check. Rollback: default.

- [ ] 4.63 `db/seed/demo/stage4/{billing,invoicing,reports}.ts`: prices and payers, charges in every state, payments of every method, a closed register with a difference and one open, invoices in every state (a pending one flagged, a rejected one, a manual one, a credit note) through the demo fake issuer; registered in `contributors.ts`. [DEM-04, DEM-02, DEM-03] Test: gap check; deterministic content.
- [ ] 4.64 Reset timing with Stage 4 data under 60 s; report totals equal the seeded totals. [DEM-05] Test: timing and totals test.

## S4.17 Stage 4 gate (~200) [Track D]

Start: S4.15, S4.16. Done when: the Stage 4 demo runs locally end to end. Verify: the e2e spec plus a fresh review. Rollback: default.

- [ ] 4.65 `e2e/stage4-demo.spec.ts`: reception closes the day's register and issues an invoice through the local AFIP, including an outage and its recovery. [BIL-09, INV-05, INV-09] Test: that spec.
- [ ] 4.66 Fresh-context review (`judgment-day`) of money invariants, immutability triggers, credential handling and double-issue protection; fix findings. Test: review report attached.
- [ ] 4.67 `docs/runbooks/afip-switch-to-real.md` (what changes when the real adapter arrives), update `docs/external-dependencies.md`, re-run `sdd-init`. Test: none.

## S4.D Deferred real-provider adapter (no gate depends on it)

Start: the owner has the ARCA certificate and homologation access. Done when: the adapter passes `invoice-issuer.contract.ts` and `AFIP_PROVIDER=afip` selects it. Verify: contract suite plus recorded SOAP fixtures; the homologation test runs in staging only. Rollback: set `AFIP_PROVIDER=local` (or `off`); issued invoices are never touched.

- [ ] 4.68 deferred: needs owner credentials/contract (ARCA certificate and homologation access). `adapters/afip-wsfe/`: WSAA ticket cache per certificate, WSFEv1 `FECompUltimoAutorizado`, `FECAESolicitar`, `FECompConsultar`, per-POS endpoint choice. [INV-05, INV-09, CTR-09] Test: `invoice-issuer.contract.ts` plus recorded SOAP fixtures.
- [ ] 4.69 deferred: needs owner credentials/contract (same). `apps/api/test/external/afip-homologation.test.ts`, tagged so it runs only in staging. [INV-05] Test: that file.

---

# Stage 5: Compliance and patient portal

Goal: a patient signs a consent and downloads a prescription from the portal. The e-prescription provider is a local simulator that issues a prescription PDF, tracks status and can go down; portal sign-in uses an emailed code. Order: seams (S5.00), two parallel tracks (compliance and portal), then integration (S5.12, S5.13). Depends on Stage 4 (patient invoice list, PDF helper, file-resource registry), Stage 3 (channel policy, OTP table, token router, appointment events) and Stage 2 (documents, clinical records, care relationship). The real e-prescription provider is the deferred slice S5.D.

Permissions: `clinical.prescription.read`, `portal.self.read` and `portal.appointment.cancel` already exist. S5.00 adds `clinical.prescription.write` and `clinical.consent.read` (professional only, never grantable), `consent.template.manage` (owner, admin, professional), `consent.request` (professional, reception) and the portal actor permissions `portal.consent.sign`, `portal.consent.revoke`, `portal.document.read`, `portal.prescription.read`, `portal.invoice.read`, `portal.profile.write`; staff get `portal.manage` (owner, admin, reception) to invite, link and deactivate.

### Parallel tracks (Stage 5)

| Track | Slices | New files live in | Migration range | Locale files |
|---|---|---|---|---|
| Seams | S5.00 | every shared file, touched once | 0500-0504 | none |
| A1 Verification | S5.01 | `modules/operator` (matricula), `features/operator/matricula` | 0505-0509 | `operator.json` (existing file, own keys) |
| A2 Consent | S5.02, S5.03, S5.11 | `modules/consent`, `features/consent` | 0510-0529 | `consent.json`, `errors.consent.json` |
| A3 e-Rx | S5.04, S5.05 | `modules/prescriptions`, `adapters/erx-*`, `features/prescriptions` | 0530-0549 | `prescriptions.json`, `errors.prescriptions.json` |
| B Portal | S5.06 to S5.10 | `modules/portal`, `features/portal` | 0550-0579 | `portal.json`, `errors.portal.json` |
| C Integration | S5.12, S5.13 | `db/seed/demo/stage5`, `test/policy`, `e2e` | 0590-0599 | none |

- Run order: S5.00 first. Then A1, A2 (S5.02), A3 (S5.04) and B (S5.06, S5.07) run at the same time. The e-Rx gate reads the existing `matricula_status` column, so S5.04 does not wait for S5.01 (only its end-to-end test does). S5.08 waits for S5.03, S5.04 and S4.12. S5.11 waits for S5.03 and S5.10. C starts when everything else is merged.
- Shared files that still need a merge step: `_journal.json` and snapshots (`pnpm db:restamp`), `db/seed/demo/contributors.ts` (only S5.12), `packages/contracts/src/ports.ts` (only S5.00 edits it).
- The portal reads consent, prescription, invoice and document data only through each module's `index.ts` list functions; it owns no clinical table.

## S5.00 Seams (~400)

Start: Stage 4 gate merged. Done when: the three module skeletons are wired, the prescription port is in the adapter resolver with a fake that passes its contract suite, and the portal actor class exists with default deny. Verify: default plus the resolver test iterating every port. Rollback: default.

- [ ] 5.1 `ERX_PROVIDER` (`local|off`, a real provider key is added by task 5.53) in `main/config.ts` and the guard of task 3.1; `prescriptionProvider` added to the adapter resolver; `packages/contracts/src/ports.ts` `PrescriptionProvider` gains `cancel(externalId, reason, key)`, `findByKey(key)` and `status(externalId)`; `adapters/erx-fake/` (in memory) and the shared suite `adapters/prescription-provider.contract.ts`. [CTR-09, ERX-02, DEM-03] Test: resolver test iterates every port; contract suite passes on the fake.
- [ ] 5.2 Contracts and catalogs: skeleton files `packages/contracts/src/{consent,prescriptions,portal}.ts`; the permissions listed above in `roles.ts` with the invariant that no non-professional role holds a `clinical.*` permission; audit actions `consent.template.created|published|retired`, `consent.requested|signed|revoked|read|expired`, `prescription.issued|cancelled|read|downloaded|failed|registered_manually`, `portal.identity.created|linked|deactivated`, `portal.signin.success|failure`, `portal.read`, `portal.download`, `portal.profile.changed`, `portal.denied`, `operator.matricula.verified|unverified`. [CNS-09, ERX-09, POR-13] Test: `roles.test.ts` and `audit-actions.test.ts` invariants stay green.
- [ ] 5.3 Module skeletons and wiring for `consent`, `prescriptions`, `portal`; clinical export contributors registered (consents and prescriptions per professional); queues `erx.submit`, `erx.reconcile`, `consent.expire`, `portal.majority_review`; `platform/authz/actor.ts` gets `PortalActor` (identity id, selected link) while staff routes keep denying it by default. [TEN-08, AUZ-14, POR-05] Test: `export-registry.test.ts` green; patient actor still denied on every staff route (existing matrix).
- [ ] 5.4 Web seams: `features/portal` registers under a separate shell (`shell: 'portal'` in the route registry), slots `patient-detail-tab` entries for consents and prescriptions, nav entry for Prescriptions (professional), locale files created empty. [SHL-01, POR-15] Test: registry test shows the portal shell is separate from the staff `AppShell`; nav test per role.

## S5.01 Matricula verification (~300) [Track A1]

Start: S5.00. Done when: only the operator can verify, and editing the number resets it. Verify: default plus `matricula-verification.test.ts`. Rollback: default.

- [ ] 5.5 `modules/operator/application/matricula.ts` and routes `POST /operator/tenants/:tenantId/professionals/:id/matricula/verify|unverify` on the platform host: sets `matricula_status` through the operator context the Stage 1 trigger already requires, writes a platform audit event, exposes only name, jurisdiction, number and tenant (no clinical data). [STF-04, TEN-07] Test: owner and professional cannot verify (trigger); operator verification audited; `app_operator` still cannot select clinical tables.
- [ ] 5.6 `GET /operator/matricula-queue` (recorded and unverified, by tenant) with an operator note field (text only); editing the number resets the state to unverified (task 1.69 behavior re-asserted) so prescribing closes again. [STF-04, ERX-01] Test: edit resets; queue lists only unverified.
- [ ] 5.7 `features/operator/matricula/*` operator screen and the "verificada" badge in the staff profile; Playwright as operator. [STF-04] Test: component tests; that spec.

## S5.02 Consent templates (~400) [Track A2]

Start: S5.00. Done when: templates are versioned and immutable once published, and non-clinical roles only see the neutral label. Verify: default plus `consent-templates.test.ts`. Rollback: default.

- [ ] 5.8 `db/schema/consent.ts` + migration `0510_consent_templates.sql`: `consent_template` (title, optional specialty and appointment type, status `draft|published|retired`), `consent_template_version` (number, body, content hash, published_at) with an immutability trigger; policies and fixtures. [CNS-01, CNS-02] Test: isolation suite; updating a published version rejected as `app_rw`.
- [ ] 5.9 `modules/consent/application/templates.ts` and routes (permission `consent.template.manage`; reception denied with a deny audit row): create draft, publish as version N, editing a published template creates version N+1, retire, only the latest published version is offered for new signatures and earlier ones stay viewable; es-AR starter templates per specialty in `modules/consent/assets/starters/`. [CNS-01, CNS-02] Test: edit after publishing keeps version 1; retire keeps signed consents.
- [ ] 5.10 `application/read-model.ts` `listConsentsForPatient(actor, patientId)`: treating professionals see everything; reception sees status and dates under the neutral label and the template title only when `reception_sees_clinical_metadata` is on; a non-clinical admin never sees the title; nobody non-clinical sees content. [CNS-08] Test: matrix of the four scenarios (setting off, setting on, admin with setting on, other patient).
- [ ] 5.11 Template content hashing in the domain (`domain/fingerprint.ts`, SHA-256 over the canonical text) shared by publish and signing. [CNS-02, CNS-04] Test: stable hash across whitespace-equivalent inputs only where defined; property test of determinism.

## S5.03 Consent requests, signing and revocation (~400) [Track A2]

Start: S5.02, S3.01 (email kind). Done when: a consent can be requested, signed against the exact version shown, and revoked without altering the original. Verify: default plus `consent-signing.test.ts`. Rollback: default.

- [ ] 5.12 Migration `0512_consent_signing.sql`: `consent_request` (patient, template version, optional appointment or encounter, status `pending|signed|declined|expired|revoked`, expiry, method `in_person|portal`), `consent_signature` (request, signer `patient|representative`, representative name, DNI and relation, acceptance flag, evidence JSON, content fingerprint, signed_at; immutable), `consent_revocation` (append-only: actor, reason, time), expand column `appointment_type.requires_consent_template_id`. [CNS-03, CNS-04, CNS-06, CNS-07] Test: isolation suite; update or delete of a signature rejected as `app_rw`.
- [ ] 5.13 `application/request-consent.ts` and `application/sign-consent.ts` (permission `consent.request` for requests): a signature binds to the version id the signer was shown even if a newer one was published meanwhile, requires the explicit acceptance action, minors require the representative data and are never marked signed by the patient, the signed record renders a printable PDF with evidence and fingerprint through the task 4.5 helper. [CNS-03, CNS-04, CNS-05] Test: spec scenarios — in person on version 3, template changed while signing, signing without acceptance, minor patient.
- [ ] 5.14 `application/revoke-consent.ts`: patient or representative (portal) or a professional recording an in-person revocation with a reason; stored as a new event linked to the original; `hasValidConsent(patientId, templateId)` feeds a warning on appointments whose type requires one; revocation is allowed in a read-only tenant, new requests and templates are not. [CNS-07, CNS-10, TEN-11] Test: revoke from the portal while read-only; warning after revocation; in-person revocation records the user.
- [ ] 5.15 Audit and export: every read of a signed consent audited, job `consent.expire`, request notice by email only with no template title (channel policy kind `consent_request`), clinical export contributor for consents, included in the patient record export. [CNS-03, CNS-09, CNS-10] Test: expired request cannot be signed; notice text has no title; contributor output per professional.

## S5.04 e-Rx backend and local provider (~450) [Track A3]

Start: S5.00. Done when: a verified professional issues a prescription through the local provider, an outage leaves it pending without a duplicate, and nobody outside the care relationship can read it. Verify: default plus `prescription-issue.test.ts`. Rollback: default (`ERX_PROVIDER=off`). May run to about 450 lines.

- [ ] 5.16 `db/schema/prescriptions.ts` + migration `0530_prescriptions.sql`: `prescription` (patient, prescriber, optional encounter, status `draft|pending_submission|issued|cancelled|dispensed|expired`, external id, issued_at, items encrypted with the tenant DEK, cancel reason, `registered_manually`, idempotency key, version) with `clinicalPolicies` and the `prescription` template kind that the SQL function never shares (D17), a trigger freezing issued content, `REVOKE DELETE`; `erx_connection` (tenant, provider key, credentials encrypted, status). [ERX-05, ERX-07, ERX-02] Test: isolation suite; issued content update rejected; `app_rw` cannot delete.
- [ ] 5.17 `modules/prescriptions/domain/prescription.ts` (required fields: patient full name, DNI and coverage when present, prescriber name, matricula and specialty, date, medications by generic name with dose, form, quantity and instructions) and `application/issue.ts` (permission `clinical.prescription.write`): the matricula must be verified at the moment of issuing, the provider connection and the feature switch must be on, the patient must belong to the organization; an outage keeps `pending_submission`, a retry calls `findByKey` first and never issues twice, and no local document is shown as a valid prescription. [ERX-01, ERX-02, ERX-03, ERX-06] Test: unverified refused, edited matricula refused, missing quantity rejected, owner who is also a professional prescribes only as professional.
- [ ] 5.18 `adapters/erx-local/` + migration `0532_local_erx.sql` (platform tables `local_erx_prescription`, `local_erx_control`; never read in production): validates the payload against a small generic-name catalog in `assets/inn-sample.json`, issues an external id and a prescription PDF stamped "receta electronica simulada, sin validez legal" (task 4.5 helper, stored under a platform prefix), supports cancel with reason, status progression to `dispensed` or `expired` through simulator controls, modes `ok|down|timeout_after_issue`, idempotent by key; customer slot when `ERX_PROVIDER=local`; controls under `/operator/dev/erx/*` with a tab in `features/operator/dev/`. [ERX-04, ERX-06, CTR-09] Test: `prescription-provider.contract.ts` on fake and local; timeout then reconcile gives one prescription.
- [ ] 5.19 Status and corrections: job `erx.reconcile` and `POST /webhooks/erx` (HMAC with `ERX_WEBHOOK_SECRET`, idempotent, allowed in a read-only tenant) reflect provider status; `POST /prescriptions/:id/cancel {reason}` goes through the provider and a refusal keeps `issued`; `POST /prescriptions/:id/register-manual {identifier}` stores the prescription flagged `registered_manually`; edits to issued prescriptions are refused with cancel-and-reissue offered. [ERX-04, ERX-05, ERX-06] Test: dispensed update; cancel refused by provider; manual registration; edit attempt.
- [ ] 5.20 Access, audit and read-only: routes with `clinical.prescription.write|read`; the admin-denied harness of task 1.56 covers them; reception sees only existence when `reception_sees_clinical_metadata` is on; a professional without a care relationship is denied whatever the sharing setting (D17); every read, issue, cancel and failure audited; clinical export contributor; read-only tenant refuses issue and cancel but allows reads. [ERX-07, ERX-09, ERX-10] Test: spec scenarios (reception, treating professional, sharing off, sharing on without relationship); admin denied with a deny audit row.

## S5.05 e-Rx UI (~350) [Track A3]

Start: S5.04, S5.00 web seams. Done when: a professional issues and cancels a prescription and understands every provider state. Verify: default plus `e2e/stage5-erx.spec.ts`. Rollback: default.

- [ ] 5.21 `features/prescriptions/*`: patient prescriptions tab (professional only, in the `patient-detail-tab` slot), issue form with generic-name typeahead from the catalog, per-field Spanish validation, coverage pre-filled; `locales/es-AR/prescriptions.json`. [ERX-03, ERX-07] Test: component tests plus axe.
- [ ] 5.22 State handling: issued, pending submission with retry, failed, cancelled with reason, dispensed; cancel dialog; manual registration form; "provider not connected" state with a link to the connection settings (owner and admin, credentials never shown after saving); reception and admin see the forbidden state. [ERX-02, ERX-04, ERX-05, ERX-06] Test: component tests per state.
- [ ] 5.23 `features/operator/dev/ErxSimulator.tsx` and `e2e/stage5-erx.spec.ts`: unverified professional refused, operator verifies, issue works, simulator `down` leaves it pending, recovery issues one prescription, reception sees no content. [ERX-01, ERX-06, ERX-07] Test: that spec.

## S5.06 Portal identity (~400) [Track B]

Start: S5.00, S3.03. Done when: staff can invite a patient and the activation link creates a portal identity with a self link. Verify: default plus `portal-identity.test.ts`. Rollback: default.

- [ ] 5.24 `db/schema/portal.ts` + migration `0550_portal_identity.sql`: `portal_identity` (citext email UNIQUE with tenant, status `invited|active|deactivated`), `portal_link` (identity, patient, relationship `self|representative`, relation, status `active|suspended|revoked`, `majority_review_on`) with the design's partial unique indexes (one self link per identity, one per patient) and composite FKs, `portal_session` (token hash, link selection, idle and absolute expiry); the `otp_challenge.purpose` check gains `portal_registration` and `portal_sign_in` (expand). [POR-01, POR-12] Test: isolation suite; two self links rejected; link to a patient of another tenant rejected.
- [ ] 5.25 `modules/portal/application/identities.ts` and routes `POST /patients/:id/portal-invitation`, `POST /portal-identities/:id/links` (permission `portal.manage`): invitation needs a confirmed email and sends a `portal_activation` token by email only; following the link creates the identity and the self link; an email already mapped to another adult is refused with a request for a different one; a representative link needs the organization's verification note; creation, linking and changes audited. [POR-01, POR-02, POR-06, POR-13] Test: spec scenarios — shared email refused, parent with two children, expired activation link.
- [ ] 5.26 Deactivation and email change: staff deactivate an identity or one link without touching the patient, which revokes sessions; changing the email is staff-only after out-of-band verification and revokes sessions; all audited; read-only tenant keeps these staff writes blocked (not in the allowlist). [POR-14, POR-03, POR-13] Test: deactivated identity cannot request codes; session ends; email change revokes sessions.

## S5.07 Portal sign-in (~400) [Track B]

Start: S5.06, S3.08 (`otp_challenge`). Done when: a patient registers or signs in with an emailed code and cannot learn whether an account exists. Verify: default plus `portal-signin.test.ts`. Rollback: default.

- [ ] 5.27 `POST /public/:slug/portal/register {nationalId, email}`: always the same response; only when the document and the email on file match one patient without a self link is a `portal_registration` code emailed to that on-file address; verifying it creates the identity and the self link; no patient record is ever created or revealed. [POR-02, IDA-06] Test: matching data activates; DNI plus wrong email gives the generic message; identical response bodies.
- [ ] 5.28 `POST /public/:slug/portal/otp` and `.../otp/verify`: same response for any email; for an active identity a 6-digit code (hashed, 10 minutes, 5 attempts, one live code per identity) is emailed through the channel policy (portal notice, email only, tenant-tagged so demo routing works); verification creates the `psid` session (30 minutes idle, 12 hours absolute); repeated failures throttle and lock and are audited. [POR-03, IDA-06, POR-13] Test: unknown email reveals nothing; lockout after repeated wrong codes; one live code.
- [ ] 5.29 `platform/http/portal-session.ts` and `portal-guard.ts`: tenant from the host and the session only, never parameters; a staff session on a portal route is denied; a patient session on a staff route is denied (extends task 1.58); unauthenticated requests get 401 except register and code routes; Origin check on writes. [POR-05, POR-12, IDA-06] Test: generated route x actor matrix for portal routes (patient, staff roles, anonymous).
- [ ] 5.30 Portal session management: `GET|DELETE /portal/sessions`, logout, revocation by an administrator, audit `portal.signin.*`. [POR-03, POR-13] Test: patient revokes another session; admin revocation ends it.

## S5.08 Portal read models (~400) [Track B]

Start: S5.07, S5.03, S5.04, S4.12. Done when: a portal user sees only their own data and never clinical note content. Verify: default plus `portal-isolation.test.ts`. Rollback: default.

- [ ] 5.31 `modules/portal/application/subject.ts`: the selected link lives in the session (`POST /portal/subject {linkId}` validates it belongs to the identity); every portal query runs through `withPortalSubject`; another patient's id answers 404 and is audited (`portal.denied`). [POR-04, AUZ-14] Test: P1 asking for P2's appointment gets 404 plus an audit row; subject switch rejects a foreign link.
- [ ] 5.32 Appointments and documents: upcoming and past appointments with the virtual join address when it exists, confirm and cancel inside the organization's policy enforced on the server; `document_share` table (migration `0552_document_share.sql`) and staff routes to share or unshare (clinical documents only by professionals who can read them, administrative ones by reception or admin); the portal lists only shared documents. [POR-07, POR-08] Test: cancel after the cut-off refused; unshared document absent; admin cannot share a clinical document.
- [ ] 5.33 Consents, prescriptions and invoices: lists through each module's `index.ts` (`listConsentsForPatient` for the portal actor, issued prescriptions, `listInvoicesForPatient` from task 4.53); payer portions never shown as owed by the patient; the portal DTO schemas contain no clinical note, diagnosis or anamnesis field (contract test); `POST /portal/copy-requests` creates a `patient_rights_request` of kind access (task 1.78) and notifies the organization by email without clinical content. [POR-09, POR-10, AUZ-14] Test: DTO snapshot; signed encounters add nothing to any section; copy request notice has no clinical text.
- [ ] 5.34 Personal data: demographics and consent status view; contact fields editable with before and after audited (`portal.profile.changed`); name, DNI and birth date changes become rectification requests that stay pending until staff approve through the versioned update. [POR-10] Test: phone update audited; identity correction pending and record unchanged.

## S5.09 Portal downloads, dependents and isolation (~350) [Track B]

Start: S5.08. Done when: every patient download is session bound, dependents work, and the read-only rules hold. Verify: default plus `portal-downloads.test.ts`. Rollback: default.

- [ ] 5.35 Session-bound downloads: `POST /portal/{documents|prescriptions|invoices|consents}/:id/download-link` issues a `document_download` token bound to the `psid` session (5 minutes, single use); the `/files/:token` registry resolvers for those kinds re-run portal authorization at redemption; every download audited. [POR-08, POR-09, POR-13] Test: expired link, link opened from another session or none, access revoked meanwhile, audit row.
- [ ] 5.36 Dependents: a representative switches between dependents inside one identity and the header names the subject; job `portal.majority_review` suspends a representative link on `majority_review_on` until the adult authorizes it (`POST /portal/links/:id/authorize` from the adult's own identity, or staff after verification); the organization can revoke a link; consent signing for a dependent records the representative data. [POR-06, PAT-12, CNS-05] Test: parent sees the child; access suspended at 18; adult authorization restores it.
- [ ] 5.37 Isolation and read-only: one person in two organizations has two identities and sees only the host's organization; in a read-only tenant the portal allows reading, sign-in and the patient-protective writes (cancel an appointment, revoke a consent, rectification request, channel opt-out) and refuses everything else with 402. [POR-12, POR-14, TEN-11] Test: cross-tenant sign-in matrix; read-only inject matrix per portal route.
- [ ] 5.38 Portal message privacy: invitation, code, document-available and consent-request notices are email only, never name a specialty, a template title or a medication, and link to the authenticated portal; the channel policy refuses WhatsApp for these kinds. [POR-11, ERX-08, CNS-03] Test: rendered text snapshots against a clinical word list; policy refusal.

## S5.10 Portal UI (~450) [Track B]

Start: S5.09, S5.04. Done when: a patient completes sign-in, reads their data and downloads at 360 px. Verify: default plus `e2e/stage5-portal.spec.ts`. Rollback: default. May run to about 450 lines.

- [ ] 5.39 `features/portal/*` shell (`/portal`, branded, installable inside the PWA scope): sign-in by email and code, registration by DNI and email with generic responses, subject picker, header that always names whose data is shown; `locales/es-AR/portal.json`. [POR-02, POR-03, POR-06, POR-15] Test: component tests plus axe.
- [ ] 5.40 Sections: appointments (confirm, cancel, join link), documents with a Spanish empty state, consents (list, sign, revoke screens reusing the consent signing components), prescriptions, invoices and receipts, each with loading, empty and error states. [POR-07, POR-08, POR-09, POR-15] Test: component tests per section.
- [ ] 5.41 Personal data screen with rectification request, clinical history copy request, consent status, sessions page. [POR-10, POR-03] Test: component tests.
- [ ] 5.42 `e2e/stage5-portal.spec.ts` at 360 px: register, read the code from the Mailpit API, see appointments, download a prescription (link bound to the session), sign a consent; a patient cannot reach staff pages. [POR-02, POR-05, POR-08, POR-09] Test: that spec.

## S5.11 Consent UI (~400) [Track A2]

Start: S5.03, S5.10. Done when: staff manage templates, request and record consents, and the neutral label rules hold on screen. Verify: default plus `e2e/stage5-consent.spec.ts`. Rollback: default.

- [ ] 5.43 `features/consent/*` template manager: draft, publish, version list, retire, es-AR starters; `locales/es-AR/consent.json`; reception sees the forbidden state. [CNS-01, CNS-02] Test: component tests plus axe.
- [ ] 5.44 Request dialog (in person on this device or through the portal) and the signing screen: full text of the version, explicit acceptance checkbox, representative form for minors, `SignaturePad` (canvas with a keyboard-accessible typed-name alternative), shared with the portal. [CNS-03, CNS-04, CNS-05] Test: component tests including rejection without acceptance.
- [ ] 5.45 Patient detail list in the `patient-detail-tab` slot using the neutral label rules (reception with the setting on or off, admin never the title), revocation recording with reason, warning banner on appointments that need a valid consent. [CNS-07, CNS-08] Test: component tests per role and setting.
- [ ] 5.46 `e2e/stage5-consent.spec.ts` at 360 px: create and publish a template, request in person, sign, revoke from the portal in a read-only tenant, reception sees the neutral label. [CNS-01, CNS-04, CNS-07, CNS-08, CNS-10] Test: that spec.

## S5.12 Demo seed (~250) [Track C]

Start: all tracks merged. Done when: the demo tenant has consents, prescriptions and portal accounts, and demo emails are readable inside the app. Verify: default plus the gap check. Rollback: default.

- [ ] 5.47 `db/seed/demo/stage5/{consent,prescriptions,portal}.ts`: template with two versions, signed and revoked consents, prescriptions issued through the demo fake, a verified matricula for the demo professional, portal identities with self and representative links; registered in `contributors.ts`. [DEM-04, DEM-02, DEM-03] Test: gap check; deterministic content.
- [ ] 5.48 Demo outbox: the demo `EmailSender` fake persists captured messages to `demo_outbox` (platform table, migration `0590_demo_outbox.sql`, removed by `demo.reset`) and the operator dev console lists them, so the demo portal code can be read without sending anything. [DEM-03, DEM-06] Test: demo email never reaches SMTP; the outbox shows the code; reset clears it.
- [ ] 5.49 Reset timing with Stage 5 data under 60 s. [DEM-05] Test: timing test.

## S5.13 Stage 5 gate (~200) [Track C]

Start: S5.12. Done when: the Stage 5 demo runs locally end to end. Verify: the e2e spec plus a fresh review. Rollback: default.

- [ ] 5.50 `e2e/stage5-demo.spec.ts`: operator verifies a matricula, the professional prescribes, the patient signs a consent and downloads the prescription from the portal. [ERX-01, CNS-04, POR-08, POR-09] Test: that spec.
- [ ] 5.51 `docs/security/asvs-l2-portal.md` checklist with evidence links, then a fresh-context review (`judgment-day`) of portal isolation, consent integrity and prescription access; fix findings. Test: review report attached.
- [ ] 5.52 Update `docs/external-dependencies.md` (e-Rx provider: local adapter in use, real deferred) and re-run `sdd-init`. Test: none.

## S5.D Deferred real-provider adapter (no gate depends on it)

Start: the owner has chosen and contracted the authorized e-prescription platform (Q3). Done when: the adapter passes `prescription-provider.contract.ts` and `ERX_PROVIDER=<key>` selects it. Verify: contract suite plus recorded payload fixtures. Rollback: set `ERX_PROVIDER=local` or `off`; issued prescriptions stay as they are.

- [ ] 5.53 deferred: needs owner credentials/contract (authorized e-prescription platform under Ley 27.553, decision Q3). `adapters/erx-<provider>/` implementing `PrescriptionProvider`, plus the provider webhook mapping. [ERX-02, ERX-04, CTR-09] Test: `prescription-provider.contract.ts` plus recorded payload fixtures.
- [ ] 5.54 deferred: needs owner credentials/contract (same). Provider onboarding form in `features/prescriptions/connection` for the real registration fields. [ERX-02] Test: component test with a mocked provider schema.

---

# Stage 6: Growth

Goal: a stranger signs up, pays through a local Mercado Pago and uses the product the same day; a cancelled tenant receives its split export and its records go into a local immutable archive. Order: seams (S6.00), three parallel tracks (subscriptions, signup, retention), then readiness and the gate (S6.11, S6.12). Depends on Stage 5 (portal, consent and prescription exports), Stage 4 (exports, PDF), Stage 3 (WhatsApp usage events, bot challenge, OTP, tokens) and Stage 2 (the onboarding wizard and the plan-impact hook of task 2.90). Legal sign-offs (Q1, Q7) are not tasks. The real Mercado Pago adapter and the AWS archive adapter are the deferred slice S6.D.

Permissions: `billing.manage` already exists and is owner-only; it guards every subscription route. No new tenant permission is needed.

### Parallel tracks (Stage 6)

| Track | Slices | New files live in | Migration range | Locale files |
|---|---|---|---|---|
| Seams | S6.00 | every shared file, touched once | 0600-0609 | none |
| A Subscriptions | S6.01, S6.03 to S6.06, S6.07 (UI) | `modules/subscriptions`, `adapters/mercadopago-*`, `features/subscription`, `features/operator/subscriptions` | 0610-0639 | `subscription.json`, `errors.subscriptions.json` |
| B Signup | S6.02, S6.07 (signup UI) | `modules/onboarding/signup`, `features/onboarding/signup` | 0640-0649 | `signup.json`, `errors.signup.json` |
| C Retention | S6.08 to S6.10 | `modules/tenancy/{cancellation,archive}`, `adapters/archive-*`, `features/export`, `features/operator/archive` | 0650-0679 | `export.json`, `errors.archive.json` |
| D Readiness | S6.11, S6.12 | `scripts`, `docs`, `infra`, `e2e` | 0690-0699 | none |

- Run order: S6.00 first. Then A (S6.01), B (S6.02, after S6.01 for the trial port) and C (S6.08) start together. C does not wait for billing: cancellation is triggered by a `TenantCancelled` port that S6.04 (subscriptions) and the operator action of task 6.36 both publish. S6.03 to S6.06 are sequential inside A. S6.07 waits for A and B. S6.11 waits for A and C. S6.12 last.
- Shared files that still need a merge step: `_journal.json` and snapshots (`pnpm db:restamp`), `db/seed/demo/contributors.ts` (only S6.12), `compose` (`infra/docker-compose.yml`: only task 6.37 adds the archive bucket and the `releaser` service).
- Retention note for the owner: the exhaustive list of hard-delete exceptions has no entry for removing hot data after archiving, so v1 keeps the cancelled tenant's rows in Postgres (read-only) and the archive is the custody copy. Confirm before S6.09.

## S6.00 Seams (~350)

Start: Stage 5 gate merged. Done when: the payments port is in the adapter resolver with a passing fake, the module skeletons are wired and the queues exist. Verify: default plus the resolver test iterating every port. Rollback: default.

- [ ] 6.1 `PAYMENTS_PROVIDER` (`local|off`, a real key is added by task 6.50), `MP_WEBHOOK_SECRET` and `MP_PUBLIC_BASE_URL` in `main/config.ts` and the guard of task 3.1; `modules/subscriptions/application/ports.ts` with `PaymentsGateway` (`createPreapproval`, `getPreapproval`, `updatePreapprovalAmount` that can answer `amount_change_refused`, `createPaymentLink`, `getPayment`, `refund`, `verifyWebhook(rawBody, headers)`); `paymentsGateway` added to the adapter resolver; `adapters/mercadopago-fake/` (in memory) and the shared suite `adapters/payments-gateway.contract.ts`. [SUB-05, SUB-06, DEM-03] Test: resolver test iterates every port; contract suite passes on the fake.
- [ ] 6.2 Contracts and catalogs: skeleton files `packages/contracts/src/{subscriptions,signup,cancellation}.ts`; audit actions `subscription.created|plan_changed|state_changed|cap_changed|surplus_flagged|refunded`, `signup.created|verified|purged`, `terms.accepted`, `tenant.cancelled`, `export.cancellation.requested|downloaded`, `archive.written|verified|accessed|released|erased`; queues `usage.snapshot`, `trial.end`, `dunning.step`, `statement.generate`, `subscription.reconcile`, `signup.purge`, `archive.write`, `archive.verify`, `archive.release` (`export.build` exists); the `archive_release` token kind stays disabled until task 6.41. [SUB-17, ONB-15, TEN-09] Test: `audit-actions.test.ts` invariants green; queue install integration test.
- [ ] 6.3 Module skeletons and wiring: `modules/subscriptions`, `modules/onboarding/signup` (under the existing onboarding module), `modules/tenancy/cancellation` and `modules/tenancy/archive` (registered through the tenancy `index.ts`), `TenantCancelled` port in `modules/tenancy/application/lifecycle.ts`; export contributors registered; `FEATURES` signup and subscriptions stay off in single mode (existing test extended to the new routes). [TEN-06, SUB-18, TEN-08] Test: `export-registry.test.ts` green; single-mode boot has no signup or subscription routes.
- [ ] 6.4 Web seams: public `/signup` route under a minimal shell, `features/subscription`, `features/onboarding/signup`, `features/export` registered through `routes.tsx` and `nav.ts` (owner-only nav entry), operator console tab entries for subscriptions and archive, empty locale files. [SHL-01, SUB-17] Test: registry and nav tests per role; single-mode build omits the signup route.

## S6.01 Plans and subscription model (~400) [Track A]

Start: S6.00. Done when: plans are data, the state machine is total, and exempt tenants never get a subscription row. Verify: default plus `subscription-state.test.ts`. Rollback: default.

- [ ] 6.5 `db/schema/subscriptions.ts` + migration `0610_subscriptions.sql`: platform `plan` (price per active professional, max active professionals, WhatsApp quota per professional 200, overage unit price, default and maximum overage cap, trial days 14, grace days 7; ARS), `plan_entitlement`; tenant `subscription` (status `trial|active|past_due|read_only|cancelling|cancelled`, `trial_ends_at`, `grace_ends_at`, `paid_through`, `dunning_step`, `overage_cap_messages`, provider ids, version), `subscription_event` (provider event id UNIQUE); a trigger refuses a subscription row for `billing_exempt` tenants; plan seed in `db/seed/plans.ts`. [SUB-02, SUB-03, SUB-04] Test: isolation suite; exempt tenant insert rejected; plan table readable by all tenants and writable only by the operator.
- [ ] 6.6 `modules/subscriptions/domain/subscription-state.ts` (pure): the transition table of design section 7 and the derived `tenant.status`; transitions come only from provider-confirmed events and dates, never from a missing confirmation. [SUB-03] Test: exhaustive from/to pair test; property test that no sequence of "unconfirmed" inputs changes state.
- [ ] 6.7 `domain/active-professional.ts` (a member with the professional role, status active and an enabled profile on that day), `domain/proration.ts` (daily, in cents with the task 4.1 allocation) and `domain/plan-limits.ts`; the definition and proration rule are documented in `docs/billing-model.md` and shown in the UI; reception and admin seats are free and unlimited; patient-safety and legal-custody actions are never blocked by a limit. [SUB-01, SUB-02] Test: 2 professionals, 4 reception and 1 admin count as 2; mid-period activation and deactivation; property test that prorated parts sum to the period price.
- [ ] 6.8 Plan-impact hook of task 2.90 made real: inviting or activating a professional first returns the price change and proration and applies only after the owner confirms, a plan limit refuses with an upgrade path, reception and admin additions always pass; routes guarded by `billing.manage`; the operator support view `GET /operator/tenants/:id/subscription` shows state, usage counts and surplus flags only. [SUB-01, SUB-02, SUB-17, ONB-06] Test: professional denied; operator view reaches no patient or clinical table (privilege test); limit exceeded refused.

## S6.02 Self-service signup backend (~400) [Track B]

Start: S6.01 (trial port), S3.07 (bot challenge) and S3.08 (OTP table). Done when: an unverified tenant exists after signup and becomes active only through the emailed link. Verify: default plus `signup.test.ts`. Rollback: default (the `signup` feature flag).

- [ ] 6.9 Migration `0640_signup.sql`: `tenant.status` gains `unverified` (expand), `terms_acceptance` (tenant, user, terms version, data-processing terms version, accepted_at), platform `terms_version` (current versions); the read-only layer treats `unverified` as blocked for patient data, messaging and paid features except verify and resend. [ONB-09, ONB-10, ONB-14] Test: isolation suite; unverified tenant refuses writes.
- [ ] 6.10 `modules/onboarding/signup`, `POST /public/signup` (multi mode with the `signup` feature on, bot challenge, rate limit, password policy of task 1.36, terms acceptance required): the slug is generated from the name with a random suffix on collision and the response never reveals a collision; an existing email gets the same response and the existing owner is notified; the verification link is a `signup_verification` token by email, resend rate-limited; a failing email provider keeps the signup and a job retries. [ONB-09, ONB-11, ONB-13, ONB-14] Test: spec scenarios — success, terms refused, single-tenant route absent, same name twice, failed challenge creates nothing, burst throttled, email provider down.
- [ ] 6.11 `POST /public/signup/verify {token}`: activates the tenant, creates the owner membership, starts the trial through `subscriptions.startTrial` (plan trial days), returns a session landing in the Part A wizard, audits `signup.verified`; an expired link offers a new one; the wizard reads trial end date and consequences from `GET /subscription`. [ONB-10, ONB-12, ONB-15] Test: verification activates; expired link; existing email never confirmed.
- [ ] 6.12 Job `signup.purge` (7 days): hard-deletes unverified tenants and their owner records, never verified tenants; added to the `no-delete` allowlist as retention exception 2 with a test that the purged tables hold no patient data. [ONB-13, TEN-10] Test: fake clock; verified tenant untouched; allowlist test names exactly the four exceptions.

## S6.03 Payments gateway and local Mercado Pago (~450) [Track A]

Start: S6.01. Done when: an owner can subscribe through a local hosted checkout, and webhooks, duplicates, out-of-order events and outages behave as specified. Verify: default plus `payments-gateway.contract.test.ts` and `mp-webhook.test.ts`. Rollback: default (`PAYMENTS_PROVIDER=off`). May run to about 450 lines.

- [ ] 6.13 `adapters/mercadopago-local/` + migration `0612_local_mercadopago.sql` (platform tables `local_mp_preapproval`, `local_mp_payment`, `local_mp_control`, never read in production): preapprovals and payments with a hosted checkout page at `/local-providers/mercadopago/checkout/:id` (es-AR, buttons approve, reject, pending, abandon), a "run billing cycle" control that fires webhooks to `/webhooks/mercadopago` signed with `MP_WEBHOOK_SECRET` using Mercado Pago's manifest scheme (`id`, `request-id` and `ts`), modes `ok|down|refuse_amount_change|duplicate_events|out_of_order`, refunds; the checkout prefix is allowed in the auth-guard only while the console flag is on. [SUB-05, SUB-06, SUB-15] Test: `payments-gateway.contract.ts` on fake and local; route-enumeration in both modes.
- [ ] 6.14 `POST /subscription/checkout` (owner): creates the preapproval and returns the checkout URL; the subscription becomes `active` only after the provider-confirmed event; an abandoned checkout keeps the trial or "not subscribed" with no inferred state; the owner sees plan, next charge date, amount and the provider's payment method label; no card data stored (schema check). [SUB-05] Test: authorization then confirmation activates; abandon leaves state unchanged.
- [ ] 6.15 `POST /webhooks/mercadopago` (`modules/subscriptions/http/mp-webhook.ts`): signature and timestamp-tolerance check, idempotent by event id through `subscription_event`, an older event never regresses state, unknown preapprovals logged and ignored with a generic response, allowed in a read-only tenant (category 9). [SUB-06, TEN-11] Test: forged request changes nothing; duplicate delivery once; out-of-order guard.
- [ ] 6.16 Duplicates and refunds: a second approved payment for the same period is recorded as surplus, flagged for the operator, and does not move `paid_through` twice; operator refunds are separate entries; retried charge attempts are idempotent. [SUB-07] Test: two approved payments for March.
- [ ] 6.17 Outage handling: a provider error never changes billing state, starting or changing a subscription during an outage fails with a retryable message, job `subscription.reconcile` pulls provider state after recovery. [SUB-15] Test: simulator mode `down` on the renewal date keeps the state; reconcile after recovery.

## S6.04 Trial, dunning and read-only (~400) [Track A]

Start: S6.03. Done when: the full timeline from trial to read-only and back runs under a fake clock. Verify: default plus `billing-timeline.test.ts`. Rollback: default.

- [ ] 6.18 Jobs `trial.end` (trial to `past_due` with `grace_ends_at`, owner emailed with the read-only date) and `dunning.step` (retries on day 1, 3 and 5 through the gateway, owner emailed after each failure in es-AR with ARS amounts and no patient data); steps are skipped while the provider outcome is unconfirmed. [SUB-12, SUB-03, SUB-19] Test: full timeline with a fake clock; email text snapshot; outage skips a step.
- [ ] 6.19 Derived tenant status: grace expiry makes the subscription `read_only`, sets `tenant.read_only_since` and the shared allowlist applies; a provider-confirmed settlement returns the tenant to `active`, clears `read_only_since`, never replays blocked actions or the messages queued in the read-only period; clinical reading and every export stay available; a non-owner refused write sees the reason without billing details. [SUB-13, SUB-14, TEN-11] Test: professional cannot create an encounter but reads records; export works; pay-and-recover scenario; reception message has no billing detail.
- [ ] 6.20 Exempt and single-mode tenants: demo tenants and single-tenant deployments with billing disabled skip every job here, show no banner, limit or read-only state; WhatsApp usage events keep being written. [SUB-04, SUB-18] Test: a demo tenant older than 14 days has no trial banner or limit; single-mode boot has no subscription routes and usage still accrues.
- [ ] 6.21 Plan change, cancel and reactivate: `POST /subscription/plan`, `/cancel` (to `cancelling`, service until `paid_through`, then `cancelled`) and `/reactivate`; reaching `cancelled` publishes `TenantCancelled`; a trial that ends unpaid follows the same grace and read-only path. [SUB-16] Test: cancel at period end, reactivate while cancelling, trial ends without payment.

## S6.05 Usage and statements (~400) [Track A]

Start: S6.04, S3.05 (usage events). Done when: a statement is generated, published and collected only after the 3 day window, at an amount the owner has seen. Verify: default plus `statement.test.ts`. Rollback: default.

- [ ] 6.22 Job `usage.snapshot` (daily): writes `usage_record(active_professional_day)` from the task 6.7 definition and aggregates WhatsApp usage per professional and period from `whatsapp_usage_event`; a professional deactivated mid-period follows the proration rule. [SUB-01, SUB-09] Test: day counts under a fake clock; deactivation mid-period.
- [ ] 6.23 `domain/statement.ts` and job `statement.generate` at period close: professionals counted, unit price, prorations, overage units and total; published in the app and emailed to the owner (no patient data); collection scheduled at least 3 days after `published_at`; invariant that nothing is collected without a published statement. [SUB-08] Test: statement content scenario; property test of the invariant.
- [ ] 6.24 Amount change: the preapproval is updated to the statement total; when the gateway answers `amount_change_refused` the delta is collected as a one-off payment link and the owner is emailed; if the provider needs a fresh authorization the owner is asked before collection; the collected amount never exceeds the statement total (resolves Q2 with the local refusal mode). [SUB-08, SUB-15] Test: both paths against the local simulator.
- [ ] 6.25 `GET /subscription/usage` (per professional and total: usage, quota, remaining, projected overage cost, counts only) and the 80% and 100% owner notices once per professional and period. [SUB-10, SUB-09] Test: privacy (no message text or patient name); threshold fires once.

## S6.06 Quota and overage cap (~300) [Track A]

Start: S6.05. Done when: WhatsApp sending respects quota, cap and the plan, falling back to email. Verify: default plus `quota-policy.test.ts`. Rollback: default (the Stage 3 default policy returns).

- [ ] 6.26 Real `QuotaPolicy` replacing the counting-only default of task 3.28: quota per active professional from the plan, overage allowed while the cap is above zero and not reached, otherwise the message falls back to email and the owner is told once; a message the provider rejected is never counted; unused quota does not carry over. [SUB-09, SUB-11, NTF-08] Test: overage enabled, disabled and cap reached scenarios; email never consumes quota.
- [ ] 6.27 `PATCH /subscription/overage-cap`: between 0 and the plan maximum, never unlimited, audited `subscription.cap_changed`; overage lines appear on the statement of the period they occurred in and trace back to counted event ids without message content. [SUB-11, SUB-08] Test: unlimited and above-maximum values refused; statement line traces to events.
- [ ] 6.28 Single-tenant metering: the same usage events feed `GET /operator/usage?tenantId=` (counts per professional and period) for contract invoicing while billing is disabled. [SUB-18, NTF-08] Test: single-mode usage report with billing off.

## S6.07 Subscription and signup UI (~450) [Tracks A and B]

Start: S6.04, S6.02. Done when: a visitor signs up, subscribes and uses the product at 360 px, and an owner manages the subscription. Verify: default plus `e2e/stage6-signup.spec.ts`. Rollback: default. May run to about 450 lines.

- [ ] 6.29 `features/onboarding/signup/*`: signup page (organization, owner name, email, password hints, two terms checkboxes, bot challenge widget), generic "check your email" screen, verification landing into the wizard, payment step that can be deferred when the provider is down, trial end date and its consequences; `locales/es-AR/signup.json`. [ONB-09, ONB-10, ONB-12, ONB-13] Test: component tests plus axe.
- [ ] 6.30 `features/subscription/*` (owner only): plan, state with dates and next transition, next charge, usage per professional with thresholds, statements list and download, overage cap control, cancel and reactivate, retry payment; a demo tenant shows an "account without billing" state; non-owner read-only banner without billing details; `locales/es-AR/subscription.json`. [SUB-03, SUB-08, SUB-10, SUB-11, SUB-17, SUB-19] Test: component tests per state and role.
- [ ] 6.31 Plan-impact dialog in staff invitation and activation (price change, proration, confirm; limit reached with upgrade path) and `features/operator/subscriptions/*` (state, usage counts, surplus flags, support view with no clinical data). [SUB-01, SUB-02, SUB-17] Test: component tests; professional cannot open billing.
- [ ] 6.32 `e2e/stage6-signup.spec.ts` at 360 px: sign up, verify from Mailpit, wizard, approve in the local checkout, tenant active the same day; professional denied on billing; reception write refused in a read-only tenant shows the reason. [ONB-09, ONB-10, SUB-05, SUB-17] Test: that spec.

## S6.08 Cancellation and split export (~450) [Track C]

Start: S6.00 and every module's contributor from Stages 1 to 5. Done when: a cancelled tenant yields an administrative package for the owner and one clinical package per professional. Verify: default plus `cancellation-export.test.ts`. Rollback: default. May run to about 450 lines.

- [ ] 6.33 `modules/tenancy/cancellation/build-export.ts` on job `export.build`: the administrative part (organization, staff, patient demographics and coverage, schedule and attendance, billing, invoices, audit metadata) as a PDF plus structured JSON in a zip, from every `administrative` contributor, with no clinical content; the clinical part per professional (entries, addenda, anamnesis, clinical documents, prescriptions, consents of their care-relationship patients; a patient seen by several appears in each package) from every `clinical` contributor. [TEN-08] Test: package structure golden test; organization 1 export holds no organization 2 data.
- [ ] 6.34 Delivery: the owner downloads the administrative package, each professional downloads their own clinical package from their account during the post-cancellation window (`export_package` table, migration `0650_export_package.sql`, session-bound links), an owner who is not a professional gets nothing clinical; patients whose professional is gone are routed to the archive custody of S6.09; works in `cancelling`, `read_only` and `cancelled` (category 4); every event audited. [TEN-08, TEN-11] Test: scenarios — owner not a professional, solo professional, no professional remains.
- [ ] 6.35 Completeness: `export-registry.test.ts` extended so every module owning data of the right kind has a contributor (billing, invoicing, notifications message metadata, waitlist, consent, prescriptions, portal identities, onboarding, subscriptions statements), and a contributor cannot emit a clinical key in an administrative part. [TEN-08] Test: that file.
- [ ] 6.36 `POST /operator/tenants/:id/cancel` (operator action for single-tenant deployments and local testing, publishes `TenantCancelled`, platform audit), `features/export/*` (owner export page, professional clinical export page) and a Playwright check of both downloads. [TEN-08, TEN-07] Test: component tests; that spec.

## S6.09 Retention archive (~400) [Track C]

Start: S6.08. Done when: cancelled-tenant records sit in an encrypted, write-once store that no routine role can alter, and integrity is verified by a test restore. Verify: default plus `archive-immutability.test.ts` (slow tag, needs the compose MinIO). Rollback: default (the archive job is off until enabled).

- [ ] 6.37 `ArchiveStore` port with `adapters/archive-local/` (a MinIO bucket `consultorio-archive` created with Object Lock in governance mode and a default retention of `ARCHIVE_RETENTION_DAYS`, default 3650; the `legal-erasure` MinIO user is the only one with bypass-governance rights) and `adapters/archive-fake/` (in memory); `infra/docker-compose.yml` creates the bucket and adds a `releaser` service; shared suite `adapters/archive-store.contract.ts`. [TEN-09] Test: contract suite; overwrite and delete of a locked object refused for the writer.
- [ ] 6.38 Per-tenant archive keys in `modules/tenancy/archive/keys.ts` (migration `0652_archive_key.sql`): an RSA-OAEP key pair per tenant, the public key encrypts a fresh data key per object (so the API and worker can write but not read), the private key is wrapped by `ARCHIVE_RELEASER_KEK` that only the `releaser` process role receives; objects carry a SHA-256 manifest. [TEN-09, TEN-08] Test: writer role cannot decrypt; private key unusable without the releaser KEK; tamper detected by the manifest.
- [ ] 6.39 Jobs `archive.write` (after the export window, configurable `ARCHIVE_AFTER_DAYS`) and `archive.verify` (checksums plus a test restore into a scratch location, decrypted in the releaser test harness); the tenant gets `archived_at`; no code path removes hot rows (the exception list is exhaustive). [TEN-09, TEN-10] Test: verify detects a corrupted object; hot rows remain; the `no-delete` scan still lists only the four exceptions.
- [ ] 6.40 Immutability and audit: any attempt by a tenant role, the routine operator role or the writer to modify or delete an archived object is refused; a purge inside the retention period is refused; every access is audited at platform level; legal erasure only through `pnpm archive:legal-erase --reference <text>` using the privileged credential and recording the legal reference. [TEN-09] Test: scenarios — archive read-only, archive access audited, retained for the full period, legal erasure succeeds only for the privileged role.

## S6.10 Break-glass release (~350) [Track C]

Start: S6.09. Done when: a verified requester receives their records through a single-use link while the operator never sees content. Verify: default plus `archive-release.test.ts`. Rollback: default.

- [ ] 6.41 `db/schema/archive-release.ts` + migration `0654_archive_release.sql` (platform table `archive_release_request`: requester kind patient or verified professional, scope, identity-verification checklist, status, approved by) and operator routes `POST|GET /operator/archive-releases` (record, verify identity out of band, approve) with a `features/operator/archive/*` screen; enable the `archive_release` token kind. [TEN-08, TEN-07] Test: operator can approve but no operator route returns content; requester kinds limited to patient and verified professional.
- [ ] 6.42 Job `archive.release` running only in the `releaser` role (the one principal holding the archive private-key KEK): decrypts the approved scope, builds the package, stores it with a 72 hour single-use `archive_release` link sent to the requester's verified email, and notifies the former tenant contact; every step in the platform audit. [TEN-08] Test: integration — operator credentials and the API role cannot decrypt (negative test); link expires and cannot be reused; wrong scope refused.
- [ ] 6.43 Release end-to-end and docs: `e2e/stage6-archive.spec.ts` (cancel a tenant, export, archive, request release as the operator, download once) and `docs/runbooks/archive-release.md`. [TEN-08, TEN-09] Test: that spec.

## S6.11 Production readiness, local (~300) [Track D]

Start: tracks A and C merged. Done when: the restore drill, metrics and runbooks exist and run without a cloud account. Verify: default plus `pnpm drill:restore`. Rollback: default.

- [ ] 6.44 `scripts/restore-drill.ts` (`pnpm drill:restore`): dumps the compose Postgres to MinIO, restores into a scratch database, re-runs the audit chain verification and row-count checks, prints a report; `docs/runbooks/backup-restore.md` (from task 2.99) gains the local drill evidence. [AUD-04, AUD-05] Test: the drill passes on the demo data; a tampered dump fails the chain check.
- [ ] 6.45 Observability: `/metrics` (Prometheus text) from `platform/metrics.ts` with queue depth, reminder failure rate, pending invoices past the outage threshold, scan backlog, unsealed audit lag, audit chain breaks and dunning step counts; alert rules as code in `infra/alerts/rules.yml` validated in CI; an optional compose profile `observability` (Prometheus, Grafana). [AUD-04, INV-09, NTF-06] Test: metrics endpoint test; rule-file validation job.
- [ ] 6.46 Runbooks and checklist: `docs/runbooks/{incident,afip-outage,provider-switch,tenant-cancellation}.md` and `docs/go-live-checklist.md`, which lists every deferred real-provider task (3.80 to 3.83, 4.68, 4.69, 5.53, 5.54, 6.50 to 6.52) with the credential or contract it needs, and the owner-held legal items (hosting review Q1, erasure Q7) as owner actions, not tasks. [SUB-15] Test: a docs test fails when a deferred task id is missing from the checklist.

## S6.12 Demo data and Stage 6 gate (~300) [Track D]

Start: S6.07, S6.10, S6.11. Done when: the Stage 6 demo runs locally end to end and the final review is closed. Verify: the e2e spec plus the review. Rollback: default.

- [ ] 6.47 `db/seed/demo/stage6/*` and `pnpm demo:platform` (refused in production): the demo tenant shows the exempt state, and four fictional non-demo tenants in dev databases cover trial, active, past_due and read_only for the operator views. [DEM-04, SUB-04] Test: gap check; guard refuses production.
- [ ] 6.48 `e2e/stage6-demo.spec.ts`: sign up, pay in the local checkout and use the product the same day; second run rejects a renewal and walks dunning, read-only, payment and recovery. [ONB-09, SUB-05, SUB-12, SUB-13, SUB-14] Test: that spec.
- [ ] 6.49 Final fresh-context security review (`judgment-day`) of webhooks, retention and archive keys, export scoping and signup abuse; `docs/security/asvs-l2-final.md`; update the traceability section; re-run `sdd-init`. Test: review report attached.

## S6.D Deferred real-provider adapters (no gate depends on them)

Start: the owner has the Mercado Pago, AWS and observability accounts. Done when: each adapter passes the contract suite of its port (`payments-gateway.contract.ts`, `archive-store.contract.ts`) and is selected by its `*_PROVIDER` variable. Verify: contract suites plus recorded fixtures; the Q2 amount-change spike runs against the real sandbox and is written up. Rollback: set the variable back to `local`; state already written (subscriptions, archived objects) is untouched.

- [ ] 6.50 deferred: needs owner credentials/contract (Mercado Pago account and credentials). `adapters/mercadopago/` real gateway plus the amount-change spike of Q2 recorded in `docs/spikes/mp-amount-change.md`. [SUB-05, SUB-06, SUB-08] Test: `payments-gateway.contract.ts` plus recorded webhook fixtures.
- [ ] 6.51 deferred: needs owner credentials/contract (AWS account, KMS CMK and IAM roles). `adapters/archive-s3/` with S3 Object Lock governance mode, a dedicated CMK per environment and the `legal-erasure` IAM role. [TEN-09] Test: `archive-store.contract.ts` plus a mocked client.
- [ ] 6.52 deferred: needs owner credentials/contract (Sentry and cloud log accounts). Real exporters for errors and traces behind the observability port. [AUD-04] Test: configuration test with exporters disabled by default.

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

# Traceability: Stage 3 to 6 capabilities

This section resolves the closing note of the Stage 0 to 2 traceability ("Stage 3 to 6 capabilities are traced when their stages are refined"). Every requirement of the 12 capabilities of Stages 3 to 6 maps to at least one task. Task ids are those of the Stage 3 to 6 sections; `deferred` tasks (3.80 to 3.83, 4.68, 4.69, 5.53, 5.54, 6.50 to 6.52) are listed only where they are the real-provider counterpart of a local task.

### Requirements that Stages 0 to 2 only prepared, completed here

| Requirement | Completed by |
|---|---|
| PAT-03 Identity review of matched bookings (online producer) | 3.43 (S3.09) |
| PAT-12 Minors and representatives (portal link review) | 5.36 (S5.09) |
| CTR-09 Legal adapters declared (implementations) | 4.2, 4.39 to 4.41 (S4.09, local AFIP), 5.1, 5.18 (S5.04, local e-Rx); real adapters deferred 4.68, 5.53 |
| IDA-06 Patient email one-time-code sign-in | 5.27 to 5.29 (S5.07), identity in 5.24, 5.25 (S5.06) |
| AUZ-14 Patient access limited to own data | 5.3, 5.31, 5.33 (S5.08) |
| STF-04 Matricula validation state (operator verification) | 5.5 to 5.7 (S5.01) |
| TEN-07 Operator has no default clinical access (matricula, archive release) | 5.5, 6.36, 6.41 |
| TEN-08 Tenant cancellation export | contributors 3.6, 4.4, 4.26, 5.3; package 6.33 to 6.36 (S6.08), release 6.41 to 6.43 |
| TEN-09 Retention archive after cancellation | 6.37 to 6.40 (S6.09), 6.43; real adapter deferred 6.51 |
| TEN-10 Retention exceptions (new exceptions 2 and 4 used) | 3.42 (`booking.purge`), 6.12 (`signup.purge`), 6.39 |
| TEN-11 Read-only allowlist (new categories) | 3.4, 3.21, 3.23, 4.27, 4.50, 4.60, 5.14, 5.37, 6.15, 6.19 |
| DOC-07 Documents export | 6.33, 6.35 (contributors registered in Stage 2) |
| DEM-03 Demo tenants use only fake adapters (new ports) | 3.1, 3.2, 3.10, 3.71, 4.2, 4.41, 4.42, 4.63, 5.1, 5.47, 5.48, 6.1 |
| DEM-04 Realistic coverage across modules | 3.71, 3.72, 4.63, 5.47, 6.47 |
| DEM-05 Reset under one minute | 3.73, 4.64, 5.49 |
| DEM-07 Demo resets and the retention rule | 3.73 |

### notifications (NTF)

| Req | Name | Tasks |
|---|---|---|
| NTF-01 | Channels and purposes | 3.12, 3.22, 3.81 (deferred) |
| NTF-02 | Automatic reminders | 3.5, 3.14 to 3.18, 3.30, 3.33, 3.69, 3.77 |
| NTF-03 | Confirmation by the patient | 3.19 to 3.21, 3.25, 3.33, 3.44, 3.76, 3.77 |
| NTF-04 | Opt-out and consent | 3.12, 3.17, 3.20, 3.25 to 3.27, 3.32, 3.33, 3.43 |
| NTF-05 | Message content and privacy | 3.13, 3.30 |
| NTF-06 | Delivery tracking, retries and fallback | 3.11, 3.12, 3.14, 3.22, 3.31, 3.80 (deferred) |
| NTF-07 | Provider webhooks and inbound messages | 3.23, 3.24, 3.33, 3.74, 3.81 (deferred) |
| NTF-08 | Quotas, usage and integration switches | 3.8, 3.28 to 3.30, 6.26, 6.28 |
| NTF-09 | Demo and read-only tenants | 3.2, 3.14 |
| NTF-10 | Audit and access to notification data | 3.3, 3.11, 3.26, 3.29, 3.31 |

### online-booking (OBK)

| Req | Name | Tasks |
|---|---|---|
| OBK-01 | Public booking links | 3.34 to 3.36, 3.47, 3.50 |
| OBK-02 | Availability and booking constraints | 3.8, 3.34, 3.36, 3.47 |
| OBK-03 | Slot hold | 3.37, 3.48, 3.50 |
| OBK-04 | Booking completion and patient identification | 3.39, 3.40, 3.43, 3.45, 3.48, 3.50, 3.75, 3.77 |
| OBK-05 | Abuse protection | 3.37, 3.38, 3.40, 3.41, 3.48, 3.74 to 3.76, 3.83 (deferred) |
| OBK-06 | Waitlist self-join | 3.49, 3.56, 3.57, 3.61 |
| OBK-07 | Self-service change and cancellation | 3.44, 3.47, 3.49 |
| OBK-08 | Privacy and data minimization | 3.3, 3.39, 3.42, 3.46 |
| OBK-09 | Read-only tenant | 3.36, 3.46 |

### waitlist (WTL)

| Req | Name | Tasks |
|---|---|---|
| WTL-01 | Joining the waitlist | 3.8, 3.51, 3.52, 3.57, 3.59 |
| WTL-02 | Matching freed slots | 3.5, 3.53, 3.54, 3.60 |
| WTL-03 | Offers with expiry | 3.55, 3.56, 3.60, 3.61, 3.77 |
| WTL-04 | Opt-out and consent in offers | 3.53, 3.55, 3.58 |
| WTL-05 | Managing and closing entries | 3.52, 3.59 |
| WTL-06 | Fairness, audit and metrics | 3.3, 3.51, 3.58, 4.29 (recovered slots) |

### teleconsultation (TLC)

| Req | Name | Tasks |
|---|---|---|
| TLC-01 | Virtual appointment mode | 3.62, 3.63, 3.67, 3.68, 3.82 (deferred) |
| TLC-02 | Link access and validity | 3.8, 3.64, 3.65, 3.69, 3.70 |
| TLC-03 | Link lifecycle on reschedule and cancellation | 3.5, 3.63 |
| TLC-04 | Provider failure and manual fallback | 3.62, 3.63, 3.65, 3.68, 3.69 |
| TLC-05 | Privacy and consent in teleconsultation | 3.3, 3.64 to 3.67, 3.70, 3.82 (deferred) |
| TLC-06 | Virtual appointment attendance | 3.62, 3.66 |

### billing-payments (BIL)

| Req | Name | Tasks |
|---|---|---|
| BIL-01 | Price catalog per organization | 4.7 to 4.10 |
| BIL-02 | Payer and plan catalog with coverage pricing | 4.7 to 4.9 |
| BIL-03 | Price snapshot on charges | 4.8, 4.11, 4.12 |
| BIL-04 | Charge capture per appointment | 4.11 to 4.13, 4.20, 4.23 |
| BIL-05 | Charge lifecycle and voiding | 4.11, 4.14, 4.20, 4.45 |
| BIL-06 | Payment recording | 4.16, 4.17, 4.21, 4.23, 4.61 |
| BIL-07 | Duplicate payment protection | 4.17, 4.21 |
| BIL-08 | Refunds and payment reversals | 4.16, 4.18, 4.61 |
| BIL-09 | Daily cash register per location | 4.16, 4.17, 4.19, 4.22, 4.23, 4.65 |
| BIL-10 | Closed register immutability | 4.16, 4.18, 4.22 |
| BIL-11 | Exports | 4.5, 4.24 to 4.26 |
| BIL-12 | Billing access control | 4.3, 4.9, 4.14, 4.15, 4.23 |
| BIL-13 | Tenant isolation and multi-specialty support | 4.15 |
| BIL-14 | Read-only tenant behavior | 4.27, 4.60 |
| BIL-15 | Audit and privacy of financial data | 4.3, 4.9, 4.15, 4.19, 4.62 |
| BIL-16 | Argentine currency and presentation | 4.1, 4.6, 4.20, 4.23 |

### reports-dashboard (RPT)

| Req | Name | Tasks |
|---|---|---|
| RPT-01 | Operational reports | 4.29, 4.31 |
| RPT-02 | Financial reports | 4.57, 4.59 |
| RPT-03 | Cash register report | 4.58, 4.59 |
| RPT-04 | Filters and period selection | 4.28, 4.32 |
| RPT-05 | Consistency with source records | 4.30 |
| RPT-06 | Role-scoped visibility | 4.28, 4.34, 4.59 |
| RPT-07 | No clinical content in reports | 4.30 |
| RPT-08 | Charts with accessible table alternative | 4.32, 4.34 |
| RPT-09 | Empty, loading and error states | 4.32 |
| RPT-10 | Report export | 4.24, 4.33, 4.59 |
| RPT-11 | Tenant isolation and audit | 4.3, 4.30 |
| RPT-12 | Read-only tenant and language | 4.33, 4.60 |

### e-invoicing-afip (INV)

| Req | Name | Tasks |
|---|---|---|
| INV-01 | Fiscal configuration per organization | 4.35, 4.36, 4.51, 4.54 |
| INV-02 | Fiscal credentials lifecycle | 4.35, 4.37, 4.49, 4.54 |
| INV-03 | Invoice type selection | 4.39, 4.55 |
| INV-04 | Recipient identification | 4.39, 4.44, 4.55 |
| INV-05 | Issuing an invoice with CAE | 4.40, 4.41, 4.43, 4.44, 4.47, 4.48, 4.55, 4.56, 4.61, 4.65, 4.68 (deferred), 4.69 (deferred) |
| INV-06 | Invoice immutability | 4.43, 4.46 |
| INV-07 | Credit notes | 4.45, 4.56, 4.61 |
| INV-08 | Voided and rejected invoices | 4.43, 4.46 |
| INV-09 | AFIP outage handling and no duplicate issuance | 4.40 to 4.42, 4.47, 4.48, 4.55, 4.56, 4.65, 4.68 (deferred) |
| INV-10 | Manual invoice entry fallback | 4.49, 4.55 |
| INV-11 | Invoice document and delivery | 4.5, 4.51 to 4.53, 5.33 |
| INV-12 | Access control and audit | 4.3, 4.38, 4.53, 4.56, 4.62 |
| INV-13 | Read-only tenant and feature control | 4.38, 4.50, 4.60 |
| INV-14 | Language | 4.51, 4.54 |

### informed-consent (CNS)

| Req | Name | Tasks |
|---|---|---|
| CNS-01 | Consent template authoring | 5.8, 5.9, 5.43, 5.46 |
| CNS-02 | Template versioning | 5.8, 5.9, 5.11, 5.43 |
| CNS-03 | Requesting a consent | 5.12, 5.13, 5.15, 5.38, 5.44 |
| CNS-04 | Signature capture and binding | 5.11 to 5.13, 5.44, 5.46, 5.50 |
| CNS-05 | Minors, incapacitated patients and representatives | 5.13, 5.36, 5.44 |
| CNS-06 | Immutability of signed consents | 5.12 |
| CNS-07 | Revocation | 5.12, 5.14, 5.45, 5.46 |
| CNS-08 | Visibility and access control | 5.10, 5.45, 5.46 |
| CNS-09 | Audit and tenant isolation | 5.2, 5.15 |
| CNS-10 | Read-only tenant, export and language | 5.14, 5.15, 5.46 |

### e-prescription (ERX)

| Req | Name | Tasks |
|---|---|---|
| ERX-01 | Prescriber eligibility | 5.6, 5.17, 5.23, 5.50 |
| ERX-02 | Authorized provider connection | 5.1, 5.16, 5.17, 5.22, 5.53 (deferred), 5.54 (deferred) |
| ERX-03 | Prescription content | 5.17, 5.21 |
| ERX-04 | Issuing and status lifecycle | 5.18, 5.19, 5.22, 5.53 (deferred) |
| ERX-05 | Immutability and cancellation | 5.16, 5.19, 5.22 |
| ERX-06 | Provider outage handling | 5.17 to 5.19, 5.22, 5.23 |
| ERX-07 | Clinical access rules | 5.16, 5.20, 5.21, 5.23 |
| ERX-08 | Patient access and delivery | 5.33, 5.35, 5.38 |
| ERX-09 | Audit, retention and tenant isolation | 5.2, 5.20 |
| ERX-10 | Read-only tenant and language | 5.20 |

### patient-portal (POR)

| Req | Name | Tasks |
|---|---|---|
| POR-01 | Portal identity | 5.24, 5.25 |
| POR-02 | Portal account activation and identity linking | 5.25, 5.27, 5.39, 5.42 |
| POR-03 | Patient authentication | 5.26, 5.28, 5.30, 5.39, 5.41 |
| POR-04 | Own-data-only access | 5.31 |
| POR-05 | Denial for non-patients | 5.3, 5.29, 5.42 |
| POR-06 | Legal representatives and dependents | 5.25, 5.36, 5.39 |
| POR-07 | Appointments in the portal | 5.32, 5.40 |
| POR-08 | Documents shared with the patient | 5.32, 5.35, 5.40, 5.42, 5.50 |
| POR-09 | Consents, prescriptions and invoices | 5.33, 5.35, 5.40, 5.42, 5.50 |
| POR-10 | Personal data access and rectification | 5.33, 5.34, 5.41 |
| POR-11 | Privacy of portal messages | 5.38 |
| POR-12 | Tenant isolation across organizations | 5.24, 5.29, 5.37 |
| POR-13 | Audit | 5.2, 5.25, 5.26, 5.28, 5.30, 5.35 |
| POR-14 | Portal deactivation and read-only tenant | 5.26, 5.37 |
| POR-15 | Mobile experience and language | 5.4, 5.39, 5.40 |

### tenant-onboarding Part B (ONB-09 to ONB-15)

| Req | Name | Tasks |
|---|---|---|
| ONB-09 | Self-service signup | 6.9, 6.10, 6.29, 6.32, 6.48 |
| ONB-10 | Email verification before activation | 6.9, 6.11, 6.29, 6.32 |
| ONB-11 | Signup abuse protection | 6.10 |
| ONB-12 | Trial and payment on signup | 6.11, 6.29 |
| ONB-13 | Provider outage and abandoned signups | 6.10, 6.12, 6.29 |
| ONB-14 | Privacy and legal acceptance | 6.9, 6.10 |
| ONB-15 | Signup audit | 6.2, 6.11 |

### subscriptions (SUB)

| Req | Name | Tasks |
|---|---|---|
| SUB-01 | Per-active-professional pricing | 6.7, 6.8, 6.22, 6.31 |
| SUB-02 | Plan catalog and limits | 6.5, 6.7, 6.8, 6.31 |
| SUB-03 | Tenant billing states | 6.5, 6.6, 6.18, 6.30 |
| SUB-04 | Exempt tenants | 6.5, 6.20, 6.47 |
| SUB-05 | Mercado Pago subscription | 6.1, 6.13, 6.14, 6.32, 6.48, 6.50 (deferred) |
| SUB-06 | Webhook handling | 6.1, 6.13, 6.15, 6.50 (deferred) |
| SUB-07 | Duplicate payment protection and refunds | 6.16 |
| SUB-08 | Billing cycle and statements | 6.23, 6.24, 6.27, 6.30, 6.50 (deferred) |
| SUB-09 | WhatsApp quota per active professional | 3.28, 6.22, 6.25, 6.26 |
| SUB-10 | Usage visibility and thresholds | 6.25, 6.30 |
| SUB-11 | Overage billing and cap | 6.26, 6.27, 6.30 |
| SUB-12 | Failed payment and dunning | 6.18, 6.48 |
| SUB-13 | Read-only transition and clinical access guarantee | 6.19, 6.48 |
| SUB-14 | Recovery from read-only | 6.19, 6.48 |
| SUB-15 | Mercado Pago outage handling | 6.13, 6.17, 6.24, 6.46 |
| SUB-16 | Trial, plan changes and cancellation | 6.21 |
| SUB-17 | Access control, isolation and audit | 6.2, 6.4, 6.8, 6.30 to 6.32 |
| SUB-18 | Single-tenant deployments | 6.3, 6.20, 6.28 |
| SUB-19 | Language and communication | 6.18, 6.30 |

Coverage result: 134 requirements across the 12 capabilities of Stages 3 to 6 (NTF 10, OBK 9, WTL 6, TLC 6, BIL 16, RPT 12, INV 14, CNS 10, ERX 10, POR 15, ONB Part B 7, SUB 19), plus the 16 earlier requirements completed or extended above. All map to at least one task. No requirement depends on a deferred task for its local behavior; the deferred tasks add the real provider behind the same contract suite.

---

# Review Workload Forecast (final)

| Stage | PR slices | Est. changed lines | Notes |
|---|---|---|---|
| 0 | 10 | ~2,500 | Plus S0.01 mechanical deletions and S0.02 docs (`size:exception`). Lockfile generated. |
| 1 | 38 | ~13,500 | 1 slice is no-code. About 20 backend slices carry RLS or migrations. |
| 2 | 34 | ~12,000 | Plus S2.34 legacy removal (`size:exception`, mechanical). |
| 3 | 20 | ~7,400 | Detailed. 83 tasks (3.1 to 3.83), of which 4 deferred. Two seam slices first. |
| 4 | 18 | ~7,050 | Detailed. 69 tasks (4.1 to 4.69), of which 2 deferred. One seam slice first. |
| 5 | 14 | ~5,150 | Detailed. 54 tasks (5.1 to 5.54), of which 2 deferred. One seam slice first. |
| 6 | 13 | ~4,950 | Detailed. 52 tasks (6.1 to 6.52), of which 3 deferred. One seam slice first. |
| **Total** | **147** | **~52,500** (range 38,000 to 75,000) | Stage 0 to 2 figures as of this edit; deferred real adapters (about 2,200 lines) are not included. |

Stages 3 to 6, slices expected above 400 lines (their headings say so): S3.00, S4.00, S4.04, S4.08 to S4.11, S4.13, S5.04, S5.10, S6.03, S6.07, S6.08, each up to about 450. Seam slices only add registrations and unused ports, so any of them can split into an API half and a web half without leaving a half-working state (S3.00 and S3.00b are already split that way).

Delivery for Stages 3 to 6 (parallel tracks): each track is its own branch stack, with slices stacked in the order listed; tracks merge to the base branch as their stated dependencies allow. After every rebase onto a branch that added a migration, run `pnpm db:restamp` (task 3.7); the drift check fails otherwise. The seam slice of each stage merges first and alone. A deferred slice (S3.D, S4.D, S5.D, S6.D) is never a dependency, and `docs/go-live-checklist.md` (task 6.46) lists every one with the credential or contract it needs.

Estimates assume slices of about 400 lines. Risk of a slice exceeding 400: highest in UI slices (S1.31 to S1.34, S2.13, S2.14, S2.22) and in S4.10. Mitigation: split on the natural seam recorded in the slice, never by file type.

Chained PRs recommended: Yes
400-line budget risk: High
Decision needed before apply: Yes
Chain strategy: pending

Questions that need an answer before the first apply batch: chain strategy; `size:exception` for S0.01, S0.02 and S2.34; whether `.atl/` is versioned.
