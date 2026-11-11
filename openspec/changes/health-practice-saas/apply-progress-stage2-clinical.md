# Apply progress: Stage 2, clinical records track (S2.17 to S2.24)

Change `health-practice-saas`. Mode: **Strict TDD**. Artifact store: openspec. Worktree `consultorio-wt-clinical`, branch `feat/stage-2-clinical`, based on the Stage 1 tip `9bd2379`. This file belongs to the parallel clinical track only; `apply-progress.md` is untouched. Engram topic `sdd/health-practice-saas/apply-progress-clinical`.

## Status

Tasks 2.47 to 2.74 (slices S2.17 to S2.24) are done and marked `[x]` in `tasks.md`. Nothing is merged and no pull request is open; the branch is pushed. A fresh security review came back FIX BEFORE MERGE; its fixes are in the section "Security review fixes (round 2)" below.

| Slice | Tasks | Commits |
|---|---|---|
| S2.17 Clinical schema and immutability triggers | 2.47 to 2.50 | `4e6a835` |
| S2.18 Draft and sign, S2.19 Addenda, errors, history | 2.51 to 2.58 | `eb67b32` |
| S2.20 Specialty templates | 2.59 to 2.62 | `0cedd9b` (contracts), `0c9f82f` (offer endpoint, end-to-end checks) |
| S2.21 Timeline, search, retention | 2.63 to 2.66 | `0c9f82f` |
| S2.22 Clinical editor UI, S2.23 Specialty UIs and odontogram | 2.67 to 2.71 | `d4d3527`, `07a9fc1` (test fix) |
| S2.24 Chart, search and addenda UI | 2.72 to 2.74 | `fe68311` |
| Demo seed (signed notes per specialty) | n/a | `b202ee2` |
| Playwright journeys | 2.69, 2.74 | `6b531e9` |
| Test timeouts, task marks, this file | n/a | `4d3325e` and the commit that adds this file |
| Security review fixes (H1/D20, M1, M2, L1; L2) | n/a | `4c31b3f`, `a29b7d2`, then the docs commit |

## Migrations added

Numbered 0060 and up, as the orchestrator asked (scheduling uses 0023 to 0039, documents 0040 and up). The journal `idx` values are 23, 24 and 25 (what drizzle-kit wrote); only the file tags and snapshot names were renamed, so the orchestrator renumbers at merge.

- `0060_clinical.sql`: `encounter`, `clinical_note`, `note_version`, `addendum`; tenant policies (FORCE RLS), the two RESTRICTIVE clinical policies on each, a RESTRICTIVE policy that keeps a draft private to its author, a RESTRICTIVE insert policy so only a treating professional adds an addendum, `REVOKE DELETE, TRUNCATE` on all four, `REVOKE UPDATE` on versions and addenda, column-level `UPDATE (visibility, updated_at)` on encounters.
- `0061_clinical_triggers.sql`: immutability and care triggers (see decisions). Two SECURITY DEFINER functions, `app.encounter_care_sync()` and `app.clinical_note_care_sync()`, executable by nobody (only trigger firing); both were in the allowlist of `definer-functions.test.ts`. Migration 0062 later removed the first.
- `0062_clinical_d20.sql` (security review round 2): encrypted reasons, the discarded draft copy, `clinical_footprint`, D20 in `encounter_guard`, counting on signature (see the section below).

## What was built

- **Backend (`apps/api/src/modules/clinical`)**: encounters and notes (open, save draft with a revision check, sign with a SHA-256 of the canonical content), addenda (`correction` and `rectification`, the latter also in a read-only organization, D16), entered in error, history (`GET /notes/:id/versions`), per-patient timeline, per-patient search (decrypt in memory, accent-insensitive, 2,000-entry cap that asks for a date range, one key unwrap per request), the professional's drafts, the current odontogram derived from signed entries, the templates a professional is offered, and the per-professional clinical export contributor. Routes: `POST /encounters`, `PUT /encounters/:id/note/draft`, `POST /notes/:id/sign`, `GET /notes/:id`, `POST /notes/:id/addenda`, `POST /notes/:id/entered-in-error`, `GET /notes/:id/versions`, `GET /patients/:id/clinical/{timeline,search,odontogram}`, `GET /clinical/{drafts,templates}`. There is no route that deletes, edits a signed entry or searches across patients (tests assert it).
- **Contracts (`packages/contracts`)**: `clinical-templates/` (general, odontology, psychology, physiotherapy, nutrition; a draft schema and a sign schema each; the versioned registry; FDI tooth validation; computed BMI; current-odontogram derivation) and `clinical.ts` (requests and responses).
- **Web (`apps/web/src/features/clinical`)**: template-driven editor (react-hook-form + the contract schemas), debounced autosave with a "Guardado" indicator and the stale-revision prompt, sign confirmation, psychology / physiotherapy / nutrition / odontology UIs, the SVG-and-button odontogram (one tab stop, arrows to move), note screen with addenda, versions drawer, addendum and entered-in-error dialogs, chart tab in the patient record, per-record search, drafts page, and `/encounters/new?patientId=&appointmentId=` (the link scheduling will use). New namespace `clinical` (es-AR).
- **Demo**: thirteen notes through the real services (cardiology and pediatrics with the general template, psychology sessions, one restricted to its author, an addendum, an entry in error, a draft). The snapshot compares them between seeds; `docs/demo.md` describes the story.

## TDD Cycle Evidence

RED = the test file was written before the production code it exercises (the run failed on a missing module, or on assertions of absent behavior). GREEN = the file-level run that followed. "Triangulated" = more than one input or a table of cases.

| Tasks | Test file(s) | Layer | RED | GREEN | Triangulation | Notes |
|---|---|---|---|---|---|---|
| 2.47, 2.50 | `test/integration/clinical-schema.test.ts`, generated `isolation.generated.test.ts`, `rls-catalog` | Integration | run seen failing (missing schema module) | green | 4 tables x policies, privileges, draft privacy, composite keys, vocabulary checks | the generated suite found that fixtures must honor every composite-key override and that triggers must raise 23503 for a parent mismatch |
| 2.48, 2.49 | `test/integration/clinical-immutability.test.ts` | Integration | run seen failing (24 of 28) | green after migration 0061 | 28 cases: draft, signed, owner, delete, truncate, entered in error, addenda, care relationship | also proves the owner cannot change a signed entry |
| 2.59, 2.61 | `packages/contracts/src/clinical-templates/templates.test.ts` | Unit | written first (the module did not exist); the failing run was not executed | green (30) | valid and invalid fixtures per template, FDI code table, BMI, derivation, specialty matching | |
| 2.53 contract | `packages/contracts/src/clinical.test.ts` | Unit | written first | green (11) | author stripped from the body, kinds, ranges | |
| 2.52 | `src/modules/clinical/domain/canonical.test.ts` | Unit + property | written first | green | fast-check on key order | |
| 2.51 to 2.54 | `clinical-notes-api.test.ts`, `clinical-access.test.ts` | Integration | written first (routes did not exist) | green (49 with the addenda file) | golden path, spoofed author, other tenant, stale save, second sign, missing field, immutable edit audited, encryption at rest, every role against every route | |
| 2.55 to 2.58 | `clinical-addenda.test.ts` | Integration | written first | green | addendum by author / colleague / shared reader, read-only organization (D16), entered in error by author / colleague / shared reader, history order and hashes, shared-read audit reason | |
| 2.60, 2.62 | `clinical-templates-api.test.ts` | Integration | written first | green | offers by specialty, validation per template, psychology excluded by default end to end | |
| 2.63 | `clinical-timeline.test.ts` | Integration | written first | green | order, hidden errors, visibility, shared, audit per entry, anamnesis link, cursor, denial | |
| 2.64 | `clinical-search.test.ts`, `domain/search-text.test.ts` | Integration + Unit | written first | green | accent-insensitive, addendum hit, visibility, cap with a lowered cap, one key unwrap on a cold cache | |
| 2.65 | `clinical-logging.test.ts` | Integration | written first | green | trace-level log, words in bodies, query, errors | |
| 2.66 | `clinical-retention.test.ts` | Integration | written first | green | read-only reads, no delete route, leaver, export per professional | |
| 2.67 to 2.69 | `clinical-editor.test.tsx`, `domain/content.test.ts` | Component + Unit | `content.test.ts` written first; **the editor was written before its component test** (deviation) | green (14 + 9) | autosave chain, invalid value, restriction, stale: keep / reload / locked, sign, missing required, server refusal, read-only, axe | Playwright `clinical.spec.ts` covers the two-tab conflict |
| 2.70, 2.71 | `clinical-templates.test.tsx`, `odontogram/*.test.*` | Component + Unit | `geometry.test.ts` and `odontogram.test.tsx` written first (run seen failing on the missing module); **the specialty field components were written before `clinical-templates.test.tsx`** (deviation) | green | one-tap choices, pain scale including 0, range of motion row, BMI, decimal comma, implausible confirmation, odontogram keyboard and read-only, axe per template | |
| 2.72 to 2.74 | `clinical-chart.test.tsx` | Component | **written after the components** (deviation) | green (33) | timeline, errors, anamnesis tab, 403, paging, versions drawer, search (term, range, too short, range required), start dialog, note read, addendum, read-only organization, entered in error, drafts, new encounter | |
| demo | `dataset.test.ts`, `demo-seed.test.ts`, existing `demo-reset` and `demo-coverage` | Unit + Integration | written first | green | notes valid for their template, every state present, snapshot equal between seeds | the reset budget test passes (1.7 s) |
| 2.69, 2.74 | `e2e/clinical.spec.ts`, `e2e/clinical.responsive.spec.ts` | E2E | written after the screens | green | autosave, two tabs, sign and lock, chart, search, addenda, role matrix, axe at 360 and 1280 px | found two real contrast problems (see below) |

## Verification

Node v24, pnpm 10.34.7 via corepack, Docker Desktop running. The host was heavily loaded by two other writers (Postgres took over two minutes to initialize), which matters for the integration row.

| Command | Result |
|---|---|
| `corepack pnpm install --frozen-lockfile` | exit 0 (no dependency was added) |
| `corepack pnpm typecheck` | exit 0 |
| `corepack pnpm lint` | exit 0 |
| `corepack pnpm format:check` | exit 0 |
| `corepack pnpm test` | **157 files, 1861 tests passed** when its three projects run on a quiet moment (web 51 files / 578 tests, contracts and api 106 files / 1283 tests). A single combined run under the full host load failed 6 timing-sensitive tests (jsdom waits and the ESLint-based unit tests), all of which pass alone |
| `corepack pnpm test:integration` (Testcontainers) | one run: 85 files, 1260 of 1271 tests passed; the 4 failures were timeouts under load (two of this track's journeys at 30 s, the demo reset budget at 45 s, the worker sealing at 16 s) and passed in isolation; a hook timeout of one clinical file led to the 90 s / 120 s limits now set by `clinical-world.ts` |
| Same suite against a persistent Postgres 17 container with the same roles script and migrations (a local-only setup, see below) | **85 files, 1271 tests: 1270 passed**; the one failure (`storage-s3`, "socket hang up" from the MinIO container) passes alone |
| `corepack pnpm build` | exit 0 |
| `corepack pnpm db:check` | "No migration drift." |
| `corepack pnpm test:e2e` equivalent (ports 3200/4273 through `E2E_API_PORT` and `E2E_WEB_PORT`, fresh stack, desktop and mobile-360) | **137 passed** (it was 112 at the Stage 1 tip) |

## Decisions and deviations

1. **Encounters and care relationship (task 2.49).** *Superseded by D20 (see the security review fixes): only a SIGNED encounter counts.* In the first pass an encounter counted for the author as soon as it was opened (draft included), as source 2 of the care relationship. An entry marked in error stops counting (`care_adjust(..., -1)`), because otherwise opening an encounter on the wrong patient would leave the professional with access to that patient's record. The design only says "an encounter by the professional"; this is the safer reading. Both triggers run as the owner because `app_rw` cannot write `care_relationship`.
2. **A draft is private to its author** (RESTRICTIVE policy `clinical_draft_author_only`), even from a professional who treats the patient. The spec lets only the author edit a draft; reading it was not specified, and a working copy is not part of the shared record. An author may also mark their own **draft** as entered in error (a draft opened on the wrong patient could never be removed otherwise); the design allowed it only from signed.
3. **`signed_by` was dropped** from `clinical_note` and `note_version`: only the author can sign (the trigger enforces it), so the signer is `author_professional_id`. `error_marked_by` has no foreign key (the trigger sets it to the acting professional). Both keep the composite-key set of the generic isolation suite simple: every composite key is `(tenant_id, x_id)`.
4. **Encounter repeats `visibility` and `template_kind`** of its note so the policies decide on one row; a trigger keeps the visibility equal while the note is a draft. One note per encounter (unique index).
5. **`appointment_id` is nullable with no foreign key** on `encounter` (an extension point, indexed). `POST /encounters` accepts `appointmentId`; scheduling can add the foreign key and the "in progress" prefill. The web link is `/encounters/new?patientId=&appointmentId=`. Today and the appointment drawer (S2.15) do not exist on this base, so task 2.68 is met through the patient chart, the drafts view and that link.
6. **Content is encrypted per row**: the draft with the AAD of the note, the signed version with the AAD of the version, the addendum with its own. The stored plaintext is the canonical JSON (sorted keys), so the stored SHA-256 is the hash of exactly what was encrypted. Signing clears the working copy.
7. **Optimistic signing**: `POST /notes/:id/sign` also accepts `expectedRevision` (the editor sends it) so a second tab's newer save is never signed unseen (409 `stale_revision`).
8. **Reasons (`reason`, `error_reason`) were plaintext columns** in the first pass. Superseded: they are encrypted since migration 0062 (see the security review fixes).
9. **Hidden-or-missing notes answer 404** (`GET /notes/:id`), uniform with the rest; the spec's "denied and audited" is met on the timeline and the search (403 plus a deny entry) where the patient is known. Refusals decided by a service carry the patient and the entry in their deny audit row.
10. **Read-only organization (D16)**: the addendum route has the `rectification_addendum` category, so the policy lets it in, and the service refuses any other kind with 402. New encounters, drafts, signatures, other addenda and error marks are refused by the `write` category.
11. **Audit volume**: each autosave writes a `clinical.note.updated` entry (clinical writes must be audited and a write must not complete without its entry). With a 1.5 s debounce this is a handful per consultation.
12. **Template offer vs. enforcement**: `GET /clinical/templates` offers the generic template plus those of the professional's specialties (keyword match on accent-folded text); the server accepts any registered template when an encounter is opened, so a professional is never blocked from writing. The organization-level enable/disable of templates (a spec MUST) has no writer in these slices and is not implemented; the offer endpoint is the place to read it from.
13. **Date range of the search** is read in the time zone of the organization's first location (UTC when it has none).
14. **Clinical export contributor** (`clinical`, per professional) needs the key service: `registerAllExportContributors(registry, { keys })`. Registered without `keys` it fails when run rather than exporting nothing. Entries in error are excluded and counted, per the spec.
15. **Hover contrast of the primary button.** Axe measured 3.83:1 for a hovered primary button in the Aillu theme (`hover:bg-primary/90`). It is a design-system token and affects every primary button, so it was not changed here; the Playwright check moves the pointer away first and the finding is reported.
16. **Link-variant buttons** (`text-primary-ink`) measured 4.31:1 on the page background in the Aillu theme; the two I added were turned into ghost and outline buttons. Other uses of that variant sit on white cards.
17. **Shared-file additions**: `E2E_WEB_PORT` / `E2E_API_PORT` in `playwright.config.ts` and `e2e/support/stack.ts` (defaults unchanged) so several checkouts can run the suite on one machine.
18. **Local-only tooling, not committed**: a persistent Postgres 17 container (`consultorio_clin_pg`, 127.0.0.1:55432), `apps/api/test/support/local-postgres.ts`, `apps/api/vitest.local.config.ts` and two stack scripts (all excluded through `.git/info/exclude`) were used because Testcontainers could not start Postgres inside its two-minute limit while the host was loaded. They run the same roles script and migrations.
19. **TDD deviations (honest list)**: the editor, the specialty field components and the chart components were written before their component tests; the tests were then written in full and all pass, including axe. The contract test files were written before their modules but their failing run was not executed. Everything in the backend followed RED first with a seen failing run (schema, triggers) or a missing-route run.

## Security review fixes (round 2)

A fresh security review of the track came back FIX BEFORE MERGE. Each finding was reproduced by a failing test first (RED: 16 of 23 new tests failed before any fix), then fixed. Migration `0062_clinical_d20.sql` (journal idx 25) carries every schema change; no earlier migration was edited.

| Finding | Commit | What changed | Test |
|---|---|---|---|
| H1 (HIGH), D20 | `4c31b3f` | `open()` refuses (403 plus a deny audit entry naming the patient, reason `encounter_requires_relationship`) unless the professional already treats the patient or the patient has no clinical footprint; `encounter_guard` repeats the rule (42501) as a database backstop; `clinical_note_care_sync` counts an encounter only when its note is SIGNED (a signed entry marked in error still takes it back, a draft marked in error never counted); trigger `encounter_care_sync` dropped; new table `clinical_footprint` (written by definer triggers on the first note or anamnesis; backfilled) and invoker function `app.has_clinical_footprint`; `appointmentId` is checked through an injected `AppointmentLookup` (patient and professional must match, `appointment_mismatch`; no lookup configured means the link is refused) | `clinical-encounter-access.test.ts` (14 cases), `clinical-immutability.test.ts` (care relationship block rewritten) |
| M1 | `4c31b3f` | Marking an entry in error sets `draft_content_enc = NULL`; the trigger refuses an error mark that keeps it (23000) and `clinical_note_state_check` requires it; `openContent` returns `{}` for such a note, so the entry, the timeline and the history show nothing | `clinical-hardening.test.ts` (M1, 3 cases) |
| M2 | `4c31b3f` | `addendum.reason` and `clinical_note.error_reason` replaced by `reason_enc` / `error_reason_enc`, encrypted with the row-bound field encryption like the content; every reader (note, history, timeline, search, export) decrypts; the non-blank rule now lives in the contract (400) and the database only insists on a value | `clinical-hardening.test.ts` (M2, 3 cases), `clinical-immutability.test.ts` |
| L1 | `4c31b3f` | `expectedRevision` is required on `POST /notes/:id/sign` (400 without it, 409 `stale_revision` when it is not the current one) | `clinical-hardening.test.ts` (L1) |
| L2 | `a29b7d2` | `GET /patients/:id/clinical/search` counts per user (`clinical.search|tenant|user`) on the existing `RateLimitStore`: default 30 a minute, 429 with `Retry-After` and `rate_limited`; configurable through `ApplicationOptions.clinical.searchRateLimit`; no other clinical read is counted | `clinical-hardening.test.ts` (L2, 2 cases) |
| L3 | n/a | Left as is, handled at merge | n/a |

### D20: orchestrator decision, pending owner confirmation

Opening an encounter must require an ALREADY active care relationship from another source: an appointment with confirmed identity (D14/D18), a care assignment, or a previously SIGNED encounter. A patient with no clinical footprint (no notes, no anamnesis, no clinical documents, no care relationship with anyone) may get a first encounter. A draft does not count as a care source until its note is signed. `appointmentId`, when given, must reference an appointment of the same patient and professional (application-level check now, foreign key at merge). Enforced in the service and as a database backstop in `encounter_guard`. Specs updated: clinical-records ("Opening an encounter needs a care relationship", plus scenarios for signing without a revision, a draft marked in error, and the search rate limit) and authorization ("Opening an encounter does not create access"). Design 3.4 updated for the encrypted reasons and the footprint table.

Consequences worth knowing:

- The footprint counts any note, including one marked in error. A professional who marks their own never-signed draft in error cannot open another encounter on that patient without another source (an assignment or an appointment). Chosen on purpose: the footprint says "somebody wrote here", and forgetting it would reopen the hole.
- Documents classified as clinical must also mark `clinical_footprint` when that module lands (a trigger calling `app.clinical_footprint_mark()`); until then documents do not count.
- Until scheduling provides the appointment lookup (`clinical.appointments` in `createApplication`), an encounter cannot name an appointment (403 `appointment_mismatch`). The web link `/encounters/new?appointmentId=` therefore fails closed until the merge wires the lookup. Scheduling also has to feed the appointment source of `care_relationship`, which is what makes the first encounter possible for a patient who already has a record.
- The migration drops the old encounter-time counting and recounts `care_relationship.encounters` from signed entries. It adds `reason_enc NOT NULL` without a default, so it fails closed on a database that already holds addenda (none exists outside demo and test data; the demo is reseeded).
- Decision 1 and decision 8 of the list below are superseded by this section.

### Verification of the fixes

Run on the final tree. Host shared with other writers; the unit suite had one jsdom timing failure under load (`clinical-editor.test.tsx`) that passes alone (14 of 14).

| Command | Result |
|---|---|
| `corepack pnpm typecheck` | exit 0 |
| `corepack pnpm lint` / `format:check` | exit 0 / exit 0 (the local-only files described in decision 18 were moved aside, as in CI, because ESLint cannot parse `vitest.local.config.ts`) |
| `corepack pnpm test` | 157 files, 1861 tests: 1860 passed, 1 jsdom timing failure under load that passes alone |
| `corepack pnpm test:integration` (Testcontainers, the official runner) | **87 files, 1298 tests passed** |
| Same suite against the persistent local Postgres | 87 files; the only failures were the 5 generated isolation tests for the new table, fixed by registering a `clinical_footprint` fixture; the tenancy, RLS and definer files then passed (133 tests) |
| `corepack pnpm build` | exit 0 |
| `corepack pnpm db:check` | "No migration drift." (before and after the commits) |
| Playwright (ports 3200 / 4273, fresh stack, desktop and mobile-360) | **137 passed** |

## Shared files touched

`packages/contracts/src/index.ts` (exports), `apps/api/src/main/application.ts` (module registration and the optional `clinical.searchCap` test option), `apps/api/src/main/export-contributors.ts`, `apps/api/src/db/schema/index.ts`, `apps/api/src/db/migrations/meta/_journal.json`, `apps/api/src/modules/patients/index.ts` (exports `isTreating`), `apps/api/test/integration/definer-functions.test.ts` (allowlist entries: `app.clinical_note_care_sync()` and `app.clinical_footprint_mark()`), `apps/api/test/policy/audit-scenarios.ts` (clinical actions now point at tests), `apps/api/test/support/fixtures.ts` (four clinical fixtures), the demo seed (`dataset.ts`, `seed.ts`, `snapshot.ts` and their tests), `apps/web/src/app/{i18n.ts,router.tsx}` and `shared/lib/translate.ts` (namespace `clinical`, routes `/notes/$noteId`, `/encounters/new`, `/drafts`, and `?tab=chart` on the patient route), `apps/web/src/features/patients/PatientDetailPage.tsx` (chart tab), `apps/web/playwright.config.ts`, `docs/demo.md`, `tasks.md`. The navigation (`nav-config.ts`) was not changed: the `drafts` entry already exists and shows when `ENABLED_STAGE` reaches 2.

## Gotchas worth keeping

- The generic isolation suite sets every non-tenant column of a composite foreign key to the parent id, so a key like `(tenant_id, a, b)` breaks it, and a BEFORE trigger that checks a parent must raise 23503 (not its own code) or the suite sees a different error.
- A test helper that resets a session setting in `finally` hides the original error with 25P02 after an aborted statement.
- A hovered primary button and `variant="link"` buttons fail WCAG contrast in the Aillu theme.
- Bash heredocs that contain apostrophes (Spanish text) break the tool: write files with the editor tools.
- `vi.setConfig` in a support module sets timeouts for every file that imports it.

## Risks and follow-ups

- Merge: scheduling and documents also edit `application.ts`, `router.tsx`, `audit-scenarios.ts`, `fixtures.ts`, `definer-functions.test.ts`, `i18n.ts`, `tasks.md` and the demo seed. The orchestrator renumbers the two migrations; the new definer functions need no renumbering. When scheduling adds `appointment`, add the foreign key on `encounter.appointment_id` and the appointment source to `care_relationship`.
- Re-authentication for signing (a spec SHOULD) is not implemented.
- The organization-level toggle for templates (decision 12) is open. D20 needs the owner's confirmation.
- The integration suite is load-sensitive on this host (tests with 15 to 30 s budgets); CI runners are quieter.
