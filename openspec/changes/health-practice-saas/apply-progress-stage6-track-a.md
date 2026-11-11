# Apply progress: Stage 6, track A (subscriptions)

Change: `health-practice-saas`. Worktree `consultorio-wt-6a`, branch `feat/stage-6-track-6a`, from the seam tip `09574fd`. Mode: automatic, strict TDD, work-unit commits, no PR, no merge, CI not polled. Slices S6.01, S6.03, S6.04, S6.05, S6.06 and the subscription half of S6.07 (tasks 6.5 to 6.8, 6.13 to 6.28, 6.30 and 6.31).

## Status of the tasks

| Task | State | Notes                                                                                                                                                                                                                                                               |
| ---- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6.5  | done  | `db/schema/subscriptions.ts`, migration `0610_subscriptions.sql`: platform `plan` / `plan_entitlement`, tenant `subscription`, event log, guards (transition table repeated in a trigger, exempt guard, immutable identity), operator grants.                     |
| 6.6  | done  | `domain/subscription-state.ts`: pure transition table; a state changes only because the provider confirmed something, a date arrived or the owner asked.                                                                                                      |
| 6.7  | done  | `domain/active-professional.ts`, `periods.ts`, `proration.ts` (largest remainder, to the cent), `plan-limits.ts`.                                                                                                                                              |
| 6.8  | done  | Plan impact (`GET /subscription/plan-impact`, `createSubscriptionPlanImpact`), plan limit in the staff invitation/activation (new lines only), trial starter, owner view, operator support view.                                                                |
| 6.13 | done  | `adapters/mercadopago-local` on Postgres (migration `0612`), hosted checkout page, provider console controls, passes `payments-gateway.contract.ts`.                                                                                                              |
| 6.14 | done  | `POST /subscription/checkout`: write-ahead mark, bounded call, answer; reconcile by reference; adopt only when every field matches; park otherwise.                                                                                                               |
| 6.15 | done  | `POST /webhooks/mercadopago`: raw-body HMAC, 5 minute window, event id UNIQUE, generic 401, enqueues `subscription.reconcile`.                                                                                                                                  |
| 6.16 | done  | Ledger: one credit per period, second approved payment is a surplus; refunds are entries of their own (`subscription_refund`). No HTTP route for the operator refund (see deviations).                                                                          |
| 6.17 | done  | Outage handling: nothing changes on a provider error; pin/settle window after an unknown outcome; pool floor raised to 22 (`CONNECTION_HOLDING_JOBS`).                                                                                                       |
| 6.18 | done  | `trial.end`, dunning day 1/3/5 driven by time, owner notices claimed in the state-change transaction and sent after commit.                                                                                                                                  |
| 6.19 | done  | Derived tenant status (`read_only_since`), recovery on a confirmed payment.                                                                                                                                                                                    |
| 6.20 | done  | Exempt (demo, deployment without billing) have no subscription and no billing job touches them.                                                                                                                                                              |
| 6.21 | done  | Plan change, cancel (stops the preapproval at the provider, retried by the reconcile), reactivate.                                                                                                                                                           |
| 6.22 | done  | `usage.snapshot` (`usage_record`, migration `0618`): days of activity and accepted messages per professional and period.                                                                                                                                      |
| 6.23 | done  | `domain/statement.ts`, `statement.generate`, statements published and emailed; collection no earlier than 3 days after publication (check constraint + trigger).                                                                                               |
| 6.24 | done  | Amount change against the local simulator: updated, refused (payment link for the difference + notice), reauthorization (owner asked), park when the amount would have to go down and cannot.                                                                    |
| 6.25 | done  | `GET /subscription/usage`; 80% / 100% notices are the existing ones of notifications, fed by the real quota; statements list, detail with event ids, PDF document.                                                                                           |
| 6.26 | done  | `createQuotaPolicy`: quota prorated by active days, overage while the cap allows it under an advisory lock, fall-back to email + one notice per period.                                                                                                       |
| 6.27 | done  | `PATCH /subscription/overage-cap` (0..plan maximum, never unlimited, audited `subscription.cap_changed`); overage lines trace to event ids.                                                                                                                   |
| 6.28 | done  | `GET /operator/usage?tenantId=`; `usage.snapshot` also runs in single mode.                                                                                                                                                                                   |
| 6.30 | done  | `features/subscription/*` (plan and state, usage with thresholds, overage cap, statements list/detail/download, cancel/reactivate, pay overdue, exempt state, simulated notice), `locales/es-AR/subscription.json`.                                              |
| 6.31 | done  | Plan-impact panel in the staff invitation, `features/operator/subscriptions/*`, provider console tab `features/operator/dev/payments/*`.                                                                                                                       |

Not mine and not touched: 6.9 to 6.12 and 6.29 (track B, signup), tasks of track C.

## Commits (in order)

| Commit     | Tasks            | What                                                                                                                       |
| ---------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `f67aba8b` | 6.5 to 6.7       | Plans, the subscription with the guards of the database, the state machine and the billing rules.                         |
| `955ca404` | 6.8              | Trial, plan impact, the plan limit in staff, the owner's view and the operator's support view.                              |
| `30f2c4a6` | 6.13             | The local Mercado Pago with its hosted checkout and provider console; `cancelPreapproval` in the port.                      |
| `dfbe329b` | 6.14 to 6.17     | Checkout, webhook, reconcile and refunds with a write-ahead log, a settle window and a pool floor.                          |
| `03b078d2` | 6.18 to 6.21     | Trial end, dunning, read-only and recovery, plan change, cancellation and reactivation, with notices.                       |
| `749daf71` | 6.22 to 6.28     | Usage metering, statements and their collection, the plan quota and the overage cap.                                        |
| `f6a3a9eb`, `e36702ab` | 6.30, 6.31 | Web: subscription screens, operator tab, provider console tab, plan-impact panel; the return page of the hosted checkout; the export part; e2e; docs. |

## Migrations

`0610_subscriptions.sql`, `0612_local_mercadopago.sql`, `0614_subscription_payments.sql`, `0616_subscription_notices.sql`, `0618_usage_and_statements.sql` (range 0610 to 0639). After the last one `pnpm db:restamp` and `pnpm db:check` are clean.

`0618` lifts FORCE row level security on `subscription_attempt` and `subscription_payment` for the length of the two `ADD CONSTRAINT ... statement_fkey` (the precedent is 0030, 0444 and 0590): a validation that runs without a tenant context cannot read a FORCE table, and `NOT VALID` plus the runner's validation fails the same way. Both tables are Stage 6 tables and hold no statement reference yet. It also: `REVOKE DELETE, TRUNCATE` on `statement` and `usage_record`; `statement_guard` (figures never change, collected never goes down); `subscription_attempt_statement_guard` (a write for a statement is refused before its window, above what is left, or for a statement that does not exist, error code 23503); `usage_record_guard`; the `subscription_notice` kind check gains the statement and quota notices; `GRANT SELECT` on the columns of `usage_record` to `app_operator` (the operator reads it one organization at a time through the tenant context).

## TDD evidence

| Slice | Test files written first (RED)                                                                                                          | What forced the code                                                                                                                             | GREEN / triangulation / refactor                                                                                                         |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| S6.01 | `subscription-state.test.ts` (unit + integration), `billing-rules.test.ts`, `operator-privileges`                                       | illegal transitions, `unconfirmed` never changes a state, proration adds up to the cent                                                            | pure machine first, trigger repeats it; property tests of the proration                                                                    |
| S6.03 | `payments-gateway.contract.ts` run on fake and local, `subscription-checkout`, `mp-webhook`, `attempt-decisions.test.ts`                | non-idempotent provider, answer lost, in-flight request after a timeout, forged/stale/duplicate notice, two plausible preapprovals                  | adopt/release/wait/park deciders; mutation checks (adopt without every field matching, release inside the settle window) made the tests fail |
| S6.04 | `billing-timeline` (fake clock), `clock.test.ts`, `ledger.test.ts`                                                                      | dunning by date not by message, outage never advances a step, second payment of a month is a surplus                                               | one notice per state change, claimed before commit                                                                                         |
| S6.05 | `domain/statement.test.ts` (16 incl. two property tests), `statement.test.ts` integration (26: metering, generation, DB guards, collection) | nothing collected before the window or above the total; refused amount change; reauthorization; park when it cannot be lowered; oldest statement first | domain written with its tests; mutation checks (`<` to `<=` on the window, drop the cap clamp, relax `left`) failed 5 tests, restored       |
| S6.06 | `quota-policy.test.ts` (18): quota by days, overage, cap, concurrency of the last place, usage view privacy, cap route, operator counts | exactly one of two concurrent reservations takes the last overage place; unlimited and above-maximum caps refused                                  | advisory lock inside `limitFor`; cap route audited                                                                                         |
| S6.07 | `subscription-page.test.tsx` (30), `subscriptions-tab.test.tsx`, `payments-simulator.test.tsx`, `plan-impact.test.tsx` x2, axe in each; `stage6-subscription.spec.ts` at 360 px | every state of the owner screen; the cap never leaves the 0..maximum range; e2e found that the hosted page's `form-action 'self'` blocks the redirect after the POST | the redirect became a page that takes the payer back (see deviations)                                                                      |

## Decisions

- **One more month in arrears.** The statement of month `M` is collected by the charge that lands in `M + 1`; the first charge (at the end of the trial) is the amount shown at checkout. Written down in `docs/billing-model.md`.
- **The recurring amount is always an amount the owner has seen**: the checkout amount or a published statement. The window is checked in the code, in a check constraint and in a trigger on the attempt (`marked_at` is the instant the application sends).
- **Booking, not inferring.** What the provider charged is booked against the oldest statement whose window had passed when the charge was made (or the statement named by the reference of a link). Surplus payments book nothing.
- **Collection runs inside `subscription.reconcile`** (already a connection-holding family), so no new family was added and the pool floor stayed at 22. `usage.snapshot` and `statement.generate` ask no provider and are not connection-holding.
- **`usage_record` for operator and statement days; `whatsapp_usage_event` for the count.** The statement counts accepted (confirmed, not released) events of the period; the live view counts what takes a place of the quota (accepted or reserved and queued).
- **Quota during the trial.** Days of the trial count for the quota, overage is never allowed during the trial (the days are free, the overage would not be billed).

## What I export

- **For B (signup):** `createTrialStarter({ clock? })` from `modules/subscriptions/index.ts`; `startTrial(tx, { tenantId })` answers `started`, `already_started` or `exempt`. Checkout creates the trial lazily for an organization that has none (the operator console creates organizations that way).
- **For C (retention):** the subscription publishes `TenantCancelledPort.publishCancelled` with `source: 'subscription'` inside the transaction that reaches `cancelled`. `registerSubscriptionsExportContributors` now fills the administrative part (`subscription`, `statements`, `payments`, no provider identifiers). **Seam gap:** `WorkerWiringContext` carries no `tenantLifecycle`, so the worker builds a fresh `createTenantLifecycle()`; a cancellation reached by `dunning.step` (end of the paid period) is published on a bus with no subscriber. C should either put the lifecycle bus in `WorkerWiringContext` or subscribe in the worker wiring.
- For everyone: `createQuotaPolicy({ clock? })` (wired by the seam in `wiring/notifications.ts`, system clock), `createSubscriptionPlanImpact()`, `assertProfessionalSeatAvailable`, `takesProfessionalSeat`, the job names and `createSubscriptionJobs`.

## Verification (run at the tip)

| Check | Result |
| ----- | ------ |
| `pnpm install --frozen-lockfile` | clean (the `prepare`/lefthook step fails in a worktree and is harmless; `--ignore-scripts` installs) |
| `pnpm typecheck` (contracts, api, web) | clean |
| `eslint` on every file touched by the track (api, web, contracts, e2e, tests) | clean |
| `prettier --check` on the files of the last two commits | clean |
| Unit suite of the api (254 files) | 3311 passed, 2 skipped, at the time of the last full run; after the last change (the export part test) the subsets `modules/subscriptions`, `modules/tenancy`, `main`, `adapters`, `test/policy` (72 files): 1092 passed, 2 skipped. `boot.test.ts` and the policy tests are green |
| Unit suite of the web (170 files) | 1972 passed |
| Integration, targeted: `statement` (26), `quota-policy` (18), `subscription-state`, `subscription-checkout`, `mp-webhook` (20), `billing-timeline`, `payments-gateway` | 209 passed, 6 skipped (7 files) |
| Integration, targeted: `operator-privileges`, `definer-functions`, `tenancy/isolation.generated`, `migrate-validation`, `migration-lanes`, `usage-metering`, `notifications-schema`, `tenancy-schema` | 504 passed (8 files) |
| `pnpm build` (api and web) | clean |
| `pnpm db:check` | no migration drift |
| `e2e/stage6-subscription.spec.ts` (desktop project, 360 px viewport, `E2E_WEB_PORT=5020 E2E_API_PORT=4020 E2E_MINIO_PORT=9020`, one worker) | 2 passed (the owner journey with axe and the width of the page on every screen; the demo and the non-owner) |

The full integration suite was not run (shared Docker: tracks B and C run at the same time). A first run of the Playwright stack timed out twice while the machine was loaded; I started the stack by hand with the same command and ran the spec against it.

## Deviations

1. **Plan impact in the staff invitation is not a slot.** There is no staff slot and the registry is the seam's. `PlanImpactPanel` is exported by `features/subscription/index.ts` and rendered by `InviteStaffDialog` (new lines only). Only the owner sees it: the numbers come from an owner-only endpoint. The activation of a deactivated professional is refused by the API with the translated limit message; there is no dialog on the activation button.
2. **No new banner for a non-owner in a read-only organization.** `/subscription` stays guarded (no-access screen for everyone but the owner) and the shell banner is the existing one. Its text (`common.json`, `state.readOnly.description`) says "regularice la suscripción desde Facturación" to everybody; a role-aware text belongs in `app/StatusBanners.tsx` (seam).
3. **The hosted page of the simulator answers its form with a page, not a 303.** Chrome applies `form-action 'self'` to the redirect that follows a post, and the way back is on the address of the organization, not on the platform host of the page. The page has a link and a `refresh`. `mp-webhook.test.ts` follows it.
4. **No HTTP route for an operator refund.** The service (`refundPayment`) and the entries (`subscription_refund`, source `operator`) exist and are tested; the operator routes get a `run` that is the `app_operator` role, which cannot write the payment tables. A route needs a `withTenant` in `OperatorWiringContext`.
5. **`usage.snapshot` is hourly, not daily** (idempotent per day) and also runs in single-tenant mode, where it is the only job of the module.
6. **Operator `activeProfessionals` count** in `OperatorSubscriptionDto` was not added; `GET /operator/usage` has the counts.
7. **`.env.example` was not edited** (denied by the permission system). The floor of the pool is 22 and the documented default was 16: the maintainer must change the line `DB_POOL_MAX=16` to `DB_POOL_MAX=24` (`DEFAULT_RUNTIME_POOL_MAX` is 24; `config.test.ts` reads the floor from the code, and a test raises `DB_POOL_MAX` to the floor when it loads the example). `docs/runbooks/deploy.md` and `docs/security/asvs-l2-portal.md` have the new numbers.

## Risks

- **Orphan containers/process after a stack that did not come up.** A run of the Playwright stack that times out (the machine was loaded) leaves its Testcontainers; I removed mine (`docker rm -f` of the three containers of my session). The stack I started by hand on port 4020 for the last runs has no way to stop except a signal; its containers were removed at the end and the idle Node process may remain: it holds port 4020 only.
- **Hosted page and real Mercado Pago.** The `form-action` finding is about the simulator. The real hosted page is the provider's; the real adapter is the deferred S6.D.
- **Collection is a booking model, not a ledger of the provider.** A charge that the provider makes on its own schedule before the window of a statement has passed is booked against no statement; the statement keeps its open amount and the next charge is moved to it. An operator can see the open amounts in the statements of the organization.
- **A message accepted after its statement was written is not billed.**
- **Quota in tests with a fake clock:** `createQuotaPolicy` is wired by the seam without a clock, so end-to-end tests that move time use the system clock for the quota; the integration tests inject one.
