# Notifications Specification (delta)

Stage 3. Covers appointment reminders and confirmations over email and WhatsApp, opt-out, delivery tracking, failure handling and message content rules.

**Reads from other capabilities** (not defined here): appointment data (`scheduling`), contact data and consents (`patients`), WhatsApp quotas and overage (`subscriptions`), video link (`teleconsultation`), waitlist offers (`waitlist`), audit (`audit-log`).

## Quick reference

| Topic | Rule |
|---|---|
| Channels | Email and WhatsApp only. No SMS in v1. WhatsApp only for appointment reminders and confirmations and waitlist offers. Everything else (codes, invitations, resets, portal notices, invoices) is email only. |
| Sender | The platform owns the WhatsApp sender; a single-tenant deployment may configure its own |
| Consent | Reminders are service communication: no data-processing consent needed beyond the channel opt-out. WhatsApp needs an explicit opt-in. Waitlist offers need an explicit opt-in. |
| Quiet hours | Default 21:00-08:00 location time; reminders and waitlist offers are deferred, never dropped silently |
| Content | Never clinical (no diagnosis, no specialty-revealing detail beyond what the organization allows) |
| Opt-out | Per patient, effective immediately, and for EVERY channel: opting out on one channel opts out of all of them (owner decision B7, 2026-10-18). Reception can open a channel again, one at a time, when the patient asks in person, with an audit entry. |
| Failure | Bounded retries, then fallback channel, then a reception worklist item (the worklist is defined in `scheduling`) |
| Message statuses | queued, sent, delivered, read (where reported), failed, cancelled; a cancelled message records its reason (for example "tenant read-only", "demo tenant", "opted out") |
| Language | es-AR message templates |
| Webhooks | Accepted only with a valid provider signature |

## ADDED Requirements

### Requirement: Channels and purposes

The system MUST support exactly two outbound patient channels in v1: email and WhatsApp. There MUST be no SMS channel. WhatsApp MUST be used only for messages tied to an appointment or a waitlist entry, namely appointment reminders, appointment confirmations and waitlist offers. Every message that is not tied to an appointment (one-time codes, invitations, password resets, portal notices, consent requests, invoices, subscription notices) MUST be sent by email only. The WhatsApp sender MUST be owned and configured by the platform; a single-tenant deployment MAY configure its own sender. The patient's personal data processing consent (`patients`) is not required to send a reminder or confirmation, because these are service communications; the channel opt-out and, for WhatsApp, the explicit opt-in below govern them.

#### Scenario: Portal code by email only
- GIVEN a patient with a WhatsApp opt-in requesting a portal sign-in code
- WHEN the code is sent
- THEN it is sent by email only

#### Scenario: Reminder without extra consent
- GIVEN a patient who has not opted out of email and whose record lacks a data-processing consent
- WHEN an appointment reminder is due
- THEN the reminder is sent by email

#### Scenario: Single-tenant sender
- GIVEN a single-tenant deployment with its own WhatsApp sender configured
- WHEN a reminder is sent over WhatsApp
- THEN it goes through the deployment's sender
- AND the usage is still metered

### Requirement: Automatic reminders

For every active appointment of a patient with at least one reachable channel, the system MUST send reminders according to the organization's schedule. The default schedule is one reminder 24 hours before the start; the organization MAY configure up to three reminders with different lead times. Lead times and quiet hours MUST be evaluated in the location's time zone. The system MUST send each scheduled reminder at most once per appointment and per channel (no duplicates, even when processing is retried). Reminders for cancelled, attended or past appointments MUST NOT be sent. If an appointment is booked inside a reminder's lead window, the system SHOULD send the confirmation immediately and skip reminders that are already overdue. Quiet hours MUST apply to automated reminders and waitlist offers: by default (21:00-08:00 in the location's time zone, configurable by the organization) nothing is sent during quiet hours, and a reminder due then MUST be deferred to the end of quiet hours if that is still before the appointment, otherwise it MUST be skipped and shown on reception's worklist. Booking confirmations that are an immediate response to an action of the patient or staff, one-time codes and transactional emails are exempt from quiet hours.

#### Scenario: Default reminder
- GIVEN an appointment tomorrow at 10:00 for a patient with a valid email
- WHEN it is 24 hours before the start
- THEN one reminder email is sent in es-AR with date, time, location and professional name

#### Scenario: Reschedule replaces reminders
- GIVEN reminders scheduled for an appointment on Tuesday
- WHEN the appointment is moved to Thursday
- THEN the Tuesday reminders are cancelled and new reminders follow Thursday's schedule

#### Scenario: Cancelled appointment
- GIVEN a pending reminder for an appointment
- WHEN the appointment is cancelled before the reminder time
- THEN the reminder is not sent

#### Scenario: Retry does not duplicate
- GIVEN a reminder job that is retried after a worker restart
- WHEN processing completes
- THEN the patient receives the reminder only once on that channel

#### Scenario: Last-minute booking
- GIVEN an appointment booked 3 hours before its start with a 24-hour reminder configured
- WHEN the booking is saved
- THEN the 24-hour reminder is skipped and only the booking confirmation is sent

#### Scenario: Reminder deferred out of quiet hours
- GIVEN an appointment tomorrow at 07:00 and a 24-hour reminder that falls due today at 07:00
- WHEN the reminder is processed with default quiet hours
- THEN it is sent today at 08:00, the end of quiet hours

#### Scenario: Reminder that cannot be deferred
- GIVEN an appointment at 07:30 with a 1-hour reminder that falls due at 06:30
- WHEN the reminder is processed with default quiet hours
- THEN no message is sent
- AND the appointment appears on reception's worklist as "reminder not sent"

---

### Requirement: Confirmation by the patient

Reminders MUST offer the patient a way to confirm or cancel the appointment. Confirmation and cancellation links MUST be single-appointment, unguessable, expire at the appointment start, and be usable without logging in but MUST NOT reveal any data beyond the appointment's date, time, location and professional. WhatsApp replies MAY be accepted as confirmation using fixed reply options. On confirmation the appointment status MUST become "confirmed" (see `scheduling`). A patient cancellation through a link MUST be recorded as cancelled by the patient and MUST follow the cancellation rules of `scheduling` (including late-cancellation flagging and the waitlist process). Ambiguous or unrecognized replies MUST NOT change an appointment and SHOULD be surfaced to reception.

#### Scenario: Confirm via link
- GIVEN a reminder email containing a confirmation link
- WHEN the patient opens the link and confirms
- THEN the appointment becomes "confirmed" and the confirmation time is recorded

#### Scenario: Expired link
- GIVEN a confirmation link for an appointment that has already started
- WHEN the patient opens it
- THEN the system shows that the link is no longer valid and changes nothing

#### Scenario: Guessed link
- GIVEN an attacker modifies a link token
- WHEN the request is made
- THEN the system answers generically (invalid link) without revealing whether the appointment exists

#### Scenario: Ambiguous WhatsApp reply
- GIVEN a patient replies "maybe tomorrow"
- WHEN the message is received
- THEN the appointment status is unchanged
- AND the reply appears in reception's worklist

#### Scenario: Shared phone number
- GIVEN two patients share the same phone number and both have outstanding reminders
- WHEN a reply "1" arrives
- THEN the system MUST NOT change any appointment unless the reply can be matched unambiguously, and it flags the reply for reception

---

### Requirement: Opt-out and consent

The system MUST honor an opt-out per patient, and an opt-out on any channel MUST be an opt-out of every channel (owner decision B7). A patient MUST be able to opt out by replying with a keyword on WhatsApp (for example STOP or BAJA), through a link in each email, or by asking reception, who SHALL record it; whichever of these the patient uses, email AND WhatsApp are opted out. An opt-out MUST take effect immediately: every message queued but unsent for the patient on any channel (reminders, confirmations, waitlist offers and video follow-ups) MUST be cancelled with the reason "opted out" and nothing MUST take its place on another channel; every waitlist entry of the patient MUST be closed (`waitlist`). Opt-out MUST apply to every automated message, including reminders, confirmations and waitlist offers. The opt-out MUST record the time, source and (when applicable) the staff member, once for each channel; a channel that was already opted out (for example by an opt-out of one channel recorded before this rule) keeps its first time and source. Reception MUST be able to open a channel again for a patient who opted out, one channel at a time, when the patient asks for it in person (the patient MAY also opt in again by the booking form or by their own email link); that opt-in MUST be recorded with the staff member and MUST be audited as reopening a channel the patient had closed. The reply to a WhatsApp opt-out and the page of the unsubscribe link MUST say that the patient will receive no more messages from the organization on any channel. Reminders and confirmations are service communications and MUST NOT require the data-processing consent of `patients`; the only gate for email is the absence of an opt-out. WhatsApp MUST NOT be used for a patient without an explicit, recorded WhatsApp opt-in, which is independent of the data-processing consent. The WhatsApp opt-in MAY be captured only in these ways: by the patient on the online booking form (`online-booking`); by the patient following a single-purpose opt-in link sent to them **by email**; or by reception recording an opt-in the patient gave in person. A WhatsApp message or reply MUST NOT create an opt-in (WhatsApp keywords can only opt out). Each opt-in MUST record time, source and, when staff recorded it, the staff member. The opt-out link in each email MUST be a single-purpose token link for that patient; pressing it opts the patient out of every channel, whichever channel the email was sent on. A patient who opted out and in whom no channel has been opened again MUST be shown to staff as "Sin avisos", on the patient record (header and channels) and wherever the channels of a patient are listed. Waitlist offers (`waitlist`) additionally require the patient's explicit opt-in to waitlist offers, on any channel.

#### Scenario: Opt out by WhatsApp keyword
- GIVEN a patient with a pending reminder on WhatsApp and another on email
- WHEN the patient replies "BAJA"
- THEN the patient is marked opted-out for WhatsApp AND for email, with time and source
- AND both pending reminders are cancelled and no reminder takes their place
- AND the patient receives a single acknowledgment that says no more messages will come on any channel

#### Scenario: Opt out by the email link also stops WhatsApp
- GIVEN a patient with a recorded WhatsApp opt-in and a pending reminder on WhatsApp
- WHEN the patient presses the unsubscribe link of an email
- THEN the patient is opted out of email and of WhatsApp
- AND the pending reminder is cancelled
- AND the page says that the patient will receive no more messages on any channel

#### Scenario: Opt out recorded by reception
- GIVEN a patient who tells reception they want no more messages
- WHEN reception records the opt-out from the patient record
- THEN both channels are opted out with source "staff" and the staff member, each audited
- AND the record shows "Sin avisos"

#### Scenario: Reception opens a channel again
- GIVEN a patient opted out of every channel who asks reception to receive emails again
- WHEN reception switches email back on from the patient record, after confirming
- THEN an email opt-in is recorded with source "staff" and the staff member, and the audit entry says it reopened a channel
- AND WhatsApp stays opted out and "Sin avisos" is no longer shown

#### Scenario: No opt-in for WhatsApp
- GIVEN a patient with a phone number but no recorded WhatsApp opt-in
- WHEN a reminder would be sent
- THEN WhatsApp is not used and the system falls back to email if available

#### Scenario: Opt-in captured at online booking
- GIVEN a visitor who ticks the WhatsApp reminders box on the booking form
- WHEN the booking completes
- THEN a WhatsApp opt-in is recorded with source "online booking" and the time

#### Scenario: Opt-in by email link
- GIVEN a patient with an email and a mobile number but no WhatsApp opt-in
- WHEN reception sends a WhatsApp opt-in request and the patient follows the link in the email and accepts
- THEN a WhatsApp opt-in is recorded with source "patient email link" and the time

#### Scenario: WhatsApp reply does not opt in
- GIVEN a patient with no WhatsApp opt-in who writes "SI" to the organization's WhatsApp number
- WHEN the message is received
- THEN no opt-in is recorded

#### Scenario: Reception records an in-person opt-in
- GIVEN a patient who tells reception they accept WhatsApp reminders
- WHEN reception records it
- THEN the opt-in is stored with source "staff" and the staff member's identity

#### Scenario: Patient with no channel
- GIVEN a patient opted out of all channels
- WHEN an appointment is booked
- THEN no automated message is sent
- AND the appointment is shown to reception as "no automated reminders"

### Requirement: Messages that still reach a patient who opted out

An opt-out stops everything the organization sends on its own initiative. The only messages that MUST still go out to a patient who opted out are those the person requests at that very moment through a public flow, to the address they just typed, and the answer to the opt-out itself. The list is explicit and closed: (1) the one-time code of an online booking and of a waitlist join, sent to the email just typed; (2) the confirmation of an online booking, sent to the verified email, with the single-purpose link to manage the booking (and, when the form asked for WhatsApp, the link to accept it: the double opt-in of decision D22 is kept as designed); (3) the email of a waitlist join that carries the link to accept WhatsApp; (4) the acknowledgment of a WhatsApp opt-out. Every other message to a patient (reminders, confirmations of staff-made appointments, waitlist offers, video follow-ups, invoices, consent requests, portal and subscription notices) MUST follow the opt-out. The booking confirmation MUST NOT depend on the opt-outs of the matched record, because an answer that depended on them would tell the visitor that the document is on file.

#### Scenario: Booking code to an opted-out patient
- GIVEN a patient opted out of every channel
- WHEN a visitor books online with the document of that patient and verifies an email
- THEN the code is sent to the email just typed and the confirmation to the verified email, like for any other visitor
- AND the reminders of that appointment are not sent

---

### Requirement: Message content and privacy

Messages MUST NOT contain clinical content: no diagnoses, treatments, notes, test results or attachment content. Messages MAY contain organization name, patient first name, date, time, location, professional name and appointment-type name only if the type is not specialty-sensitive according to organization settings. The organization SHOULD be able to hide the professional name and appointment type, in which case messages use a neutral wording. Messages MUST NOT contain data for more than one patient. Message templates MUST be written in es-AR and MUST NOT contain hardcoded organization names; branding comes from `tenant-branding`. Message logs MUST store metadata (type, channel, status, time) and MUST NOT store clinical data.

#### Scenario: Neutral wording
- GIVEN the organization hides professional and type
- WHEN a reminder is sent
- THEN the text says that there is an appointment on the given date, time and place at the organization
- AND no professional name or appointment type appears

#### Scenario: No clinical content
- GIVEN an appointment of type "Psychotherapy session" with a diagnosis in the clinical record
- WHEN a reminder is generated
- THEN the message contains no diagnosis or clinical information

#### Scenario: Branded message
- GIVEN two organizations with different names
- WHEN each sends a reminder
- THEN each message uses its own organization name and no other tenant's data

---

### Requirement: Delivery tracking, retries and fallback

Every message MUST have a status among: queued, sent, delivered, failed, cancelled; and (where the channel reports it) read. The system MUST retry transient failures with increasing intervals up to a bounded number of attempts (default 3) without exceeding the time of the appointment. When a channel permanently fails (invalid number, hard bounce, rejected template), the system MUST mark that contact as unreachable on that channel and, if the patient has another permitted channel, MUST send through it. When no channel succeeds, the system MUST add the appointment to reception's worklist as "reminder not delivered". An invalid contact MUST NOT be retried until it is corrected. Delivery results MUST be recorded and visible to authorized staff per appointment.

#### Scenario: Transient failure then success
- GIVEN the email provider returns a temporary error
- WHEN the system retries after the first interval and the second attempt succeeds
- THEN the status becomes "sent" and later "delivered", and only one message reaches the patient

#### Scenario: Permanent WhatsApp failure falls back to email
- GIVEN a patient with a WhatsApp opt-in whose number is not on WhatsApp, and a valid email
- WHEN the WhatsApp message fails permanently
- THEN the WhatsApp contact is marked unreachable
- AND the reminder is sent by email

#### Scenario: All channels fail
- GIVEN both channels fail permanently
- WHEN the retries are exhausted
- THEN the appointment appears in reception's worklist as "reminder not delivered" with the failure reasons

#### Scenario: Bad number is not retried
- GIVEN a number marked unreachable
- WHEN the next appointment's reminder is scheduled
- THEN WhatsApp is not attempted until the number is corrected

---

### Requirement: Provider webhooks and inbound messages

Webhook endpoints that receive delivery status and inbound messages MUST verify the provider's signature or shared secret and MUST reject unsigned or invalid requests without side effects. The tenant of an inbound message MUST be derived from the matched outbound message or the dedicated sender identity, never from the request content. Replayed webhook events MUST be idempotent. Inbound messages from unknown numbers MUST be ignored and MUST NOT create patients or appointments.

#### Scenario: Invalid signature
- GIVEN a delivery-status request with an invalid signature
- WHEN it reaches the webhook
- THEN it is rejected and no message status changes

#### Scenario: Replayed event
- GIVEN the same "delivered" event is received twice
- WHEN both are processed
- THEN the message status and counters change only once

#### Scenario: Unknown sender
- GIVEN an inbound message from a number that matches no patient
- WHEN it is received
- THEN it is ignored and no record is created for that number

---

### Requirement: Quotas, usage and integration switches

Each WhatsApp message sent MUST be reported as a usage event attributed to the appointment's professional for quota accounting in `subscriptions`. When the professional's monthly WhatsApp quota is exhausted, sending MUST continue as billable overage if the plan allows it; otherwise the system MUST fall back to email and notify the owner/admin. The tenant MUST be able to see its WhatsApp usage per professional before it is billed. Usage MUST be metered in single-tenant deployments too, even when subscription billing is disabled (`subscriptions`). WhatsApp, and separately each other integration, MUST be switchable per tenant; when off, the system MUST use email and reception's worklist as the manual fallback. Email reminders MUST NOT be limited by the WhatsApp quota.

#### Scenario: Usage attribution
- GIVEN professional P sends 120 WhatsApp reminders in a month
- WHEN the admin opens usage
- THEN the 120 messages are shown against P

#### Scenario: Quota exhausted without overage
- GIVEN P's quota is exhausted and the plan does not allow overage
- WHEN another WhatsApp reminder is due for P's patient with a valid email
- THEN the reminder goes by email and the owner/admin is notified once

#### Scenario: WhatsApp switched off
- GIVEN WhatsApp is disabled for the tenant
- WHEN reminders are due
- THEN only email is used
- AND patients without email appear in reception's worklist

---

### Requirement: Demo and read-only tenants

A tenant flagged as demo MUST NOT send any real message: sends MUST be suppressed before leaving the system and recorded as cancelled with the reason "demo tenant" (see `demo-tenant`). A tenant that is read-only MUST NOT send messages, and every sending job MUST re-check the tenant's status when it runs; a message whose send time fell inside a read-only period MUST be cancelled with the reason "tenant read-only" and MUST NOT be sent after recovery (see `tenancy`).

#### Scenario: Demo reminder suppressed
- GIVEN a demo tenant with a reminder due
- WHEN the sending job runs
- THEN no email or WhatsApp message leaves the system
- AND the message is recorded as cancelled with the reason "demo tenant"

#### Scenario: Job re-checks tenant status
- GIVEN a reminder queued before the tenant became read-only
- WHEN the job runs after the transition
- THEN the message is not sent and is cancelled with the reason "tenant read-only"

### Requirement: Audit and access to notification data

Opt-outs, opt-ins, staff-recorded opt-outs, manual resends and integration switches MUST be audited. Message logs MUST be visible only within the tenant and only to roles with scheduling or administration permission. A manual resend MUST respect opt-out and MUST NOT exceed a per-appointment limit (default 3 manual resends).

#### Scenario: Manual resend respects opt-out
- GIVEN a patient opted out of email
- WHEN reception triggers a manual email reminder
- THEN the system refuses and states that the patient opted out

#### Scenario: Resend limit
- GIVEN an appointment with 3 manual resends already
- WHEN reception tries a fourth
- THEN the system refuses

#### Scenario: Cross-tenant log access
- GIVEN an admin in organization A
- WHEN they request the message log of an appointment in organization B
- THEN the system responds as not found

---

### Requirement: WhatsApp opt-in from a public form

A WhatsApp opt-in entered on a public form (online booking or waitlist join) for a phone number nobody has verified MUST stay pending: the form records no opt-in. The system MUST send the patient a single-use `whatsapp_opt_in` link at the email address the visitor verified, and the opt-in MUST exist only after the patient follows it. Until then the messages of that patient MUST go by email. The link MUST exist for every submission that ticked WhatsApp, whoever the typed document belongs to (a new patient, a record on file, a booking that could not stand on the record with its document, an entry that was refused), and the email that carries it MUST be the same in every case: its absence would tell the visitor that the document was on file. The token belongs to the submission and remembers whether that submission registered the patient; following it MUST record the opt-in only when it did. In any other case it MUST show the same page and write nothing on the record, and reception MUST get an identity review of the booking. An opt-out on any channel (a BAJA, the unsubscribe link or reception) MUST revoke the pending `whatsapp_opt_in` links of that patient, even when WhatsApp was already opted out and the link was asked for afterwards, so that following one later does not opt them back in. Declared limitation: the link proves that the visitor controls the EMAIL address, not that the typed phone number is theirs; the number stays unverified. The same rule MUST hold for staff: a request to accept WhatsApp is an email, so it MUST be refused for a patient who opted out of email.

#### Scenario: Pending until the link
- GIVEN a visitor who ticked WhatsApp on the booking form and verified their email
- WHEN the booking is confirmed
- THEN no opt-in is recorded and the confirmation email carries the link to accept WhatsApp
- AND the reminders go by email

#### Scenario: Accepting records the opt-in
- GIVEN the link of the confirmation
- WHEN the patient follows it and accepts
- THEN the opt-in is recorded from the patient's email link and WhatsApp may be used from then on

#### Scenario: Record that already existed
- GIVEN a visitor who typed the document of a patient on file and ticked WhatsApp
- WHEN the booking is confirmed
- THEN the confirmation email carries a link exactly like the one of a new patient
- AND nothing is written on that record, neither on confirming nor when the link is followed, and reception gets an identity review

#### Scenario: BAJA revokes a pending link
- GIVEN a patient with a link to accept WhatsApp that was not followed
- WHEN the patient opts out on any channel (for example by replying "BAJA")
- THEN following the link afterwards records nothing

#### Scenario: Replies attributed to one organization
- GIVEN a number that two organizations wrote to
- WHEN the patient replies "2" without quoting any message
- THEN neither cancels anything and each organization's reception sees the reply
- AND a reply that quotes a message of one organization acts only in that one
