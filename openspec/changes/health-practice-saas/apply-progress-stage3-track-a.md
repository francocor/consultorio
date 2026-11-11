# Apply progress: Stage 3, track A (messaging, S3.01 to S3.06)

Strict TDD. Worktree `consultorio-wt-3a`, branch `feat/stage-3-track-3a`, based on the seam tip `e761579`. Automatic mode, delivery `size:exception` (work-unit commits, no PR, no merge, CI not polled). Tasks 3.11 to 3.33 are marked done in `tasks.md`. This file is separate from `apply-progress.md` on purpose; the orchestrator merges it.

## Commits (in order, oldest first)

| Slice | Commit | What |
|---|---|---|
| S3.01 | `0e351eb` | contracts `notifications.ts`, `message` and `message_attempt` tables, migration **0320** (task 3.11) |
| S3.01 | `e7cf213` | pure channel policy (3.12) |
| S3.01 | `6f7e9d1` | es-AR templates and the renderer, no clinical field in the render input (3.13) |
| S3.01 | `69d2662` | `reminder.send` job: three-step at-most-once delivery, retries, fallback, tenant checks (3.14) |
| S3.02 | `f27b8e2` | reminder planning, quiet hours, hourly sweep, retry safety (3.15 to 3.18) |
| S3.03 | `fbaa5e3` | public token router, the four handlers, link revocation (3.19 to 3.21) |
| S3.04 | `d6c05fe` | local WhatsApp simulator, signed webhook, simulator controls, inbound replies (3.22 to 3.25), migration **0322** |
| S3.05 | `ff927c6` | channel preferences (opt-in and opt-out), opt-in by email, usage metering and quotas, integration switch (3.26 to 3.29), migrations **0321** and **0323** |
| S3.06 | `2fb4479` | message log and manual resend routes (3.31, API side) |
| S3.06 | `e9e79e1` | Settings > Mensajes, message log in the appointment drawer, channels panel in the patient record (3.30 to 3.32) |
| S3.06 | `4dc2aaa` | WhatsApp simulator tab in the provider console (3.33, UI side) |
| S3.06 | `2b39467` | fix: token pages answer with `Referrer-Policy: same-origin` (found by the e2e, see "Bugs found") |
| S3.06 | `5ce517e` | `e2e/stage3-messaging.spec.ts` at 360 px; channel buttons wrap on a phone (3.33) |

## Migrations

`0320_notifications_core.sql` (message, message_attempt; DELETE and TRUNCATE revoked), `0321_channel_preference.sql` (append-only), `0322_local_whatsapp.sql` (platform simulator tables, `message_event`, `inbound_message`, failure-reason constraint swap `NOT VALID`, two lookup policies on `message`), `0323_whatsapp_usage.sql`. `db:check`: no drift.

## What was built

- **Delivery (3.11 to 3.14).** `message` is the log and the queue (dedupe key `${groupKey}:${channel}`). Delivery is three steps so a crash never sends twice: `prepareDelivery` (own committed transaction, locks the message row first, writes a `started` attempt), `callProvider` (never throws), `completeDelivery` (job transaction, locks the message row first, records the outcome). A crash after the provider accepted an email makes the retry mark it sent with reason `unconfirmed` and not resend; WhatsApp is resent with the same idempotency key. Retries 1, 5 and 15 minutes, never past the appointment start. A permanent failure marks the address unreachable and queues the fallback channel as a new message with the same group key; with none left the worklist item `reminder_not_delivered` is opened. Read-only tenants cancel (`tenant_read_only`), demonstration tenants cancel (`demo_tenant`).
- **Planning (3.15 to 3.18).** A subscriber on the appointment event bus plans in the booking transaction (no call from scheduling code). `planReminders` is pure; `applyQuietHours` uses luxon (DST-safe), default 21:00 to 08:00 in the location zone. An overdue lead time for a future appointment becomes a confirmation sent at once. `reminder.sweep` (hourly) flags unreachable patients (`reminder_not_sent`), plans never-planned appointments and closes stale queued messages of a read-only tenant.
- **Public token router (3.19 to 3.21).** `GET|POST /public/t/:token`, GET only looks and POST acts, one identical 404 page for every invalid link, 402 in a read-only tenant for kinds that are not `allowedWhenReadOnly`. Handlers: confirm, cancel (honors the organization deadline), opt-out, WhatsApp opt-in. Links are revoked on reschedule, reassignment and cancel.
- **WhatsApp (3.22 to 3.25).** `whatsapp-local` adapter with platform tables and a control row (mode ok, down, reject_template; unreachable numbers; reserved `+999`). Signed webhook `POST /webhooks/whatsapp` (HMAC-SHA256 over the raw body, idempotent by event id, tenant found through two lookup policies, no SECURITY DEFINER). Dev routes `/operator/dev/whatsapp/*` sign events and post them to the real webhook. `classifyReply`: BAJA and STOP opt out, `1` confirms, `2` cancels, anything else opens the worklist item `reply_to_review` with encrypted detail. A reply never opts in.
- **Preferences, usage, switch (3.26 to 3.29).** Append-only `channel_preference`; an opt-out cancels queued messages of the channel at once. Usage events are counted once, when the provider accepts. `QuotaPolicy` port (`UNLIMITED_QUOTA` default); owner emails at 80% and 100% once per professional, month and threshold (one email for the highest if a message crosses both); a spent quota without overage cancels with `quota_exhausted` and falls back to email. `settings.integrations.whatsapp=false` makes reminders email only; audited.
- **Staff API and UI (3.30 to 3.33).** `GET /appointments/:id/messages` (`notifications.log.read`) and `POST /appointments/:id/messages/resend` (`scheduling.book`, at most 3, channel policy applies, audit `notification.resend`); location scoped. Settings > Mensajes (lead times, quiet hours, neutral wording, WhatsApp switch, usage table), `MessageLog` in the `appointment-drawer` slot, `ChannelsPanel` as a `patient-detail-tab`, the simulator as a `DevTab` (`whatsapp`). es-AR in `messaging.json` and `errors.notifications.json`.

## Seam files touched (each one needed by the track)

- `apps/api/src/modules/patients/index.ts` and new `application/contact.ts`: `readPatientContact(tx, patientId)`, `readPatientContacts(tx, ids)`, type `PatientContact {id, givenNames, familyName, email, phone, status}`. Read-only, no clinical field.
- `apps/api/src/platform/public/token-router.ts` and `token-page.ts` (new): see the contract for tracks B, C and D below.
- `apps/api/src/platform/http/security-headers.ts`: `referrer-policy` became a default a route may replace (the doc already said so; the code always overwrote it).
- `platform/tokens/kinds.ts`: `enabled: true` for `appointment_confirm`, `appointment_cancel`, `notification_opt_out`, `whatsapp_opt_in`; `kinds.test.ts` made tolerant to Stage 3 kinds.
- `main/wiring/notifications.ts` (adapters, dev providers, worker schedule), `main/wiring/wiring.test.ts` ("does nothing observable yet" became "only ADDS routes"), `scripts/check-migration-drift.test.ts` (uses Stage 4 tracks 4a/4b so the numbers do not collide), `test/policy/audit-scenarios/notifications.ts`.

## Contract for the other tracks

- **`patients/index.ts` gained exactly:** `export { readPatientContact, readPatientContacts } from './application/contact.js';` and `export type { PatientContact } from './application/contact.js';`.
- **`platform/public/token-router.ts` exports:** `registerTokenHandler(kind, handler)` (module-level registry, last registration wins), `registeredTokenKinds()`, `createTokenRoutes(options)`, and the types `TokenHandler {allowedWhenReadOnly, audits, describe(ctx), perform(ctx)}`, `TokenContext {tx, tenantId, now, kind, subjectId, payload, actor, redeem()}`, `TokenPage`. A handler declares `allowedWhenReadOnly` and `audits` (a static list the POST route uses); it calls `ctx.redeem()` before acting; a kind must be `enabled` in `platform/tokens/kinds.ts` before tokens can be issued. `renderTokenPage` and `PAGE_CONTENT_SECURITY_POLICY` are in `token-page.ts`. The pages carry `Referrer-Policy: same-origin`.

## TDD Cycle Evidence

| Task | Test files | Layer | RED | GREEN | Triangulation |
|---|---|---|---|---|---|
| 3.11 | `contracts/notifications.test.ts`, `notifications-schema.test.ts` | Unit + integration | written first (tables missing) | green. Migration 0320 was regenerated several times as the schema settled | append-only grants, isolation, constraints |
| 3.12 | `domain/channel-policy.test.ts` | Unit | written first | green | every kind, opt-in, opt-out, no email, unreachable |
| 3.13 | `domain/content.test.ts`, `application/render.test.ts` | Unit | written first | green | hidden professional and type, no clinical field (compile-time), every template |
| 3.14 | `notifications-send.test.ts` | Integration | written first | green after two fixes (lock order deadlock, see below) | transient then success, both channels fail, read-only, demo, retries, permanent failure |
| 3.15, 3.16 | `domain/reminder-plan.test.ts`, `domain/quiet-hours.test.ts`, `reminder-plan.test.ts` | Unit + integration | written first | green | DST, overdue, quiet skip, reschedule, cancel, no lead times |
| 3.17 | `reminder-sweep.test.ts` | Integration | written first | green | unreachable, never planned, stale queue, demo |
| 3.18 | `reminder-idempotency.test.ts` | Integration | written first | green | crash after acceptance (email and WhatsApp), concurrent workers |
| 3.19 to 3.21 | `notifications-tokens.test.ts`, `platform/public/token-page.test.ts`, `domain/validity.test.ts` | Integration + unit | written first | green | one identical body for every invalid case, GET does not spend, POST does, deadline, read-only, revocation |
| 3.22 to 3.25 | `whatsapp-local.test.ts` (and the shared `whatsapp.contract.ts`), `whatsapp-webhook.test.ts`, `whatsapp-inbound.test.ts`, `whatsapp-loop.test.ts`, `domain/keywords.test.ts` | Contract + integration | written first | green | bad signature, replayed event, unknown tenant, each keyword, ambiguous reply, the full loop |
| 3.26, 3.27 | `notifications-preferences.test.ts`, `notifications-channels.test.ts` | Integration | written first | green | append-only history, reception cannot opt in again, opt-in by link |
| 3.28, 3.29 | `usage-metering.test.ts`, `domain/usage.test.ts`, `notifications-integration.test.ts` | Integration + unit | written first | green after four fixes (see below) | once on acceptance, 80% and 100%, quota exhausted, switch off, audit |
| 3.30 | `messaging-settings.test.tsx` (14), `domain/lead-times.test.ts` (12) | Component + unit | written first | green after the dirty-flag fix | every validation message, only what changed is sent, usage table, denial, axe |
| 3.31 | `notifications-message-log.test.ts` (12), `components/message-log.test.tsx` (11) | Integration + component | written first | green | limit of 3, opted-out channel refused, location scope, read-only, axe |
| 3.32 | `components/channels-panel.test.tsx` (10) | Component | written first | green | opted-out disables the control with its reason, confirm dialog, server refusal, no controls without `patients.write`, axe |
| 3.33 | `whatsapp-simulator.test.tsx` (12); `e2e/stage3-messaging.spec.ts` | Component + e2e (real stack) | written first | e2e green after three fixes (see below) | receipts, reply, outage, unreachable numbers, tab registration; the journey end to end |

## Bugs found by the tests

1. Deadlock between workers: `completeDelivery` took the message row lock after the attempt row, the opposite of `prepareDelivery`. Both lock the message row first now.
2. Drizzle leaves columns unqualified in one-table selects, so an exists-subquery matched the wrong `id`; fully qualified raw SQL.
3. `Promise.all` of queries on one pg client; made sequential.
4. A unique constraint name over 63 characters; shortened to `whatsapp_usage_alert_key`, migration regenerated.
5. Alert thresholds sorted lexicographically; numeric sort. One message crossing both thresholds sent two emails; now one, for the highest.
6. The messaging Save button was disabled whenever the draft was invalid, so the errors never showed. It uses a `dirty` flag now.
7. **Found only by the browser journey:** a form POST under `Referrer-Policy: no-referrer` carries `Origin: null` in Chrome, which the CSRF origin check refuses, so every token page button returned 403 in a real browser (the integration tests inject requests without a browser). The token pages answer `same-origin`; `security-headers` lets a route replace the default. Regression tests in `security-headers.test.ts` and `notifications-tokens.test.ts`. **This affects any other public HTML page with a form (track D video join, track C offers if they render a page).**
8. At 360 px the long channel button labels overflowed the page by 25 px; they wrap now.
9. The e2e learned that, with WhatsApp accepted, each reminder is queued on WhatsApp only and email is the fallback (not both channels).

## Verification (tip of `feat/stage-3-track-3a`, Node 24, pnpm 10.34.7, Docker running)

| Command | Result |
|---|---|
| `corepack pnpm install --frozen-lockfile` | exit 0 |
| `corepack pnpm typecheck` | exit 0 |
| `corepack pnpm lint` | exit 0 |
| `corepack pnpm format:check` | exit 0 |
| `corepack pnpm test` | **274 files, 3511 tests passed** |
| `corepack pnpm test:integration` | **141 files passed, 1 skipped; 2153 tests passed, 4 skipped** (Postgres 17, MinIO, Mailpit). A first run had two failures, both fixed and committed: a seam test that used `appointment_confirm` as a not-yet-enabled kind, and a fixture e-mail collision across files |
| `corepack pnpm build` | exit 0 |
| `corepack pnpm db:check` | No migration drift |
| `corepack pnpm test:e2e` (ports 4520, 3520, 9520, `--workers=3`) | **171 passed** (desktop and mobile-360 projects, including `stage3-messaging.spec.ts`); no flaky retry needed |


## Deviations from the design and tasks

- **Demonstration organizations never send** (they cancel with `demo_tenant`, as task 3.14 says), so the e2e creates a real organization through the operator API instead of using `aillu`. The spec cannot reuse the `Organization` helpers of `support/stack.ts`; it builds its own origins.
- **The e2e gets the reminder with the owner's manual resend**, because a timed reminder cannot be made to fall due within a test; an overdue lead time sends a confirmation (no confirm link) instead. The timed path is covered by `reminder-plan.test.ts`, `reminder-idempotency.test.ts` and `notifications-send.test.ts`.
- **`appointment_event.actor_kind` is hard-coded to `staff` by scheduling**, so a confirmation or cancellation made with a link shows as staff in the appointment history. The audit trail (`actor` of the token request) and `cancelled_by=patient` carry the truth. Fix belongs to scheduling.
- **Seam tests changed** (listed above) because they asserted that nothing was wired yet or fixed migration numbers.
- `security-headers.ts` is shared platform code; the change is the one-line default described above.

## Risks and gaps

- **Not done, not in the A tasks:** a registration API for the video join URL (`VideoJoinUrlResolver`, track D) and a generic offer-delivery entry point (`waitlist_offer` kind exists in the catalogue, templates and renderer, but nothing sends it; track C needs to call `queue`/`prepareDelivery` or add its own producer).
- The token registry is process-global, last registration wins; two tracks registering the same kind would silently replace each other.
- The webhook secret is a per-process random value when `WHATSAPP_APP_SECRET` is absent (stack, demo). Production must set it; the simulator then signs with the same secret.
- Phone normalization is Argentina-specific (`+549...`).
- After an opt-out the queued WhatsApp reminders are cancelled (asserted by the e2e); whether an email reminder replaces them was not verified or covered by a test, and by design email is only the fallback of a failed message.
