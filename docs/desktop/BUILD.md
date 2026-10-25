# Building and releasing Consulvia Desktop

For the developer who builds the Windows installer. The clinic's guide is [INSTALACION.md](INSTALACION.md); the design and the contract between the shell and the API are in [design.md](design.md).

## What you get

`pnpm --filter @consultorio/desktop dist` builds the API bundle, the web app and the Electron shell, stages everything next to the shell and packs `apps/desktop/release/Consulvia-Setup-<version>.exe`, an NSIS one-click per-user installer (no administrator prompt), plus `Consulvia-Setup-<version>.exe.sha256`. `release/` is gitignored.

```text
Consulvia-Setup-<version>.exe              -> %LOCALAPPDATA%\Programs\Consulvia\
  Consulvia.exe                            Electron 44.9.3 (Node 24.22.0, Chromium 152); also the Node that runs the API
  resources\app.asar                       the shell: one bundled file (dist/main.cjs), no node_modules
  resources\api\                           dist/main.js (+ migrations/), assets/, node_modules/ (production, hoisted), package.json
  resources\web\                           apps/web/dist
  resources\postgres\{bin,lib,share}       PostgreSQL 17.10: initdb, pg_ctl, postgres and only the DLLs they load
  resources\tools\                         pg_dump.exe, pg_restore.exe and the DLLs they load
  resources\sql\01-roles.sql               infra/postgres/init/01-roles.sql
  resources\icons\                         tray.png, window.png
```

Everything except the shell is under `resources\` as plain files, **outside** `app.asar`: the API is a separate program (`ELECTRON_RUN_AS_NODE=1`), PostgreSQL is a set of executables, and the native modules `@node-rs/argon2` and `sharp` cannot load from inside an archive. That is the same outcome as unpacking them from the asar, with less machinery.

## Requirements of the build machine

- **Windows 10/11 x64.** The PostgreSQL server binaries come from `@embedded-postgres/windows-x64`, an optional dependency that only installs on win32-x64. On Linux/macOS (and in CI) `pnpm install` skips it, and the tests, typecheck, lint and `build` of this package still run; `stage` and `dist` stop with a message that says so.
- Node 24 and pnpm 10 through corepack, as in the rest of the repository.
- The **Microsoft Visual C++ 2015-2022 Redistributable (x64)** installed. PostgreSQL, its tools and `@node-rs/argon2` load `VCRUNTIME140.dll` / `MSVCP140.dll`, which a clean Windows does not have. The build copies them from `C:\Windows\System32` next to each program that needs them (app-local deployment, which Microsoft permits) and stops if they are missing.
- Internet on the first build: the Electron binary (~120 MB, cached by electron), the NSIS tools (cached by electron-builder in `%LOCALAPPDATA%\electron-builder\Cache`) and the EnterpriseDB archive (334 MB, cached in `apps/desktop/build/cache`).

```powershell
corepack pnpm install
# If the Electron binary is missing (pnpm may skip its postinstall): node apps/desktop/node_modules/electron/install.js
corepack pnpm --filter @consultorio/desktop dist
```

Useful variants:

| Command                                                                               | What it does                                                                                                               |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @consultorio/desktop stage`                                            | Builds the API and the web app and fills `apps/desktop/stage/`                                                             |
| `pnpm --filter @consultorio/desktop dist --skip-build`                                | As `dist`, reusing the existing `apps/api/dist` and `apps/web/dist`                                                        |
| `pnpm --filter @consultorio/desktop dist --reuse-stage`                               | Repacks from the current `stage/` (about a minute shorter than a full stage)                                               |
| `pnpm --filter @consultorio/desktop dist --reuse-stage --dir-only`                    | Packs only `release/win-unpacked` (the program as installed, no installer): minutes faster, and enough to test the program |
| `pnpm --filter @consultorio/desktop verify:installer --program=<releasewin-unpacked>` | The same end-to-end checks against an unpacked program (no install, no uninstall)                                          |
| `pnpm --filter @consultorio/desktop start`                                            | Runs the shell with the workspace Electron against `stage/` (data in `%LOCALAPPDATA%\Consulvia`)                           |
| `pnpm --filter @consultorio/desktop verify:installer [file]`                          | Installs the installer silently in a temporary folder and exercises it end to end (see below)                              |

## The pinned binaries

| What                                               | Pin                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron                                           | `electron@44.9.3` in `apps/desktop/package.json`, exact. Its bundled Node is 24.22.0, which satisfies the `node24` target of the API bundle. Chromium 152.0.7977.167.                                                                                                                         |
| electron-builder                                   | `^26.18.0` (lockfile)                                                                                                                                                                                                                                                                         |
| PostgreSQL server (`initdb`, `pg_ctl`, `postgres`) | `@embedded-postgres/windows-x64@17.10.0-beta.17`, exact, `optionalDependencies`. It is the EnterpriseDB build of 17.10 with the extensions the product needs (`btree_gist`, `citext`, `pgcrypto`, `pg_trgm`, `unaccent`) and the time zone data. It has no `pg_dump`, `pg_restore` or `psql`. |
| `pg_dump`, `pg_restore`                            | EnterpriseDB `postgresql-17.10-1-windows-x64-binaries.zip`, URL and SHA-256 pinned in `apps/desktop/scripts/pg-tools.ts`                                                                                                                                                                      |

The EnterpriseDB archive is downloaded once, its SHA-256 is verified (`f9aafca58e7026a1ef2caeee711acf761671e57904d430adc85f468374f5a821`, 333,925,750 bytes), and only `pg_dump.exe`, `pg_restore.exe` and the DLLs they import are kept (found by reading the PE import tables, `scripts/pe-imports.ts`). A wrong hash stops the build. The hash was computed once from the official download over HTTPS; EnterpriseDB publishes no checksum to compare it with.

**Why 17.10-1 and not the newest 17.11-1:** the server we ship is 17.10, and the tools match it exactly. A newer `pg_dump` can read an older server, but there is no gain in the difference.

**To move to another PostgreSQL release:** bump `@embedded-postgres/windows-x64` (it publishes the same version numbers as the EnterpriseDB build), change the three values in `EDB_ARCHIVE` to the matching `postgresql-<version>-windows-x64-binaries.zip`, run `stage` (it fails and prints the new hash), check where the file came from, and pin that hash. A major version needs a `pg_upgrade` plan for existing installs; the shell does not do one.

If the EnterpriseDB download is blocked, put the archive in `apps/desktop/build/cache/` by hand: it is used when its hash matches. Without `pg_dump` the installer would have no backups, so the build never skips it.

## How the installed program runs

See "Shape" and "API contract for the shell" in [design.md](design.md). In short: the shell (`apps/desktop/src`) starts PostgreSQL on a free loopback port, creates the roles once from `01-roles.sql` with random passwords, runs `main.js migrate` on every start, `main.js provision` once (from the first-run screen), then `main.js api` and `main.js worker` as children of Electron-as-Node, and serves the web app plus the reverse proxy on `127.0.0.1:47800` (or another free port, kept for the life of the install). Secrets are generated with `crypto.randomBytes` and stored in `config.json` encrypted with Electron `safeStorage` (DPAPI). Backups are encrypted and authenticated (`backup-crypto.ts`, `backup-archive.ts`); the database cluster and the documents on disk are **not** encrypted by the shell, which `INSTALACION.md` says plainly and answers with a BitLocker recommendation.

Modules (`apps/desktop/src`), each unit-tested with Electron injected or absent: `paths`, `secrets`, `config-store`, `recovery`, `postgres`, `roles`, `api-env`, `api-commands`, `supervisor`, `local-server` (`static-files`, `proxy`, `internal-pages`, `pages`, `tokens`, `setup-validation`, `password-check`), `backup`, `restore`, `zip`, `outbox`, `controller` (the state machine) and `main` (windows, tray, single instance: the only file that imports Electron).

### Hooks for tests and support

| Name                                              | Effect                                                                                                                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONSULVIA_DATA_DIR`                              | Replaces `%LOCALAPPDATA%\Consulvia`. Also moves the Chromium profile and the single-instance lock, so a test install runs beside a real one                                  |
| `CONSULVIA_BACKUP_DIR`                            | Replaces `Documents\Consulvia\Copias`                                                                                                                                        |
| `CONSULVIA_TEST_MODE=1`                           | Writes the one-time setup and reset addresses to `logs/shell.log`, skips the confirmation of `--restore`, never touches the Windows login items. Never set it on a clinic PC |
| `CONSULVIA_RESOURCES`                             | Where the staged files are, in a development run (`stage/` by default)                                                                                                       |
| `CONSULVIA_DEVTOOLS=1`                            | Allows DevTools in the windows                                                                                                                                               |
| `Consulvia.exe --quit`                            | Asks the running instance to stop everything and exit, as the tray's _Salir_                                                                                                 |
| `--backup`, `--reset-password`, `--restore=<zip>` | Ask the running instance to do what the tray does. A second launch passes its command line to the first one (`requestSingleInstanceLock`)                                    |
| `--hidden`                                        | Start without showing the window (what the _Iniciar con Windows_ option registers)                                                                                           |

## Verifying an installer

`pnpm --filter @consultorio/desktop verify:installer` installs `release/Consulvia-Setup-<version>.exe` with `/S` into a temporary folder (`/D=`), runs it with `CONSULVIA_DATA_DIR` and `CONSULVIA_BACKUP_DIR` pointing at temporary folders, and from outside the program: drives `/__setup` with its one-time token, signs in through `/api/auth`, lists and creates patients, uploads a PDF through the presigned flow and downloads it after the scan, checks that EICAR is rejected, makes a backup, quits through `--quit` and checks that no `postgres.exe` or child remains, starts again and checks the data, restores the backup, resets the owner's password and removes the second factor, and uninstalls with `Uninstall Consulvia.exe /S` checking that the data folder stays. It also takes a screenshot of the real window after sign-in (`apps/desktop/docs/screenshot-login.png`) over the DevTools protocol. The installer creates and removes a desktop shortcut and a Start-menu entry of the current Windows user, like any install. The report is written to `apps/desktop/build/verify-report.json`.

## Releasing

1. Bump `version` in `apps/desktop/package.json` (semver; the installer name and the Windows "Apps" list show it). Update [INSTALACION.md](INSTALACION.md) if behavior changed.
2. `pnpm install`, `pnpm typecheck`, `pnpm test`, `pnpm lint` on the commit to release.
3. `pnpm --filter @consultorio/desktop dist` on a Windows x64 machine. Note the size and SHA-256 it prints (also in `release/*.sha256`).
4. `pnpm --filter @consultorio/desktop verify:installer`. Do not release if a step fails.
5. Publish `Consulvia-Setup-<version>.exe` and its `.sha256` (for example as a GitHub Release asset of a tag `desktop-v<version>`) and give clinics the SHA-256.

**Updates:** a clinic runs the new installer over the old one; the data in `%LOCALAPPDATA%\Consulvia` is untouched and the shell applies new migrations (`migrate`) at the next start. There is no automatic updater yet.

**Signing:** the installer is **not signed**, so Windows SmartScreen warns ("Windows protegió su PC"). With a code-signing certificate, set `win.certificateFile` / `certificatePassword` (or `azureSignOptions`) in `apps/desktop/scripts/builder-config.ts` from environment variables; never commit a certificate. electron-builder already tries to sign every program it packs and skips it when none is configured.

## CI

`.github/workflows/ci.yml` sets `ELECTRON_SKIP_BINARY_DOWNLOAD=1` for the whole workflow so installing the workspace does not download Electron. The package's unit tests run in `pnpm test`, its types in `pnpm typecheck`, its lint in the sharded `pnpm lint` and its bundle in `pnpm build`. Building the installer is manual (it needs Windows and ~15 minutes). The image build (`infra/Dockerfile`) copies `apps/desktop/package.json` so the lockfile still matches the workspace.

## Things verified on the real program

- **`upgrade-insecure-requests` does not break `http://localhost`.** The Content Security Policy of the web build is sent unchanged (it still carries that directive). In the real window the page, its scripts, the service worker and the API calls all load, and the DevTools protocol reports no policy violation (`verify:installer` fails if one appears). Chromium treats loopback as trustworthy and does not upgrade it, so nothing is stripped in the shell.
- **A restore does not use `pg_restore --clean` on the live database.** That fails on the partitioned `audit_event_*` tables (`cannot drop inherited constraint`). The backup is restored into an empty database next to the real one (`consultorio_restore`, in one transaction), the documents folder is swapped, and only then the databases are renamed. A restore that fails leaves the live data untouched, and the safety backup made before it is the last resort.
- **First run on a slow or busy PC takes minutes**, not seconds: `initdb` about 30 s and the first `migrate` (about 80 migrations) 1 to 2 minutes with an antivirus and other programs competing. The shell shows "Preparando la base de datos…" meanwhile, and the commands have generous timeouts (`migrate` 10 min, `provision` 10 min, `reset-password` 5 min).
