# Runbook: delivery to staging and production

Audience: whoever deploys. Status of task 2.98: **deferred, owner action**. Delivering to the cloud
needs an AWS account, a region (decision Q1), a managed Postgres, container hosting, DNS and the
GitHub environments with their approvals. None of that exists, so no workflow is written that could
not be run; **nothing in Stage 2 or later depends on it**.

## What is ready today

| Piece            | State                                                                                                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container image  | `infra/Dockerfile` builds one image for the API and the worker (`api` or `worker` as the command). CI builds it and starts it with the production configuration as a smoke test of `/health`.            |
| Migrations       | Forward-only, applied by `pnpm db:migrate` as `app_owner` (also installs the job queues). Run them as a one-off task BEFORE starting the new version, and take a backup first (see `backup-restore.md`). |
| Configuration    | Every variable is documented in `docs/dev-setup.md` and in `.env.example`; the application refuses to start in production with the local KEK, insecure cookies or static storage keys.                   |
| Local equivalent | `pnpm demo:stack` runs everything (Postgres, MinIO, Mailpit, API, worker, two demo organizations) with only Docker; `docker compose --profile app up --build` runs the production image locally.         |

## Before running more than one instance of the API

The counters of the public routes (the rate limits of the portal, of the booking and of the waitlist, the tries at a code) live in the MEMORY of each API process (`platform/http/rate-limit.ts`, the memory store). With one instance that is exact; with N instances behind a balancer each one counts on its own, so the real allowance is up to N times the written one. **TODO for the first multi-instance deployment: give `rateLimitStore` a shared store (Redis or Postgres) before scaling out.** The limits that protect a person stay in the database whatever the store does (three sends an hour per address, five tries per challenge and twenty in all), so the hole is in the per-client limits only. A client whose address is not known is counted by its user agent too (JD-S5 R3-7), so a clinic behind one address is not one bucket.

## Size the connection pool of the API and of the worker

`DB_POOL_MAX` (default 36, at least 34, at most 100) is the most connections EACH process opens. Both the API and the worker read it and refuse to start below the floor. A job of eight families keeps the transaction the job framework opens for it idle while it waits for an outside service and asks for a second connection for its own work: `afip.issue` (the authority), `erx.reconcile` (the e-prescription provider), `portal.notice_sweep` (the mail server), `subscription.reconcile` and `dunning.step` (the payments provider), and the three of the retention archive, `export.build` (the package of a cancelled organization, streamed to the files bucket), `archive.write` and `archive.verify` (the write-once store). The worker runs two jobs of each family at once, so the floor is 8 x 2 x 2 + 2 = 34 (the 2 are for the sweeper and the other jobs); the `releaser` process (which carries out the approved release of archived records, `docs/runbooks/archive-release.md`) has a pool of its own of six connections and runs one family, `archive.release`, so it does not count here; it is a floor, not a size, and a busy worker wants more (JD-S5 R4-2, `docs/runbooks/afip-switch-to-real.md`). **`.env.example` still pins `DB_POOL_MAX=16`, below the floor: the maintainer changes that line to `DB_POOL_MAX=36`** (the example is not edited by the tracks; `config.test.ts` raises the value to the floor while it says 16). Add the connections of every instance (API plus worker, times the instances, plus the migrator and the operator and sealer logins) and check them against `max_connections` of the managed Postgres.

## The address of the client behind the proxy

A request whose client address is not known (`ip` is null: no `TRUST_PROXY` entry matched, or the proxy did not send it) is counted in the rate limits of the public and portal routes by a hash of its user agent. That bucket is **not a security boundary**: a client changes its user agent at will, so it only keeps a clinic behind one unknown address from being one shared bucket. The limits that protect a person stay in the database (JD-S5 R3-7, R4-7). The API logs a warning ("the client address of a portal request is unknown") each time it happens on a portal route: if you see it, `TRUST_PROXY` does not match the proxies in front of the app.

## What the owner has to provide

1. The cloud account and region (Q1), and the managed Postgres 17 with the roles of
   `infra/postgres/init/01-roles.sql` (the infrastructure provisions the roles with managed secrets).
2. A container registry (ECR) and the hosting for two processes, `api` and `worker`.
3. A KMS key (`KMS_PROVIDER=aws`), an S3 bucket with default encryption, a ClamAV service for the
   scanner (production refuses a bucket without one) and a mail provider for SMTP.
4. GitHub environments `staging` (deploys on `master`) and `production` (deploys on a tag, behind a
   manual approval), with the secrets of each.

## The workflow to write once those exist (`.github/workflows/deploy.yml`)

1. Build and push the image tagged with the commit (staging) or the tag (production).
2. Run `db:migrate` as a one-off task with the owner connection. A failing migration stops the
   release before any traffic moves.
3. Update the `api` and `worker` services; wait for `/health`.
4. Run the smoke check against the public URL.
5. Production only: wait for the approval of the `production` environment before step 2.

Test it with a dry run on a fork (as the plan says) before trusting it.
