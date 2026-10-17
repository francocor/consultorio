# Apply progress: Stage 2, onboarding track (S2.29 and S2.30)

Strict TDD. Worktree `consultorio-wt-onboarding`, branch `feat/stage-2-onboarding`, based on `28ba4cf`. Automatic mode, delivery `size:exception` (work-unit commits, no PR, no merge, CI not polled). Tasks 2.86 to 2.93 are marked done in `tasks.md`. This file is separate from `apply-progress.md` on purpose; the orchestrator merges it.

## Commits (in order)

| Slice | Commit | What |
|---|---|---|
| S2.29 | `615491a` | contracts: `onboarding.ts`, permission `onboarding.manage` (owner; grantable), `needsWizard` in `MeResponse`, five audit actions, identity port `needsWizard` |
| S2.29 | `1bc9b40` | `onboarding_state` table, migration **0070**, isolation fixture, completed demo state in the seed |
| S2.29 | `5c76811` | `modules/onboarding` (domain, facts, store, service, routes), self-added professional role for the owner, wiring in `application.ts` |
| S2.30 | `e400abf` | wizard page, quick setup, six steps and review, `/onboarding` route, sign-in landing, es-AR catalog |
| S2.30 | `cd5745e` | first-run checklist in the shell slot, dialog from the account menu |
| S2.30 | `a7f03d5`, `8a82535` | e2e ports by environment; `e2e/onboarding.spec.ts` (three journeys at 360 px) |
| S2.29 | `28f647b` | administrative export contributor (a guard test demands one per module) |
| S2.30 | `489fcc4`, `b7034b9` | label of the new grant in the permissions tab; docs |

## What was built

- **State (2.86).** One row per organization (`onboarding_state`: step progress, cursor, answers, wizard completed and checklist dismissed, each with its author). `GET|PUT /onboarding/state`, `POST /onboarding/complete` (400 with the missing pieces named), `GET /onboarding/invitation-impact`. Everything needs the new permission `onboarding.manage`: the owner has it, an admin only by an explicit grant (it is in `GRANTABLE`). A required step (location, hours, appointment type) is never skipped or declared done by a click: it is done by its data.
- **Roles (2.87).** `POST /onboarding/professional`: yes adds the `professional` role to the owner's own membership and saves the profile (matricula optional); no records the answer and the wizard keeps asking for a professional. Tenant defaults (country AR, es-AR boot, Buenos Aires zone for a new location) are proven by a test; they already existed.
- **Fast path (2.88).** `POST /onboarding/fast-path` fills only the gaps (professional, location "Consultorio", Monday to Friday 09:00 to 17:00, a 30-minute "Consulta"), never duplicates, no matricula, and finishes the wizard. A first booking through the real API is proven.
- **Checklist (2.89).** `domain/checklist.ts` over `application/facts.ts` (one SQL round trip): eight items from real data. Items and wizard steps of an unavailable capability (`patients`, `scheduling`, `branding`, `billing`) are not listed (`onboardingCapabilities` option).
- **Invitations and audit (2.90).** The invitation is the existing `POST /staff/invitations` (inviter ceiling, D19, email only); the plan-impact hook is `PlanImpact` (a no-op until subscriptions). `/auth/me` returns `needsWizard`. Audited: `onboarding.step_updated`, `.completed`, `.fast_path`, `.checklist_dismissed`, `.checklist_restored`, plus the existing `role.changed`, `staff.profile_updated`, `location.created`, `professional.hours_updated`, `appointment_type.created`.
- **Wizard UI (2.91).** `/onboarding`: first visit offers "Atiendo por mi cuenta" (quick setup, one form, then a ready screen with "Ir a la agenda" and "Registrar un paciente") or "paso a paso" (profile, consultorio, days and hours, appointment type, team, branding, review). Resumable (cursor and answers saved), inline Spanish validation, required steps have no skip, optional ones do. Signing in lands in the wizard while it is unfinished (unless a `redirect` was asked for).
- **Checklist UI (2.92).** Card in `FirstRunSlot` (people with `onboarding.manage`, hidden when dismissed or finished, quiet on loading or error), "Primeros pasos" in the account menu (Help) with the progress and "Mostrar en el inicio", and a link in the Settings header.
- **e2e (2.93).** Resume at step 3, skipped branding keeps the default theme, reception sees no checklist and is denied the wizard, the quick setup; axe and no horizontal overflow at every step at 360 px.

## TDD Cycle Evidence

| Task | Test files | Layer | RED | GREEN | Triangulation |
|---|---|---|---|---|---|
| 2.86 | `contracts/onboarding.test.ts`; `domain/wizard.test.ts`; `onboarding-schema.test.ts`; `onboarding-api.test.ts` (state, complete); generated isolation | Unit + integration | written first (modules missing). **Deviation:** the schema file was written before its test, so no failing run of the schema test was seen | green | denials per role, grant for an admin, required step refused, dismiss and restore, other organization |
| 2.87 | `onboarding-api.test.ts` ("are you a professional?") | Integration | written first | green | yes, yes twice, no, bad matricula atomic, admin refused, closed after the wizard, audit |
| 2.88 | `onboarding-api.test.ts` (fast path) | Integration | written first | green | full, booking, repeat, gaps, named, audit, three denials, invalid body |
| 2.89 | `domain/checklist.test.ts`; `onboarding-api.test.ts` (checklist) | Unit + integration | written first | green | each item from its own data, capability hidden |
| 2.90 | `onboarding-api.test.ts` (impact, invitation, needsWizard); `onboarding-export.test.ts` | Integration | written first; the export test came from a failing guard (`export-registry.test`) | green | role ceiling, D19, admin with grant |
| 2.91 | `wizard.test.tsx` (35), `schedule-summary.test.ts`, `checklist.test.tsx` (landing) | Component + unit | written first | green. First run after the implementation: 59 of 60, the failure was an ambiguous selector of the test | every step, validation, resume, skip, blocked finish, denial, error and retry, axe |
| 2.92 | `checklist.test.tsx` (12), `staff/permission-labels.test.ts` | Component | written first; the label test was seen failing (RED) before the catalog entry | green | owner, reception, admin with and without grant, dismissed, finished, Help |
| 2.93 | `e2e/onboarding.spec.ts` | e2e (real stack) | written first | green after waiting for a toast to finish fading (axe read it mid-fade) | three journeys |

### Bugs found by the tests

1. `world()` of the API test mixed a professional and staff into every organization, which made the checklist facts wrong; the test world is now owner-only and adds a team on demand.
2. The matricula is normalized by the country pack (`MP 12345` is stored as `12345`); the test expected the raw text.
3. The export guard (`every module registers an export contributor`) failed for the new module.
4. axe in the browser flagged a toast mid-fade (`color-contrast`); the spec waits for it to settle.
5. Python on Windows rewrote files with CRLF; prettier on commit (lint-staged) normalizes them. Four contract files keep showing as modified in `git status` for that reason only (`git diff` is empty).

## Verification (tip of `feat/stage-2-onboarding`, Node 24, pnpm 10.34.7, Docker running)

| Command | Result |
|---|---|
| `corepack pnpm install --frozen-lockfile` | exit 0 |
| `corepack pnpm typecheck` | exit 0 |
| `corepack pnpm lint` | exit 0 |
| `corepack pnpm format:check` | exit 0 |
| `corepack pnpm test` | **171 files, 2260 tests passed** |
| `corepack pnpm test:integration` | **93 files, 1453 tests passed** (Postgres 17, MinIO, Mailpit) |
| `corepack pnpm build` | exit 0 |
| `corepack pnpm db:check` | "No migration drift." |
| `corepack pnpm test:e2e` | **115 passed** (112 plus the three onboarding journeys; private ports 3310 and 4310, `--workers=3`, stack started by hand) |

Shared Docker: one earlier full integration run had two timing failures (`demo-coverage` reset time and `worker` sealing) while other worktrees used the machine; both passed alone. A later run failed one onboarding test that depended on the row order of an unordered `select` (a test bug, fixed in `dae4724`: the booking now uses the owner's professional); the final run is clean.

The `export-registry` guard (a module without an export contributor) failed once in `pnpm test` and led to `28f647b`.

## Decisions and deviations

1. **Permission.** `onboarding.manage`: owner by role, admin by grant. Reading the state needs it too, so an admin without the grant does not see the checklist (the app-shell text says "owners/admin"; the onboarding text says admins only when granted, and that one wins).
2. **The owner adds the professional role to themselves.** The authorization spec says roles are never self-assigned; the onboarding spec requires it ("owner has both roles"). It is one narrow path (`addProfessionalRoleToOwner`): read from the database (active owner), adds only `professional`, audited as `role.changed` with `via: onboarding`, and it is **closed once the wizard is finished** (a later owner asks another owner). No session revocation: roles are read from the membership on every request. The two specs should be reconciled by the owner.
3. **`needsWizard`** is true for a person with the permission whose organization has not finished the wizard, including an organization with no row. The demo seed writes a finished wizard and a dismissed checklist, so the demo opens on the agenda; a non-demo organization shows the wizard. Existing integration and e2e organizations are unaffected (the e2e ones are demo).
4. **Step order** is profile, consultorio, hours, appointment type, team, branding (the spec lists the set, not the order); the organization name is edited in the branding step.
5. **Checklist data.** "Invite staff" is done when another member exists or a staff invitation not created by the operator exists; "branding" when the theme has a saved color or logo (the name given at creation does not count); "matricula" when an active professional has one.
6. **Task text vs files.** `application/checklist.ts` became `domain/checklist.ts` (pure) plus `application/facts.ts`.
7. **The quick setup ends on a screen**, not an automatic redirect, because `/calendar` belongs to the scheduling UI slices; the screen links to it.
8. **Specialties** are typed comma-separated and split on the client.
9. **Migration 0070** (renamed from the generated 0028; journal `idx` is still 28, tag `0070_onboarding_state`). Regenerate the meta at merge if another track also numbered from its own base.
10. **No AI attribution** in commits, as the owner's standing rule requires.

## Shared files touched (expect merge work)

`packages/contracts`: `index.ts`, `roles.ts` (+test, a permission and `GRANTABLE` is now 6), `auth.ts` (+test, `needsWizard` is required), `audit-actions.ts`. API: `main/application.ts`, `main/export-contributors.ts`, `db/schema/index.ts`, `db/seed/demo/seed.ts`, `db/migrations/meta/_journal.json`, `modules/{access,staff,scheduling}/index.ts` (additive exports), `modules/identity/{index.ts,http/auth-routes.ts}`, `test/policy/audit-scenarios.ts`, `test/support/fixtures.ts`. Web: `app/{router.tsx,FirstRunSlot.tsx,UserMenu.tsx,i18n.ts,shell.test.tsx}`, `features/auth/LoginPage.tsx`, `features/settings/SettingsPage.tsx`, `shared/lib/{translate.ts,api-client.test.ts}`, `shared/test/fixtures.ts` (`needsWizard: false` in `meFor`), `locales/es-AR/{audit,settings,shell,staff}.json`, `playwright.config.ts`, `e2e/support/stack.ts`. Docs: `docs/dev-setup.md`, `docs/demo.md`.

## Assumed scheduling UI paths

`/calendar` (agenda: the quick-setup screen and the checklist item "first appointment"), `/patients/new` (exists). The wizard and the checklist do not build any calendar screen. Until the scheduling UI is merged `/calendar` shows the not-found page. Navigation entries stay gated by `ENABLED_STAGE`, untouched.

## Risks

- The two specs on role self-assignment (decision 2).
- `MeResponse.needsWizard` is required: any other track that builds a `MeResponse` literal must add it (`meFor` already does).
- Nothing was verified in CI (never polled); Lighthouse not re-run.
- The first-run card sits above every page of the owner until dismissed; the item list is collapsed outside the start page.
