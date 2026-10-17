# Apply progress: Stage 3, track D (teleconsultation, S3.14 and S3.15)

Branch `feat/stage-3-track-3d`, from the seam tip `e761579`. Mode: automatic, strict TDD, `size:exception` (work-unit commits, no merge, CI not polled). Tasks 3.62 to 3.70 are done and ticked in `tasks.md`. The track edited only what `docs/stage3-tracks.md` lists for D, plus the exceptions named under "Deviations" (two seam tests and the one `video_join` line).

## Commits (in order)

| Slice | Task(s)       | Commit    | What                                                                                                                                                     |
| ----- | ------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S3.14 | 3.62          | `96f1fa0` | `video_session` table (migration 0370), contracts (summary, manual link request, error catalog, vocabularies), es-AR error messages, fixture             |
| S3.14 | 3.67          | `4e4e551` | `adapters/video-local` (public Jitsi, muted and unrecorded), the `unavailable` provider, `video.contract.ts` on fake and local, registry slot            |
| S3.14 | 3.63          | `9245d26` | Event subscriber (open, renew on reschedule and reassignment, close), job `video.link.create` with retries and the `link_pending` states, audit          |
| S3.14 | 3.64          | `3f69953` | `GET /public/v/:token`: forwards (302) only inside the window, es-AR page with the notice otherwise, `video_join` kind enabled                            |
| S3.14 | 3.65          | `f1d7433` | `GET /appointments/:id/video`, `POST .../video/join`, `PUT .../video/manual-link`; assigned professional only; calendar feed carries no link            |
| S3.14 | 3.66          | `0594bd8` | Attendance tests: opened-link flag, no automatic status change, no-show wait, audit without secrets                                                       |
| S3.15 | 3.69 (API)    | `ff859b5` | `VideoJoinUrlResolver` (`Teleconsultation.joinUrlResolver`), the console control `POST /operator/dev/video/links`, simulator default hosts               |
| S3.15 | 3.68, 3.69    | `30d92d4` | `features/teleconsultation`: video panel in the `appointment-drawer` slot, manual link dialog, video section in the `settings-section` slot (scheduling) |
| S3.15 | 3.70          | `e72bfd5` | `e2e/stage3-teleconsult.spec.ts` at 360 px                                                                                                               |
| S3.14 | extra tests   | `87040db` | Limit of visits to the join address, read-only matrix of the video routes                                                                                |

## Migration

Only `0370_video_session.sql` (`pnpm db:new 3d video_session --number 0370`, then `finish-migration.ts` for the policies, plus `REVOKE DELETE, TRUNCATE ... FROM app_rw`). `db:check`: no drift, journal sound.

## Dependencies on track A (and on the seam)

- **Token router (S3.03): none.** `/public/v/:token` is its own prefix in design 4.5 (`/public/t/` is the router's), so the module registers the route itself; `platform/public/token-router.ts` is neither imported nor created.
- **`VideoJoinUrlResolver` (S3.01 to S3.03 of track A).** The notifications module has no function that accepts a resolver yet. The resolver is built and tested here: `createTeleconsultation(...).joinUrlResolver` (type exported from `modules/teleconsultation/index.ts`). Integration point: the notifications module (or track E) calls `resolve(tx, appointmentId)` while rendering a reminder, in the transaction that renders it. It answers `in_person`, `pending` (the reminder says the link follows, or is not sent), `closed` or `link` (the platform address and when it expires). Wiring file `main/wiring/teleconsultation.ts` is where the one registration line goes once A exports its function (`create` has the module in hand).
- The simulator control `POST /operator/dev/video/links { tenantId, appointmentId }` returns the address a reminder would have carried. It exists so the browser suite can open the patient link until the real reminder does; track E can drop its use when the e2e reads the address from Mailpit.

## Requests for a seam commit (not done here, by the rules)

1. **`platform/tokens/kinds.ts`: `video_join.ttlMs` is 3 hours.** A reminder is rendered up to 24 hours (or 14 days) before the start, and `issue` caps the lifetime at the kind's `ttlMs`, so a link issued at reminder time dies before the window opens. The resolver already asks for "window end plus 12 hours"; it works as soon as the cap is raised (suggestion: `3 * DAY`, like `waitlist_offer` at 2 days). Until then only links issued within 3 hours of the end of the window work. A test pins the current behavior (`video-join-address.test.ts`, "asks for a lifetime that covers the join window, which the kind caps at three hours") and must change with the cap.
2. **`VIDEO_LOCAL_BASE_URL`** (task 3.67 names it) is not in `main/config-providers.ts`; the adapter takes `baseUrl` (default `https://meet.jit.si`), and the wiring uses the default.
3. **`CalendarEntryDto` carries no appointment mode**, and `features/today` has no slot, so the "virtual" marker on calendar entries and the Today view button of tasks 3.68 and 3.69 are not possible without scheduling or a slot. The panel in the drawer (also opened from Today) has the marker and the action.
4. **`WiringContext` has no `config`**: the hosts a manual link may use (`VIDEO_ALLOWED_DOMAINS`) reach the module through the provider adapter (`manualLinkDomains` on the port).

## Deviations from the design and the task text

1. **Port extended** (`modules/teleconsultation/application/ports.ts`): `name`, `manualLinkDomains`, `isOpaqueRoomId`, `newOpaqueRoomId`, `InvalidRoomNameError`, `VideoProviderUnavailableError`. `createRoom` refuses any name that is not 32 lowercase hex characters, so no caller can send personal data as a room name. The seam fake (`adapters/video-fake`) was adapted (a `name`, the same refusal, optional `manualLinkDomains`).
2. **Customer slot**: `VIDEO_PROVIDER=local` gets the local adapter; `off` and `jaas` (real adapter deferred, task 3.82) get an `unavailable` provider that cannot make a room but still carries the allowed manual hosts. No Jitsi-as-a-Service stub was written: tasks.md does not ask for one. While the simulators run and `VIDEO_ALLOWED_DOMAINS` is empty, the allowed hosts default to `meet.jit.si`, `meet.google.com`, `zoom.us`, `teams.microsoft.com`; production with a real provider or video off has no default (an empty list allows nothing).
3. **Seam tests edited** because a track cannot keep them green otherwise: `platform/tokens/kinds.test.ts` (the enabled set now has `video_join`) and `main/wiring/wiring.test.ts` ("the skeletons register no route" became "the modules add routes and take none away"). Tracks A, B and C will touch the same two tests: expect merge conflicts there.
4. **Alert for `link_pending`**: `WORKLIST_KINDS` has no video kind and is shared, so the alert is the state itself, shown in the drawer panel and in `GET /appointments/:id/video` (`pendingReason`). The job leaves `provider_failed` after the last retry.
5. **The type of an appointment becoming in person** has no event on the bus. The session is not closed at that moment; the platform address and the professional's join check the mode on every use and refuse (`unavailable` page, `video_not_virtual`).
6. **The room is written to `appointment.video_room` by this module** (direct Drizzle write of that one column, as task 3.62 and design 7 say), because scheduling exposes no API for it. Scheduling already puts a new `randomUUID()` there on a reschedule and `NULL` on a cancel; the subscriber replaces it with a 128-bit name in the same transaction.
7. **No-show wait** (task 3.66) is enforced by the subscriber: a no-show of a virtual appointment before `startsAt + noShowAfterMinutes` throws `video_no_show_too_early` (409) and the write rolls back with it (the bus semantics). Scheduling's own rule (not before the start) is unchanged.
8. **The notice of the third-party service** (spec, "Patient information on join") is on every page the address shows (early, closed, pending). A patient who opens the address for the first time inside the window is forwarded at once (302, as task 3.64 says) and does not see it. An interstitial with a button would fix it at the cost of one click; owner decision.
9. **The link stays known 12 hours after the window** so "the appointment ended two hours ago" shows "the session is closed" (410) instead of the generic page. It forwards nowhere after the window.
10. **E2E uses the demonstration organizations**, whose provider is the fake (`https://video.example.invalid/...`), so the spec asserts that address and a stubbed manual host. The local provider's `meet.jit.si` address and the recording flags are asserted in the integration tests.
11. `docs/dev-setup.md` was not touched (not in the track's list): the `/operator/dev/video/links` control and the default hosts of the simulators are described in the code and here.

## Risks

- The `video_join` lifetime cap (request 1). Highest.
- Reception, the professional and the patient may all hold the same manual link; it is not a secret of the platform. It stays out of audit entries, summaries and the calendar feed.
- The public Jitsi server (`meet.jit.si`) is a third-party service shared by everyone: the 128-bit room name is what keeps a room private. A self-hosted Jitsi is a `baseUrl` away (request 2).
- The console control is bound late (`lateBound` in the wiring) because the console routes are registered before the module exists; it only runs when `LOCAL_PROVIDERS_CONSOLE` is on, and a second application built in the same process rebinds it.
- Provider calls happen inside a job transaction (one connection held for the call); fine for the local adapter, to reconsider for a networked one.

## TDD cycle evidence

| Task | Tests (files)                                                                                                                                                                  | RED                                                                                                                      | GREEN  | Notes                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------- |
| 3.62 | `contracts/teleconsultation.test.ts` (+6, 10 in the file), `integration/teleconsultation-schema.test.ts` (9), isolation suite through `fixtures/teleconsultation.ts`                         | contracts: 6 failed (exports missing). Schema test written against a table that did not exist (compile failure)         | passed | the schema test first ran after the migration existed; the RED is the missing table export                                 |
| 3.67 | `adapters/video-local/index.test.ts` (contract on fake and local, local and unavailable provider: 31), `main/wiring/teleconsultation.test.ts` (6)                                                            | module missing, then 12 failed (the refusal threw instead of rejecting)                                                  | passed | triangulated over six non-opaque names, four bad base addresses                                                            |
| 3.63 | `integration/video-links.test.ts` (17), `domain/join-window.test.ts` (4), `domain/manual-link.test.ts` (15)                                                                            | domain: modules missing; links: 5 failed (kind disabled, polluted queue in the test world)                               | passed | found: jobs of earlier tests piled up in the recording queue, fixed with `forgetPastWork`                                  |
| 3.64 | `integration/video-join-public.test.ts` (14), `http/join-page.test.ts` (7), `domain/local-time.test.ts` (3)                                                                   | 1 failed: the per-response nonce made two unavailable pages differ; replaced by a style hash                             | passed | identical bodies for guessed, revoked, cancelled and malformed tokens                                                      |
| 3.65 | `integration/video-professional.test.ts` (21)                                                                                                                                  | routes missing (all failed), then 1 failed (test bug: the clock of a second appointment moved the first)                 | passed | cross-organization 404, other professional 403 plus `access.denied`, 402 in a read-only organization                       |
| 3.66 | `integration/video-attendance.test.ts` (5)                                                                                                                                     | written against the finished routes: no separate RED (it characterizes the combination)                                  | passed | audit scan: no token, room, passcode or provider address in any `video.link.*` entry                                       |
| 3.69 | `integration/video-join-address.test.ts` (10), `http/dev-routes.test.ts` (5), wiring tests (+2 of the 6)                                                                              | type `VideoJoinAddress` missing                                                                                          | passed | pins the 3 hour cap of the kind                                                                                            |
| 3.68 | `video-session-panel.test.tsx` (18), `video-settings-section.test.tsx` (9), `slots.test.tsx` (3), all with axe                                                                | panel: written first (component missing); settings: 3 failed (two locale keys misnamed)                                  | passed | 360 px layout and contrast are covered by the e2e axe run, as in the other features                                        |
| 3.70 | `e2e/stage3-teleconsult.spec.ts` (7 tests, serial)                                                                                                                            | first run: 5 passed, 1 failed (test asked for the wrong button name), 2 did not run                                      | passed |                                                                                                                            |

## Verification

Node v24.22.0, pnpm 10.34.7 (`corepack pnpm`), Docker running and shared with other projects. Tip of the branch: `6e38849` (the later commit that records this file changes no code).

| Command | Result |
|---|---|
| `corepack pnpm install --frozen-lockfile` | exit 0 |
| `corepack pnpm typecheck` | exit 0 (contracts, api, web) |
| `corepack pnpm lint` / `format:check` | exit 0 |
| `corepack pnpm test` | **269 files, 3,410 tests passed** (seam: 259 files, 3,303) |
| `corepack pnpm test:integration` | **132 files passed, 1 skipped (the slow ClamAV suite); 2,013 tests passed, 4 skipped** (seam: 126 files, 1,933). A first full run had one failure of this track's own schema test (it shared the `fixture-N` e-mails of the fixture helpers with other files in the one database); fixed with the scheduling test world and re-run complete |
| `corepack pnpm build` | exit 0 |
| `corepack pnpm db:check` | No migration drift |
| `test:e2e` (`E2E_WEB_PORT=4560 E2E_API_PORT=3560 E2E_MINIO_PORT=9560`, `--workers=3`) | **176 passed, 1 failed**: `stage2-center.spec.ts:59` ("a day in the center") fails with `Page crashed` while waiting for the booking dialog. It fails the same way **alone** and **at the seam tip `e761579`** (checked out detached, web rebuilt, same ports), so it is not from this track: a browser crash on this machine today. This track's own spec passes (7 tests, alone and inside the suite) |

CI was not run or polled. Lighthouse was not run.
