# ASVS Level 2: Stage 6 and the final checklist

Scope: what Stage 6 added (self-service signup, the subscription and its payments through Mercado Pago,
the cancellation export, the retention archive with its break-glass release, and the readiness pieces:
the restore drill, the metrics port and the alert rules), read together with the earlier checklists:
`asvs-l2-stage1.md` (the secure core), `public-surface-stage3.md` (the public routes) and
`asvs-l2-portal.md` (the patient portal). Task 6.49 asks for this page and for the fresh-context review
(`judgment-day`) of webhooks, retention and archive keys, export scoping and signup abuse.

How to read it: **Met** has a test or a file you can open; **Partial** says what is missing; **Accepted**
is a decision recorded with its reason; **Later** is out of scope for this stage. Paths are relative to
the repository root.

Review status: **written by the author of the readiness slice (S6.11 and S6.12) from the code and the
tests. The independent review has not been run**: an executor cannot run a fresh-context reviewer. The
orchestrator runs it on the diff of the Stage 6 branch; what it finds is added below under "Findings of the
review", and the task stays open until then.

## V1 Architecture

| Requirement                      | Status | Evidence                                                                                                                                                                                                                                                                                                                |
| -------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.2 Authentication architecture  | Met    | A signup is public and guarded by a bot challenge, a limit per client and a token by email (`docs/stage6-tracks.md`, "Track B"); the subscription belongs to the owner alone (`billing.manage`, `packages/contracts/src/roles.test.ts`); the operator console keeps its own session and second factor.                  |
| 1.4 Access control architecture  | Met    | The operator never reads content: its routes run on the `app_operator` connection, which has no clinical table and no privilege on the archive tables, the keys or the packages (`test/integration/operator-privileges.test.ts`, `archive-release-requests.test.ts`: "has no privilege on the archive tables").         |
| 1.6 Cryptographic architecture   | Met    | Archive objects are encrypted with a data key per object that only the public key of the organization can seal; the private key is sealed to the releaser (`modules/tenancy/archive/archive-crypto.ts`, `docs/runbooks/archive-release.md`, "The processes and what each one holds").                                   |
| 1.7 Logging architecture         | Met    | The archive and the end of an organization write the platform trail (`PLATFORM_AUDIT_ACTIONS`); every action of Stage 6 has a scenario that reads the trail back (`test/policy/stage6-audit.ts`, `audit-coverage.test.ts`).                                                                                             |
| 1.8 Data protection architecture | Met    | The cancellation export is split by kind: nothing clinical in the administrative package, one clinical package per professional for their own patients (`test/integration/cancellation-export.test.ts`, `export-streaming.test.ts`).                                                                                    |
| 1.14 Configuration architecture  | Met    | `PAYMENTS_PROVIDER` and the other providers are environment only, refused local in production (`main/config-providers.ts`); the key of the releaser is refused in the API and the worker (`main/main.ts`, `assertNoReleaserKey`); the metrics port needs a token off the loopback interface (`main/config-metrics.ts`). |

## V2 Authentication

| Requirement                      | Status | Evidence                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 Passwords (signup)           | Met    | The password policy of task 1.36 applies to the signup; the password is never in the log, the answer or an email (`test/security/signup-abuse.test.ts`: "writes no address, name, password or link in the log").                                                                                                                                                                              |
| 2.2.1 Anti-automation            | Met    | A bot challenge on every public step, a limit per client with a limit of its own on each route, and one that answers before the token is looked at (`signup-abuse.test.ts`: "limits each route per client", "answers a request of a client that hammers the verification").                                                                                                                   |
| 2.2.2 Account enumeration        | Met    | The answer, the work and the time are the same for a new address, one with a signup waiting, one with an account and a name already used (`signup-abuse.test.ts`: "is the same for a new address...", "sends the database the same number of statements...").                                                                                                                                 |
| 2.3.1 Single-use, expiring links | Met    | The verification link is a `signup_verification` token by email; an expired one offers a new one and the first stops working (`e2e/stage6-signup.spec.ts`); the release link is single-use and lasts 72 hours (`archive-release.test.ts`).                                                                                                                                                    |
| 2.8 Operator second factor       | Met    | Releasing archived records takes a different operator to approve than the one who recorded and the one who verified the identity; the database refuses any rewrite of who took a step, on every update (`archive-release-requests.test.ts`). The operator of the session travels in `app.user_id`, which protects against bugs and console misuse, not against a hostile database credential. |

## V3 Session management

| Requirement     | Status | Evidence                                                                                                                                                                                                                                           |
| --------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1 Fundamental | Met    | A verified signup signs the owner in on the host of the new organization only (`e2e/stage6-signup.spec.ts`: "opens the emailed link on the new organization and activates it"); the link never points at a host the request named.                 |
| 3.7 Defenses    | Met    | The package links of the cancellation export are bound to the session that asked for them and last five minutes (`platform/tokens/kinds.ts`, `cancellation_export`; `test/integration/cancellation-export.test.ts`: "who may have which package"). |

## V4 Access control

| Requirement                     | Status | Evidence                                                                                                                                                                                                                                               |
| ------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 4.1 General access control      | Met    | Every route of Stage 6 declares its read-only category and its audit (`test/policy/stage6-routes.ts`, `stage6-audit.ts`); a professional, reception and admin are denied on the subscription (`e2e/stage6-signup.spec.ts`, `e2e/stage6-demo.spec.ts`). |
| 4.1.3 Least privilege           | Met    | The reception of a read-only organization is refused every write with the reason and without a word about the billing (`e2e/stage6-signup.spec.ts`; `test/integration/demo-platform.test.ts`).                                                         |
| 4.2.1 IDOR                      | Met    | A clinical package is for the professional it was made for and nobody else; an owner who is not a professional gets nothing clinical (`cancellation-export.test.ts`: "who may have which package").                                                    |
| 4.3.1 Administrative interfaces | Met    | The operator console routes sit behind the operator session; the archive release answers only counts and states, never content (`archive-release-requests.test.ts`: "never gets a record, a key or a name of an object").                              |

## V6 Stored cryptography

| Requirement             | Status  | Evidence                                                                                                                                                                                                                                                    |
| ----------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6.1 Data classification | Met     | The archive holds the clinical record, encrypted object by object; the objects carry a manifest with the SHA-256 of each (`archive-write.test.ts`).                                                                                                         |
| 6.2 Algorithms          | Met     | AES-256-GCM per object, RSA-OAEP (3072 bits, SHA-256) for the data key, an X25519 sealed box for the private key (`archive-crypto.ts`); each ciphertext is bound to its organization, object and key version through the authenticated data.                |
| 6.4 Secret management   | Partial | The key of the releaser (`ARCHIVE_RELEASER_KEK`) is one environment variable of one process. A cloud deployment keeps it in a secret store with a recovery owner, and the real archive store has a dedicated KMS key per environment (task 6.51, deferred). |

## V7 Error handling and logging

| Requirement        | Status | Evidence                                                                                                                                                                                                                                  |
| ------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7.1 Log content    | Met    | No address, name, card, token or secret in the logs or in the audit metadata of Stage 6 (`signup-abuse.test.ts`; the audit metadata refuses `cardNumber`, `cvv`, `pan`, `token` and `secret`, `packages/contracts/src/audit-actions.ts`). |
| 7.4 Error handling | Met    | The metrics port answers "metrics unavailable" and never the reason a measurement failed (`platform/metrics-server.test.ts`); a webhook refusal is one generic answer (`mp-webhook.test.ts`).                                             |

## V8 Data protection

| Requirement                     | Status | Evidence                                                                                                                                                                                                                                                              |
| ------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8.1 General                     | Met    | No card data is stored: the owner sees the label the provider gives, and the schema has no column for a card (`subscription-checkout.test.ts`: "keeps no card"). The simulated provider says so on every screen and in the hosted page.                               |
| 8.3 Sensitive private data      | Met    | The metrics are counts, ages and codes; the labels are queue names, statuses and steps (`platform/metrics-catalog.test.ts`, "keeps patient data out of the labels it documents"; `test/integration/platform-metrics.test.ts`, "exposes only counts and short codes"). |
| 8.2 Client-side data protection | Met    | The export packages and the release package are served by the door of the files with `no-store`, as an attachment (`cancellation-export.test.ts`; `archive-release.test.ts`).                                                                                         |

## V9 Communication

| Requirement              | Status | Evidence                                                                                                                                                                                                                                                                                                             |
| ------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9.1 Client communication | Later  | TLS is terminated by the reverse proxy (`docs/dev-setup.md`). `MP_PUBLIC_BASE_URL` must be https in production (`config-providers.ts`).                                                                                                                                                                              |
| 9.2 Server communication | Met    | The webhook of Mercado Pago is verified with the HMAC of its manifest and a five-minute window over the RAW body before anything is read (`adapters/mercadopago-fake/mp-signature.ts`, `mp-signature.test.ts`; `mp-webhook.test.ts`: "answers one generic refusal to a forged, altered, unsigned and stale notice"). |
| 9.3 Metrics port         | Met    | The metrics port is off unless `METRICS_PORT` is set, listens on the loopback interface by default, and refuses to start on another interface without a token of 24 characters or more, compared in constant time (`main/config-metrics.test.ts`, `platform/metrics-server.test.ts`).                                |

## V11 Business logic

| Requirement             | Status  | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11.1.1 Sequential steps | Met     | A subscription becomes active only when the provider CONFIRMS something and moves on a date, never on a missing confirmation; an outage skips a step (`billing-timeline.test.ts`, `subscription-state.test.ts`: the property that no sequence of unconfirmed inputs changes the state).                                                                                                                                                                                                                                                           |
| 11.1.4 Anti-automation  | Partial | The public signup is behind a proof-of-work challenge and three counters: per client, per mailbox (a `+tag` alias is the same mailbox) and one overall ceiling that fails CLOSED when the counters store fails (the other two fail open and say so in the log), and unconfirmed signups are purged after seven days (`signup.test.ts`, `signup-abuse.test.ts`, `limits.test.ts`). The rate-limit store itself is not shared across API instances yet. The idempotence of the payment webhook is an integrity property (V13), not anti-automation. |
| 11.1.5 Business limits  | Met     | The overage cap is between 0 and the plan maximum, never unlimited; nothing is collected without a published statement and not before the third day after it (`quota-policy.test.ts`, `statement.test.ts`).                                                                                                                                                                                                                                                                                                                                       |
| 11.1.6 Race conditions  | Met     | The payments gateway is written for a provider that is not idempotent: the intent is written before the call, the answer after it, an unknown outcome is searched by reference and never repeated before the settle window (`docs/stage6-tracks.md`, "The rules that this stage learned the hard way"; `payments-gateway.test.ts`).                                                                                                                                                                                                               |
| 11.1.8 Resource limits  | Met     | The export reads the big tables a page at a time and the lint runs in shards: neither holds a whole table or the whole tree in memory (`export-streaming.test.ts`, `packages/config/eslint/shards.test.js`).                                                                                                                                                                                                                                                                                                                                      |

## V12 Files and resources

| Requirement         | Status  | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 12.1 Upload         | Met     | The release package and the export packages are built from bytes the platform wrote; every attached file is checked against its recorded SHA-256 (`package-content.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 12.3 File execution | Met     | A package is a zip that nothing opens on the server; a key that would leave the folder is refused (`scripts/drill/store.ts`, `downloadFolder`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 12.5 Retention      | Partial | An archived object cannot be altered, shortened or deleted by the writer, the operator or a tenant role; the only way out before the end of the retention is the privileged `legal-erasure` identity, run by an operator and a second operator named on the command (an attribution, not an approval: no row confirms it; a real second approval is open work) with the intent written to the platform trail first (`archive-immutability.test.ts`, `legal-erase.test.ts`). It is governance mode: an administrator of the bucket account can still bypass it. The hot rows of a cancelled organization and the backups are NOT covered by the archive or by the erasure, and the ids on the erasure command are attribution, not authentication (`docs/runbooks/archive-release.md`). |

## V13 API

| Requirement  | Status | Evidence                                                                                                                                                                                                                   |
| ------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13.1 Generic | Met    | Every body, query and param of Stage 6 has a strict schema shared with the web (`packages/contracts/src/{subscriptions,signup,cancellation}.ts`); a route without a read-only category fails the boot and the policy test. |

## V14 Configuration

| Requirement                | Status | Evidence                                                                                                                                                                                                                                                                                           |
| -------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 14.1 Build                 | Met    | The lint runs in shards of at most 300 files, so a type-aware rule cannot silently stop for lack of heap (`packages/config/eslint/lint.js`); the alert rules are checked by `promtool` in CI and by a test that they read only series the application exposes (`test/policy/alert-rules.test.ts`). |
| 14.2 Dependency            | Met    | No dependency was added by Stage 6 readiness. The audit of production dependencies runs in CI.                                                                                                                                                                                                     |
| 14.3 Unintended disclosure | Met    | The operator sees counts and states of subscriptions and archives, never content; the platform demo is refused in production (`stage6/guard.ts`, `demo-platform.test.ts`).                                                                                                                         |
| 14.5 HTTP request header   | Met    | The hosted page of the local Mercado Pago sets its own `Content-Security-Policy`, `Referrer-Policy` and `X-Robots-Tag` and asks for no card (`mp-webhook.test.ts`, "says it is simulated, offers approve, reject, pending and abandon, and asks for no card").                                     |

## Readiness evidence

| Claim                                                                       | Evidence                                                                                                                                                                 |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A backup can be restored and the copy is faithful, chains included          | `pnpm drill:restore`; `test/integration/restore-drill.test.ts` (it passes on the demo data and fails, naming the event, when a sealed event was altered before the dump) |
| A person is woken when the worker stops, a chain breaks or a queue is stuck | `infra/alerts/rules.yml`, `docs/runbooks/incident.md`; the checks above                                                                                                  |
| The end of an organization is rehearsed from the console to the release     | `e2e/stage6-demo.spec.ts` (cancel, split export, archive), `e2e/stage6-archive.spec.ts` (release once), `docs/runbooks/tenant-cancellation.md`                           |
| What is left for the owner is listed and cannot fall behind the plan        | `docs/go-live-checklist.md`, `test/policy/go-live-checklist.test.ts`                                                                                                     |

## Accepted decisions

- **The metrics of the platform are measured organization by organization** as the system, one statement
  each, every minute, except for a cancelled organization (only its subscription is read) and for the
  figures no organization can answer, which come from one definer function (`app.platform_health()`:
  archives, release requests, unconfirmed signups, the heartbeat of the releaser). It keeps row level
  security whole and costs one query per live organization per minute; with thousands of organizations the
  interval is the change (`main/platform-metrics.ts`).
- **Version 1 keeps the hot rows of a cancelled organization** and treats the archive as the copy in
  custody; the exception list of the plan has no entry for removing them. The owner confirms the policy
  (`docs/go-live-checklist.md`).
- **The restore drill compares counts, not contents.** A count between the one before and the one after the
  dump, and the chains of the audit trail, are what a script can prove without reading patient data; the
  person who opens a record on the copy (checklist item 5 of the runbook) proves the rest.

## Findings carried to the review

- The independent review of webhooks, retention and archive keys, export scoping and signup abuse.
- The real adapters (tasks 6.50 to 6.52) change the surface of V9 and V6: they need this page read again.
- `auth.password.changed` and `cross_tenant.denied` are still pending scenarios of Stage 1 (a screen that
  was not built, and an event that has no writer); neither belongs to Stage 6, and both are in the plan of
  the owner.

## Findings of the review

The fresh-context review ran as a Judgment Day: two blind judges, four rounds, on the whole Stage 6 diff. Each
round's findings and fixes are in `openspec/changes/health-practice-saas/apply-progress.md`.

- **Round 1:** two CRITICAL findings, both closed. A subscription whose creation was parked could be charged
  twice. A superseded preapproval kept charging after a new checkout: it is now cancelled first, and its
  charges are flagged as surplus.
- **Rounds 2 and 3:** no CRITICAL findings. Among the fixes:
  - a refund token answered from every attempt;
  - a four-eyes trigger that covers every `*_by` column;
  - export cleanup after a legal erasure;
  - resend without rotating a young link;
  - status-guarded release steps;
  - an empty legal-erasure listing that needs a prior intent.
- **Round 4:** both judges approved. Both raised one WARNING: an `intent` whose run was refused before
  erasing anything still counted as proof. It is fixed: `hasIntent` ignores an intent followed by an
  `incomplete` entry with no object erased, and an integration test covers it.
- **Open, accepted for version 1:**
  - The legal erasure names a second operator but records no separate approval. The runbook says so.
  - The supersede step does not reconcile first, so a charge not yet seen is flagged as surplus instead of
    being credited. An operator reviews it.
  - `lastReconciledAt` moves even after an incomplete search for strays.
