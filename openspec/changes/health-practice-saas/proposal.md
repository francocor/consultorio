# Proposal: Health Practice SaaS (rewrite of Centro Medico Aillu)

> **Decision**: Build a complete, sellable health-practice management product (Argentina first) on a new foundation. Deliver it in 7 ordered stages, each one demoable on its own. The legacy Aillu app is not in use and holds no real data. It is reference material only, and it is archived or removed once Stage 2 reaches feature parity.

## Intent

| Problem | Why now |
|---|---|
| The legacy app is **unsafe by design**: all endpoints are public, JWTs are never verified, roles can be self-assigned, password reset is public and sets the password to `1234`, and secrets are committed. | It cannot be deployed for any client. Authentication, tenancy and audit cut across every table and endpoint, so a rewrite costs less than a retrofit. |
| It is **single-clinic**: no tenancy, hardcoded branding (three different names appear), no audit, no versioning. | It cannot be sold or customized per client. |
| The owner, an independent developer, needs a **complete, polished product** to show prospects as-is and use as a portfolio flagship. | The success bar is "complete and ready to use", not an MVP. |

## Users and situations

| Customer type | Persona | Key moment |
|---|---|---|
| Solo professional (any discipline), modeled as an organization with one member | Professional, sometimes with a receptionist | Sets up alone and books the first patient on a phone between sessions |
| Small center (3–15 professionals, shared reception) | Owner/admin | Configures locations, staff, prices and payers, and reads reports |
| | Reception | Fast booking, check-in, payments and the daily cash register under time pressure |
| | Professional | Reviews today's patients and writes clinical notes quickly |
| Either | Patient | Books online, confirms by WhatsApp or email, signs consent, downloads documents |
| Platform | Operator (the owner) | Creates tenants, deploys single-tenant instances, resets the demo |

## Scope: capability areas

| Area | Outcome |
|---|---|
| Tenancy and deployment | Every record belongs to one organization. A single-tenant instance is the same build with different configuration. A cancelling tenant gets an administrative export (owner) and a clinical export (each professional, for their own patients), and the platform keeps a read-only retention archive. A read-only tenant follows one shared allowlist. |
| Identity and access | Secure login, 2FA mandatory for professionals and owners/admins (7-day grace), passwordless email one-time-code sign-in for patients, session management and an audited password reset. |
| Authorization | Roles (owner/admin, professional, reception, patient) with clinical-access rules enforced on the server. Clinical access follows a care relationship and one sharing-scope model. Demographics are organization-wide. |
| Audit log | Append-only record of who read or changed what, and when. |
| Branding and UX shell | Per-tenant name, logo and colors. One layout driven by role. Mobile-first installable PWA, i18n-ready Spanish (AR), and clear empty/loading/error states. |
| Country rules (AR pack) | DNI/CUIT, obras sociales/prepagas, retention and the legal integrations are isolated behind a country module. |
| Professionals and staff | Profiles, matrícula, specialties, locations and working hours. |
| Patients | Demographics, payer coverage, anamnesis, deduplication by DNI, data-processing consent. |
| Scheduling | Day/week/month calendar per professional and per location, blocks and holidays, appointment types with duration and price, overbooking policy, attendance states. |
| Clinical records | Generic encounter notes plus specialty templates (odontogram, psychology, physiotherapy, nutrition). Signed entries are immutable and corrected with addenda. Search is per patient only. |
| Documents | Attachments stored in private object storage, with type and size limits, malware scanning that fails closed, and 5-minute session-bound download links. |
| Reminders | Email and WhatsApp reminders and confirmations, with opt-out. WhatsApp is used only for reminders, confirmations and waitlist offers. There is no SMS. |
| Online booking | A public booking link per professional or organization. |
| Waitlist | Freed slots are offered to waiting patients. |
| Teleconsultation | A video link attached to virtual appointments (third-party provider). |
| Billing and cash | Private and payer pricing, charge capture per appointment, payments, a daily cash register per location, exports, and reports with charts. |
| Electronic invoicing | AFIP factura electrónica, with credit notes for corrections. |
| E-prescription | Ley 27.553 prescriptions issued through an authorized provider. |
| Informed consent | Versioned consent templates signed by the patient. |
| Patient portal | Patients see their appointments, documents, consents, prescriptions and invoices. Clinical note content is never shown; patients request a formal copy. |
| Onboarding and subscriptions | Stage 2: guided first run (setup wizard, solo fast path, first-run checklist). Stage 6: self-service signup and Mercado Pago billing per active professional per month (14-day trial, 7-day grace), with WhatsApp quotas per professional. |
| Demo tenant | Realistic fake data across all modules. Can be reset on demand. |

### Out of scope (non-goals)

- Direct electronic claims to obras sociales.
- In-house video infrastructure.
- Native mobile apps. The product is a PWA instead.
- Cross-patient search over clinical text (D4). Search of clinical content is per patient in v1.
- An SMS channel (D5).
- HL7/FHIR interoperability. Noted as future work; the data model should not block it.
- Countries other than Argentina. The country rules are isolated so other countries can be added later, but no other country pack is built now.
- Migrating data from the legacy app. It holds no real data.

## Capabilities (contract for sdd-spec)

### New Capabilities

- `tenancy`: organizations, locations, tenant isolation, single-tenant deployment configuration, split cancellation export, retention archive, retention exceptions and the read-only allowlist
- `identity-access`: authentication, mandatory 2FA for privileged roles, patient email one-time-code sign-in, sessions, password reset, public-route allowlist
- `authorization`: roles, care relationship, permission rules, grantable non-clinical permissions, clinical-access and sharing-scope policy
- `audit-log`: append-only access and change trail
- `tenant-branding`: per-tenant name, logo, colors
- `app-shell-ux`: role-driven layout, PWA, i18n, UX states, host for the guided first run
- `country-rules-ar`: the AR CountryPack: identifiers, payer catalog, holiday catalog, matrícula rules, retention, personal-data rules, locale defaults, legal adapters
- `staff-professionals`: users, professional profiles, working hours
- `patients`: patient registry, coverage, anamnesis, data consent
- `scheduling`: calendar, appointment types, blocks, slot holds, overbooking as capacity, attendance (eight statuses)
- `clinical-records`: encounters, templates, versioning, addenda
- `documents`: attachments and object storage access
- `notifications`: reminders and confirmations by email and WhatsApp
- `online-booking`: public booking flow, WhatsApp opt-in capture, waitlist self-join
- `waitlist`: waitlist and slot offers (opt-in required)
- `teleconsultation`: video links for virtual appointments
- `billing-payments`: pricing, payers, charge capture, payments, cash register, exports
- `reports-dashboard`: operational and financial reports
- `e-invoicing-afip`: electronic invoices and credit notes
- `e-prescription`: Ley 27.553 prescriptions
- `informed-consent`: consent templates and signatures
- `patient-portal`: patient-facing access through portal identities (no clinical note content)
- `tenant-onboarding`: Part A (Stage 2) setup wizard, solo fast path and first-run checklist; Part B (Stage 6) self-service signup
- `subscriptions`: per-active-professional plans, trial/grace/dunning states, Mercado Pago billing, WhatsApp quotas and capped overage, plan limits
- `demo-tenant`: seed data and reset

### Modified Capabilities

None. `openspec/specs/` is empty.

## Delivery roadmap

Each stage is a chained set of PR slices. Each stage ends with a demo the owner can show.

| # | Stage | Contents | Demo at the end |
|---|---|---|---|
| 0 | Repo hygiene (prerequisite) | `.gitignore`, untrack `node_modules` and `BackEnd/.env`, rotate the committed secrets (good practice), new app skeleton with CI | Clean repo, green pipeline |
| 1 | Secure core | Tenancy, auth with 2FA, RBAC, audit log, branding, app shell/PWA/i18n, staff and professionals, patients (with explicit assignment to a professional and the safety flag), demo seed scaffold | Two isolated branded tenants, with role-specific views and an audit trail |
| 2 | Practice core | Scheduling, attendance, clinical records with versioning, templates and attachments, guided first run (setup wizard, solo fast path and first-run checklist, `tenant-onboarding` Part A) | A solo professional books a first appointment in minutes, and a multi-professional center runs a full day. Legacy code can be archived or removed after this stage. |
| 3 | Patient engagement | Reminders and confirmations (email, then WhatsApp), online booking, waitlist, teleconsultation links | A patient books online, gets a WhatsApp reminder and confirms |
| 4 | Revenue | Payer and private pricing, charge capture with export, payments, cash register, reports dashboard, AFIP invoicing | Reception closes the day's cash register and issues an invoice |
| 5 | Clinical compliance and patient portal | E-prescription, signed informed consent, patient portal | A patient signs consent and downloads a prescription from the portal |
| 6 | Growth | Self-service signup (`tenant-onboarding` Part B), Mercado Pago subscriptions, trial and grace states, plan limits. The Stage 2 wizard is reused for signed-up tenants. | A stranger signs up, pays and is using the product the same day |

**Changes from the suggested order, with reasons:**

1. **The foundation is split into Stages 1 and 2.** As one stage it is too large to review. Stage 1 is security-critical and should be reviewed on its own.
2. **Charge capture and export move to Stage 4.** They were in Stage 2 only to match legacy billing for a cutover, and there is no cutover now. Keeping all money flows in Stage 4 avoids an interim billing model that would be redesigned later, and keeps Stage 2, the largest stage, smaller. In the Stage 2 "full day" demo, scheduling, check-in and clinical notes work end to end. Payment collection arrives in Stage 4.
3. **The guided first run moves to Stage 2 (D12).** The solo fast-path wizard and the first-run checklist ship with Stage 2, because the "first appointment in 10 minutes" goal and the sales demo both depend on them. Only self-service signup and subscriptions stay in Stage 6, because the operator can create tenants by hand until then.
4. **Teleconsultation moves to Stage 3.** It is only a link, and reminders are the channel that delivers it.
5. **Work on slow external dependencies starts during Stage 1.** These are WhatsApp Business approval, AFIP certificates and homologation, and the contract with an e-prescription provider. All of them take weeks of lead time.

## Business rules and compliance

| Rule | Requirement |
|---|---|
| Tenant isolation | No data is ever visible across organizations. Tenant and user identity come only from the authenticated session, never from the request body or query string. |
| Clinical access (hard rule) | **Only health professionals can read clinical notes.** A non-clinical owner/admin can **never** read them, and no setting can grant that access. A user who is both owner and professional reads clinical data only through their professional role. |
| Reception | Never reads the content of clinical notes. Can see demographics, the schedule, attendance and payments. |
| Professional | Reads clinical records only for patients they treat (a care relationship, D2, with identity confirmation, D14), unless the organization turns on sharing, which gives other professionals read-only access within a sharing scope. Demographics are organization-wide. Every shared read is audited. |
| Platform operator | Has no default access to tenant clinical data. Any support access is explicit, time-boxed and audited. |
| Immutability (Ley 26.529) | Signed clinical entries cannot be edited. Corrections are made with addenda, and every version is kept. |
| Retention | Clinical records and their audit trail are kept for at least 10 years after the patient's last encounter. Records are never hard-deleted. Users are deactivated, not deleted. |
| Tenant cancellation | The export is split (D7). The owner receives the administrative export. Each professional receives the clinical records of their own patients. Each export is PDF plus structured data. If no professional remains, the platform keeps custody under contract and releases records only to the patient or a verified professional. The platform keeps an encrypted, read-only archive for the 10-year legal retention period, under contract. Any access to the archive is audited. |
| Personal data (Ley 25.326) | Data-processing consent is captured. Patients can access and rectify their data. Messages contain no clinical content. Encrypted in transit and at rest. |
| Consent | Templates are versioned. A signature is tied to the exact template version. |
| E-prescription (Ley 27.553) | Only professionals with a **verified** matrícula can prescribe, and only through an authorized platform. A recorded but unverified matrícula is enough for all other clinical work (D1). Only the platform operator verifies. |
| Invoicing | Issued invoices are immutable. Corrections use credit notes. |
| Pricing and plan limits | The tenant is billed per active professional per month. Reception and admin seats are free and unlimited. WhatsApp messages come as a monthly quota per active professional (200 by default, configurable per plan), with capped paid overage. Plan limits are based on active professionals and the message quota. The demo tenant is excluded. |
| Non-payment | After a 14-day trial or a failed payment the tenant has a 7-day grace period, then goes read-only under one shared allowlist. Reading and exporting clinical records is **never** blocked, because the professional is the legal custodian. |
| Messaging consent (D10) | Appointment reminders are service communication and need no data-processing consent beyond the channel opt-out. WhatsApp and waitlist offers need explicit opt-in. |
| Attachments | Allowed types are whitelisted and file size is capped. Every file is malware-scanned and unavailable until the scan passes. Files are stored privately and served through 5-minute links bound to the requester's session. They are never embedded in lists. |

## Stack constraints for sdd-design (no stack chosen here)

- Static typing end to end. Tests, linting and CI from Stage 0.
- Tenant isolation is enforced centrally, ideally at the data layer, not only by query filters.
- Relational database with versioned migrations, backups with point-in-time recovery, and support for 10-year retention.
- An encrypted, read-only archive that survives tenant cancellation.
- S3-compatible object storage.
- A background job runner for reminders, retries, exports and the AFIP queue.
- Ports and adapters for messaging, payments, invoicing, e-prescription, video and country rules.
- Usage metering for active professionals and WhatsApp messages.
- One container image. Multi-tenant or single-tenant mode is chosen by configuration.
- PWA support, per-tenant theme tokens and externalized UI strings.
- Hosting must comply with Ley 25.326 rules on international data transfer.
- Low operating cost and low operational burden, because one developer runs it.

## Legacy handling

- The legacy app is **not in use**: no production deployment and no real patient data. There is no data migration and no cutover.
- `BackEnd/` and `FrontEnd/` are **reference only**, for domain knowledge and UI design. Known legacy bugs are not ported.
- Reused UI concepts: role shells, the patient chart, the encounter and anamnesis forms, slot validation, and the billing table.
- The legacy code is archived or removed once Stage 2 reaches feature parity.

## Affected areas

| Area | Impact |
|---|---|
| New application root (location decided in design) | New |
| `.gitignore`, git index (`node_modules`, `BackEnd/.env`) | Modified (hygiene) |
| `BackEnd/`, `FrontEnd/` | Reference only. Archived or removed after Stage 2 parity. |
| `openspec/specs/*` | New (25 capabilities) |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| The scope is too large for one developer | High | Ordered stages, each demoable. Polish is part of every stage's definition of done. |
| AFIP homologation or certificates are delayed | Med | Start in Stage 1. Isolate it behind an adapter. Allow manual invoice entry as a fallback. |
| E-prescription provider availability, cost or registration | Med | Choose a provider early. Keep legacy-style external links as an interim fallback. |
| WhatsApp API approval, per-message cost, overage disputes | Med | Email first. Per-professional quotas with metered overage. Usage shown to the tenant before it is billed. |
| A tenant isolation bug leaks health data | Low/High impact | Isolation at the data layer, automated cross-tenant tests and audit. |
| Retention archive cost and custody obligations after cancellation | Med | Cold encrypted storage with a governance-mode retention lock (D13), so that a privileged, audited role can perform a legally required erasure. Archive terms in the contract. Audited access. Pending legal counsel. |
| Committed secrets are reused elsewhere | Med | Rotate in Stage 0, before anything else. |

## Rollback plan

- **Stage 0**: Untracking files does not delete them locally, and secret rotation is forward-only. Keep the old credentials revoked.
- **Each stage**: Ships as revertible PR slices behind per-tenant feature flags. A faulty module can be turned off without a redeploy.
- **Database**: Migrations are forward-only, with a backup before each release. A failed migration is restored from point-in-time recovery.
- **Legacy removal**: Done in its own commit after Stage 2 parity. It can be undone with a git revert, or restored from an archive tag.
- **Integrations** (AFIP, WhatsApp, e-prescription, Mercado Pago): Each can be turned off per tenant, with a manual fallback.

## Dependencies

- Accounts and approvals from AFIP (certificate and homologation), Meta WhatsApp Business, an authorized e-prescription platform, and Mercado Pago.

## Success criteria

- [ ] A new solo professional books a first appointment within **10 minutes** of first login, without help.
- [ ] Reception books an existing patient from the calendar in **≤ 30 seconds**.
- [ ] Core flows are usable at a 360 px width, the app is installable as a PWA, and p75 page load is **< 2.5 s** on 4G.
- [ ] **0** unauthenticated endpoints outside the explicit public allowlist: login and password reset, invitation acceptance, signup and verification, public booking (organization and per-professional links) and public waitlist self-join, single-purpose token links (confirm, cancel and reschedule; waitlist offer; video join; notification opt-out; WhatsApp opt-in by email), patient portal activation (invitation or verified registration) and one-time-code sign-in, and provider webhooks. Cross-tenant tests cover every data path.
- [ ] **100%** of clinical record reads and writes appear in the audit log. No signed entry can be edited. A non-clinical admin is denied clinical access on every path.
- [ ] Stage 2 parity is reached and the legacy code is archived or removed.
- [ ] Reminders go out for **≥ 95%** of appointments that have contact data. The no-show rate (no-show / (attended + no-show)) is visible in reports.
- [ ] A cancelling tenant receives a complete export in two parts (administrative to the owner, clinical to each professional for their own patients), each as PDF and structured data, and the archive stays readable for the retention period.
- [ ] A single-tenant deployment runs from the same build, changed only by configuration.
- [ ] The demo tenant resets in **< 1 minute** with data in every module.
- [ ] AFIP invoices are issued successfully in homologation and then in production.

## Proposal question round: decisions

Business decisions 1–6 from the first round are binding. The second round produced these binding decisions:

| # | Question | Decision |
|---|---|---|
| 1 | Is the legacy app in use? | No. There is no production deployment and no real data. Therefore there is no migration and no cutover, and the legacy code is reference only. |
| 2 | Can a non-clinical admin read clinical notes? | Never. Only health professionals can. |
| 3 | Who keeps records after a tenant cancels? | The tenant gets a full export (PDF plus structured data). The platform keeps an encrypted, read-only archive for 10 years, under contract. |
| 4 | What is the pricing model? | Per active professional per month. Reception and admin seats are free. WhatsApp quota per professional, with paid overage. |

## Gate review 1: binding decisions D1–D13 (accepted 2026-10-15)

These product-owner decisions answer the first gate review (`gate-review-1.md`) and take precedence over any earlier statement in this proposal.

| # | Topic | Decision |
|---|---|---|
| D1 | Matrícula | A recorded but unverified matrícula is enough for clinical work. A "verified" status is required only for e-prescription. Verification is done by the platform operator; a professional can never verify themselves, owners included. |
| D2 | Care relationship ("own patient") | Created by an active (non-cancelled) appointment with the professional, an encounter, or an explicit assignment. A cancelled appointment that was never attended does NOT create one. |
| D3 | 2FA | Mandatory for professionals and owners/admins, with a 7-day grace period after first sign-in. Optional for reception unless the organization requires it. |
| D4 | Clinical search | v1 has per-patient search over clinical content only. Cross-patient clinical text search is out of scope for v1. |
| D5 | WhatsApp | The platform owns the WhatsApp sender (a single-tenant deployment may configure its own). WhatsApp is used only for appointment reminders/confirmations and waitlist offers. OTPs, invitations and password resets go by email only. No SMS channel in v1. |
| D6 | Commercial parameters | 14-day trial, 7-day grace period before read-only, WhatsApp quota of 200 messages per active professional per month (configurable per plan). Prices are configuration, not specified. The demo tenant is excluded from subscription and trial logic. |
| D7 | Clinical export on cancellation | Each professional receives the clinical records of their own patients. If no professional remains, the platform keeps custody under contract and releases records only to the patient or to a verified professional. The administrative export goes to the owner. |
| D8 | Payment timing | A charge can be captured from check-in onward, not only after "attended". |
| D9 | No-show rate | no-show / (attended + no-show). Cancellations are excluded. "Rescheduled" is derived from appointment history; it is not a status. |
| D10 | Consent for messages | Appointment reminders are service communication and need no data-processing consent beyond the patient's channel opt-out. WhatsApp still requires an explicit opt-in. Waitlist offers require opt-in. |
| D11 | Portal and clinical notes | The patient portal never shows clinical note content in v1. Patients request a formal copy (Ley 26.529). |
| D12 | Guided first run | The solo fast-path wizard and the first-run checklist belong to Stage 2. Self-service signup and subscriptions stay in Stage 6. |
| D13 | Retention lock | The 10-year archive uses a governance-mode (not compliance-mode) retention lock, so a privileged, audited role can perform a legally required erasure. Pending legal counsel. |

**Note on D2 (amended by D14 and D15):** an appointment creates a care relationship only when its patient identity is confirmed. Two kinds of appointment start unconfirmed: an online booking that matched an existing patient, and an appointment a professional books with themselves for an existing patient. A staff member other than the appointment's professional confirms the identity, at the identity review or at check-in, whichever comes first. In a one-professional organization with no other active staff, the professional may self-confirm at in-person check-in (D18). A no-show counts only if the identity was already confirmed. Pending-approval and cancelled appointments never count.

## Gate review 2: binding decisions D14–D18 (accepted 2026-10-15)

These product-owner decisions answer the second gate review (`gate-review-2.md`) and take precedence over any earlier statement in this proposal.

| # | Topic | Decision |
|---|---|---|
| D14 | Identity confirmation (security) | Two kinds of appointment match an existing patient without anyone checking who the patient is: one created through the public online-booking flow, and one a professional books for themselves. Neither creates a care relationship until a staff member other than the booking professional confirms the identity, at match review or at check-in, whichever comes first. Until then the appointment carries `identity_confirmed = false`. New patients created online are exempt. The patient-facing confirmation does not change. Any access that relies on a care relationship before confirmation is impossible by construction. |
| D15 | No-show and care relationship | A no-show appointment creates a care relationship only if the identity was already confirmed. Pending-approval appointments never create one. A cancelled appointment that was never attended never creates one. |
| D16 | Read-only tenant and rectification | While the tenant is read-only, treating professionals may add rectification addenda, because rectification is a patient right under Ley 26.529. New encounters and other clinical writes are refused. |
| D17 | Prescriptions and sharing | Prescriptions do not follow organization sharing. Only the prescriber and the patient's treating professionals can read them. |
| D18 | Solo practice identity confirmation | When an organization has exactly one active professional and no other active staff (no reception and no other admin who could confirm), that professional may confirm the identity themselves at in-person check-in, after seeing the patient and the ID document. The confirmation is audited with a distinct "self_confirmed" marker. When the organization has other staff, D14 applies unchanged. Rationale: D14 protects clinical history from *other* professionals of the same organization, and a one-professional organization has none. If staff join later, existing self-confirmations stay valid and new confirmations follow D14. |

## Stage 1 security review: decision D19 (revised and confirmed by the owner of the product on 2026-10-17)

This decision answers finding 3 of the Stage 1 security review. The orchestrator first took it in automatic mode ("only the owner brings professionals in"); the owner of the product **revised it and confirmed the revision on 2026-10-17**. The revised text below is the binding one.

| # | Topic | Decision |
|---|---|---|
| D19 | Who brings professionals in (revised, **confirmed by owner 2026-10-17**) | The **owner AND the admin** can invite or create users with the `professional` role, and can grant the `professional` role to an existing member. Nobody below an owner can create an owner. A patient assignment made by a non-clinical actor (someone who does not hold the `professional` role) to a professional added in the last 7 days still writes a distinct `assignment.review_flag` audit event next to the ordinary `assignment.created`. NEW: when an admin who is not an owner adds a professional, by invitation or by granting the role, the system writes the audit event `professional.added_by_admin` (with `via: invitation` or `via: role_grant` and the number of owners notified) and sends an email to **every active owner** of the organization through the transactional email (Mailpit in development). The email carries no clinical data; it names the admin and the professional when they have names and links to the staff screen. It is sent after the change is committed; a provider failure does not undo the change, the audit event is the record. An owner who adds a professional triggers neither. D1 stays as it is: an unverified matricula is enough for clinical work. |

**Accepted residual risk (D19, revised).** An admin can now create a professional account of their own choosing, with an arbitrary matricula, and then assign patients to it. That gives the admin a path to a second, clinical account, which the original D19 closed. The owner of the product accepts this: **clinical separation against a malicious admin is now audited and notified rather than prevented.** The controls that remain are detective, not preventive: the `professional.added_by_admin` event, the email to every active owner, the `assignment.review_flag` event for the first 7 days of a new professional, the audit viewer, and the fact that an owner can deactivate the account at any time. D1 (an unverified matricula opens clinical work) makes the account usable immediately, which is why the owners are told at once. An admin still cannot create an owner and still cannot touch an owner.

## Stage 2 integration: decisions D20 and D21 (confirmed by the owner of the product on 2026-10-17)

These two decisions came out of the clinical security review (D20) and the onboarding track (D21). The orchestrator took them in automatic mode while the owner was away. The owner of the product reviewed them on 2026-10-17: **D20 is confirmed exactly as implemented, and D21 is revised and confirmed in its revised form.**

| # | Topic | Decision |
|---|---|---|
| D20 | Opening an encounter (**confirmed by owner 2026-10-17**, exactly as implemented) | Opening an encounter does not create a care relationship; it needs an ALREADY active one from another source: an appointment with confirmed identity (D14, D18), a care assignment, or an earlier SIGNED encounter. A patient with no clinical footprint (no notes, no anamnesis, no clinical documents, no active care relationship with anyone) may get a first encounter. A draft does not count until its note is signed. An `appointmentId`, when given, MUST reference an appointment of the same patient and the same professional, with a confirmed identity and a status that counts for the care relationship (not cancelled, not awaiting approval). Enforced in the service and again by a database guard and by composite foreign keys. |
| D21 | The owner who is also a professional (revised, **confirmed by owner 2026-10-17**) | An **active owner MAY act as a health professional at any time**, provided they complete a professional profile with the same data and rules as any professional: name, specialty, and the matricula with its jurisdiction (format checked by the country module; the matricula stays unverified, D1, and only the platform operator verifies it, which is needed for e-prescription only). Completing the profile grants the `professional` role in one transaction with the profile write, and is audited as `role.changed` with `via: owner_professional_profile` (and `self: true`). The profile data is required **before** the role is active: a missing or malformed matricula leaves no role, no profile and no audit entry behind. There is no one-time limit, no closure when the wizard is finished and no 30-day window. The onboarding wizard's "Atiendo por mi cuenta" fast path and the wizard profile step use this same rule, so both now ask for the matricula and its jurisdiction. The path adds only the `professional` role, never any other role or permission, and only an active owner (read from the database, not from the session) can use it: **non-owners still cannot self-assign roles**, and an owner still cannot change their own roles through the role-change endpoint. Rationale: a solo professional creates the organization and must be able to work the same day, and an owner who starts attending later has the same need; the owner already controls the organization, so the risk is bounded to the owner. Superseded: the first version of D21 ("exactly once, only during the wizard, closed when it is finished"). |

## Stage 3 integration (judgment day, round 1): decisions D22 and D23 (orchestrator decision in automatic mode, pending owner confirmation)

These two decisions came out of the first round of the judgment day on Stage 3 (public booking, waitlist and messaging). The orchestrator took them in automatic mode while the owner was away. **They are pending confirmation by the owner of the product**; until then they are implemented as written here.

| # | Topic | Decision |
|---|---|---|
| D22 | WhatsApp double opt-in for numbers typed on a public form (**orchestrator decision in automatic mode, pending owner confirmation**) | A WhatsApp opt-in entered on a public form (online booking or waitlist join) for a phone number nobody has verified stays PENDING: nothing is recorded as an opt-in. The first WhatsApp message goes out only after the patient confirms through the `whatsapp_opt_in` email link, which is sent to the email address the visitor verified with a code (inside the booking confirmation, or in an email of its own for the waitlist). Until then that patient's messages go by email. A request is made only for a patient the booking or the join registered: a record that already had the typed document never gets one. Opt-ins that staff enter themselves are unchanged. |
| D23 | Limits of online booking (**orchestrator decision in automatic mode, pending owner confirmation**) | The limits of online booking count only the VERIFIED email address and are enforced after the code is accepted and after the professional is locked, so the answer before the code never depends on what the organization holds. The cap per document stays (three future online appointments), but it never creates a response that differs before verification: it is evaluated after verification and, when it is reached, when the matched record is deactivated, or when the link already holds its limit, the booking is answered like any other and the appointment stands on a record of its own that carries what the visitor typed, with an identity review for reception that says why. Each booking link has a limit of future appointments that stand on a patient already on file with the identity unconfirmed: the default is 20 and staff can configure it (0 to 500). |

Decisions D1–D13 supersede the earlier assumptions that the WhatsApp quota size and the archive access procedure were left to design: the quota is fixed by D6, and archive access follows D7 and D13.

No other open product questions remain. These details are left to sdd-design:

- Exact definition and proration of an "active professional".
- Technical procedure for releasing custodied records (automated, audited, and unreadable by the operator).
