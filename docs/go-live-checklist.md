# Go-live checklist

Audience: the owner. This is the list of what stands between the product that runs on a laptop and the
first real patient. Everything the platform can do without a cloud account or a contract is built and
tested; what is left needs something only the owner can bring: an account, a certificate, a contract, a
decision. `apps/api/test/policy/go-live-checklist.test.ts` reads the plan (`tasks.md`) and fails when a
real-provider task that was deferred is missing here, so this page cannot fall behind it.

Nothing on this page is a dependency of a gate, a demo or a test: each local adapter passes the same
contract suite that its real counterpart will pass, so switching is a configuration change, not a
rewrite (`docs/runbooks/provider-switch.md`).

## Real providers (deferred tasks)

Each row is a task of the plan that waits for the owner. "Needs" repeats what the plan says it needs;
"Where it plugs in" is the setting that selects the adapter; "Proof" is the test that must pass before
the switch.

| Task | Needs                                                            | What it builds                                                                                                                      | Where it plugs in                               | Proof                                                     |
| ---- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------- |
| 3.80 | AWS SES account and verified domain                              | `adapters/ses/`: the native SES API as `EmailSender`, with bounce and complaint handling                                            | `SMTP_*` today; a provider key with the adapter | `email.contract.ts` and a mocked client                   |
| 3.81 | Meta WABA verification and approved templates                    | `adapters/whatsapp-meta/`: the Cloud API sender and the parsing of its webhook                                                      | `WHATSAPP_PROVIDER`                             | `whatsapp.contract.ts` and recorded payloads              |
| 3.82 | Jitsi as a Service account                                       | `adapters/jitsi-jaas/`: rooms with a signed token and recording disabled                                                            | `VIDEO_PROVIDER`                                | `video.contract.ts` and the claims of the token           |
| 3.83 | Cloudflare Turnstile keys                                        | `adapters/bot-challenge-turnstile/`                                                                                                 | `BOT_CHALLENGE`                                 | `bot-challenge.contract.ts` and a mocked verify endpoint  |
| 4.68 | ARCA certificate and homologation access                         | `adapters/afip-wsfe/`: the ticket of WSAA per certificate, WSFEv1 (last number, request, query), the endpoint of each point of sale | `AFIP_PROVIDER`                                 | `invoice-issuer.contract.ts` and recorded SOAP            |
| 4.69 | same as 4.68                                                     | `apps/api/test/external/afip-homologation.test.ts`, tagged so that it runs only in staging                                          | staging only                                    | that file                                                 |
| 5.53 | authorized e-prescription platform under Ley 27.553, decision Q3 | `adapters/erx-<provider>/` and the mapping of the webhook of the provider                                                           | `ERX_PROVIDER`                                  | `prescription-provider.contract.ts` and recorded payloads |
| 5.54 | same as 5.53                                                     | The onboarding form for the registration fields of the real provider                                                                | `features/prescriptions/connection`             | a component test with a mocked provider schema            |
| 6.50 | Mercado Pago account and credentials                             | `adapters/mercadopago/`: the real gateway, and the spike of Q2 about changing the amount (`docs/spikes/mp-amount-change.md`)        | `PAYMENTS_PROVIDER`, `MP_WEBHOOK_SECRET`        | `payments-gateway.contract.ts` and recorded webhooks      |
| 6.51 | AWS account, KMS CMK and IAM roles                               | `adapters/archive-s3/`: S3 Object Lock in governance mode, a CMK per environment and the `legal-erasure` role                       | `ARCHIVE_*`                                     | `archive-store.contract.ts` and a mocked client           |
| 6.52 | Sentry and cloud log accounts                                    | The exporters of errors and traces behind the observability port                                                                    | the observability port                          | a configuration test with the exporters off by default    |

Until a real adapter exists, production refuses the local one: a deployment that sets a `*_PROVIDER` to
`local` without `ALLOW_LOCAL_PROVIDERS=true` does not start. That is the safety net, not the plan: with
the local adapters nobody receives an email, a WhatsApp, an invoice or a charge.

## Owner actions

These are decisions and paperwork that belong to the owner and to nobody else. They are not tasks of
the plan, so a task cannot be marked done for them.

- [ ] **Hosting review (Q1).** Is the region of São Paulo plus the model clauses of the AAIP acceptable,
      or does the product start in an EU region? The code is the same either way. Needed before the
      first real patient.
- [ ] **Erasure (Q7).** Confirm with the lawyer that governance-mode Object Lock with a privileged
      erasure role satisfies the retention duty and the right to erasure. The archive of an organization
      that left (`docs/runbooks/archive-release.md`) depends on the answer.
- [ ] **Retention of the hot rows.** Version 1 keeps the rows of a cancelled organization in the database
      (read-only) and treats the archive as the copy in custody, because the plan has no exception that
      allows removing them. Confirm this is the intended policy (`docs/runbooks/tenant-cancellation.md`).
- [ ] **Rotate the legacy secrets (task 0.1).** Every credential that was in the legacy repository is
      compromised by its history. Record "rotated, date" and never the values.
- [ ] **Sign off `docs/legacy-parity.md` (task 2.101)** and the independent reviews of the plan that an
      executor cannot run (`judgment-day`).
- [ ] **Terms of service and data-processing terms.** The signup shows the two documents and records the
      versions accepted (`terms_version`); the text of both is the owner's to write and to publish.
- [ ] **Name the owners of the alerts.** Someone has to be woken by the rules of `infra/alerts/rules.yml`
      and read `docs/runbooks/incident.md`.

## Configuration that production insists on

The application refuses to start in production without these, and says which one is missing.

- A real key service for the encryption of the clinical fields (`KMS_PROVIDER=aws`, `AWS_REGION`,
  `AWS_KMS_KEY_ID`), never the local key. The key has its own escrow (`docs/runbooks/backup-restore.md`).
- A real mail server (`SMTP_HOST`, `SMTP_SECURITY`) and `ADDRESS_HASH_PEPPER`.
- `DB_POOL_MAX` of at least 46: eleven families of jobs hold a connection while a provider answers
  or a mail goes out (`docs/runbooks/deploy.md`). The example file says 48. Both the API and the worker
  open that many, so `max_connections` of the database must cover both with room to spare (150 is
  a sound number for one API, one worker, the releaser and the migrator).
- The archive: `ARCHIVE_S3_*`, the public half of the key of the releaser in the API and the worker
  (`ARCHIVE_RELEASER_PUBLIC_KEY`), the private half only in the releaser (`ARCHIVE_RELEASER_KEK`).
- `PAYMENTS_PROVIDER` and the other providers, set to a real adapter or to `off`. With `off` the dates of
  the billing hold (nobody can subscribe, so a trial that ends or a grace that runs out is not walked
  toward read-only for a debt nobody can pay): every organization stays as it is. Set it to a real
  adapter before the first trial ends, or the trials never turn into customers.
- The metrics port of each process (`METRICS_PORT`, `METRICS_HOST`, `METRICS_TOKEN`) and the scraper
  that loads `infra/alerts/rules.yml`.

## Before the first customer

- [ ] `pnpm drill:restore` passed on a copy of the real database, and the report is in the operations log
      (`docs/runbooks/backup-restore.md`).
- [ ] The alert rules are loaded and one of them was made to fire on purpose
      (`docs/runbooks/incident.md`).
- [ ] The cancellation of an organization was rehearsed from the console to the release of the archive
      (`docs/runbooks/tenant-cancellation.md`, `docs/runbooks/archive-release.md`).
- [ ] The switch to a real provider was rehearsed in staging with the runbook
      (`docs/runbooks/provider-switch.md`), and the way back is known.
- [ ] A person who is not the developer followed `docs/runbooks/deploy.md` from an empty account.
