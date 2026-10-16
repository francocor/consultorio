# Gate review 1: specs × design × proposal

Date: 2026-10-15. Reviewer: fresh-context gatekeeper (read-only). Verdict: **FAIL**. There are 7 critical findings, and the warnings need alignment.

## Product owner decisions (binding, accepted 2026-10-15)

| # | Topic | Decision |
|---|---|---|
| D1 | Matrícula | A recorded but unverified matrícula is enough for clinical work. A "verified" status is required only for e-prescription. Verification is done by the platform operator; a professional can never verify themselves, owners included. |
| D2 | Care relationship ("own patient") | Created by an active (non-cancelled) appointment with the professional, an encounter, or an explicit assignment. A cancelled appointment that was never attended does NOT create one. |
| D3 | 2FA | Mandatory for professionals and owners/admins, with a 7-day grace period after first sign-in. Optional for reception unless the organization requires it. |
| D4 | Clinical search | v1 has per-patient search over clinical content only (server-side decrypt and filter). Cross-patient clinical text search is out of scope for v1. |
| D5 | WhatsApp | The platform owns the WhatsApp sender (a single-tenant deployment may configure its own). WhatsApp is used only for appointment reminders/confirmations and waitlist offers. OTPs, invitations and password resets go by email only. No SMS channel in v1. |
| D6 | Commercial parameters | 14-day trial, 7-day grace period before read-only, WhatsApp quota of 200 messages per active professional per month (configurable per plan). Prices are configuration, not specified. The demo tenant is excluded from subscription and trial logic. |
| D7 | Clinical export on cancellation | Each professional receives the clinical records of their own patients. If no professional remains, the platform keeps custody under contract and releases records only to the patient or to a verified professional. The administrative export goes to the owner. |
| D8 | Payment timing | A charge can be captured from check-in onward, not only after "attended". |
| D9 | No-show rate | no-show / (attended + no-show). Cancellations are excluded. "Rescheduled" is derived from appointment history; it is not a status. |
| D10 | Consent for messages | Appointment reminders are service communication. They need no data-processing consent beyond the patient's channel opt-out. WhatsApp still requires an explicit opt-in. Waitlist offers require opt-in. |
| D11 | Portal and clinical notes | The patient portal never shows clinical note content in v1. Patients request a formal copy (Ley 26.529). Remove "as released" from authorization. |
| D12 | Guided first run | The solo fast-path wizard and the first-run checklist belong to Stage 2. Self-service signup and subscriptions stay in Stage 6. |
| D13 | Retention lock | The 10-year archive uses S3 Object Lock in **governance** mode, so a privileged, audited role can perform a legally required erasure. Pending legal counsel. |

## Critical findings (must fix)

| # | Finding | Fix |
|---|---|---|
| C1 | clinical-records requires search over clinical content; the design encrypts that content per field. | Apply D4: the spec states per-patient search; the design implements server-side decrypt and filter. Add a non-encrypted "safety flag on file" column (for example "allergy on file") for the reception flag that `patients` requires. |
| C2 | documents requires links valid 5 minutes and bound to the user; the design uses a 120 s presigned GET, which is a bearer URL. The portal requires links tied to the session. | Downloads go through an API endpoint that checks the session, or through a one-time token bound to the session. Align the TTL to 5 minutes. |
| C3 | documents requires a malware scan; the design only sniffs file bytes and leaves the question open (Q5). | Close Q5 as yes: add a ClamAV step to quarantined → available that fails closed. |
| C4 | The design's exclusion constraint uses different status names and omits "in progress" and "pending approval". Overbooking is modeled as a per-day cap, but the spec needs a maximum of simultaneous appointments. The slot hold is an appointment row with a patient FK. Holds are hard-deleted. | Use the 8 statuses from scheduling. Add a separate `slot_hold` table, constrained alongside appointments. Model overbooking as a capacity count. Define whether the buffer is part of the range. |
| C5 | Matrícula is a three-way conflict: staff-professionals vs tenant-onboarding vs ADR-003 ("validated" gates RLS). | Apply D1: the RLS gate is an active professional profile with a recorded matrícula. e-prescription requires verified. Fix ADR-003 and the e-prescription text. |
| C6 | No requirements stand behind the Stage 2 guided first run. | Apply D12: split tenant-onboarding into a Stage 2 wizard/first-run part and a Stage 6 signup part, or add first-run checklist requirements to app-shell-ux. |
| C7 | Portal authentication conflicts: the spec uses identity-access credentials, the design uses passwordless OTP, and there is no SMS port and no portal entity. | Passwordless email OTP for patients. Amend patient-portal and identity-access. Add a `portal_identity` entity (patient link, representative, deactivation). |

## Warnings (align)

- **W8 Read-only allowlist.** Define one cross-cutting allowlist in `tenancy` and in the design. It covers reads, audit, authentication, exports, patient-protective writes (cancellation, consent revocation, rectification), and AFIP submissions already queued. Messages queued while read-only MUST NOT be sent after recovery: jobs re-check tenant status.
- **W9 Export and archive delivery.** Apply D7. Split the export into an administrative part and a clinical part. Break-glass key release is automated and audited, and the operator cannot read the content.
- **W10 Grantable permissions.** Add org-configurable, non-clinical permission toggles to `authorization`: out-of-hours override, past-booking registration, delegated calendar, cash register, patient administration. `clinical.*` stays locked to professionals.
- **W11 Demographics.** Demographics are visible organization-wide to clinical staff and reception. Only clinical content is scoped by care relationship (D2).
- **W12 Definitions.** Define "treating professional" (= care relationship, D2). e-prescription reads stay scoped to the prescriber plus treating professionals.
- **W13 Anamnesis in Stage 1.** Add an explicit "assign patient to professional" action in Stage 1 (D2).
- **W14 One sharing-scope model.** Define a single model that covers per-entry author restriction and the psychology default exclusion, and reflect it in the authorization matrix and the design.
- **W15 Addenda under sharing.** Shared access is read-only. Only treating professionals can add an addendum.
- **W16 2FA.** Apply D3 in identity-access and ADR-004.
- **W17 Public routes.**
  - Extend the design's `/public` routes with the token links: confirm/cancel, waitlist offer, video join, invitation, signup/verification, portal activation, OTP.
  - Add per-professional booking links.
  - Reword "0 unauthenticated endpoints".
- **W18 Teleconsultation.** Use a platform join URL that redirects only inside the join window. The room name rotates on reschedule. Recording is off.
- **W19 WhatsApp and online booking.**
  - Apply D5 and D10. The booking form captures the WhatsApp opt-in.
  - Messages not tied to an appointment are email only.
  - Add a waitlist self-join requirement to online-booking.
- **W20 Invoicing.**
  - Model `charge_line` and `invoice_line` many-to-many.
  - Align the invoice status set: pending, issued, rejected, manual, plus internal retry states documented as sub-states.
  - Manual CAE entry is restricted to owner/admin.
- **W21 Reporting.** Apply D9.
- **W22 CountryPack.** Add the holiday catalog, matrícula format and validation, personal-data rules, and date/currency/time-zone defaults.
- **W23 Locations.** Add membership-to-locations for non-professionals. The location time zone is authoritative.
- **W24 Branding contrast.** Warn and auto-adjust instead of rejecting.
- **W25 Demo reset.**
  - A privileged reset path, restricted to the demo flag, with a hash-chain-aware audit exemption.
  - A hard guard that allows only fake adapters for demo tenants.
  - Exclude the demo tenant from subscription logic (D6).
- **W26 Audit chain.** Write audit rows synchronously (fail-closed) and seal the chain with a sequenced background job. Denied attempts are written in their own transaction.
- **W27 Subscription model.**
  - Add trial, grace and dunning states, plan and entitlement fields, and an overage cap.
  - Resolve the Mercado Pago amount-change question (design Q2) against the "statement before collection" rule.
- **W28 Gaps.**
  - Quiet hours in design §5.2.
  - An "entered in error" status in the note model.
  - Draft revision history: keep the SHOULD, or downgrade it to MAY and state that.

## Suggestions

- **S29** Use one org setting, "reception sees clinical metadata", across documents, e-prescription and consent.
- **S30** Consent template titles can reveal clinical information. Hide them from admin and reception, or require neutral titles.
- **S31**
  - State the retention exceptions explicitly: demo reset and the purge of unverified signups.
  - Auto-generate the signup slug.
- **S32**
  - Add a local common-password list.
  - Spec lockout vs design backoff: align (lockout with audit, plus backoff).
- **S33**
  - Turnstile on signup.
  - AFIP environment per point of sale.
  - WhatsApp is metered in single-tenant mode too.
  - Patients without an ID document: the unique key applies only where a document is present.
