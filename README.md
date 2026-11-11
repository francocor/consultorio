# Consulvia

Consulvia is practice management software for health professionals and small medical centers, built first for Argentina. It rests on a secure, multi-tenant foundation.

## Product and organizations

Consulvia is the product. An organization is a practice or medical center that uses it: each one has its own name, logo and colors, and the product shows those instead of its own wherever a patient or a staff member signs in. The demo organizations ("Centro Médico Aillu", "Clínica Norte") are examples of that, not product names.

## What it is

- **Solo professionals and small centers** run their agenda, patients, clinical records, documents and billing in one place.
- **Multi-tenant by design**: every organization is isolated by database row level security, has its own branding and its own role views. A single-tenant deployment of the same build is also supported.
- **Health data first**: authentication with two factors, a permission catalog, an append-only audit trail and encryption of sensitive fields are part of the foundation, not an afterthought.
- **Mobile first**: a PWA that works at 360 px wide, in Spanish (es-AR) with the country rules of Argentina behind a country pack.

The product is delivered in seven demoable stages (0 to 6) plus a Windows desktop edition. The plan, specifications and design live in [`openspec/changes/health-practice-saas/`](openspec/changes/health-practice-saas/).

## Status

**Built and tested against local adapters: stages 0 to 6 and the Windows desktop edition.** Every row below is implemented, covered by unit and integration tests and by Playwright specs (`apps/web/e2e/stage*.spec.ts`), and runs in the [demo](docs/demo.md). What is _not_ done is connecting real outside providers: see [What is still needed to go live](#what-is-still-needed-to-go-live).

| Stage | Delivers                                                                                                                                                        | State |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 0     | Monorepo, toolchain, database foundation, Docker image, CI (typecheck, lint, tests, audit, secret scan)                                                         | Done  |
| 1     | Secure core: tenants with row level security, sign-in with two factors, permissions, append-only audit, encryption, staff, patients, branding, operator console | Done  |
| 2     | Practice core: agenda and appointments, clinical records and odontogram, documents with scanning, guided first run for solo professionals and centers           | Done  |
| 3     | Patient engagement: online booking, reminders by email and WhatsApp, waitlist, video visits                                                                     | Done  |
| 4     | Revenue: prices and payers, charges, cash registers, electronic invoices (AFIP), reports                                                                        | Done  |
| 5     | Compliance and patient portal: matricula verification, consent, e-prescription, patient portal                                                                  | Done  |
| 6     | Growth: public signup, subscriptions and billing, archive of organizations that leave                                                                           | Done  |
| Desk  | Windows desktop edition: one clinic on one PC, embedded PostgreSQL, no Docker or internet needed ([`apps/desktop`](apps/desktop))                               | Done  |

**What "done" means here.** Email, WhatsApp, video, AFIP, e-prescription, payments and the archive store run on local or simulated adapters that pass the same contract suites the real ones must pass; production refuses them unless explicitly allowed. Nothing is sent to a patient, invoiced or charged for real until the owner connects the providers below.

## Where to look

| I want to...                         | Go to                                                                                         |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| See the product with demo data       | [docs/demo.md](docs/demo.md) (`pnpm demo:stack`, needs only Docker)                           |
| Read the user manual                 | [docs/manual/Consulvia-Manual-de-Usuario.pdf](docs/manual/Consulvia-Manual-de-Usuario.pdf)    |
| Build or install the Windows edition | [docs/desktop/BUILD.md](docs/desktop/BUILD.md), [INSTALACION.md](docs/desktop/INSTALACION.md) |
| Deploy to the cloud                  | [docs/runbooks/deploy.md](docs/runbooks/deploy.md)                                            |
| Know what blocks the first customer  | [docs/go-live-checklist.md](docs/go-live-checklist.md)                                        |

## What is still needed to go live

Only the owner can provide these. The code is ready to receive them: switching a provider is a configuration change ([provider-switch runbook](docs/runbooks/provider-switch.md)). The full list, with the setting and the proof for each item, is [docs/go-live-checklist.md](docs/go-live-checklist.md).

- [ ] **Cloud hosting**: account, region, managed Postgres, S3, KMS, ClamAV, SMTP and DNS ([deploy runbook](docs/runbooks/deploy.md)). There is no delivery workflow yet, because nothing could run it.
- [ ] **Electronic invoicing**: the AFIP (ARCA) production certificate and the accountant's validation ([switch to real AFIP](docs/runbooks/afip-switch-to-real.md)).
- [ ] **Windows installer**: a code-signing certificate. Until then the installer is unsigned and SmartScreen warns ([BUILD.md](docs/desktop/BUILD.md)).
- [ ] **Legal texts**: privacy policy and terms of service. The signup records the accepted version; the text is the owner's to write.
- [ ] **Legacy secrets**: rotate every credential that was in the legacy repository.
- [ ] **Other real providers**, when the product needs them: Mercado Pago, WhatsApp (Meta), Jitsi, Turnstile, an authorized e-prescription platform, Sentry.

## Layout

| Path                 | Contents                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `apps/api`           | Fastify API and background worker (one modular monolith, two runtime roles)                    |
| `apps/web`           | React 19 + Vite + Tailwind 4 PWA (staff app, patient portal, public booking)                   |
| `apps/desktop`       | Electron shell of the Windows edition (embedded PostgreSQL, API and worker on one PC)          |
| `packages/contracts` | Zod schemas, DTOs, permission catalog and error codes shared by api and web                    |
| `packages/config`    | Shared TypeScript, ESLint and Prettier presets                                                 |
| `infra`              | Dockerfile, docker compose for local services, database role bootstrap                         |
| `docs`               | [Development setup](docs/dev-setup.md), [demo](docs/demo.md), runbooks, manual, desktop guides |
| `openspec`           | Spec-driven planning artifacts: proposal, specs, design and tasks                              |

## Legacy reference app

This product replaces an earlier single-clinic app built for Centro Medico Aillu. That legacy app is not part of this repository; it is kept privately as reference material (domain knowledge and UI design).

## Getting started

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm infra:up                              # Postgres, MinIO and Mailpit, waits until healthy
pnpm --filter @consultorio/api db:migrate
pnpm dev                                   # API and web app
pnpm --filter @consultorio/api dev:worker  # background jobs, in a second terminal
```

Want to look around first? `pnpm demo:stack` starts a throwaway stack with demo data and needs only Docker ([docs/demo.md](docs/demo.md)).

Full instructions, local service URLs and troubleshooting: [docs/dev-setup.md](docs/dev-setup.md).

## Quality gates

`pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm test:integration` and `pnpm test:e2e` run in CI on every pull request, together with an image build, a dependency audit and a secret scan (gitleaks). A pre-commit hook scans staged changes for secrets, so install [gitleaks](https://github.com/gitleaks/gitleaks#installing) before your first commit.

The CI secret scan uses `gitleaks/gitleaks-action`, which is free for personal GitHub accounts but requires a license key when the repository belongs to a GitHub organization. In that case add the key as the repository secret `GITLEAKS_LICENSE` (the workflow already passes it).

## Stack

TypeScript everywhere. Node 24, Fastify, PostgreSQL 17 with Drizzle ORM and pg-boss, React 19, Vite, Tailwind CSS 4, Vitest, Testcontainers and Playwright, in a pnpm monorepo.
