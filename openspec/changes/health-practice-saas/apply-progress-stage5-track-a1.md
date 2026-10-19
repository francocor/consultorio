# Apply progress: Stage 5, track A1 (matricula verification, S5.01)

Strict TDD. Worktree `consultorio-wt-5a1`, branch `feat/stage-5-track-5a1`, cut from the Stage 5 seam `e53c33f`. Automatic mode, work-unit commits, no PR, no merge, CI not polled. Tasks 5.5, 5.6 and 5.7 are marked done in `tasks.md`. Scope: the platform operator verifies, withdraws and annotates a professional's matricula (routes, queue, operator screen), with both audit trails. The trigger of migration 0013 (only `app_operator` can verify, an edit of the number or jurisdiction resets the state) was already in place and is re-asserted, not changed.

## Commits (in order, oldest first)

| Task | Commit | What |
|---|---|---|
| 5.5, 5.6 | `4e316a2` | contracts (queue, verify, unverify, note), `application/matricula.ts`, four routes, migration **0505** (operator note table, name function, audit scope), integration test, policy and privilege test updates |
| 5.7 | `4022d5b` | `features/operator/matricula/*` (queue, verify, withdraw and note dialogs), the tab in the console, `matricula.*` keys in `operator.json`, component tests, Playwright desktop and 360 px |
| 5.5 | `7f5f635` | `test/support/matricula.ts` (`verifyMatriculaAsOperator`) for the other tracks, one line in `docs/stage5-tracks.md` |
| docs | this unit | `tasks.md` 5.5 to 5.7 marked, this file |

## Migration (range 5a1, `0505`)

`0505_matricula_operator_note.sql`:

- Table `matricula_operator_note` (id, `target_tenant_id`, `professional_id`, `note` up to 500 characters, `updated_by`, timestamps). A platform table, like `operator_session`: no `tenant_id` column and no row level security, because `REVOKE ALL ... FROM app_rw` leaves the operator role as the only reader and writer (SELECT, INSERT, UPDATE of `note`, `updated_by`, `updated_at`). The composite key to `professional (tenant_id, id)` is declared inside `CREATE TABLE` (an `ALTER TABLE ... ADD CONSTRAINT` validates with a query over the FORCE-secured `professional` and fails with an empty tenant) and cascades, so the demo reset removes the note with its professional.
- Function `app.operator_professional_name(uuid)`: SECURITY DEFINER, search path pinned, executable only by `app_operator`. It returns the display name of one professional of the transaction's own organization (FORCE RLS on `membership` still applies to the owner), because the operator role has, on purpose, no privilege on `membership`.
- The restrictive policy `operator_audit_scope` on `audit_event` now allows `matricula.verified` next to `tenant.created` and `support.access`, so the owner reads the verification in the organization's own trail.

## What was built

- **Routes** (platform host, operator session, `readOnly` categories like the holiday routes): `GET /operator/matricula-queue?status=unverified|verified`, `POST /operator/tenants/:tenantId/professionals/:id/matricula/verify|unverify`, `PUT .../matricula/note`.
- **Queue.** One transaction of the operator connection walks the non-cancelled organizations, sets `app.tenant_id` for each and selects the active professionals with a recorded matricula in the wanted state (name through the function, note by left join). Oldest first for the pending list, latest verification first for the verified one, at most 200. The DTO is strict: tenant (id, name), professional id, name, jurisdiction, number, state, verification time, note. Nothing else of the profile or of the care is selectable by the role.
- **Verify** names the registration that was checked (`jurisdiction` and `number` in the body). The update repeats that comparison in its `WHERE`, so a refusal (409) covers: edited since the operator looked, none recorded, inactive profile, already verified. It sets the three verification columns through the operator connection (the trigger accepts only that role), saves the optional note, writes `operator.matricula.verified` to the platform trail and `matricula.verified` to the organization's trail in the same transaction. **Unverify** clears the three columns and writes `operator.matricula.unverified` to the platform trail only. **Note** saves the text alone (an empty text clears it).
- **Screen.** A "Matrículas" tab (the declared exception in `OperatorConsole.tsx`), pending and verified filters, a table with caption, status badge with icon and word, note, verify, withdraw (confirmation) and note dialogs, empty and error states, the dedicated message when the server says the registration changed. The "Verificada" badge in the staff profile and cards already existed and reads the existing DTO field; the e2e proves the owner sees it change.

## TDD cycle evidence

| Task | Test file | Layer | RED | GREEN | TRIANGULATE | REFACTOR |
|---|---|---|---|---|---|---|
| 5.5 | `packages/contracts/src/operator.test.ts` (5 new) | Unit | 4 failed (schemas missing), then 2 failed when the verify body gained the registration | 7 passed | strict parsing, trimming, defaults, rejection of extras and of an empty number | none needed |
| 5.5, 5.6 | `apps/api/test/integration/matricula-verification.test.ts` (24) | Integration, real Postgres as `app_rw` and `app_operator` | written before any route or migration existed | 9 failed on the first run (routes answered 500: the tenant-trail insert was refused by `operator_audit_scope`), 1 failed on a test bug (`undefined` triggers a default parameter); 20 passed after the policy change and the fix; 24 passed with the later cases | verify twice, no registration, inactive, foreign organization, unknown and malformed ids, stale number and jurisdiction, no session, tenant host as professional and as owner, database trigger for `app_rw`, withdraw twice, edit resets and requeues, both queue states, exclusions, strict status, note save, replace, clear, limits, note unreadable by the organization, name scoped to its tenant, clinical tables unreadable, demo reset cascade, out-of-band helper | `matricula.ts` split into `selectRows`, `load`, `writeNote`, `assertDecidable`; prettier |
| 5.5 | `operator-privileges.test.ts`, `definer-functions.test.ts`, `audit-scenarios.ts` | Integration, policy | table and function not in the allowlists (red by design) | passed after the entries | audit scope: the three allowed actions insert, three others are refused | none needed |
| 5.7 | `apps/web/src/features/operator/matricula/matricula.test.tsx` (10) | Component | tab and queue missing | 10 passed | pending and verified lists, verify with and without a note, stale refusal, withdraw with a note, note prefilled and saved, two empty states, axe | typing fix flagged by eslint |
| 5.7 | `apps/web/e2e/stage5-matricula.spec.ts` (2), `stage5-matricula.responsive.spec.ts` (2, run on desktop and mobile-360) | E2E, real stack | specs written against the screen | first run failed on the accessible name (it includes "Dr."); 7 of 7 passed after the fix | operator verifies, owner's team page changes, operator withdraws; note saved and restored; 360 px without horizontal overflow; axe on page and dialog | none needed |

Safety net: the files edited rather than created (`operator-routes.ts`, `index.ts`, `operator.ts` schema and contracts, the privilege and definer tests, `OperatorConsole.tsx`) were covered by the green baseline of the seam (393 files, 5,017 tests) and by the same suites re-run after each change (the last full run is in the table below).

## Deviations from the tasks and the design

1. **Verify carries the reviewed registration** (`jurisdiction`, `number`), not an empty body. Without it, an edit by the organization between the operator's look and the click would let the operator vouch for a number nobody checked. Not in the spec; it adds a 409.
2. **The note is a platform table without `tenant_id`.** The first version was a tenant table with RLS; the generated isolation suite exercises every `tenant_id` table as `app_rw`, which must not touch an operator-only table. Naming the column `target_tenant_id` and revoking `app_rw` follows `operator_session` and `platform_audit_event`.
3. **A definer function returns the professional's name.** The task says the operator sees the name; `membership` holds it and `operator-privileges.test.ts` forbids any privilege on it. The function returns that one text for the transaction's tenant.
4. **The tenant trail gets `matricula.verified`, which needed a migration** (the operator could insert only two tenant actions). `docs/stage5-tracks.md` says the tenant trail already has the action; it did not say the operator role could write it. A withdrawal has no tenant action (the track may not add one), so it appears in the platform trail only.
5. **`GET /operator/matricula-queue` takes `?status=verified`.** Without it the operator could never find a verified registration to withdraw. The default is the pending list, as the task says.
6. **Edits outside the track's own list**, all additive and small: `db/schema/operator.ts` (the table), `packages/contracts/src/operator.ts` and its test (the shapes; the A1 list names no contracts file), `test/integration/definer-functions.test.ts` and `operator-privileges.test.ts` (one entry each plus an audit-scope test), `test/policy/audit-scenarios.ts` (one line: `matricula.verified` goes from pending to `matricula-verification.test.ts`), `docs/stage5-tracks.md` (one sentence). No seam file was touched.
7. **No self-verification check by id.** The design says the service rejects verification where the operator user equals the professional's user. Operators and staff are different tables with different id spaces, so the case cannot happen and a check would be vacuous; what stops owners and professionals is the trigger, proven for `app_rw` in the new test.
8. **A note save is not audited on its own** (the platform catalog is closed and the track may not add actions). The row keeps who wrote it and when, and a note that travels with a decision is flagged `noteChanged` in that decision's audit entry. A note is never audited with its content (`note` is a forbidden metadata key).

## Exports for the other tracks

- **Track A3 (e-Rx gate).** Nothing new in production: the gate reads `professional.matricula_status = 'verified'`. Only the operator role can set it and the trigger resets it when the number or jurisdiction changes, so "prescribing closes again" needs no code in `prescriptions`. For tests, `verifyMatriculaAsOperator(operatorDb, tenantId, professionalId)` in `apps/api/test/support/matricula.ts` verifies as the operator role does. A test of the console goes through the verify route with `{ jurisdiction, number }`.
- **Track B (portal).** Nothing. The portal does not read the matricula.
- **Track C (integration).** The note table has no `tenant_id`, so the demo coverage test needs no exemption. The demo seed may leave professionals unverified (as today) or verify some through the operator role; the e2e of this track verifies and withdraws one pediatrician and leaves the demo unverified.

## Risks and follow-ups

- The queue walks the organizations one by one inside one transaction (one query each). Fine for the hundreds of organizations of this stage; at thousands it wants an index-backed definer function or a counter, and the 200-row cap becomes pagination.
- A registration whose professional is inactive is not in the queue and cannot be decided; reactivating the profile brings it back.
- A withdrawal is invisible in the organization's trail (no tenant action). If the owner should see it, a later seam adds `matricula.unverified` to the tenant catalog and to `operator_audit_scope`.
- `apply-progress.md` and `tasks.md` are appended or edited by every track; keep every section when merging. `_journal.json` and the snapshots need `pnpm db:restamp` after the merge.

## Verification (tip `7f5f635`, Node v24.22.0, pnpm 10.34.7, Docker shared with up to five agents)

| Command | Result |
|---|---|
| `corepack pnpm install --frozen-lockfile` | exit 0 |
| `corepack pnpm typecheck` | exit 0 |
| `corepack pnpm lint` / `format:check` | exit 0 |
| `corepack pnpm test` | **394 files, 5,032 tests passed, 1 skipped** (`boot.test.ts`, the Lighthouse lazy-route checks and the policy tests included) |
| targeted `test:integration` files (matricula verification, operator privileges, definer functions, no-delete privileges, RLS catalog, generated isolation, demo coverage, migration lanes, staff profile and schema, audit coverage, schema index, public routes, route role matrix, operator support, tenants, auth and holidays, provider console, Stage 4 demo, wiring) | **19 files, 735 tests passed**; `matricula-verification.test.ts` alone: 24 passed |
| `corepack pnpm build` | exit 0 |
| `corepack pnpm db:check` / `db:restamp` | No migration drift; stamps already rising; snapshots already chained |
| Playwright (`E2E_WEB_PORT=4920 E2E_API_PORT=3920 E2E_MINIO_PORT=9920`, `--workers=1`): `stage5-matricula.spec.ts`, `stage5-matricula.responsive.spec.ts` | **7 passed** (setup, 4 desktop, 2 mobile-360); axe clean, no horizontal overflow at 360 px |

The full integration and e2e suites were not run (shared Docker). No `.env` file was read or written. Logs are in `$TEMP/5a1-*.log`. The containers of the e2e stack were removed by their Ryuk reaper; none was killed by hand.
