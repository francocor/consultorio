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

Compose creates the `app_owner`, `app_rw`, `app_operator` and `audit_sealer` database roles on the first start of the Postgres volume. If you change `infra/postgres/init/01-roles.sql` (`audit_sealer` arrived with the audit trail and `app_operator`, the role of the operator console, with the staff tables), recreate the volume:

```bash
pnpm infra:reset                # docker compose down -v: removes containers and volumes
```

**The audit sealer is a login of its own.** `audit_sealer` is the only role that may fill the hash chain (`seq`, `prev_hash`, `hash`) of the audit trails, and only the worker connects as it (`AUDIT_SEALER_DATABASE_URL`; the worker refuses to start without it, and the API should not have it). Neither `app_rw` nor `app_operator` can switch to it, so a compromised API connection can neither read the platform trail nor forge a seal; and no role but the sealer can INSERT an event that already carries a seal (migration 0020). A database created before migration 0020 whose `app_rw` membership of `audit_sealer` was granted by a superuser needs `REVOKE audit_sealer FROM app_rw;` as a superuser (the migration says so); local databases: `pnpm infra:reset`. In production the infrastructure provisions the role with a managed secret.

`pnpm infra:up`, `infra:down` and `infra:reset` wrap `docker compose --env-file .env -f infra/docker-compose.yml ...`. The `--env-file .env` part matters: compose reads variable defaults from the folder of the compose file (`infra/`), so without it your root `.env` (ports, passwords) would be ignored. Every published port is bound to `127.0.0.1` only.

`pnpm infra:up` starts Postgres, MinIO and Mailpit with `up --wait`, then runs the one-shot `minio-init` job with `docker compose run`. The job is run on its own because Compose treats a container that exits, even with code 0, as a failure while it waits. It is safe to run again: an existing bucket is kept.

### Encryption keys and the local KEK

Sensitive fields are encrypted with a per-tenant key that a key-encryption key (KEK) wraps. In development the KEK is `KMS_LOCAL_KEK_BASE64` from `.env.example`: a public placeholder, so anything you encrypt locally can be decrypted by anyone with this repository. Production refuses the local KEK and uses AWS KMS (`KMS_PROVIDER=aws`).

### Sign-in, second factor and email

- **Email.** Password reset links and staff invitations go through SMTP. With `pnpm infra:up` running and `SMTP_HOST=localhost` (the default of `.env.example`) every message lands in Mailpit at `http://localhost:8025`; nothing leaves your machine. Without `SMTP_HOST` the API keeps messages in memory, delivers nothing and logs a warning at startup. Production requires `SMTP_HOST` and refuses `SMTP_SECURITY=none`.
- **Passwords.** New passwords are checked against the common-password list in `apps/api/assets` (the API stops at startup if it cannot find it). `AUTH_BREACH_CHECK=true` also asks a breach range API about the first five characters of the password hash; the password never leaves the server.
- **Lockout.** `AUTH_LOCKOUT_MAX_FAILURES` consecutive failures (a wrong password or a wrong second-factor code) lock an account for `AUTH_LOCKOUT_MINUTES`. Short delays apply before the lock.
- **Second factor.** Owners, admins and professionals have 7 days from their first sign-in to enroll an authenticator app (TOTP); after that their session can only reach the enrollment endpoints. Any authenticator app works in development.

### Logos and object storage

Logo upload stores the image in the S3-compatible bucket. Locally that is MinIO: `pnpm infra:up` creates the bucket named by `S3_BUCKET`, and `.env.example` already points `S3_ENDPOINT` and the keys at it. Without `S3_BUCKET` the API still starts, but `PUT /branding/logo` answers 503 and the public logo route answers 404. Uploads are re-encoded to a clean PNG (metadata stripped, 512 pixels at most), so what the browser later receives is never the file that was uploaded. In production leave `S3_ENDPOINT` and the keys empty: the task role supplies the credentials and the bucket encryption (SSE-KMS) protects the objects.

### The operator console

The platform operator (you, running the platform, not a clinic user) signs in on `platform.localhost`. An operator is not a tenant user: separate accounts, a separate `osid` cookie, a password plus a mandatory authenticator code (no grace period) and a separate audit trail. The console is off until `OPERATOR_DATABASE_URL` is set (`.env.example` has the local value, the `app_operator` login) and exists only in multi mode.

```bash
# 1. Existing local databases need the app_operator role: pnpm infra:reset, then pnpm infra:up and db:migrate.
# 2. Create the first operator. The password comes from the environment, never from a flag.
OPERATOR_PASSWORD='a long passphrase of at least 14 characters'   pnpm --filter @consultorio/api operator:create --email you@example.com --name "Your Name"
# 3. Add the printed secret to an authenticator app. It is shown once.
```

With the API and the web app running, open `http://platform.localhost:5173`: the console asks for the email, the password and the six-digit code of the authenticator (`TOTP_SECRET=... pnpm --filter @consultorio/api operator:code` prints the current code without a phone). From there an operator lists the organizations, creates one (optionally marking it as a demonstration, which can never change afterwards), resends an owner's invitation while nobody has joined, and resets a demonstration organization. The owner receives an invitation by email (Mailpit, `http://localhost:8025`) pointing at `{slug}.localhost:5173/accept-invitation`. The same actions are available as API calls on `platform.localhost:3000` (`POST /operator/auth/login` with `{"email","password","code"}`, then `/operator/tenants`, `/operator/tenants/{id}/owner-invitation` and `/operator/tenants/{id}/demo-reset`). See [demo.md](demo.md) for the demonstration organization and its reset.

The operator's database login can touch the tenant row, a few administrative tables and the operator tables, and nothing clinical. Seeing an organization's configuration needs a **support grant**: its owner opens a time-boxed window with `POST /support-grants` (up to 7 days) and can revoke it at any time. Every use of a grant is recorded twice, in the platform trail and in the organization's own audit log.

The API reads the tenant from the host name: `{slug}.localhost` in multi mode (current browsers resolve `*.localhost` to 127.0.0.1) and `platform.localhost` for the operator console.

## Run the apps

```bash
pnpm dev                          # API (port 3000) and web (port 5173) together
pnpm --filter @consultorio/api dev      # API only
pnpm --filter @consultorio/web dev      # web only; /api is proxied to the API
```

Check the API: `curl http://localhost:3000/health` answers `{"status":"ok"}`, and `/ready` answers 200 once Postgres is reachable.

## Reverse proxy contract

The web app is a static bundle that talks to the API through one prefix, and a reverse proxy (the Vite dev and preview servers locally, a load balancer or CDN in production) has to honor these rules. The Vite configuration is the reference implementation (`apps/web/vite.config.ts`).

| Request from the browser     | The proxy must                                                                                                                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/*`                     | **Strip the `/api` prefix** and forward to the API. The API has no `/api/v1`: its routes are `/auth/login`, `/patients`, `/branding`, ...                                                                               |
| `/manifest.webmanifest`      | Forward untouched. The API answers with a manifest per host (name, colors, icons of the organization)                                                                                                                   |
| `/public/branding/logo`      | Forward untouched. It is the public logo of the organization, referenced by the boot payload and the manifest                                                                                                           |
| `/public/t/*`, `/public/v/*` | Forward untouched. They are the pages of the links in reminders and waitlist offers and the video join address, rendered by the API (Stage 3)                                                                           |
| Everything else              | Serve the web bundle; unknown paths answer `index.html` (the router handles them)                                                                                                                                       |
| Any request                  | **Preserve the `Host` header** (`changeOrigin: false`). The API resolves the organization from it (`aillu.localhost`, `clinica.example.com`) and rejects a state-changing request whose `Origin` host is not the `Host` |

Other things the deployment must know:

- **One host per organization**, plus `platform.<base domain>` for the operator console. The web app decides it is the console from the first label of the host (`platform`) or from `VITE_PLATFORM_HOST` at build time.
- **Content Security Policy.** Send the policy of the build on every response of the web bundle (the HTML, the scripts, the service worker). The build writes it, with the hashes of the two inline scripts (zod without code generation, and the theme boot), to `dist/content-security-policy.txt`; the proxy of the deployment sends that file's content as `Content-Security-Policy`. In development the Vite servers send it themselves (`vite dev` the development form, with the allowances for hot reload; `vite preview` the production form, which the browser suite runs against and fails on any violation). The production policy: scripts from this origin plus those two hashes only (no `unsafe-inline`, no `unsafe-eval`); styles from this origin and inline (libraries add `<style>` elements); images from this origin, `data:` and `blob:`; fonts, API calls, the manifest and the service worker from this origin; no plugins, no `<base>` changes, forms only to this origin, never framed; `upgrade-insecure-requests`. A new inline script, a CDN font or an analytics snippet needs a conscious change of `apps/web/vite/csp.ts`, not an exception at the proxy.
- **Documents.** Two things on top of the rules above. (1) The browser uploads a file straight to object storage with a presigned POST, so the storage origin must be allowed in `connect-src`: build the web app with `CSP_CONNECT_SOURCES=https://<storage origin>` (comma or space separated; only plain http(s) origins are accepted, anything else is dropped), and give the bucket a CORS rule that allows `POST` from the app's origin. (2) A download is `GET /api/files/<token>`: the API streams the file, so the proxy must not buffer it whole, must not cache it and must pass `Content-Disposition` through. The same session cookie is needed, which is why the file never comes from storage directly.
- **Service worker.** `sw.js` must be served from the root with `Cache-Control: no-cache` so a new version reaches people at their next visit; hashed assets under `/assets/` can be cached for a year. The worker never caches `/api/*` or any personal data.
- **Emailed links never come from the request.** Password reset and invitation links are built from configuration: `{slug}.BASE_DOMAIN` in multi mode (add `PUBLIC_PORT=5173` locally so the link opens the dev server) and the required `PUBLIC_URL` (`https://agenda.clinica.example`, https in production) in single mode. A forged `Host` header cannot change them.
- **Client address.** `TRUST_PROXY` is the number of reverse proxies in front of the API (production default `1`; development default `false`) or a comma-separated list of proxy addresses and ranges. The API takes the client address from `X-Forwarded-For` that many hops from the right, so addresses a client prepends are ignored; `true` is refused because it would believe the leftmost entry. The contract: the API is reachable **only** through the proxy, and the proxy **appends** the address it received the connection from (the default of nginx, Envoy and the AWS ALB). An entry that is not an IP address is stored as "unknown", never as an error.
- **Cookies.** Where cookies are secure (production, HTTPS) the session cookie is `__Host-sid` and the operator's `__Host-osid` (ASVS 3.4.4): `Secure`, `Path=/`, no `Domain`, `HttpOnly`; staff `SameSite=Lax`, operator `SameSite=Strict`. The proxy must therefore forward over HTTPS, must not rewrite cookie domains or paths, and must not add a `Domain`. Plain-http local development uses `sid` and `osid`, because browsers reject a `__Host-` cookie that is not `Secure`.
- **Sessions end after 30 minutes without use** (any request counts as use) and after 7 days whatever the use. A person working in the app never notices it; a screen left open on a shared desk locks itself (ASVS 3.3.2).

## Local services

| Service    | URL or port                                        | Credentials (local only)                             |
| ---------- | -------------------------------------------------- | ---------------------------------------------------- |
| Postgres   | `localhost:5432`, database `consultorio`           | `app_rw` and `app_owner`, see `.env.example`         |
| MinIO API  | `http://localhost:9000`                            | `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`            |
| MinIO UI   | `http://localhost:9001`                            | same as above; bucket `consultorio-files` is private |
| Mailpit UI | `http://localhost:8025` (SMTP on `localhost:1025`) | none; every outgoing email is captured here          |
| ClamAV     | `localhost:3310`, profile `scan`                   | none; needs about 1 GB of RAM, so it is opt-in       |

Start the virus scanner only when working on uploads: `docker compose --env-file .env -f infra/docker-compose.yml --profile scan up -d clamav`.

**Documents and the scanner.** Every uploaded document is scanned before anyone can download it, and the worker does the scanning. Two variables point it at `clamd`: `CLAMAV_HOST` (for the local container, `127.0.0.1`) and `CLAMAV_PORT` (default `3310`, the same variable the compose file uses to publish the container). Without `CLAMAV_HOST` outside production the worker uses a fake scanner that only flags the EICAR test string, so the upload flow can be tried without ClamAV. In production a bucket (`S3_BUCKET`) without `CLAMAV_HOST` is a startup error: with no scanner every upload would wait in quarantine forever. If the scanner stops answering, documents simply stay quarantined and are retried with a growing delay; after an hour of waiting the worker logs an error. The slow test against a real ClamAV only runs with `SLOW_TESTS=1` (`SLOW_TESTS=1 pnpm test:integration -- clamav`); it needs the image `clamav/clamav` and takes one to three minutes to start.

**Providers and their local simulators.** Every external provider of the patient-engagement stages has a local adapter that works without an account, and the product runs on it until the owner has the real contract (`docs/external-dependencies.md`). Outside production nothing needs configuring: WhatsApp, video, the bot challenge, the AFIP invoice issuer and the e-prescription provider run on their simulators. A prescription that the simulator issues has no legal validity, and every screen and PDF that shows it says so. An invoice that the simulator issues is a test document with no fiscal validity, and every screen that shows it says so.

| Variable                  | Values (default)                                       | Meaning                                                                                                                                                                                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WHATSAPP_PROVIDER`       | `local`, `meta`, `off` (`local`; production `off`)     | Who sends WhatsApp messages. `meta` is the real Cloud API and needs `WHATSAPP_APP_SECRET`                                                                                                                                                                                                                                                              |
| `VIDEO_PROVIDER`          | `local`, `jaas`, `off` (`local`; production `off`)     | Who creates the video room of a teleconsultation                                                                                                                                                                                                                                                                                                       |
| `BOT_CHALLENGE`           | `local`, `turnstile` (`local`; production `turnstile`) | The bot challenge of the public booking forms                                                                                                                                                                                                                                                                                                          |
| `AFIP_PROVIDER`           | `local`, `afip`, `off` (`local`; production `off`)     | Who issues electronic invoices (Stage 4). `local` is the AFIP simulator (CAE, numbering, outage modes); `afip` is the real ARCA adapter, not built yet                                                                                                                                                                                                 |
| `ERX_PROVIDER`            | `local`, `off` (`local`; production `off`)             | Who issues electronic prescriptions (Stage 5). `local` is the prescription simulator (external id, a PDF marked "simulated", status changes, outage modes); the real provider key is added with its adapter, not built yet                                                                                                                             |
| `WHATSAPP_APP_SECRET`     | at least 16 characters, secret                         | Signs the WhatsApp webhook (`X-Hub-Signature-256`). Never logged                                                                                                                                                                                                                                                                                       |
| `ERX_WEBHOOK_SECRET`      | at least 16 characters, secret                         | Signs the webhook of the e-prescription provider (HMAC). Never logged                                                                                                                                                                                                                                                                                  |
| `ADDRESS_HASH_PEPPER`     | at least 32 characters, secret; required in production | Keys (HMAC-SHA256) the hash of the addresses in the message log, the same for the whole platform. Development has a public default. Rotating it forgets which addresses failed and which numbers were written to. `pnpm demo:seed` and `pnpm demo:reset` hash the demo message log with the same value, so run them with the same `.env` as the server |
| `VIDEO_ALLOWED_DOMAINS`   | comma-separated host names (empty)                     | The hosts a professional's manual video link may point at                                                                                                                                                                                                                                                                                              |
| `VIDEO_LOCAL_BASE_URL`    | an `https` address (`https://meet.jit.si`)             | The Jitsi server whose rooms the local video provider links to. A self-hosted one needs no code change                                                                                                                                                                                                                                                 |
| `ALLOW_LOCAL_PROVIDERS`   | `true`, `false` (`false`)                              | Lets a production process run the simulators. For a demo or staging deployment only                                                                                                                                                                                                                                                                    |
| `LOCAL_PROVIDERS_CONSOLE` | `true`, `false` (`false`)                              | Serves the simulator console (`/operator/dev/*`, behind the operator session). Without it those paths do not exist. In production it needs the flag above                                                                                                                                                                                              |

The simulator's phone (`local_whatsapp_message`) is a platform table with no organization and no row level security, and the messages in it show the links they carry: it is for development and demonstrations with fictitious data, never for a deployment that serves real patients.

A production process that selects a simulator, or turns the console on, without `ALLOW_LOCAL_PROVIDERS=true` refuses to start and names the variable. The defaults of production are "no simulator" (`off` and `turnstile`), so an existing production configuration keeps starting. These variables are described here, and not in `.env.example`, like the scanner ones; a test checks that each one appears in this guide.

To try the production image locally: `docker compose --env-file .env -f infra/docker-compose.yml --profile app up --build`.

## Everyday commands

| Command                                         | What it does                                                                                                                                                   |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                | TypeScript across all packages                                                                                                                                 |
| `pnpm lint` / `pnpm format:check`               | ESLint and Prettier (`pnpm format` fixes formatting)                                                                                                           |
| `pnpm test`                                     | Unit tests (Vitest: api and contracts in Node, web in jsdom)                                                                                                   |
| `pnpm test:coverage`                            | Same, with a v8 coverage report in `coverage/`                                                                                                                 |
| `pnpm test:integration`                         | Integration tests against a real Postgres 17 (needs Docker)                                                                                                    |
| `pnpm test:e2e`                                 | Builds the web app and runs Playwright on mobile and desktop                                                                                                   |
| `pnpm demo:seed`                                | Seeds the demo organization "aillu" in your local database                                                                                                     |
| `pnpm demo:reset`                               | Puts a demo organization back to its starting content                                                                                                          |
| `pnpm demo:stack`                               | A throwaway Docker stack with two demo organizations                                                                                                           |
| `pnpm backup:local`                             | Backs up the local database and bucket; `verify` and `restore` subcommands (see `docs/runbooks/backup-restore.md`)                                             |
| `pnpm --filter @consultorio/api bench:clinical` | Benchmarks the clinical row level security with 100,000 notes (`docs/perf/clinical-readable.md`)                                                               |
| `pnpm build`                                    | Builds the web app and bundles the API into `apps/api/dist`                                                                                                    |
| `pnpm db:check`                                 | Fails when the migration journal is unsound (a stamp that does not rise, a duplicate or out-of-range number) or the Drizzle schema and the migrations disagree |
| `pnpm db:new <track> <name>`                    | Creates the next migration of a track, in its range (`docs/migration-ranges.md`)                                                                               |
| `pnpm db:restamp`                               | After a merge or a rebase: raises stamps that do not rise and re-chains the snapshots                                                                          |

Migrations are forward-only. Never edit a migration that has been merged; add a new one.

**Migrations in parallel tracks.** Stages 3 to 6 are built by parallel tracks, so migrations are numbered by range (Stage 3 is `0300`-`0399`, split by track) and are created with `pnpm db:new <track> <name>`, for example `pnpm db:new 3a notifications_core`. Never run `drizzle-kit generate` by hand (`db:generate` refuses): it names files by position, not by range, and takes the wrong snapshot as the current state once ranges interleave. After merging or rebasing a branch that has migrations, run `pnpm db:restamp` and `pnpm db:check`, then commit what they changed. The reasons (Drizzle's migrator skips an entry whose stamp is older than the last one a database ran), the ranges of every track and the exact workflow are in `docs/migration-ranges.md`.

`pnpm test:e2e` starts its own stack (Postgres, MinIO, Mailpit, API and worker in Docker) and the preview server: the web on port 4173, the API on 3100 and the document storage (MinIO) on 9190. When another run holds those ports (several worktrees on one machine), give the run its own, and Playwright starts everything on them:

```bash
cd apps/web && pnpm exec vite build
E2E_WEB_PORT=4310 E2E_API_PORT=3310 E2E_MINIO_PORT=9310 pnpm exec playwright test --workers=3
```

The preview server's Content Security Policy allows the storage origin (`CSP_CONNECT_SOURCES`, set by `playwright.config.ts` from `E2E_MINIO_PORT`), because the browser uploads documents straight to MinIO.

## Troubleshooting

- **Install fails with an engine error**: your Node is older than 24. Use `nvm use` (reads `.nvmrc`) or install Node 24.
- **`pnpm` is the wrong version**: run `corepack enable`, or call `corepack pnpm ...` explicitly.
- **Integration tests say "Could not find a working container runtime"**: start Docker Desktop.
- **Port already in use** (another Postgres or MinIO container is common): change the matching `*_PORT` variable in `.env`, and the port inside `DATABASE_URL` and `MIGRATION_DATABASE_URL` if you changed `POSTGRES_PORT`.
