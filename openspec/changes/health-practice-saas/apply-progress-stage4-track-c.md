# Apply progress: Stage 4, track C, first wave (S4.08 and S4.09, tasks 4.35 to 4.42)

Change: `health-practice-saas`. Branch `feat/stage-4-track-4c`, from the seam tip `caf5ee1`. Mode: automatic, strict TDD, `size:exception` (work-unit commits, no PR, no merge, CI not polled). This file is separate from `apply-progress.md` on purpose; the orchestrator merges it.

S4.10 to S4.13 (tasks 4.43 to 4.56) are **pending**: they need track A's charge lines (migration 0444 has a foreign key and a trigger on `charge_line`, from 0412). The real WSAA/WSFEv1 adapter (4.68, 4.69) is deferred and was not started.

## Status of the tasks

| Task | State   | Notes                                                                                                                                                                                                                                                                                                                     |
| ---- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.35 | done    | `fiscal_profile`, `point_of_sale`, `fiscal_credential`, migration `0440_fiscal_config.sql`, fixtures, isolation suite. The `enabled` column is not there: the switch is `settings.integrations.einvoicing` (see deviations).                                                                                                |
| 4.36 | done    | `GET /invoicing/config`, `GET /invoicing/readiness`, `PUT /invoicing/profile`, `POST|PATCH /invoicing/points-of-sale`. CUIT through the country pack, environment per point of sale, homologation forced while the issuer is a simulator.                                                                                  |
| 4.37 | done    | `PUT /invoicing/credentials` (Node `X509Certificate`, key match, CUIT in the subject, encrypted with the tenant key), state `valid|expiring|expired|invalid`, job `fiscal.credential_watch` (email to the owners, once per certificate), `pnpm dev:afip-cert`.                                                            |
| 4.38 | done    | The switch is the seam's `integrations.einvoicing` (owner and admin through `tenant.settings.manage`, audited as `invoicing.config.changed`); `invoicingReadiness` blocks new invoices while it is off. "Old invoices stay readable" has nothing to read yet: it is proven for the configuration and left to S4.10 for invoices. |
| 4.39 | done    | `country/ar/afip/invoice-type.ts`, reached through `CountryPack.invoiceRules`. `InvoiceIssuer` is `implemented: true` in `legal-adapters.ts`.                                                                                                                                                                              |
| 4.40 | done    | `adapters/afip-local/` + migration `0442_local_afip.sql` (platform tables, no `tenant_id`), modes `ok|down|slow|timeout_after_authorize|reject_next`, sequential numbering under concurrency, `findIssued`.                                                                                                               |
| 4.41 | done    | `adapters/afip-fake/` (in memory, deterministic CAE) and the shared suite `adapters/invoice-issuer.contract.ts`, run on both.                                                                                                                                                                                             |
| 4.42 | done    | Customer slot filled while `AFIP_PROVIDER=local`; `/operator/dev/afip/{state,mode,reset}`; `features/operator/dev/afip/` tab. Absent unless `LOCAL_PROVIDERS_CONSOLE` is on.                                                                                                                                              |
| 4.54 | partial | The settings half only (profile, points of sale with environment, certificate upload and state, enable switch, simulated banner). The rest of 4.54 belongs to S4.13 and the task stays unchecked.                                                                                                                         |

## Commits (oldest first)

1. `f758d19` invoice type rules through the country pack (4.39)
2. `f39d585` fiscal tables, migration 0440 (4.35)
3. `dd2bfda` credential reading, state rules, dev certificate generator and `dev:afip-cert` (4.37)
4. `ac1fcb9` fiscal routes, readiness, encrypted upload, credential watch job (4.36 to 4.38)
5. `924bdb0` fake and local issuers, contract suite, migration 0442, console controls (4.40 to 4.42)
6. `8ede610` fiscal settings tab and the AFIP simulator tab (4.42, 4.54 settings half)

## Migrations

`0440_fiscal_config.sql` (three tenant tables, row level security forced, `REVOKE DELETE, TRUNCATE`) and `0442_local_afip.sql` (three platform tables without `tenant_id`; `REVOKE UPDATE, DELETE, TRUNCATE` on vouchers and requests, `REVOKE DELETE, TRUNCATE` on the control row). Both pass `db:check`. `0444` (invoices) is untouched, for the next wave.

## The issuer port and the simulator modes

The port is the Stage 1 `InvoiceIssuer` of `packages/contracts/src/ports.ts` (`issue(request, idempotencyKey)`, `findIssued(ref)`). Optional fields were added (declared exception 2, and one beyond it, see deviations): on `InvoiceRequest` the `issuerCuit`, `environment`, `buyerName`, `buyerTaxCondition`, `concept`, `netCents`, `vatCents`, `exemptCents`; on `InvoiceRef` the `issuerCuit`.

Both simulators (`createFakeInvoiceIssuer`, `createLocalInvoiceIssuer`) carry `simulated: true`; the module reads it (`isSimulatedIssuer`) to say "simulated" and to force homologation.

| Mode                      | What the simulator does                                                                        | Lasts      |
| ------------------------- | ---------------------------------------------------------------------------------------------- | ---------- |
| `ok`                      | authorizes: next number per issuer CUIT, point of sale and type; 14 digit CAE; expiry date + 10 days | sticky     |
| `down`                    | `retryable`, `outcomeUnknown: false`, nothing issued; `findIssued` also `retryable`            | sticky     |
| `slow`                    | answers after `slowMs` (default 1500), then as `ok`                                            | sticky     |
| `timeout_after_authorize` | authorizes and commits, then answers `retryable`, `outcomeUnknown: true`                       | next request only |
| `reject_next`             | rejects the next request with a simulated message                                              | next request only |

Rules shared by both (`adapters/afip-local/voucher-rules.ts`): the same idempotency key and request give the same answer (voucher or rejection); the same key with another request is refused; a rejection consumes no number; refusals mimic AFIP (bad buyer CUIT, total different from net + VAT + exempt, Factura A without a buyer CUIT, bad date, currency, amount). `reset` on the local simulator moves an `epoch` forward instead of deleting (the application role cannot delete).

## What S4.10 to S4.13 need from track A

- Charge lines readable through `modules/billing/index.ts` exports: id, charge id, patient, portion (`patient|payer`), description, `amount_cents`, `invoiced_cents`, and the charge status (voided or not). S4.10 reads them with `SELECT ... FOR UPDATE` and keeps `charge_line.invoiced_cents` in step with a trigger (migration 0444, after 0412 in the journal).
- The payer of a charge (id and name) for a payer invoice. **Gap found:** the platform `payer` catalog has no CUIT, and the pack's invoice rules want the payer CUIT for a Factura A. Either track A's `tenant_payer` (0410) carries a nullable `cuit`, or S4.10's recipient form asks for it.
- The patient portion / payer portion split is by line, which the spec already says.
- For the void rule (task 4.14 of track A): `invoiceLookup` is still the seam stub; S4.10 (task 4.45) replaces it without changing the signature.
- After S4.02 merges: `pnpm db:restamp` then `pnpm db:check` before creating 0444.

Things S4.10 to S4.13 can use from this wave: `invoicingReadiness(tx, deps)` (exported from the module `index.ts`), `packFor(country).invoiceRules` (`resolveInvoiceType`, `creditNoteTypeFor`, `checkRecipient`), the issuer through `adapters.forTenant(tenant, 'invoiceIssuer')`, `isSimulatedIssuer`, and the `afip.issue` queue with its read-only class from the seam. The reconciliation the issue job needs is `issue` again with the same idempotency key (idempotent in both simulators) and `findIssued({ issuerCuit, pointOfSale, type, number })`.

## TDD cycle evidence

| Task | Tests | RED | GREEN | Notes |
| ---- | ----- | --- | ----- | ----- |
| 4.39 | `invoice-type.test.ts` (26: table of issuer x recipient, forbidden types, credit note types, recipient data per type, threshold boundary), `ar-pack.test.ts` | module missing | passed (26, then 35 with the pack) | |
| 4.35 | `fiscal-config-schema.test.ts` (9), generated isolation suite with `fixtures/invoicing.ts`, `no-delete-privileges`, `demo-coverage` | tables missing (9 failed, `42P01`) | passed | `demo-coverage` needed the exemptions file; vitest cached the transform of its glob (see risks) |
| 4.37 | `dev-afip-certificate.test.ts` (5), `credential.test.ts` (16: parse, fingerprint, mismatch, expired, state table with the 30 day boundary), `dev-afip-cert.test.ts` (7) | modules missing | passed | two test mistakes fixed (a date computed by hand, milliseconds in the dates the generator returns) |
| 4.36, 4.37, 4.38 | `fiscal-config.test.ts` (38 through the real application: roles, CUIT, points of sale, readiness, upload, ciphertext, logs, audit), `fiscal-credential-watch.test.ts` (8), `invoicing.test.ts` wiring (2) | written first against missing modules (not executed before the code) | passed (46) | the order of `changedFields` in a test and the milliseconds of the certificate dates were wrong in the tests, not in the code |
| 4.41 | `invoice-issuer.contract.ts` run by `afip-fake/index.test.ts` (13 contract + 4 own) | 16 failed against the seam placeholder | passed (17) | |
| 4.40 | `afip-local.test.ts` (23: the same contract on Postgres, 12 requests at once, same key twice at once, shared mode, one-shot modes, list, reset, no update/delete) | tables and adapter missing | passed (23) first run | |
| 4.42 | `afip-console.test.ts` (6), `invoicing.test.ts` wiring (5 more), `afip-simulator.test.tsx` (8) | dev routes / tab missing | passed | the voucher date showed one day early: `formatDate` shifts a date-only value, `formatCalendarDay` does not |
| 4.54 (settings) | `invoicing-settings.test.tsx` (29 with axe), `forms.test.ts` (13) | feature missing | passed (42 for the folder) | lint moved the e-invoicing PATCH into the feature's own api file (a feature cannot import another feature's internals) |

Honest note on RED: for 4.36 to 4.38 and the settings screen the tests were written before the code and referenced modules that did not exist, but I ran them for the first time together with the implementation. For 4.39, 4.35, 4.41, 4.40 and 4.42 the failing run was executed and seen.

## Deviations from the tasks and the design

1. **`fiscal_profile` has no `enabled` column** (task 4.35 lists one). The switch is `settings.integrations.einvoicing`, which the seam registered, audited and tested; a second copy would disagree with it. Task 4.38 uses the setting.
2. **The credential `state` is derived, not stored** (task 4.35 lists a `state` column). It depends on the clock and on the CUIT of the profile (a certificate stops being valid for it when the CUIT changes), so a stored value would be stale. The table keeps `not_after`, `subject_cuit` and `expiry_warned_at`; every response recomputes the state.
3. **`InvoiceRef` also gained an optional `issuerCuit`** (declared exception 2 names `InvoiceRequest` only). Numbering is per issuer, so without it `findIssued` of a shared simulator could answer with another organization's voucher. Optional, so other adapters compile.
4. **Exempt issuers issue Factura C** in the type rules. The specification names rules for monotributo and responsable inscripto only; an exempt issuer does not itemize VAT. Decision recorded in `invoice-type.ts`; to be confirmed.
5. **`legalAdapters` says `implemented: true` for `InvoiceIssuer`** as the declared exception asks, although the WSAA/WSFEv1 adapter is deferred: it means the port has working adapters (fake, local). The comment says so.
6. **Expiring means 30 days or fewer** (the task says both "under 30 days" and "30 days or fewer"); the day counts.
7. **A simulator needs no certificate** to issue; a real issuer does. An expired or mismatched certificate that is there blocks in both cases.
8. **Simulator reset is an epoch, not a delete**: the application role cannot delete (a policy test enforces it).
9. **`one-shot` modes**: `timeout_after_authorize` and `reject_next` fire once and go back to `ok` by themselves (the tasks do not say).
10. **The contract file is run by `afip-fake/index.test.ts` and `test/integration/afip-local.test.ts`**; there is no file named `invoice-issuer.contract.test.ts`.
11. **`IDENTIFICATION_THRESHOLD_CENTS`** (amount from which a consumer must be identified) is a constant of the pack; its value must be confirmed against the current ARCA resolution before the real adapter.
12. **Pack failure keys `country.ar.invoice.*` have no es-AR text yet.** Their texts would go in `packages/contracts/src/country/ar/messages.ts` (not in track C's list). Nothing shows them in this wave; S4.10 maps them to `invoicing:` texts in `locales/es-AR/invoicing.json` or asks the seam for the messages.

## Risks and follow-ups

- vitest caches the transform of a file that uses `import.meta.glob` by content: after adding a glob-found file (a fixture, a demo exemption) `demo-coverage.test.ts` kept failing locally until `node_modules/.vitest-cache` was removed. A fresh checkout (CI) is not affected.
- `check-migration-drift.test.ts` (two tracks, one merge) times out at 180 s when the machine is overloaded (other agents running); it passes alone.
- The credential watch emails the owners from the worker with the organization's email adapter; the first real run is not covered by an end to end test (the job is tested through `runJob`).
- Payer CUIT is missing from the payer catalog (see "What S4.10 to S4.13 need from track A").
- The `invoices` navigation entry and the `invoice_pdf` token kind are not touched (S4.12, S4.13).

## Verification

Node v24.22.0, pnpm 10.34.7, Docker shared with other agents and projects; ports 3740, 4740, 9740. Tip before this progress commit: `8ede610`.

| Command | Result |
| --- | --- |
| `corepack pnpm install --frozen-lockfile` | exit 0 |
| `corepack pnpm typecheck` | exit 0 (contracts, api, web) |
| `corepack pnpm lint` / `format:check` | exit 0 / exit 0 |
| `corepack pnpm test` | **337 files; 4,362 passed, 1 failed under load** (`check-migration-drift.test.ts`, the two-track tool test, timed out at 180 s while the machine was overloaded; alone it passes, 17 of 17 with the PDF frame test). `boot.test.ts` included and green: boot stays DB-free |
| `corepack pnpm test:integration` | **184 files, 181 passed, 1 skipped (ClamAV), 2 failed under load; 2,875 tests passed, 2 failed.** The two: `waitlist-offer-link` "exactly one appointment when reception and the patient take the slot at once" (a race test; 19 of 19 on two reruns alone) and `worker.test` "seals new audit events ... shortly after" (a timing test; passes alone). Neither touches code of this wave |
| `corepack pnpm build` | exit 0 (the invoicing settings page is its own lazy chunk; the entry chunk holds none of it) |
| `corepack pnpm db:check` | No migration drift |
| `test:e2e` (`vite build`, ports 3740/4740/9740, `--workers=3`) | **185 passed** (the seam's number; this wave adds no e2e: the invoicing spec belongs to S4.13) |

CI, Lighthouse and the real ARCA adapter were not run. No `.env` file was read or written. No certificate or key fixture looks real: every test certificate is generated on the spot by `src/testing/dev-afip-certificate.ts` (subject "DEV ONLY").

---

# Wave 2: S4.10 to S4.13 (tasks 4.43 to 4.56)

Branch `feat/stage-4-track-4c`, based on the Stage 4 integration tip `aba4fa2` (local merge `1341e5d`). Strict TDD mode, artifact store `openspec`. Ports 3820, 4820, 9820 for the end to end run.

## Status of the tasks

All of 4.43 to 4.56 are `[x]` in `tasks.md`. Task 4.54 was left partial by wave 1 (settings); its second half (invoice screens, states, the prolonged-outage flag and the manual entry dialog) is in this wave.

| Slice | Tasks | What |
| ----- | ----- | ---- |
| S4.10 | 4.43 to 4.46 | Tables, immutability, `invoiced_cents` balance, create invoice, credit notes, rejected attempts, real `invoiceLookup` |
| S4.11 | 4.47 to 4.50 | The `afip.issue` job, the retry clock, outage visibility, manual entry, read-only rules |
| S4.12 | 4.51 to 4.53 | PDF with the AFIP QR, delivery by email, `invoice_pdf` token kind, `listInvoicesForPatient` |
| S4.13 | 4.54 (second half), 4.55, 4.56 | Screens, drawer panel, nav entry `invoices`, credit note dialog, `e2e/stage4-invoicing.spec.ts` |

## Commits (oldest first)

| Commit | What |
| ------ | ---- |
| `2fd5ded` | Invoice tables, immutability triggers, `invoiced_cents` balance (migration 0444) |
| `aab6b8e` | es-AR texts for the `country.ar.invoice.*` failure keys |
| `1f70e36` | Create invoice, credit notes, rejected attempts, real `invoiceLookup` |
| `514cd6b` | Issue job, retry clock, outage handling, manual entry, read-only rules |
| `3329000` | Invoice PDF with QR, email delivery, PDF links, invoices of a patient |
| `3f9db75` | Read functions for the reports and the options of the invoice form |
| `ae1f4ca` | The provider console drives the demo fake issuer |
| `24f0efd` | Invoicing screens, issue dialog, credit notes, the invoices of a charge |
| `d874efd` | `stage4-invoicing.spec.ts` at 360 px (and the card fix it found) |
| `9a1e5c0` | The console shows a mode only for the simulator that serves customers |

## Migrations

- `0444_invoices.sql`: `invoice`, `invoice_line`, `invoice_document`; the triggers `guard_invoice`, `guard_invoice_insert`, `guard_invoice_line_insert`, `refuse_invoice_line_update`, `guard_invoice_document`; `app.refresh_invoiced` (the only writer of `charge_line.invoiced_cents`, `GRANT EXECUTE` to `app_rw`). The foreign key from `invoice_line` to `charge_line` sits inside the `NO FORCE` / `FORCE` lift of `charge_line`, as the task required.
- `0446_appointment_type_invoice_description.sql`: nullable `appointment_type.invoice_description` (1 to 120 characters) so an invoice line can carry the wording of the service.

`db:restamp` and `db:check` were run first (nothing to restamp) and at the end ("No migration drift").

## Design as built

- **Retries are not self-requeued jobs.** A job that is enqueued again gets a new `createdOn`, and the read-only gate (`jobMayRun` / `assertTenantWritable`) judges a job by `enqueuedAt` against `read_only_since`: a retry would be cancelled in a read-only organization. The retry clock is the `runDueAttempts` sweep (every 30 seconds) over `invoice.next_attempt_at` (1 minute doubling to 6 hours), judged by the `created_at` of the invoice. A request made before the read-only date keeps being submitted.
- **One attempt per invoice at a time** (advisory lock). Lock order: charge lines by id, then the invoice row.
- **Unknown outcome**: before any new send the module probes `findIssued(expected number)`; then `issue()` with the same idempotency key (the port promises idempotency). A timeout after authorization yields exactly one voucher (tested with the simulator mode `timeout_after_authorize`).
- A pending invoice also counts as "standing over" a charge, so a charge cannot be voided while an invoice for it is pending.
- Manual entry (owner and admin only) may `replacesInvoiceId`: the pending invoice is closed as rejected so it is never issued as well.
- Credit notes: pending ones count against the cumulative limit; `invoiced_cents` drops only when the note is issued. The void route always answers 409 (an issued invoice is never voided; the way back is a credit note).
- Invoices are sent by email only (never WhatsApp); a payer invoice is not emailed.

## Read functions exported for the reports (S4.14)

From `modules/invoicing/index.ts`:

- `readInvoicedLines(tx, { from, to })` returns `InvoicedLine[]`: one row per invoice line of an issued or manual voucher with `locationId`, `professionalId`, `payerId` and `payerName` (or none for a private payment), `patientId`, `issueDate`, `type`, `kind` and a signed `netCents` (credit notes are negative).
- `summarizeInvoiced(rows, groupBy)` with `groupBy` in `total | day | month | location | professional | payer | type` returns `InvoicedGroup[]` (`key`, `label`, `invoicedCents`, `creditedCents`, `netCents`, `documents`). The private payer is `PRIVATE_PAYER_KEY` (`'private'`). Only issued and manual vouchers count.
- Also: `listInvoicesForPatient` (audits `patient.read`), `invoiceLookup` (the real lookup behind the void rule of track A), `runDueAttempts`, `invoicingReadiness`.

## TDD cycle evidence

| Task | Tests | RED | GREEN | Notes |
| ---- | ----- | --- | ----- | ----- |
| 4.43 | `invoice-invariants.test.ts` (DB level: immutability, cumulative limit, line rules, FORCE RLS), isolation suite with the `invoice` fixture | tables missing | passed | RED first. Two bugs found by the tests: a pending row could carry only a CAE (CHECK split in two equalities), and a plpgsql `CASE` inside an `IF` |
| 4.44 | `invoice-create.test.ts` (including a fast-check concurrency property), `invoice-amounts.test.ts` | functions missing | passed | The application code was written before the HTTP level tests; RED was seen at behavior level (domain and DB tests) |
| 4.45, 4.46 | `credit-note.test.ts`, `invoice-rejection.test.ts`, extended `invoice-type.test.ts` | module missing | passed | Same remark as 4.44 for the HTTP level |
| 4.47, 4.48, 4.50 | `afip-issue-job.test.ts`, `retry-schedule.test.ts`, `billing-read-only` extensions | job missing | passed | RED first for the job and the schedule |
| 4.49 | `invoice-manual.test.ts` | route missing | passed | Contracts and domain tests written together with the code |
| 4.51 | `invoice-qr.test.ts`, `render-invoice.test.ts`, `invoice-render.test.ts` | module missing | passed | |
| 4.52 | `invoice-email.test.ts`, `invoice-render.test.ts`, `kinds.test.ts`, `public-tokens.test.ts` | token kind off | passed | `invoice_pdf` enabled with its `ELSEWHERE` line |
| 4.53 | `invoice-patient-list.test.ts` | function missing | passed | |
| reads | `invoiced-summary.test.ts`, `invoice-reads.test.ts`, `invoicing-options.test.ts`, `appointment-type-invoice-description.test.ts` | functions missing | passed | |
| 4.54 to 4.56 (web) | `invoice-display.test.ts`, `submission-key.test.ts`, `invoices-page.test.tsx`, `issue-invoice.test.tsx`, `invoice-detail.test.tsx`, `charge-invoices-panel.test.tsx` (113 tests for the feature folder, with axe) | feature missing | passed | |
| 4.56 | `e2e/stage4-invoicing.spec.ts` | the first full run failed on the width of the page (41 px) with a credit note in the list | passed (2 of 2 with the operator setup) | The button "Ver detalle de Nota de crédito C 0001-0000000N" did not wrap: the visible label is now "Ver detalle" with the full accessible name in `aria-label`, and the grids use `grid-cols-1` |

Honest note: for 4.44 to 4.46 and 4.47 the application code was written before the HTTP level tests; the failing run that was seen is at behavior level (domain and database tests). The invariants test (4.43) and the later items had RED first.

## Deviations from the tasks and the design

1. **Sweeper instead of re-enqueued retries** (see "Design as built"): required by the read-only rule. The job `afip.issue` is enqueued once per request.
2. **`loadNoticeRecipient`** added to the notifications `index.ts` and **`readInvoiceWording`** to the scheduling `index.ts` (invoice email recipient and the line wording). Both are read-only exports.
3. **Migration 0446 and the field `invoiceDescription`** on the appointment type (DTO, create, update). Four web fixtures and two raw JSON responses in `onboarding/wizard.test.tsx` gained `invoiceDescription: null`.
4. **The es-AR texts of the failure keys** live in `packages/contracts/src/country/ar/messages.ts` (deviation 12 of wave 1 left that open).
5. **`GET /invoicing/options`** was added (types by recipient condition and active points of sale) so the issue dialog shows the type the rules give without duplicating them in the web.
6. **A pending invoice also blocks voiding a charge.**
7. **The provider console drives the demo fake** (one fake per configuration, held in a `WeakMap`): without it the end to end journey could not put the demonstration organizations in an outage, since they never use the local simulator. `status().mode` stays `null` when the simulator does not serve customers.
8. **`readInvoicedLines` has a flat read model**; grouping is done by `summarizeInvoiced` in memory over the requested period.
9. **The PDF snapshot of the issuer data is taken at render time** (the job renders from the invoice and the fiscal profile of that moment).
10. **A manual number that collides with an AFIP-issued number** leaves the manual invoice pending with a clear error, never issued.
11. **`listInvoicesForPatient` audits with `patient.read`.**
12. **Manual invoices get no PDF and no email** (the owner has the original document); payer invoices are not emailed.
13. **The `/files/:token` door** serves the invoice PDF with the `invoice_pdf` kind (session bound, 5 minutes, one use).

## Risks and follow-ups

- The end to end stack has no S3 configuration, so the `invoice.pdf` job is not registered there: the journey shows "El PDF se está preparando." and the PDF download is covered by integration tests only (`invoice-render.test.ts`), not in the browser.
- Exempt issuers get Factura C and health services are treated as exempt from VAT for A and B: assumption to confirm with an accountant before production.
- The real WSAA and WSFEv1 adapter (4.68, 4.69) is untouched: with `AFIP_PROVIDER=afip` nothing is issued for customers.
- The retry clock runs every 30 seconds with a first wait of one minute: a recovery shows up between one and two minutes later. The end to end spec waits for it (about two minutes total).
- The `invoiced_cents` column has exactly one writer (`app.refresh_invoiced`); a future write path must go through the invoice tables.
- Known load flakes: `src/platform/pdf/render.test.ts` (first load, 5 s) and `check-migration-drift` under a busy machine. Both pass alone.
- Shared Docker daemon: an end to end start failed twice with a container port problem while the previous run containers were still going down; the containers of this track were removed by id.

## Verification (wave 2)

Node v24.22.0, pnpm 10.34.7, ports 3820, 4820, 9820. Code tip before this progress commit: `9a1e5c0`.

| Command | Result |
| --- | --- |
| `corepack pnpm install --frozen-lockfile` | exit 0 |
| `corepack pnpm typecheck` | exit 0 |
| `corepack pnpm lint` / `format:check` | exit 0 / exit 0 |
| `corepack pnpm test` | 375 files, 4,765 tests: 4,763 passed; 2 failed: `render.test.ts` (known first-load timeout, passes alone 12 of 12) and `wiring.test.ts` (a real regression of mine: the console status showed `ok` instead of `null`; fixed in `9a1e5c0`, `src/main/wiring` 40 of 40) |
| Targeted `test:integration` (invoicing, credit notes, AFIP job, fiscal config, console, void, read-only, demo coverage, no-delete, notifications, scheduling config, `test/policy`, `test/security`) | 40 files, 603 tests passed |
| Isolation suite (`test/tenancy`), `migration-lanes`, `tenancy-schema` | 4 files, 362 tests passed |
| `corepack pnpm build` | exit 0; the invoicing page, the drawer panel and the settings are lazy chunks (`InvoicesPage` 16.5 kB, `ChargeInvoicesPanel` 2.7 kB); the entry chunk is 383.67 kB |
| `corepack pnpm db:check` | No migration drift |
| `e2e/stage4-invoicing.spec.ts` (`vite build`, desktop project, `--workers=2`) | 2 passed (operator setup and the journey) |

The full integration suite and the full end to end suite were not run (the integrator runs them alone). CI, Lighthouse and the real ARCA adapter were not run. No `.env` file was read or written.
