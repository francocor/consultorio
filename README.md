# Consultorio

Practice management for health professionals and small medical centers, built first for Argentina. It rests on a secure, multi-tenant foundation.

## What it is

- **Solo professionals and small centers** run their agenda, patients, clinical records, documents and billing in one place.
- **Multi-tenant by design**: every organization is isolated by database row level security, has its own branding and its own role views. A single-tenant deployment of the same build is also supported.
- **Health data first**: authentication with two factors, a permission catalog, an append-only audit trail and encryption of sensitive fields are part of the foundation, not an afterthought.
- **Mobile first**: a PWA that works at 360 px wide, in Spanish (es-AR) with the country rules of Argentina behind a country pack.

The product is delivered in seven demoable stages (0 to 6). The plan, specifications and design live in [`openspec/changes/health-practice-saas/`](openspec/changes/health-practice-saas/).

## Layout

| Path                 | Contents                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `apps/api`           | Fastify API and background worker (one modular monolith, two runtime roles)                    |
| `apps/web`           | React 19 + Vite + Tailwind 4 PWA (staff app, patient portal, public booking)                   |
| `packages/contracts` | Zod schemas, DTOs, permission catalog and error codes shared by api and web                    |
| `packages/config`    | Shared TypeScript, ESLint and Prettier presets                                                 |
| `infra`              | Dockerfile, docker compose for local services, database role bootstrap                         |
| `docs`               | [Development setup](docs/dev-setup.md), [external dependencies](docs/external-dependencies.md) |
| `openspec`           | Spec-driven planning artifacts: proposal, specs, design and tasks                              |

## Legacy reference app

This product replaces an earlier single-clinic app built for Centro Medico Aillu. That legacy app is not part of this repository; it is kept privately as reference material (domain knowledge and UI design).

## Getting started

```bash
corepack enable
pnpm install
cp .env.example .env
docker compose -f infra/docker-compose.yml up -d
pnpm --filter @consultorio/api db:migrate
pnpm dev
```

Full instructions, local service URLs and troubleshooting: [docs/dev-setup.md](docs/dev-setup.md).

## Quality gates

`pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm test:integration` and `pnpm test:e2e` run in CI on every pull request, together with an image build, a dependency audit and a secret scan (gitleaks). A pre-commit hook scans staged changes for secrets, so install [gitleaks](https://github.com/gitleaks/gitleaks#installing) before your first commit.

The CI secret scan uses `gitleaks/gitleaks-action`, which is free for personal GitHub accounts but requires a license key when the repository belongs to a GitHub organization. In that case add the key as the repository secret `GITLEAKS_LICENSE` (the workflow already passes it).

## Stack

TypeScript everywhere. Node 24, Fastify, PostgreSQL 17 with Drizzle ORM and pg-boss, React 19, Vite, Tailwind CSS 4, Vitest, Testcontainers and Playwright, in a pnpm monorepo.
