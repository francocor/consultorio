# Online Booking Specification (delta)

Stage 3. Covers the public, unauthenticated booking flow reached by a link per professional or per organization, and its abuse and privacy protections.

**Reads from other capabilities** (not defined here): availability and booking rules (`scheduling`), patient registry and deduplication (`patients`), reminders (`notifications`), branding (`tenant-branding`), audit (`audit-log`), plan limits (`subscriptions`).

## Quick reference

| Topic | Rule |
|---|---|
| Authentication | None. This is one of the few allowed unauthenticated surfaces. |
| Tenant resolution | From the booking link only, never from request content |
| Disclosure | Never reveals whether a person is already a patient, nor any existing appointment or clinical data |
| Abuse | Rate limiting, bot challenge, email verification, slot holds and per-contact caps |
| Capacity | Public flows always use a capacity of 1, never overbooked capacity |
| Existing patient match | Attaches silently; the appointment's identity stays unconfirmed (no care relationship) until reception confirms it (D14) |
| Consent | Data-processing consent is required. WhatsApp reminders are a separate, unticked opt-in. Waitlist offers need their own opt-in. |
| Waitlist | A visitor can join the waitlist from the public flow |
| Read-only tenant | The public flow is closed to new bookings and waitlist joins; token-link cancellation still works |
| Language | es-AR UI, mobile-first at 360 px |

## ADDED Requirements

### Requirement: Public booking links

An organization MUST be able to enable a public booking link at organization level and at professional level. Each link MUST be unguessable or use a stable, human-readable slug unique within the platform, and MUST resolve to exactly one organization (and optionally one professional). An authorized user MUST be able to enable, disable and regenerate a link; a disabled or regenerated link MUST stop working immediately and MUST show a generic "not available" page that does not reveal whether the organization exists. The organization MUST be able to choose which professionals, locations and appointment types are bookable online. The page MUST apply the tenant's branding and MUST be usable on a 360 px width in es-AR.

#### Scenario: Open an organization link
- GIVEN organization A enabled its public link and exposed two professionals
- WHEN an anonymous visitor opens the link
- THEN a branded page lists the two professionals and their bookable types

#### Scenario: Professional-specific link
- GIVEN professional P has an individual link
- WHEN a visitor opens it
- THEN only P's bookable types and slots are offered

#### Scenario: Disabled or regenerated link
- GIVEN an admin regenerates a professional's link
- WHEN a visitor uses the old link
- THEN a generic "not available" page is shown and no data about the organization is revealed

#### Scenario: Hidden professional
- GIVEN professional Q is not enabled for online booking
- WHEN a visitor opens the organization link
- THEN Q does not appear and Q's slots cannot be requested by identifier

---

### Requirement: Availability and booking constraints

The public flow MUST offer only slots that `scheduling` considers free (working hours, blocks, holidays and conflicts included) and that satisfy the organization's online-booking rules: a minimum lead time before the start (default 2 hours), a maximum horizon in the future (default 60 days), and an optional daily cap per professional for online bookings. Slots MUST be shown in the location's time zone, labeled with it. When the organization enables overbooking in `scheduling`, the public flow MUST treat each professional as having a capacity of 1 and MUST NOT use overbooked capacity. Only appointment types marked as online-bookable and, for virtual types, with a teleconsultation configured, MUST be shown. The flow MUST NOT disclose other patients' appointments or the reason a slot is unavailable.

#### Scenario: Minimum lead time
- GIVEN a lead time of 2 hours and now is 09:00
- WHEN a visitor looks at today's slots
- THEN no slot earlier than 11:00 is offered

#### Scenario: Beyond the horizon
- GIVEN a 60-day horizon
- WHEN a visitor browses to a date 90 days away
- THEN no slots are offered

#### Scenario: Slot taken meanwhile
- GIVEN two visitors view the same slot
- WHEN both try to book it
- THEN exactly one booking succeeds and the other is told the slot is no longer available and offered alternatives

#### Scenario: Overbooked capacity hidden
- GIVEN professional P allows 2 simultaneous appointments for internal use
- WHEN a visitor views P's availability
- THEN the public flow treats a slot as taken once one appointment exists

---

### Requirement: Slot hold

When a visitor selects a slot, the system MUST hold it for a short period (default 10 minutes) so that others cannot book it while the visitor completes the form, using the slot hold of `scheduling` (a hold is not an appointment, has no patient and occupies the professional's range). An expired hold MUST release the slot automatically; expiry MUST NOT trigger waitlist offers. A visitor (one browsing session is one source) MUST NOT hold more than a small number of slots at once (default 1), and a hold MUST NOT stop internal staff from booking the slot with an explicit override, which invalidates the hold.

#### Scenario: Hold expires
- GIVEN a visitor selected a slot 11 minutes ago and did not finish
- WHEN another visitor views the same slot
- THEN the slot is available again

#### Scenario: Multiple holds
- GIVEN a visitor already holds a slot
- WHEN the same visitor selects another slot
- THEN the first hold is released and only the new one is held

---

### Requirement: Booking completion and patient identification

To complete a booking the visitor MUST provide full name, a national identifier (DNI for Argentina, via `country-rules-ar`), an email address and MUST accept the data-processing consent. A mobile number is optional and is needed only for WhatsApp reminders. The email MUST be verified by a one-time code sent by email before the appointment is finalized (no SMS channel exists). The code MUST be sent only after the form is submitted, and only to the email address entered in that form. No patient record or appointment MAY exist before verification, and an unverified request MUST expire without creating one. The form MUST offer an unticked, separate choice to receive reminders and confirmations by WhatsApp, which requires the mobile number; ticking it MUST record a WhatsApp opt-in with source "online booking" and the time (`notifications`). Email reminders need no further choice beyond the data-processing consent already required here. The system MUST apply the patient deduplication rules from `patients`: if a patient with the same identifier exists, the booking MUST attach to that patient but MUST NOT reveal to the visitor that the patient already existed, and MUST NOT overwrite the existing record's contact or demographic data with unverified input. Because nobody has checked that the visitor is that patient, such an appointment MUST start with its identity unconfirmed (`authorization`). It MUST NOT create a care relationship, and it MUST open an identity review on the reception worklist (`scheduling`, `patients`) that also carries the submitted differences. If no patient exists, a new patient MUST be created marked as "created online", and the appointment's identity is confirmed from creation. The patient-facing confirmation MUST be identical in both cases. The organization MAY require staff approval, in which case the appointment is created as pending approval, appears on the reception worklist, and becomes scheduled upon approval. Approval alone does not confirm the identity. The visitor MUST receive a confirmation through the verified channel following `notifications` rules. The form MUST NOT ask clinical questions. It MAY offer an optional free-text reason, which MUST be treated as administrative text and warn the visitor not to include health details.

#### Scenario: New patient books
- GIVEN a visitor with no existing patient record
- WHEN they complete the form, accept consent and verify their email by code
- THEN a patient marked "created online" and a scheduled appointment are created
- AND they receive a confirmation email

#### Scenario: Existing patient is not revealed
- GIVEN a patient with DNI 30111222 already exists with a different phone number
- WHEN a visitor submits the form with that DNI and a new phone number, and verifies it
- THEN the appointment is attached to the existing patient with its identity unconfirmed
- AND the visitor sees the same confirmation as a new patient would
- AND the existing phone number is not overwritten
- AND an identity review with the phone difference appears on the reception worklist

#### Scenario: Stranger uses a victim's DNI
- GIVEN patient V with DNI 30111222 has clinical records and no care relationship with professional B
- WHEN a stranger books B online with DNI 30111222 and verifies their own email
- THEN the stranger sees the standard confirmation
- AND B gets no clinical access to V until a staff member other than B confirms the identity at the identity review or at check-in
- AND V's contact data is unchanged

#### Scenario: Code goes only to the submitted email
- GIVEN a visitor who holds a slot and has not yet submitted the form
- WHEN they submit the form with email e
- THEN one verification code is sent to e
- AND no code is sent to any address on file for a matching patient

#### Scenario: WhatsApp opt-in at booking
- GIVEN a visitor who provides a mobile number and ticks the WhatsApp choice
- WHEN the booking completes
- THEN a WhatsApp opt-in is recorded for the patient with source "online booking"

#### Scenario: No WhatsApp choice
- GIVEN a visitor who leaves the WhatsApp choice unticked
- WHEN the booking completes
- THEN no WhatsApp opt-in is recorded
- AND reminders go by email only

#### Scenario: Unverified contact
- GIVEN a visitor who does not enter the verification code
- WHEN the hold expires
- THEN no appointment is created and the slot is released

#### Scenario: Missing consent
- GIVEN a visitor who does not accept the data-processing consent
- WHEN they submit
- THEN the booking is refused and the reason is explained

#### Scenario: Invalid identifier
- GIVEN a DNI that fails the format validation
- WHEN the visitor submits
- THEN the form shows a validation message and nothing is created

#### Scenario: Approval required
- GIVEN the organization requires approval of online bookings
- WHEN a visitor completes a verified booking
- THEN the appointment is "pending approval" and reception sees it on the reception worklist
- AND the visitor is told the booking awaits confirmation

---

### Requirement: Abuse protection

The public endpoints MUST be protected from automated abuse. They MUST apply rate limits per source and per link, MUST present a bot challenge on submission, and MUST bound the number of verification codes sent per contact and per time window (default 3 per hour). The same contact or national identifier MUST NOT hold more than a configured number of future online appointments with the same organization (default 3) and MUST NOT create more than a configured number of bookings per day. The system MUST reject requests that exceed limits with a generic message and no information about existing patients. Verification codes MUST expire (default 10 minutes) and MUST be invalidated after a bounded number of wrong attempts (default 5). Suspicious activity MUST be recorded for the organization's admin and the platform operator. Public endpoints MUST accept only the minimal input fields and MUST ignore any client-supplied organization, role or patient identifiers.

#### Scenario: Rate limit exceeded
- GIVEN a source exceeds the request limit for the booking endpoints
- WHEN it sends another request
- THEN the system rejects it with a generic "try again later" message

#### Scenario: Code flooding
- GIVEN 3 verification codes were already sent to one email within an hour
- WHEN another code is requested for the same email
- THEN no code is sent and the visitor sees a generic message

#### Scenario: Code guessing
- GIVEN a verification code with 5 wrong attempts
- WHEN the visitor tries again
- THEN the code is invalidated and a new request is required

#### Scenario: Slot hoarding
- GIVEN a contact already has 3 future online appointments with the organization
- WHEN they try to book a fourth
- THEN the booking is refused with a message to contact the organization

#### Scenario: Forged tenant
- GIVEN a submission containing an organization identifier different from the link's organization
- WHEN the system processes it
- THEN the organization from the link is used and the body value is ignored

#### Scenario: Bot submission
- GIVEN a submission that fails the bot challenge
- WHEN it is received
- THEN the system rejects it and creates no patient, hold or appointment

---

### Requirement: Waitlist self-join

When no suitable slot is available (or the visitor prefers a different time), the public flow MUST let the visitor join the waitlist (`waitlist`) for the chosen professional or organization and appointment type, with the same data, verification, deduplication, consent, rate limits and non-disclosure rules as a booking. The visitor MUST give an explicit, separate opt-in to receive waitlist offers and MUST choose the channel(s), with WhatsApp following the opt-in rules of `notifications`. No waitlist entry MAY become active before the email is verified, and an unverified request MUST expire like an unverified booking. The visitor MUST see the same confirmation whether or not the person already existed as a patient. If the entry was attached to an existing patient, an appointment later booked from it through a waitlist offer counts as created through the public flow: its identity MUST start unconfirmed, as for a direct online booking. The number of active entries per contact MUST respect the waitlist bound, and joining MUST NOT reveal other patients' entries or appointments.

#### Scenario: Join the waitlist when nothing is free
- GIVEN a professional with no free slot in the horizon
- WHEN a visitor completes the waitlist form, ticks the offers opt-in and verifies their email
- THEN an active waitlist entry exists for that patient
- AND the visitor sees a confirmation that does not say whether they were already a patient

#### Scenario: No offers opt-in
- GIVEN a visitor who does not tick the waitlist offers opt-in
- WHEN they submit the waitlist form
- THEN the system refuses to create an entry and explains why

#### Scenario: Unverified waitlist request
- GIVEN a visitor who never verifies their email
- WHEN the retention period for unverified submissions ends
- THEN the request is deleted and no entry or patient exists

### Requirement: Self-service change and cancellation

The patient MUST be able to cancel or reschedule an online appointment through a single-appointment, unguessable link sent in the confirmation, until the organization's configured deadline (default 12 hours before the start). After the deadline the link MUST direct the patient to contact the organization. Rescheduling MUST follow the same constraints as new bookings and MUST release the previous slot only when the new one is confirmed. Cancellation MUST follow `scheduling` rules and trigger the waitlist process. Links MUST not reveal information beyond the appointment's date, time, location and professional.

#### Scenario: Cancel before the deadline
- GIVEN an appointment in 3 days and a 12-hour deadline
- WHEN the patient cancels through the link
- THEN the appointment becomes cancelled by the patient and the slot is freed

#### Scenario: After the deadline
- GIVEN an appointment in 5 hours
- WHEN the patient opens the cancellation link
- THEN the patient is told to contact the organization and nothing changes

#### Scenario: Reschedule onto a taken slot
- GIVEN a patient selects a new slot that was taken meanwhile
- WHEN they confirm
- THEN the reschedule fails and the original appointment is kept

---

### Requirement: Privacy and data minimization

The public flow MUST NOT expose clinical information, patient lists or appointment details of anyone other than the visitor's own appointment accessed through its link. The flow MUST collect only the data needed to book. Data collected from visitors MUST be encrypted in transit and at rest and MUST be tied to the data-processing consent captured. Abandoned or unverified submissions, both bookings and waitlist self-joins, MUST be deleted automatically after a short period (default 24 hours) and MUST NOT create patient records; this deletion is retention exception 4 of the no-hard-delete rule (`tenancy`). Bookings MUST be audited with source "online" and the verified contact. The page MUST NOT embed third-party trackers that transmit visitor-entered data.

#### Scenario: Abandoned data cleanup
- GIVEN a visitor entered name and DNI but never verified the contact
- WHEN 24 hours pass
- THEN the submission data is deleted and no patient exists for it

#### Scenario: No cross-visitor leakage
- GIVEN two visitors using the flow at once
- WHEN each views the booking summary
- THEN each sees only their own data

#### Scenario: Audit of the online booking
- GIVEN a completed online booking
- WHEN an auditor reviews it
- THEN the appointment's audit entry shows source "online" and the verified contact channel, with no session or tenant data supplied by the visitor

---

### Requirement: Read-only tenant

When the tenant is read-only (`subscriptions`, allowlist in `tenancy`), the public booking page and the waitlist join MUST show the generic "not available" page and MUST NOT create holds, patients, appointments or waitlist entries. Cancellation through an existing single-appointment link is a patient-protective write and MUST keep working.

#### Scenario: Visitor on a read-only tenant
- GIVEN a read-only tenant
- WHEN a visitor opens its public booking link
- THEN the generic "not available" page is shown and nothing is created

#### Scenario: Cancel through a link while read-only
- GIVEN a read-only tenant and a patient with an online appointment
- WHEN the patient cancels through the link in the confirmation
- THEN the appointment becomes cancelled by the patient

---

### Requirement: Limits that never reveal what the organization holds

The limits of a contact MUST be applied to the email address the visitor verified with the one-time code, and only after the code was accepted and the professional of the slot was locked, so that two visitors who confirm at the same moment are served one after the other. Before the code is accepted, no answer of the public flow MAY depend on the patients or the appointments of the organization. The cap of future online appointments per document MUST be evaluated after verification and MUST NOT produce an answer different from any other booking. When a booking cannot stand on the record that has the typed document (the record is deactivated, the document is at its cap, or the link already holds its limit of unconfirmed appointments), the visitor MUST be answered as for any booking, the appointment MUST stand on a record of its own that carries what the visitor typed, nothing MUST be written on or sent to the record that has the document, and reception MUST get an identity review that says why. The record of its own MUST be reused: a later booking by the same verified address, name and birth date that cannot stand on the record with its document MUST be put on the record of its own that already exists, not on a new one. Each booking link MUST have a limit of future appointments with the identity unconfirmed, whether they stand on a patient already on file or on a record of their own; the default is 20 and an administrator MAY change it from 0 to 500. The booking confirmation MUST always be sent to the verified address, whatever the opt-outs of the matched record (an opt-out is for every channel, `notifications`, and the code and the confirmation of the booking are among the few messages that still reach a patient who opted out: they answer what the visitor is doing at that moment, and an answer that depended on the opt-outs of the record would reveal that the document is on file). The WhatsApp choice on the form MUST be a request (see notifications, "WhatsApp opt-in from a public form").

#### Scenario: Document at its cap
- GIVEN a patient with three future online appointments
- WHEN a visitor verifies an email and books with that patient's document
- THEN the answer is the same as for a person nobody registered
- AND the appointment stands on a new record without the document
- AND reception sees an identity review whose reason is the cap on the document

#### Scenario: Deactivated record
- GIVEN a deactivated patient with document D
- WHEN a visitor verifies an email and books with document D
- THEN the answer is the same as for a new person and the confirmation goes to the verified address
- AND the deactivated record has no appointment

#### Scenario: Nothing is refused before the code
- GIVEN a document that has three future online appointments
- WHEN a visitor submits the form with that document
- THEN the answer is the same as for any other document and nothing is flagged

#### Scenario: Limit of the link
- GIVEN a link whose limit of unconfirmed appointments is 1 and that already holds one
- WHEN another visitor books with the document of a patient on file
- THEN the appointment stands on a record of its own and reception reviews it

#### Scenario: Two confirmations at once
- GIVEN a daily cap of one online booking and two visitors who confirm at the same moment
- THEN exactly one booking is made and the other visitor is told the time is no longer available
