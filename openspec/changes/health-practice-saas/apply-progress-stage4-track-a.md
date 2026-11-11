# Apply progress: Stage 4, track A (billing, S4.01 to S4.05)

Strict TDD. Worktree `consultorio-wt-4a`, branch `feat/stage-4-track-4a`, based on the seam tip `caf5ee1`. Automatic mode, work-unit commits, no PR, no merge, CI not polled. Tasks 4.7 to 4.27 are marked done in `tasks.md`. Scope: pricing (private and payer prices, copago, plus), charges (capture from check-in, D8, charge lines), payments and the daily cash register, the billing and cash UI, and exports.

## Commits (in order, oldest first)

| Slice | Commit | What |
|---|---|---|
| S4.01 | `7d83aef` | price list, payers and payer plan prices tables, migration **0410** (4.7) |
| S4.01 | `a639196` | pure price resolution: specificity, payer plans, snapshot-ready quote (4.8) |
| S4.01 | `c4af1fa` | price list and payer routes, price quote, billing contracts (4.9, 4.10) |
| S4.02 | `fcaf884` | charge and charge line tables with guards, migration **0412** (4.11) |
| S4.02 | `d82df72` | capture a charge from check-in, price snapshot, late fee, charge lines (4.12) |
| S4.02 | `bcf8b36` | flag a charge when its appointment ends without service; void under the rules (4.13, 4.14) |
| S4.02 | `8a298c5` | charge access by role and location (4.15) |
| S4.03 | `d1889b8` | payment, refund, cash register and export request tables with guards, migration **0414** (4.16) |
| S4.03 | `1589182` | record payments, refunds, corrections, cash register, receivables (4.17 to 4.19) |
| S4.02 | `380f778` | charge line read and write API for the invoicing track, documented in `docs/stage4-charge-lines.md` |
| S4.05 | `a0484a8` | exports of charges, payments and payer settlement; payer CUIT, migration **0416**; charge lines with payer (4.24 to 4.27) |
| S4.01 | `6d60cd5` | the migration drift test reads the created migration tag instead of hardcoding numbers |
| S4.04 | `0180f61` | charge panel in the appointment drawer, payment dialog, payers with CUIT, prices, charges list, receivables, exports (4.20, 4.21) |
| S4.04 | `29ae685` | daily cash register screen (4.22) |
| S4.04 | `547c832` | `e2e/stage4-cash.spec.ts` at 360 px; billing slots load lazily (4.23) |
| S4.04 | `5435530` | tasks 4.20 to 4.23 marked |
| S4.05 | `25a4a01` | the JSON golden of the spreadsheet is compared by content (the formatter owns its layout) |

## Migrations (range 4a, `0410` to `0429`)

- `0410_pricing.sql`: `tenant_payer`, `price`, `payer_plan_price`.
- `0412_charges.sql`: `charge`, `charge_line`; guards `guard_charge`, `guard_charge_line` (only `invoiced_cents` may change), `guard_charge_line_insert`; DELETE revoked.
- `0414_payments_cash.sql`: `cash_session`, `payment`, `payment_reversal`, `export_request`; guards; UPDATE and DELETE revoked from `app_rw` on `payment` and `payment_reversal`.
- `0416_payer_cuit.sql`: nullable `tenant_payer.cuit` with `^[0-9]{11}$` check (requested by track C, because 0410 was already pushed).

## What was built

- **Pricing (S4.01).** Prices by type with scope (professional > specialty > location > general) and the latest `effective_from` not after the service date; payer plan prices (exact plan before all-plans) with copago and plus; a pure `resolvePrice` that explains why a private price was used (`payer_inactive`, `payer_without_price`, `payer_not_listed`). A quote route shows the desk what will be charged.
- **Charges (S4.02).** Capture from check-in (not before) with the price snapshot in the charge; one live charge per appointment (partial unique index); an explicit amount when nothing prices the service (audited as override); late fee line for no-show and late cancellation when the organization enabled it. A subscriber on the appointment events flags (`needs_review`) but never voids or refunds (D8). Void needs a reason, refuses a charge with payments or an issued invoice, and the charge stays visible. Access by role and location (`scope.ts`).
- **Payments and cash (S4.03).** Payments are append-only; refunds and corrections are compensating entries (`payment_reversal`, `corrects_payment_id`). Idempotency by client key plus request hash (replay is 200 `replayed:true`, same key with another body is 409). Overpayment needs `confirmCredit`. A duplicate voucher needs an override reason. Cash needs an open register; one open register per location; a closed register is immutable; expected cash = opening + cash in - cash out; a difference needs a reason; a correction after close goes to the open register. The stored charge status is recomputed under a `FOR UPDATE` lock on the charge row (payments cannot be locked: they are append-only by privilege).
- **Charge lines for invoicing (track C).** `docs/stage4-charge-lines.md`; billing never writes `invoiced_cents` (a test fails if code under `modules/billing/` names it in a write).
- **UI (S4.04).** `features/billing` (charge panel in the `appointment-drawer` slot, patient charges tab, payment, refund, correct, void and add-line dialogs, payers with CUIT, price list, charges list with filters, receivables, exports) and `features/cash` (open, summary by method, close with count and difference reason, history, corrections). Locale files `billing.json`, `cash.json`, `errors.billing.json`. The slots are lazy so the sign-in chunk stays light (index chunk 380 kB).
- **Exports (S4.05).** `platform/exports/` (csv with BOM, quoting and formula guard; xlsx with real numbers and dates; pdf; generic `export.build` job with ports), billing sources (charges, payments, payer settlement), `export_request`, download through `/files/:token` with a session-bound `export_download` token. Read-only tenants keep reads and exports.

## Seam files touched (each one needed by the track)

- `modules/scheduling/index.ts` (+ `application/charge-source.ts`): `readAppointmentForCharge`, type `AppointmentForCharge`.
- `modules/patients/index.ts` (+ `application/payer-plan.ts`): `readPatientPayerPlan`.
- `platform/tokens/kinds.ts` and `kinds.test.ts`: only the `enabled` line of `export_download`; `test/security/public-tokens.test.ts`: its `ELSEWHERE` line.
- `test/integration/file-resources.test.ts`: the probe wiring excludes billing (billing registers the `export_download` resource).
- `scripts/check-migration-drift.test.ts` and `apps/web/src/app/i18n.test.ts` (an invented namespace stood for "never translated"; billing now exists).
- No queue, permission or audit action was added.

## TDD Cycle Evidence

| Task | Test files | Layer | RED | GREEN | Triangulation |
|---|---|---|---|---|---|
| 4.7 | `billing-pricing-schema.test.ts` | Integration | written first | green | uniqueness per scope, RLS isolation, CUIT check |
| 4.8 | `domain/price-resolution.test.ts`, `price-resolution.test.ts` | Unit + integration | written first | green | each specificity level, effective date, plan vs all-plans, inactive and unlisted payer |
| 4.9, 4.10 | `billing-pricing-api.test.ts`, contracts `billing.test.ts` | Integration + unit | written first | green | permissions, duplicates, quote reasons |
| 4.11 | `billing-charges-schema.test.ts` | Integration | written first | green | guards (only `invoiced_cents`), no delete, no line on a voided charge |
| 4.12 | `capture-charge.test.ts` | Integration | written first | green | before check-in refused, explicit amount, late fee, double capture, payer by hand |
| 4.13, 4.14 | `charge-review.test.ts`, `void-charge.test.ts` | Integration | written first | green | flag never voids, void rules, issued invoice refuses |
| 4.15 | `charge-access.test.ts` | Integration | written first | green | role and location matrix |
| 4.16 | `billing-payments-schema.test.ts` | Integration | written first | green | append-only grants, PAN-lookalike check, closed session immutable |
| 4.17, 4.18, 4.19 | `record-payment.test.ts`, `refund-payment.test.ts`, `cash-register.test.ts` | Integration | written after the code (see deviations) | green | replay, reused key, overpayment, voucher duplicate, partial refund bounds, correction after close, difference reason |
| 4.24 to 4.27 | `exports.test.ts` (golden), `billing-exports.test.ts`, `billing-export-contributor.test.ts`, `billing-read-only.test.ts`, `billing-payer-cuit.test.ts`, `charge-lines-api.test.ts` | Unit + integration | written first | green | formula guard, scope in exports, empty export, read-only, invalid CUIT |
| 4.20 | `charge-panel.test.tsx` | Component + axe | written first | green after two test fixes (payer kind value, voided charges show as a note) | quote, payer choice, explicit amount, fee only, review flag, void, read-only, restricted role |
| 4.21 | `payment-dialog.test.tsx`, `charges-page.test.tsx`, `payers-section.test.tsx` | Component + axe | written first | green after flattening the locale files and showing field errors | double click sends once, same key on retry and another on change, overpayment confirm, voucher override, CUIT error, exports flow, receivables |
| 4.22 | `cash-page.test.tsx` | Component + axe | written first | green | exact, short and over count, reason, location filter, closed register history, read-only, role |
| 4.23 | `e2e/stage4-cash.spec.ts` | E2E 360 px | written first | green (first run failed on a race in the spec: the location select was read before it rendered) | refusal without register, partial payment, reception cannot void or refund (UI and API 403), close with difference |

Mutation checks that proved the tests bite: overpayment rule and the idempotency lookup were removed one at a time and their tests failed.

## Bugs found by the tests

- The locale files were written nested while the catalogs are flat maps (`keySeparator: false`): every key came out missing. Flattened.
- The charges list asked the server for a period that ends before it starts. The query is now disabled while the period is invalid.
- A refused CUIT showed the generic "some data is not valid". The alert now shows the field messages.
- The billing slots were eager and put the whole billing UI in the sign-in chunk (418 kB); `lazySlot` brought it to 380 kB.
- `prettier` rewrote the JSON golden of the spreadsheet on commit; the test compares that file by content now.

## Deviations

1. Tests of payments, refunds and cash register (4.17 to 4.19) were written after the implementation, not before. Mutation checks on the key rules were added to compensate.
2. A new migration `0416` (payer CUIT) outside the three listed in the tasks, authorized by the coordinator for track C.
3. `charge_line.invoiced_cents` is maintained by track C's trigger (0444), not by billing; billing refuses to write it.
4. The charge panel shows a voided charge only as a note ("there was a voided charge"); the voided charge itself is in the charges list.

## Risks

- Track C's migration `0444` adds an FK to `charge_line`; it must come after `0412` (the run order guarantees it) and use the FORCE RLS lift described in `docs/migration-ranges.md`.
- `invoiceLookup` in `modules/invoicing/index.ts` is still a stub; voiding a charge with an issued invoice relies on track C replacing it (task 4.45) without changing its signature.
- Exports are built by the worker; in the e2e stack the download was exercised in component tests and through the API, not through a browser download.

## Verification

Run on the final tree, Docker engine 29.8.2, PATH with Node and gitleaks, `corepack pnpm`:

- `install --frozen-lockfile`, `typecheck`, `lint`, `format:check`, `build`, `db:check` ("No migration drift"): all pass.
- `test`: 346 files, 4369 tests pass.
- `test:integration`: 194 files passed, 1 skipped; 3035 tests passed. `backup-restore.test.ts` failed in the full run (MinIO `socket hang up` under the load of the other containers running on the machine) and passed alone (4/4): infrastructure load, re-run once alone as agreed.
- `test:e2e` (`E2E_WEB_PORT=4700 E2E_API_PORT=3700 E2E_MINIO_PORT=9700`, `--workers=3`): 186 passed. A first full run had one failure in `calendar.day.spec.ts` (the first free time of the cardiologist, taken in parallel); `stage4-cash.spec.ts` now takes its time from the later half of the free times, and the second full run passed entirely.
