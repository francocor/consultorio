# Apply progress: Stage 5, track B (patient portal)

Change: `health-practice-saas`. Branch `feat/stage-5-track-5b`, from the seam tip `e53c33f`. Mode: automatic, strict TDD, work-unit commits, no PR, no merge, CI not polled. Slices S5.06 to S5.10 (tasks 5.24 to 5.42) are done. Consent (track A2) and e-prescription (track A3) are built on other branches: the portal builds against ports, shows an empty state while a port is not wired, and ships the adapters that map each module's real entry points to its ports (see "Integrator wiring").

## Status of the tasks

| Task | State | Notes                                                                                                                                                                             |
| ---- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.24 | done  | `db/schema/portal.ts`, migration `0550_portal_identity.sql` (identity, link, session; `REVOKE DELETE, TRUNCATE`; partial unique indexes on live links; FORCE row level security on the three tables; the `otp_challenge.purpose` check already listed the portal purposes, so no expand was needed). |
| 5.25 | done  | Invitation, activation (`portal_activation` token handler), deactivation, link revocation, staff routes.                                                                          |
| 5.26 | done  | Dependent links: representative invited at their own email with a verification note; majority review job (daily) suspends links at 18.                                           |
| 5.27 | done  | Registration by DNI and email with a code; no existence oracle.                                                                                                                  |
| 5.28 | done  | Sign in with email and code; one live code, 5 attempts, 3 sends per hour per address, per-address verify throttle; queue `portal.code_send` (category `auth`).                  |
| 5.29 | done  | `platform/http/{portal-session,portal-guard}.ts`, `auth-guard.ts` exception: `auth:'portal'` routes only under `/portal/`, `portalPermission`, Origin mandatory on writes.        |
| 5.30 | done  | Sessions of their own: `psid` cookie (`__Host-psid` when secure), 30 min idle, 12 h absolute, listing and ending sessions.                                                        |
| 5.31 | done  | Subject of the session: picker, `withPortalSubject`, DEFINER-bound GUCs.                                                                                                          |
| 5.32 | done  | Appointments (confirm, cancel inside the policy, join address) and shared documents (`0552_document_share.sql`, staff share/unshare routes).                                      |
| 5.33 | done  | Invoices, profile, rights requests; consents and prescriptions through ports (+ adapters for the real modules).                                                                   |
| 5.34 | done  | Profile edit (optimistic version), rectification and copy requests, DTO contract test (no clinical field).                                                                        |
| 5.35 | done  | One `document_download` portal file resource dispatching on `resourceType`; link bound to the session, 5 minutes, single use, re-authorized at redemption, `portal.download` audit. |
| 5.36 | done  | Dependents flow end to end, authorize / revoke by the adult.                                                                                                                      |
| 5.37 | done  | Tenant isolation: another organization's identity, link and file never resolve.                                                                                                  |
| 5.38 | done  | Message privacy (email only, no clinical words) and policy refusal for WhatsApp.                                                                                                  |
| 5.39 | done  | `features/portal`: sign-in, registration, code step, subject picker, frame naming whose data is shown; `portal.json`.                                                             |
| 5.40 | done  | Sections: appointments, documents, consents (list, read, sign, revoke), prescriptions, invoices; loading, empty and error states each.                                            |
| 5.41 | done  | Personal data, rectification, copy request, representatives, sessions; staff tab in the patient record.                                                                           |
| 5.42 | done  | `e2e/stage5-portal.spec.ts` (2 tests at 360 px).                                                                                                                                  |

## Commits (in order)

| Commit    | Tasks         | What                                                                                                        |
| --------- | ------------- | ----------------------------------------------------------------------------------------------------------- |
| `2b8a79f` | seam addendum | `portal.code_send` queue (category `auth`) so a read-only organization still lets patients sign in.        |
| `9cab2c1` | 5.24          | Schema, migration 0550, DEFINER hardening and allowlist, fixtures.                                         |
| `27047a8` | 5.29          | Portal cookie, session loader, guard, `findMisplacedPortalRoutes`.                                          |
| `30a65ea` | 5.25, 5.26    | Invitation, activation, deactivation, staff routes.                                                         |
| `3eeac57` | 5.27, 5.28, 5.30 | Register and sign in with a code, sessions.                                                              |
| `853ab3f` | 5.31, 5.32    | Subject of a session, appointments.                                                                         |
| `2413b6e` | 5.32          | Documents shared with the patient (migration 0552).                                                         |
| `6b36df6` | 5.33, 5.34    | Consents and prescriptions ports, invoices, profile and requests.                                           |
| `ac8e148` | 5.35 to 5.38  | Downloads, dependents, isolation, message privacy.                                                          |
| `614a8e2` | 5.27          | The slug of the public path is never read; the organization is the host's.                                  |
| `45f8f5d` | 5.39 to 5.41  | Web screens, locale file, component tests.                                                                  |
| `171f20a` | 5.33          | Consent adapter and files rendered on demand (bytes).                                                       |
| `fbd8034` | 5.33          | Prescriptions adapter.                                                                                      |
| `3e13859` | 5.42          | E2E spec and the two defects it found (logout body, contrast of the switch link).                           |

## Migrations

`0550_portal_identity.sql` and `0552_document_share.sql` (range 0550 to 0579). After both: `pnpm db:restamp` and `pnpm db:check` are clean. `0550` revokes DELETE and TRUNCATE on the three tables from `app_rw`; `0552` creates `document_share` (FORCE row level security, DELETE and TRUNCATE revoked) and the two `SECURITY DEFINER` functions `app.portal_shared_documents()` and `app.portal_shared_document(uuid)` (hardened with `REVOKE ALL ... FROM PUBLIC` and a grant to `app_rw`, and listed in the allowlist of `test/integration/definer-functions.test.ts`). `no-delete-privileges.test.ts` covers the revokes.

## TDD evidence

| Slice | Test files written first (RED) | What forced the code                                                                                                              | GREEN / triangulation / refactor                                                                                          |
| ----- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| S5.06 | `portal-identity` (integration), `domain/*.test.ts` | invitation per patient, no second live self link, deactivation closes sessions, representative needs a note        | tables and services; partial unique indexes added after the duplicate-link test failed; refactor: one `identities.ts`   |
| S5.07 | `portal-signin`, `portal-session`, `portal-guard`, `auth-guard`, `code.test.ts` | no oracle (same answer for known and unknown), attempts, hourly cap, cookie names, Origin on writes, staff vs portal cookie | codes and sessions; triangulated with unknown-address verify and a read-only organization; the slug test (`614a8e2`) was RED first |
| S5.08 | `portal-sections`, `portal-documents`, `appointment-policy.test.ts` | cancel after the cut-off refused, unshared document absent, admin cannot share a clinical document, DB containment of shared docs | DEFINER functions bound to validated link/identity; refactor of `document-shares.ts`                                      |
| S5.09 | `portal-downloads`, `portal-dependents`, `portal-isolation`, `portal-invoices`, `portal-tenancy`, `portal-message-privacy` | link bound to the session, single use, re-authorization at redemption, majority suspension, another organization's file | one resource dispatching by type; rendered-file delivery RED first (`portal-downloads`), then GREEN with the storage copy removed on close |
| S5.10 | `sign-in`, `frame`, `sections`, `account`, `staff-tab` component tests (71), axe in each; `stage5-portal.spec.ts` | every state of every section; e2e at 360 px found the logout 400 and a contrast failure that the unit tests could not see | logout sends `{}`; the switch link uses the foreground colour; regression assertion added in `frame.test.tsx`             |
| Adapters | `consent-adapter.test.ts` (15), `prescription-adapter.test.ts` (5) | every field mapped, "not theirs" is `null`, other refusals go up unchanged                                                       | pure mapping functions; no import of the other modules                                                                    |

## Decisions

1. **Organization is always the host's.** The public path keeps `:slug` (`/public/:slug/portal/...`) but never reads it; the web uses the constant `_`.
2. **Sign-in has no oracle.** Same answer and same timing path for known, unknown and deactivated addresses; the verify throttle is keyed on a hash of the address and counts unknown addresses too. Codes go out by a dedicated `auth` queue job, so a read-only organization still signs in.
3. **One file door.** `GET /portal/files/:token` redeems a `document_download` token issued to the session; the resource dispatches on `resourceType` (document, prescription, invoice, consent), re-authorizes for the current subject, audits `portal.download`, and streams from the API (the storage address never reaches the browser).
4. **Documents are contained in the database.** The portal reads shared documents only through two DEFINER functions keyed on GUCs that `bindSubject` sets from a validated link and identity; a portal query cannot read another document even with a bug in the route.
5. **Read-only categories.** `auth` (sign in, sign out, codes), `patient_protective` (cancel appointment, revoke consent, rectification, copy request), `read` (download-link issue); everything else is `write` (402 in a read-only organization).
6. **Signing binds to the version the request is bound to.** The consent adapter asks `signingView` for the version right before `sign` and sends that `versionId`; a request is bound to exactly one version when it is made, so this is the version the person read. The portal contract has no `versionId` field.
7. **Rendered files.** A module that hands over bytes (consent PDF) is stored under `t/<tenant>/portal-rendered/<uuid>` only when the link is used, and removed when the response closes. Asking for the link only checks existence.
8. **Screens do not repeat the module.** Consent and prescription screens are driven by `available` and `capabilities`; with no port wired they show an empty state, and the staff-facing text never names a template or medication.

## Integrator wiring (S5.12)

Everything is in `apps/api/src/main/wiring/portal.ts`: `createPortalWiring(ports)` takes `{ consent?, prescriptions? }` and `portalWiring = createPortalWiring()` is what `main/wiring/index.ts` uses today. Replace it with the real ports once both branches are merged:

```ts
import { createConsentPortal } from '../../modules/consent/index.js';
import { listPrescriptionsForPatient, openPortalDocument } from '../../modules/prescriptions/index.js';
import { adaptConsentModule, adaptPrescriptionModule } from '../../modules/portal/index.js';

const portalWiring = createPortalWiring({
  consent: adaptConsentModule(createConsentPortal({ keys })),
  prescriptions: adaptPrescriptionModule({
    list: (input) => listPrescriptionsForPatient(withTenant, input),
    openDocument: (input) => openPortalDocument(withTenant, prescriptionDeps, input),
  }),
});
```

(`keys` is the tenant key service the API already builds; `prescriptionDeps` is the `PrescriptionDeps` of `createPrescriptions(...).services`.) Both adapters are structural: the compiler checks them against the real modules when the branches meet.

Consent mapping (A2 `ConsentPortal` to `PortalConsentPort`):

| Portal port                | A2 call                                      | Mapping                                                                                                                                                                         |
| -------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`                     | `list(tx, { actor, patientId })`             | Drops `in_person` requests still pending (they wait at the practice). `requestedAt = createdAt`; `title ?? 'Consentimiento'`; `canSign` = pending and `portal`; `canRevoke` = signed; `hasDocument` = `canOpen` and signed; `expiresAt` only while pending. |
| `read`                     | `list` + `signingView(tx, { actor, patientId, requestId })` | Text and `requiresRepresentative` from the view while open for signing. A closed consent has `body: ''` (its record is the PDF); the screen hides the empty text.              |
| `sign`                     | `signingView` then `sign(tx, { actor, auditActor, patientId, requestId, request })` | `versionId` = the view's version; `signer` = `representative` when the screen sent one; `representative = { name: fullName, nationalId, relation }`; typed mark `{ kind: 'typed', name }`, drawn mark `{ kind: 'drawn', imageDataUrl }`; then the result is re-read from `list`. |
| `revoke`                   | `revoke(tx, { ..., request: { reason? } })`  | Route stays `patient_protective`.                                                                                                                                                |
| `document`                 | `document(tx, { actor, auditActor, patientId, requestId })` | `{ bytes, fileName }` becomes a rendered file (`application/pdf`) the door stores for one download.                                                                      |
| errors                     |                                              | `AppError('not_found')` is `null` (the route answers 404 and writes `portal.denied`); `consent_method_mismatch`, `ConsentRefused` and the rest go up unchanged.                 |

Optional: swap the typed-name signature in `sections/ConsentDetail.tsx` for A2's `SignaturePad` and `ConsentStatusBadge` from `features/consent/index.ts`; the adapter already accepts the drawn mark. The consent module should send its "waiting for your signature" notice with `renderPortalNoticeEmail({ kind: 'consent_request' })` (exported from `modules/portal/index.ts`).

Prescriptions mapping (A3 to `PortalPrescriptionPort`): `list` is `listPrescriptionsForPatient`, with `prescriberName: null` (the module does not say) and `hasDocument` true for every status but `cancelled`; `document` is `openPortalDocument`, whose `FileDelivery` is a storage object that fits the file door as it is (the file name is read back from its `content-disposition`). Note: the module audits `prescription.downloaded` each time it opens the document, and the door opens it twice per download (once to issue the link, once to redeem it). If the doubled entry is not wanted, add a `purpose` to the port call that the adapter can use to skip the audit on the first call. The portal test cannot assert `prescription.downloaded` (the module is not in this branch): assert it in the S5.12 integration test.

Other merge notes:

- Queue `portal.code_send` (category `auth`) is a seam addition: `platform/jobs/queues.ts` and `platform/read-only/jobs.ts`.
- `platform/public/token-page.ts` has an optional `link` field (the "Ir al portal" button of the activation page).
- `platform/http/auth-guard.ts` has the portal exception (`PORTAL_ROUTE_PREFIX`, `RouteAuth` `'portal'`, `portalPermission`, `findMisplacedPortalRoutes`).
- Journal: after merging run `pnpm db:restamp` then `pnpm db:check`; never reorder applied entries.
- At S5.12 drop the fixtures that stand in for the other tracks: `test/integration/demo-coverage-exemptions/portal.ts`, and the fakes in `test/support/portal-fakes.ts` can stay for the unit-level port tests.
- The documents screen of the staff has no "share with the patient" control: `portalStaffApi.share/unshare` and the routes exist, but the documents feature belongs to another track. A button on the document row (permission `portal.manage`) is the missing piece; the e2e shares through the API.

## Verification (run at the tip)

| Check                                                                 | Result                                                                                       |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                      | clean (no dependency changed)                                                                |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`                    | clean                                                                                        |
| `pnpm test` (unit, api + web + contracts + policy)                    | 5185 passed; 2 web tests timed out under machine load and passed alone (documents tab, clinical chart tab) |
| Integration, 16 files (all `portal-*`, definer-functions, no-delete-privileges, file-resources, job-queues, worker, tenancy-schema, migration-lanes) | 196 passed                                              |
| `pnpm build`                                                          | clean; portal pages are a lazy chunk, the sign-in route does not pull them in               |
| `pnpm db:check`                                                       | clean                                                                                        |
| `stage5-portal.spec.ts` on ports 4950 / 3950 / 9950, `--workers=1`   | 2 passed (axe and no horizontal overflow at 360 px on every screen)                          |

## Deviations

- The e2e does not download a prescription or sign a consent: those modules are not in this branch, so the spec asserts their empty states. The adapters are unit-tested against fakes shaped like the real modules; the real journey is for S5.12.
- The portal sign request has no `versionId` (see decision 6).
- Documents are shared through the API in the e2e (no staff control yet, see merge notes).

## Risks

1. **Shared Docker.** Testcontainers from other agents shared Ryuk with this run; one e2e start failed with "socket hang up" while migrating and passed on retry. Only the containers of this run were removed.
2. **Doubled `prescription.downloaded` audit** per download (see merge notes).
3. **Closed consent text.** A signed consent shows no text in the portal (A2's `signingView` only serves open requests); the PDF is the record. If product wants the text, A2 needs a read function for closed requests.
4. **`hasDocument` for prescriptions** is inferred from the status; a confirmed prescription without a stored document would show a button that answers 404 until the document exists.
