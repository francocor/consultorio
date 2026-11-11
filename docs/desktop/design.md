# Consulvia Desktop: design

Consulvia Desktop lets one clinic run the product on one Windows PC. It installs with a double click and needs no Docker, no cloud account and no internet connection. It is the same code as the hosted product, run in single-organization mode behind a small local server.

## Product name

- **Consulvia** is the product.
- Organizations keep their own name, logo and colors. "Centro Médico Aillu" and "Clínica Norte" are demo organizations, not product names.
- Rename only what users see, and keep internal identifiers:
  - the `@consultorio/*` package scopes;
  - the database objects;
  - `'consultorio/archive-key-wrap/v1'`, which is the HKDF context of the archive key wrap. Renaming it would make existing archives unreadable.

## Shape

```
Consulvia-Setup-<version>.exe   (NSIS, one click, per user, Electron + electron-builder)
  Electron main process
    ├─ PostgreSQL 17 (bundled binaries, data in %LOCALAPPDATA%\Consulvia\pgdata, loopback only, random port)
    ├─ API child process   (ELECTRON_RUN_AS_NODE, apps/api/dist/main.js api)
    ├─ worker child process (ELECTRON_RUN_AS_NODE, apps/api/dist/main.js worker)
    ├─ local HTTP server on 127.0.0.1:<port>: serves apps/web/dist and proxies to the API
    │    (the reverse proxy contract of docs/dev-setup.md, with the CSP from content-security-policy.txt)
    ├─ BrowserWindow on http://127.0.0.1:<port>
    └─ tray: open, open in browser, backup, restore, reset owner password, view outgoing emails, quit
```

## Runtime profile: `DEPLOYMENT_PROFILE=desktop`

`NODE_ENV=production` refuses several things a loopback install needs, and `development` is unsafe because it has a public pepper, simulators on, and a demo outbox. The new profile keeps `NODE_ENV=production` and relaxes exactly these checks, with nothing else changed:

| Check                  | Hosted production  | Desktop profile                                                                                 |
| ---------------------- | ------------------ | ----------------------------------------------------------------------------------------------- |
| `KMS_PROVIDER=local`   | refused            | allowed. The KEK is random per install and stored encrypted with Electron `safeStorage` (DPAPI) |
| `PUBLIC_URL`           | https only         | `http://localhost:<port>` or `http://127.0.0.1:<port>` only                                     |
| `COOKIE_SECURE`        | must be true       | false                                                                                           |
| `SMTP_HOST`            | required, with TLS | optional. Without it, mail goes to a local outbox (below)                                       |
| `ADDRESS_HASH_PEPPER`  | required           | required. Generated per install                                                                 |
| Static S3 keys, ClamAV | refused, required  | not used: storage is the filesystem; the scanner is the EICAR-only fake (logged)                |
| Providers              | —                  | forced `off` (WhatsApp, video, AFIP, e-prescription, payments); `BOT_CHALLENGE=local`           |
| Archive, releaser      | —                  | not configured                                                                                  |
| `HOST`                 | —                  | `127.0.0.1`, with `TRUST_PROXY=false`                                                           |

The profile requires `DEPLOYMENT_MODE=single`. Any other combination is refused at boot.

## Pieces to build

1. **Rebrand.** Every user-visible string listed in the branding inventory (title, `app.name`, fallback names, icon label, `MAIL_FROM`, PDF metadata, TOTP issuer, ICS PRODID, README), and a product icon.
2. **Desktop profile.** The rows above in `config.ts` and `config-providers.ts`, with tests that the hosted rules are unchanged.
3. **Filesystem storage.** `adapters/fs-storage` implements `ObjectStorage` under `STORAGE_DIR`.
   - `presignedPost` returns a same-origin `/api/files/uploads/<token>` URL. It carries a signed policy with the key, content type, maximum size and expiry, and is checked by a new upload route. This keeps the browser flow unchanged.
   - One factory replaces the seven `createS3ObjectStorage` call sites.
   - Path traversal is refused, and keys map to paths under the root only.
4. **Provisioning.** `scripts/provision-local.ts` is bundled. It is idempotent and creates:
   - the tenant, with `billing_exempt=true` and `is_demo=false`;
   - its key;
   - the owner, with a password chosen in the setup screen;
   - a first location.
5. **Bundled migrator.** `migrate-cli` is a second esbuild entry. The migration folder can be overridden by an env var, and it ships with `*.sql` and `meta/_journal.json`.
6. **Mail without SMTP.** An outbox sender stores each message as a file under `%LOCALAPPDATA%\Consulvia\outbox`, and the tray opens it. The tray can also reset the owner password, so a forgotten password has a way back.
7. **Shutdown.** The API and the worker stop gracefully on an IPC `shutdown` message, since `child.kill()` on Windows is a hard kill.
8. **Electron shell** (`apps/desktop`):
   - first-run setup: organization name and owner email and password;
   - PostgreSQL bootstrap: `initdb`, the roles from `01-roles.sql` with random passwords, and `max_connections=200`;
   - the local server and proxy;
   - the tray;
   - backup and restore: `pg_dump` plus the storage folder, to `Documents\Consulvia\Copias`;
   - single instance.
9. **Installer.** `pnpm --filter @consultorio/desktop dist` builds `release/Consulvia-Setup-<version>.exe`. Native modules (`@node-rs/argon2`, `sharp`) are unpacked from asar.

## Not available on the desktop

- Matricula verification lives in the operator console, which does not exist in single mode, so prescriptions are off.
- Real AFIP and e-prescription adapters are deferred.
- Public booking, the patient portal and the waitlist reach only the PC itself, or the LAN if it is opened later.

## Data

| What                                   | Where                                  |
| -------------------------------------- | -------------------------------------- |
| Database                               | `%LOCALAPPDATA%\Consulvia\pgdata`      |
| Files                                  | `%LOCALAPPDATA%\Consulvia\files`       |
| Secrets (encrypted with `safeStorage`) | `%LOCALAPPDATA%\Consulvia\config.json` |
| Backups                                | `Documents\Consulvia\Copias`           |

Uninstalling keeps the data.

## Pool sizing and `max_connections`

Every connection is a PostgreSQL backend process, so the shell sets `max_connections` once, from the worst case below. `DB_POOL_MAX` stays at its default of 48 (the floor is 46). It is the most connections ONE pool opens, and a pool opens them on demand.

| Process                       | Pools (most connections)                                                                                     | Worst case |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------: |
| `api`                         | runtime pool `DB_POOL_MAX` (48), health probe (1), job-queue client (2, opened by the first enqueue)         |         51 |
| `worker`                      | runtime pool of the worker (48), runtime pool of the adapters (48), audit sealer (2), job-queue client (6)   |        104 |
| `migrate`                     | owner pool (2), job-queue install (2). Runs while the API and the worker are stopped                         |          4 |
| `provision`, `reset-password` | one runtime pool of 4. Run while the API and the worker are stopped, or briefly beside them                  |          4 |
| Shell                         | `pg_dump` for a backup (1), its own health check (1 to 2), `superuser_reserved_connections` (3, the default) |          7 |

The API and the worker together can hold 155 connections at the extreme, and 162 with the shell. The shell sets **`max_connections=200`**: it covers the worst case with 38 to spare, and a PC that uses a few dozen connections pays nothing for the headroom (an unused slot costs no memory).

The worker opens TWO runtime pools of `DB_POOL_MAX`: one inside `startWorker`, one for the adapter registry. That is a property of the code and not a need; if it is ever fixed, 200 only gets safer. Do not lower `DB_POOL_MAX` below 46 to save connections: the API and the worker refuse to start.

## API contract for the shell

The Electron shell builds ONLY from this section. Everything runs from the bundle, `node apps/api/dist/main.js <command>`; under Electron that is `ELECTRON_RUN_AS_NODE=1` with the Electron binary as `node`.

### What ships with the bundle

- `apps/api/dist/main.js` (and `main.js.map`), with `dist/migrations/` beside it: the `*.sql` files and `meta/_journal.json`, nothing else. `pnpm --filter @consultorio/api build` produces both.
- `apps/api/assets/common-passwords-100k.txt`. The process looks in `<cwd>/assets`, then in `<folder of main.js>/../assets`. Start every process with the working directory set to `apps/api`, or ship `assets/` one level above `dist/`. A missing list stops the process on purpose.
- The runtime dependencies of `apps/api/package.json`, in a `node_modules` that `main.js` resolves from: everything except `@consultorio/*`, which is inlined. Native ones: `@node-rs/argon2` and `sharp` (unpack them from asar).

### Start-up order

1. First run only: `initdb`, start PostgreSQL (`max_connections=200`, loopback, random port), create the database, and run `infra/postgres/init/01-roles.sql` as the superuser while connected to that database. The script also grants `audit_sealer` to `app_rw`, and migration 0020 takes it away: run the script ONCE per cluster, before the first `migrate`, never after. The script gives every login it creates a public development password, so set a random one for `app_owner`, `app_rw` and `audit_sealer`, and make `app_operator` and `app_releaser`, which the desktop never uses, `NOLOGIN`.
2. Every start, and after an update: `migrate`. It is safe to repeat.
3. First run only: `provision`, with what the setup screen collected.
4. `api` and `worker`. The API is ready when `GET /health` answers 200 (`GET /ready` also checks the database).
5. Quit: send `{ "type": "shutdown" }` to each, wait for the exit, then stop PostgreSQL.

### Environment variables

`DATABASE_URL` is the `app_rw` login. Names that are not listed are not read. The processes never print a value.

`x` required, `o` optional, blank not read by that process.

| Variable                                                                | `api` | `worker` | `provision`, `reset-password` | `migrate` | Value                                                                                                                               |
| ----------------------------------------------------------------------- | :---: | :------: | :---------------------------: | :-------: | ----------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                              |   x   |    x     |               x               |           | `production`                                                                                                                        |
| `DEPLOYMENT_PROFILE`                                                    |   x   |    x     |               x               |           | `desktop`                                                                                                                           |
| `DEPLOYMENT_MODE`                                                       |   x   |    x     |               x               |           | `single`                                                                                                                            |
| `SINGLE_TENANT_SLUG`                                                    |   x   |    x     |               x               |           | the organization slug: 2 to 63 characters, lowercase letters, digits and inner hyphens                                              |
| `PUBLIC_URL`                                                            |   x   |    x     |               x               |           | `http://127.0.0.1:<port>` or `http://localhost:<port>` of the LOCAL SERVER the window opens; the port is required                   |
| `DATABASE_URL`                                                          |   x   |    x     |               x               |           | `postgres://app_rw:<password>@127.0.0.1:<pgport>/<database>`                                                                        |
| `KMS_PROVIDER`, `KMS_LOCAL_KEK_BASE64`                                  |   x   |    x     |               x               |           | `local`, and 32 random bytes in base64 (the KEK: lose it and the clinical data cannot be read)                                      |
| `ADDRESS_HASH_PEPPER`                                                   |   x   |    x     |               x               |           | at least 32 random characters, fixed for the install                                                                                |
| `STORAGE_DIR`, `STORAGE_UPLOAD_SECRET`                                  |   x   |    x     |               x               |           | an absolute folder (`%LOCALAPPDATA%\Consulvia\files`), and at least 32 random characters                                            |
| `OUTBOX_DIR`                                                            |   x   |    x     |               x               |           | an absolute folder (`%LOCALAPPDATA%\Consulvia\outbox`). Required while `SMTP_HOST` is not set                                       |
| `DESKTOP_PROXY_SECRET`                                                  |   x   |          |                               |           | at least 32 random characters, NEW FOR EVERY RUN of the services. Without it the API does not start (see "Behind the local server") |
| `AUDIT_SEALER_DATABASE_URL`                                             |       |    x     |                               |           | `postgres://audit_sealer:<password>@127.0.0.1:<pgport>/<database>`. The API must NOT have it                                        |
| `MIGRATION_DATABASE_URL`                                                |       |          |                               |     x     | `postgres://app_owner:<password>@127.0.0.1:<pgport>/<database>`                                                                     |
| `MIGRATIONS_DIR`                                                        |       |          |                               |     o     | a folder with `*.sql` and `meta/_journal.json`. Default: `dist/migrations` next to `main.js`                                        |
| `PORT`                                                                  |   o   |    o     |                               |           | the API port. Default 3000                                                                                                          |
| `HOST`                                                                  |   o   |    o     |                               |           | `127.0.0.1`, `localhost` or `::1`. Default `127.0.0.1`; anything else stops the process                                             |
| `LOG_LEVEL`                                                             |   o   |    o     |                               |           | `info` by default. The worker says `worker started` at `info`                                                                       |
| `MAIL_FROM`                                                             |   o   |    o     |                               |           | the sender of the outbox mail. Default `Consulvia <no-responder@localhost>`                                                         |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USER`, `SMTP_PASSWORD` |   o   |    o     |                               |           | a real mail server instead of the outbox. Then `OUTBOX_DIR` must be unset and the security `starttls` or `tls`                      |
| `CLAMAV_HOST`, `CLAMAV_PORT`                                            |   o   |    o     |                               |           | a ClamAV daemon. Without it uploads are checked by the fake scanner (EICAR only) and the worker logs that                           |
| `DB_POOL_MAX`                                                           |   o   |    o     |                               |           | 46 to 100, default 48. See pool sizing                                                                                              |
| `COOKIE_SECURE`, `TRUST_PROXY`                                          |   o   |    o     |                               |           | leave unset. Only `false` is accepted                                                                                               |

These are refused at boot by the desktop profile, naming the variable: any `*_PROVIDER` other than `off`, `BOT_CHALLENGE` other than `local`, `LOCAL_PROVIDERS_CONSOLE`, `ARCHIVE_*`, `S3_*`, a `HOST` outside the loopback, `COOKIE_SECURE=true`, a `TRUST_PROXY` other than `false`, and a `PUBLIC_URL` that is not a loopback address with a port. `provision` and `reset-password` exist only in this profile: with `DEPLOYMENT_PROFILE` unset or `hosted` they exit 3 naming the variable, before they open the database.

### Commands

Each command writes ONE JSON line to the standard output when it worked and ONE to the standard error when it did not. The exception is `migrate`, whose output is plain progress lines. Passwords are never printed. Never put a password in the arguments: the only flag is `--stdin`.

| Command                            | What it does                                                                                                               | Success output (stdout)                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `main.js migrate`                  | applies the pending migrations and loads the platform catalogs (payers, holidays)                                          | `migrations applied`, then `platform catalogs loaded`                                         |
| `main.js provision [--stdin]`      | creates the organization, its key, its first location (`Consultorio`) and the owner. Idempotent                            | `{"result":"created"\|"exists","tenantId":"<uuid>","slug":"<slug>"}`                          |
| `main.js reset-password [--stdin]` | gives the owner a new password, ends the owner's sessions, lifts a lock, keeps the second factor unless asked to remove it | `{"result":"reset","email":"<owner email>","secondFactorCleared":false,"ownerNotified":true}` |
| `main.js api`                      | the HTTP API on `HOST:PORT`. Stays up                                                                                      | nothing (JSON logs)                                                                           |
| `main.js worker`                   | the jobs and the audit sealing. Stays up                                                                                   | nothing (JSON logs)                                                                           |

`provision` reads its input from the environment or, with `--stdin`, from a JSON document. The document replaces the environment, and unknown keys are refused.

| Environment variable          | JSON key           | Required | Rules                                                              |
| ----------------------------- | ------------------ | :------: | ------------------------------------------------------------------ |
| `PROVISION_ORGANIZATION_NAME` | `organizationName` |    x     | 2 to 80 visible characters. The name of the organization           |
| `PROVISION_OWNER_NAME`        | `ownerName`        |    x     | 2 to 100 visible characters                                        |
| `PROVISION_OWNER_EMAIL`       | `ownerEmail`       |    x     | a valid address, stored in lower case; it is the sign-in           |
| `PROVISION_OWNER_PASSWORD`    | `ownerPassword`    |    x     | the product's password rules (length, not common, not the address) |
| `PROVISION_TIME_ZONE`         | `timeZone`         |          | an IANA name; default `America/Argentina/Buenos_Aires`             |
| `PROVISION_SLUG`              | `slug`             |          | must equal `SINGLE_TENANT_SLUG` if given                           |

`reset-password` reads `RESET_NEW_PASSWORD` (`newPassword`) and, only if the organization has more than one owner, `RESET_OWNER_EMAIL` (`ownerEmail`). `RESET_CLEAR_SECOND_FACTOR` (`clearSecondFactor`, `true` or `1`; default no) also removes the owner's TOTP secret and recovery codes, for an owner who lost the phone, and writes an `auth.2fa.disabled` audit entry. Whoever can run the command already controls the PC and its database, so it is not a gain of privilege; the tray asks the person at the PC whether to do it. The audit entries are filed under the system (no actor user, user agent `desktop-shell`) with the reason `local_reset`, so they cannot pass for the owner's own action, and a notice goes to the owner's address in the outbox (`ownerNotified` says whether it could be written). The shell asks for the recovery key before it runs the command.

A second `provision` with the same slug changes nothing (not even the password), exits 0 and answers `"result":"exists"`. The creation is one transaction. An organization that exists and is a demo one is never touched.

### Exit codes

| Code | Meaning                                                          | stderr                                                                                                                                                                                                       |
| ---: | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
|    0 | worked (`provision`: created, or already there)                  | empty                                                                                                                                                                                                        |
|    1 | unexpected failure: the database is down, a query failed         | `{"error":"failed","message":"..."}`                                                                                                                                                                         |
|    2 | the input is wrong; show it to the user                          | `{"error":"invalid_input","fields":["ownerEmail"]}`, or `{"error":"password_rejected","issues":["too_short"]}` with `issues` among `too_short`, `too_long`, `common`, `repeated_character`, `contains_email` |
|    3 | the environment is not a valid configuration: a bug of the shell | `{"error":"invalid_config","message":"Invalid environment configuration. HOST: ..."}` (variable names, never values)                                                                                         |
|    4 | the request is valid but the install cannot do it                | `{"error":"<reason>"}` with the reason among `demo_organization`, `email_in_use`, `owner_not_found`, `owner_ambiguous`, `organization_not_found`                                                             |

`api` and `worker` exit 1 with one plain line on the standard error when the configuration is invalid, and 0 after a shutdown.

### IPC and shutdown

Start `api` and `worker` with `stdio: ['pipe', 'pipe', 'pipe', 'ipc']`: a pipe for the standard input, not `'ignore'`. Read their standard output and error into the log file.

| Direction      | Message or event                                                   | Effect                                                                                                                                            |
| -------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| shell to child | `child.send({ type: 'shutdown' })`                                 | graceful stop. Any other message is ignored                                                                                                       |
| shell to child | closing the IPC channel (`child.disconnect()`, or the shell dying) | the same graceful stop                                                                                                                            |
| shell to child | closing the child's standard input (`child.stdin.end()`)           | the same, ONLY when there is an IPC channel and the input is a pipe. An ignored input is never watched, so it cannot stop the process by accident |
| child to shell | nothing                                                            | the child sends no IPC messages. Use `GET /health` to know the API is up, and `worker started` on stdout for the worker                           |

After the message the child closes the HTTP server, the job queue and the database pools, and exits by itself with code 0, normally within a second and at most about 15. Wait for the `exit` event and terminate the child only after 30 seconds. `child.kill()` on Windows is a hard kill that runs nothing: use it only as that last resort. `SIGINT` and `SIGTERM` still work for a terminal or a container. `provision`, `reset-password` and `migrate` take no IPC: they end by themselves.

### Behind the local server

The reverse-proxy contract of `docs/dev-setup.md` applies: strip `/api`, preserve the `Host` header, forward `Origin`. The API refuses a state-changing request whose `Origin` host is not its `Host`. Three things are new with the desktop profile:

- The loopback port of the API is open to every program of the PC, so in the desktop profile the API answers **403 to every request that does not carry** `x-consulvia-proxy: <DESKTOP_PROXY_SECRET>` (a constant-time compare) **or whose `Host` is not** `localhost:<port>` / `127.0.0.1:<port>` of `PUBLIC_URL`. The local server adds the header to what it forwards and drops one the page sent. The shell generates the secret anew each time it starts the services and shows it to nobody.
- The secret protects the API from programs that reach **its** port. It does not protect it from programs that reach the port of the **local server**, which adds the secret to what it forwards: so the local server answers **403 to every `/api/*` request that does not present the proof of a window**. The proof is a random value of each run, in two forms. The windows of the shell send it as the header `x-consulvia-window`, which the shell adds in the network layer of its session (`webRequest.onBeforeSendHeaders`) to requests for its own origin only (`http://127.0.0.1:<port>`, by number: the program never uses the name `localhost`, which can lead to `::1`, where any program may listen on the same port and would be handed the proof), replacing any such header a page set, so no page can read or forge it. The browser of the PC (tray, "Abrir en el navegador") is sent to `/__browser?t=<token>`, an address that works once within a minute, which sets the other value as an `HttpOnly`, `SameSite=Strict` cookie and redirects to `/`. The two values differ, neither is passed on to the API, and the bundle, the public routes and the token-gated pages of the shell are served without them. What this does not do: it does not stop a program that can read the memory of the shell or the cookies of the browser of the same Windows session (that one already is the user), and cookies are not isolated by port, so another web server on `localhost` can see the browser cookie.
- `GET /health` with a header `x-consulvia-nonce` (16 to 128 characters of `A-Za-z0-9_-`) is the only request answered without the secret: it replies 200 with `x-consulvia-proof: hex(HMAC-SHA256(secret, "consulvia-health:" + nonce))`. The shell sends a fresh nonce on every probe and accepts the API only when the proof checks, so a program that took the port cannot pass for the API and never sees the secret. If the API cannot bind, the shell tries another free port at the next launch.

- A document upload is `POST /api/files/uploads/<token>`, a `multipart/form-data` body of up to about 20 MiB that the browser sends with the fields it received and then the file. It carries no session: the token, signed with `STORAGE_UPLOAD_SECRET`, is the authorization (one object, one content type, a size cap, 15 minutes). The proxy must stream it with no smaller limit and pass `Content-Type` and `Content-Length`.
- The session cookie is `sid`, not `__Host-sid`: the loopback is plain http.

### Files under `%LOCALAPPDATA%\Consulvia`

| Path                     | Owner       | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pgdata\`                | shell       | the PostgreSQL cluster                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `files\` (`STORAGE_DIR`) | API, worker | `t\<tenant id>\<folder>\<object id>.obj` (the bytes) and `.meta` (the content type, JSON). Uploads wait in `quarantine\` and are released to `docs\`. A backup copies the whole folder and ignores `*.tmp` and `*.moving`, the leftovers of an interrupted write                                                                                                                                                                                                         |
| `outbox\` (`OUTBOX_DIR`) | API, worker | one pair per message: `<yyyymmddThhmmssSSSZ>-<8 hex>.eml` (open it in a mail client) and the same name with `.json`: `{ id, file, createdAt, from, to, subject, links }`. List the `.json` files (the name sorts by time); `links` holds the reset or invitation link. The folder holds links that were live when they were written, so the shell deletes messages older than 60 days at every start (an invitation can wait days to be opened, so a week was too short) |
| `config.json`            | shell       | the secrets, encrypted with `safeStorage`: the three database passwords (`app_owner`, `app_rw`, `audit_sealer`), `KMS_LOCAL_KEK_BASE64`, `ADDRESS_HASH_PEPPER`, `STORAGE_UPLOAD_SECRET`. Lose `KMS_LOCAL_KEK_BASE64` and the clinical data cannot be decrypted: back it up with the data                                                                                                                                                                                 |

The API and the worker never write outside `STORAGE_DIR` and `OUTBOX_DIR`.
