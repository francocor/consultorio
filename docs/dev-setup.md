# Development setup

How to run the new stack (`apps/`, `packages/`, `infra/`) on your machine. The legacy reference app is not part of this repository or this setup.

## Prerequisites

| Tool            | Version                  | Notes                                                                               |
| --------------- | ------------------------ | ----------------------------------------------------------------------------------- |
| Node.js         | 24 or newer              | `.nvmrc` pins 24. `engine-strict` makes installs fail on older versions.            |
| pnpm            | 10.34.7                  | Provided by Corepack from the `packageManager` field: `corepack enable`.            |
| Docker          | Desktop or Engine, 4 GB+ | Runs Postgres, MinIO, Mailpit and the integration tests (Testcontainers).           |
| Playwright      | installed by pnpm        | One-time browser download: `pnpm --filter @consultorio/web exec playwright install` |
| Git, a terminal | any recent               |                                                                                     |

## First run

```bash
corepack enable
pnpm install

cp .env.example .env            # safe local placeholders, never commit .env
pnpm infra:up                   # starts the services, waits until healthy, then creates the bucket

# create the schema (runs as app_owner)
pnpm --filter @consultorio/api db:migrate
```

`db:migrate` applies the SQL migrations and then installs (or upgrades) the pg-boss job tables and queues, both as `app_owner`. Run it again after every `git pull` that adds a migration.

Compose creates the `app_owner`, `app_rw` and `audit_sealer` database roles on the first start of the Postgres volume. If you change `infra/postgres/init/01-roles.sql` (the `audit_sealer` role arrived with the audit trail), recreate the volume:

```bash
pnpm infra:reset                # docker compose down -v: removes containers and volumes
```

`pnpm infra:up`, `infra:down` and `infra:reset` wrap `docker compose --env-file .env -f infra/docker-compose.yml ...`. The `--env-file .env` part matters: compose reads variable defaults from the folder of the compose file (`infra/`), so without it your root `.env` (ports, passwords) would be ignored. Every published port is bound to `127.0.0.1` only.

`pnpm infra:up` starts Postgres, MinIO and Mailpit with `up --wait`, then runs the one-shot `minio-init` job with `docker compose run`. The job is run on its own because Compose treats a container that exits, even with code 0, as a failure while it waits. It is safe to run again: an existing bucket is kept.

### Encryption keys and the local KEK

Sensitive fields are encrypted with a per-tenant key that a key-encryption key (KEK) wraps. In development the KEK is `KMS_LOCAL_KEK_BASE64` from `.env.example`: a public placeholder, so anything you encrypt locally can be decrypted by anyone with this repository. Production refuses the local KEK and uses AWS KMS (`KMS_PROVIDER=aws`).

The API reads the tenant from the host name: `{slug}.localhost` in multi mode (current browsers resolve `*.localhost` to 127.0.0.1) and `platform.localhost` for the operator console.

## Run the apps

```bash
pnpm dev                          # API (port 3000) and web (port 5173) together
pnpm --filter @consultorio/api dev      # API only
pnpm --filter @consultorio/web dev      # web only; /api is proxied to the API
```

Check the API: `curl http://localhost:3000/health` answers `{"status":"ok"}`, and `/ready` answers 200 once Postgres is reachable.

## Local services

| Service    | URL or port                                        | Credentials (local only)                             |
| ---------- | -------------------------------------------------- | ---------------------------------------------------- |
| Postgres   | `localhost:5432`, database `consultorio`           | `app_rw` and `app_owner`, see `.env.example`         |
| MinIO API  | `http://localhost:9000`                            | `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`            |
| MinIO UI   | `http://localhost:9001`                            | same as above; bucket `consultorio-files` is private |
| Mailpit UI | `http://localhost:8025` (SMTP on `localhost:1025`) | none; every outgoing email is captured here          |
| ClamAV     | `localhost:3310`, profile `scan`                   | none; needs about 1 GB of RAM, so it is opt-in       |

Start the virus scanner only when working on uploads: `docker compose --env-file .env -f infra/docker-compose.yml --profile scan up -d clamav`.

To try the production image locally: `docker compose --env-file .env -f infra/docker-compose.yml --profile app up --build`.

## Everyday commands

| Command                                      | What it does                                                 |
| -------------------------------------------- | ------------------------------------------------------------ |
| `pnpm typecheck`                             | TypeScript across all packages                               |
| `pnpm lint` / `pnpm format:check`            | ESLint and Prettier (`pnpm format` fixes formatting)         |
| `pnpm test`                                  | Unit tests (Vitest: api and contracts in Node, web in jsdom) |
| `pnpm test:coverage`                         | Same, with a v8 coverage report in `coverage/`               |
| `pnpm test:integration`                      | Integration tests against a real Postgres 17 (needs Docker)  |
| `pnpm test:e2e`                              | Builds the web app and runs Playwright on mobile and desktop |
| `pnpm build`                                 | Builds the web app and bundles the API into `apps/api/dist`  |
| `pnpm db:check`                              | Fails when the Drizzle schema and the migrations disagree    |
| `pnpm --filter @consultorio/api db:generate` | Generates a migration from schema changes                    |

Migrations are forward-only. Never edit a migration that has been merged; add a new one.

## Troubleshooting

- **Install fails with an engine error**: your Node is older than 24. Use `nvm use` (reads `.nvmrc`) or install Node 24.
- **`pnpm` is the wrong version**: run `corepack enable`, or call `corepack pnpm ...` explicitly.
- **Integration tests say "Could not find a working container runtime"**: start Docker Desktop.
- **Port already in use** (another Postgres or MinIO container is common): change the matching `*_PORT` variable in `.env`, and the port inside `DATABASE_URL` and `MIGRATION_DATABASE_URL` if you changed `POSTGRES_PORT`.
