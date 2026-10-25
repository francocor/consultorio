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
    ├─ PostgreSQL 17 (bundled binaries, data in %APPDATA%\Consulvia\pgdata, loopback only, random port)
    ├─ API child process   (ELECTRON_RUN_AS_NODE, apps/api/dist/main.js api)
    ├─ worker child process (ELECTRON_RUN_AS_NODE, apps/api/dist/main.js worker)
    ├─ local HTTP server on 127.0.0.1:<port>: serves apps/web/dist and proxies to the API
    │    (the reverse proxy contract of docs/dev-setup.md, with the CSP from content-security-policy.txt)
    ├─ BrowserWindow on http://localhost:<port>
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
6. **Mail without SMTP.** An outbox sender stores each message as a file under `%APPDATA%\Consulvia\outbox`, and the tray opens it. The tray can also reset the owner password, so a forgotten password has a way back.
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

| What                                   | Where                             |
| -------------------------------------- | --------------------------------- |
| Database                               | `%APPDATA%\Consulvia\pgdata`      |
| Files                                  | `%APPDATA%\Consulvia\files`       |
| Secrets (encrypted with `safeStorage`) | `%APPDATA%\Consulvia\config.json` |
| Backups                                | `Documents\Consulvia\Copias`      |

Uninstalling keeps the data.
