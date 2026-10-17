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
