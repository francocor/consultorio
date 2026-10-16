# Gate review 2: after the gate-review-1 amendments

Date: 2026-10-15. Verdict: **PASS WITH FIXES**. C1–C7 are resolved, but design and specs drifted apart because they were amended in parallel. This round uses a SINGLE writer for both, so they stay aligned.

## Product owner decisions (binding, accepted 2026-10-15)

| # | Topic | Decision |
|---|---|---|
| D14 | Identity confirmation (security) | Two kinds of appointment match an EXISTING patient without anyone checking who the patient is: one created through the public online-booking flow, and one a professional books for themselves. Neither creates a care relationship until a staff member other than the booking professional confirms the identity, at match review or at check-in, whichever comes first. Until then the appointment carries `identity_confirmed = false`. New patients created online are exempt. The patient-facing confirmation does not change. Any access that relies on a care relationship before confirmation is impossible by construction. |
| D15 | No-show and care relationship | A no-show appointment creates a care relationship only if the identity was already confirmed. Pending-approval appointments never create one. A cancelled appointment that was never attended never creates one. |
| D16 | Read-only tenant and rectification | While the tenant is read-only, treating professionals MAY add rectification addenda, because rectification is a patient right under Ley 26.529. New encounters and other clinical writes are refused. |
| D17 | Prescriptions and sharing | Prescriptions do NOT follow organization sharing. Only the prescriber and the patient's treating professionals can read them. |

## Fixes to apply (design + specs together)

| # | Fix |
|---|---|
| F1 | Apply D14 in authorization (definition + scenarios), online-booking (completion), scheduling (check-in confirms identity), patients (match-review queue), design §3.2/§3.6 (trigger/flag) and §5.3, and the proposal (a note under D2). |
| F2 | The `attended` status occupies its time slot. Add it to the design's `slot_occupancy` active set, matching the scheduling scenario "Attended appointment still occupies". |
| F3 | Holds and capacity: public flows use capacity 1 only, never an overbooking lane. Add a per-source hold bound (default 1) and the staff-override invalidation from the spec to the design. Remove "hold expiry triggers waitlist offer" from design §5.3, unless waitlist adds it; choose one and keep both files consistent. |
| F4 | Care-relationship sources must be the same in authorization, clinical-records and design §3.6, applying D2, D14 and D15. |
| F5 | Entered-in-error: either the author or another treating professional. Fix the design (§4.2/§5.4). |
| F6 | Author-only restriction is set only at creation or while the entry is a draft. Fix design §4.2. Sharing scope uses an INCLUSION list (new templates are not shared by default) in both files. |
| F7 | Apply D17 to authorization, e-prescription and design §4.2. |
| F8 | Read-only allowlist: one identical list in tenancy and design §7. It contains reads, audit writes, auth, every export, owner subscription and payment management, patient cancellation, opt-out, AFIP submissions already queued, provider webhooks, and rectification addenda (D16). Public booking and waitlist routes show the generic "not available" page instead of a 402. |
| F9 | Portal: one identity per email per organization, with N patient links, each carrying a relationship. Add a link table and uniqueness constraints to the design. Add a registration flow with two-attribute verification. |
| F10 | Public routes and token kinds: add the notification opt-out link, the reschedule token and waitlist self-join to the design's token kinds, the identity-access allowlist and the proposal's success criterion. |
| F11 | The signup slug is auto-generated and the visitor never chooses it. Fix design §7. |
| F12 | Retention exceptions: one identical list of 4 in tenancy and design (demo reset, purge of unverified signups, legal erasure, abandoned booking submissions). Online booking verifies the email before sending the OTP. Add a purge job for unverified submissions. |
| F13 | Subscriptions: add a `cancelling` state. Plan fields add the default overage cap, the platform maximum, trial length and grace length. |
| F14 | Add a reception worklist entity and design. It holds unsent reminders, replies to review, manual-contact waitlist items and pending approvals, and it is used by notifications, waitlist and online-booking. |
| F15 | Consent title: a generic label by default. Reception sees the real title only when `reception_sees_clinical_metadata` is on; admin never sees it. Align the design. |
| F16 | Small alignments. |

F16 covers:

- **Safety flag:** the system maintains it. Explicit toggling only if the spec allows it; pick one.
- **Document link redemption:** re-runs authorization (design §5.6).
- **Matrícula statuses:** use the same names everywhere. Either define `rejected` in the spec or drop it from the design.
- **Invoice sub-state names:** "contingency" vs "awaiting reconciliation" — pick one.
- **WhatsApp opt-in:** by email, not by WhatsApp reply.
- **Holiday catalog:** updatable without a release.
- **Read-only job state name:** "cancelled, reason tenant read-only".
- **Operator console:** a minimal one in Stage 1/2, for creating tenants and setting the demo flag.
- **Lockout:** a failed 2FA code counts toward it.
