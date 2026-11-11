# Delta for patient-portal

> Stage 5 (Clinical compliance and patient portal). New capability. Patient-facing authenticated access to their own appointments, documents, consents, prescriptions and invoices. Authentication primitives belong to `identity-access`. Role rules belong to `authorization`.
> Decision (D11): clinical note content is NEVER displayed in the portal in v1. Patients obtain a formal copy of their clinical history by requesting it from the organization (Ley 26.529 right of access).
> Decision (C7): patients have no password. They sign in with a one-time code sent to their verified email address (see `identity-access`). No SMS channel exists in v1.

## Quick map

| Area | Requirements |
|---|---|
| Access | Portal identity, activation and identity link, authentication, non-patient denial, representatives |
| Content | Appointments, documents, consents, prescriptions, invoices, own data |
| Safety | Own-data-only, tenant isolation, short-lived links, message privacy, audit |
| Lifecycle | Deactivation, read-only tenant |
| UX | Mobile, language |

## ADDED Requirements

### Requirement: Portal identity

Portal access MUST be modeled as a portal identity: one person's portal login within one organization, distinct from any staff user. A portal identity MUST have an email address, a status (invited, active or deactivated), and one or more links to patient records of the same organization. It becomes active only once its email is verified, and only an active identity can sign in. Each link MUST state its relationship: the person themselves ("self") or a representative of a dependent. A person MUST have at most one "self" link per organization, a patient record MUST have at most one "self" link, and a verified email MUST map to at most one portal identity per organization. A portal identity MUST NOT be created for, or linked to, a patient record of another organization. Creation, linking, representative changes and deactivation MUST be audited.

#### Scenario: Two adult patients sharing one email
- GIVEN adult patient A already has a portal identity on email e
- WHEN adult patient B is invited with the same email e as "self"
- THEN the system refuses and asks for a different email for B

#### Scenario: Parent with two children
- GIVEN a representative with one portal identity
- WHEN the organization links two dependent patient records to it
- THEN the representative can switch between the two dependents inside the same identity

### Requirement: Portal account activation and identity linking

A patient MUST gain portal access only by an invitation originated by the organization for an existing patient record, or by a registration flow that verifies the person against that record. Verification MUST match at least two attributes held on the record (for example DNI and the email address on file, confirmed with a one-time code sent by email). The system MUST NOT create a patient record or link to one through open self-registration. The activation response MUST NOT reveal whether a given DNI exists in the organization. Invitations and activation codes MUST be sent by email only.

#### Scenario: Invitation
- GIVEN a patient record with a confirmed email
- WHEN reception sends a portal invitation
- THEN the patient MUST receive, by email, a single-use, expiring activation link containing no clinical content
- AND following it creates the portal identity linked to that record

#### Scenario: Registration with matching data
- GIVEN a patient record with DNI d and email e on file, and no "self" portal link
- WHEN a visitor registers with DNI d and email e and enters the one-time code sent to e
- THEN a portal identity for e is created with a "self" link to that record
- AND no new patient record is created

#### Scenario: Registration with data that does not match
- GIVEN a visitor who enters a DNI that matches a record but a contact channel that does not
- WHEN they submit
- THEN activation MUST fail with a generic message that does not confirm or deny the DNI

#### Scenario: Expired activation link
- GIVEN an activation link past its expiry
- WHEN the patient opens it
- THEN the system MUST reject it and offer to request a new invitation

### Requirement: Patient authentication

Portal sign-in MUST use the passwordless email one-time-code flow defined in `identity-access`; there is no password and no password reset for patients. The portal MUST enforce rate limiting, backoff and lockout on repeated failures. Portal sessions MUST expire after inactivity and MUST be revocable by the patient and by an administrator.

#### Scenario: Repeated failures
- GIVEN a portal identity
- WHEN several consecutive wrong codes are submitted
- THEN the system MUST throttle or lock further attempts and audit the event

#### Scenario: Lost access to the email
- GIVEN a patient who can no longer use the email of their portal identity
- WHEN they ask the organization to change it
- THEN the owner or an administrator (not reception) MUST verify the patient's identity out of band and change the email
- AND the change MUST be audited and existing portal sessions revoked
- AND a notice without a link MUST be sent to the PREVIOUS address, queued in the same transaction as the change, and recorded in the audit log

#### Scenario: Lock-out of a patient by a stranger
- GIVEN a stranger who knows the email of a portal identity
- WHEN they submit many wrong codes for it
- THEN the portal MUST stop answering that client, and MUST NOT stop answering the patient from another client
- AND the tries at a code MUST be counted per challenge and per client (five each), with a cap on the challenge, so that tries from one client cannot spend the code of the patient
- AND a request for a code that the portal answers without sending one (a document that does not match) MUST NOT end the live code of the address nor count among the codes sent to it
- AND a client MUST NOT be able to ask for codes without limit

#### Scenario: Code request does not reveal accounts
- GIVEN a code request for an email without a portal identity
- WHEN the request is processed
- THEN the response MUST NOT reveal whether the account exists

### Requirement: Own-data-only access

A portal user MUST access only data of the patient record(s) they are linked to. The patient identity MUST be derived from the authenticated session, never from request parameters. Requests naming another patient's identifier MUST be answered as if the resource does not exist.

#### Scenario: Patient requests another patient's appointment
- GIVEN patient P1 signed in
- WHEN P1 requests appointment A2 that belongs to P2
- THEN the system MUST respond as not found
- AND MUST record the attempt in `audit-log`

### Requirement: Denial for non-patients

A staff account (owner/admin, professional, reception) MUST NOT be able to use patient portal endpoints to read patient data under staff identity, and a patient account MUST NOT be able to access any staff, administrative or clinical endpoint. A person who is both a staff member and a patient MUST use a separate portal identity for their own patient data. An unauthenticated visitor MUST NOT access any portal data.

#### Scenario: Staff token on portal data route
- GIVEN a signed-in reception user
- WHEN they call a portal endpoint for patient P1's documents
- THEN the system MUST deny the request

#### Scenario: Patient calls a staff endpoint
- GIVEN a signed-in patient
- WHEN they call the patient registry listing
- THEN the system MUST deny the request

#### Scenario: Unauthenticated access
- GIVEN no session
- WHEN a visitor requests any portal resource except activation and sign-in
- THEN the system MUST respond unauthorized

### Requirement: Legal representatives and dependents

The system MUST support a representative, being a portal identity with representative links to one or more dependent patient records (for example minors), created after verification by the organization. The representative MUST act within the portal for dependents only, and sign-in is by the representative's own email one-time code. The portal MUST show clearly whose data is being viewed. A representative link MUST exist only for a MINOR: an adult is represented only through the adult's own authorization, given from their own portal session, and the organization MUST NOT create or restore a representative link for an adult. A minor MUST NOT have a portal account of their own; they are reached only through a verified representative. A representative link MUST be revocable by the organization and by the adult, and MUST stop giving access on the day the dependent reaches the age of majority (in the organization's time zone), whether or not any scheduled review has run; the organization MUST NOT restore it after that day. When the organization gives a representative access to a minor's record it MUST notify the email on the patient's record, when there is one, and record the notice in the audit log. The notice MUST be queued in the same transaction as the change. A representative for a minor whose record has no email MUST be given by an owner or an administrator, not by reception.

The portal trusts two facts that the staff can edit: the email of the patient's record and the birth date. Whenever either changes, the system MUST write the change in the same transaction, whoever makes it, and MUST notify the PREVIOUS email of the record (when there was one) with a notice that carries no link, no value and no name. For seven days after such a change, inviting the patient to the portal, inviting or linking a representative, restoring a suspended representative link, and registering through the public form MUST require an owner or an administrator (reception MUST be refused, and the refusal audited); the use of that exception by an owner or an administrator MUST be marked in the audit log.

When a change of the email of a record gives an email to a record that had none (or whose previous email could not be told, because the notice failed or the week ended without it), nobody who knew the old record was warned, so the seven days are not enough: PUBLIC self-registration for that patient (document number and email, with no invitation) MUST stay closed until an owner or an administrator invites the patient, which is an explicit act and MUST be audited. Reception MUST NOT be able to open it. A representative for such a patient MUST be given by an owner or an administrator too. The notice to the previous email MUST be generic: it MUST NOT name a patient, a file or what changed, because the mailbox may belong to somebody who is not the patient. A notice that cannot be told MUST be retried a bounded number of times, then given up with an audit entry and a log line. While a notice has not been told, whatever its age (the worker may be stopped after the week), the registration MUST stay closed in the same way, and an invitation by an owner or an administrator MUST open it.

A correction of the birth date of a patient MUST NOT extend the access of an existing representative: the day the link stops giving access is the earlier of the day it had and the one the new date gives. If an earlier day suspends the link, restoring it is the gated act for a minor. Restoring a suspended representative link MUST notify the email on the record like the first time.

#### Scenario: Parent sees child appointments
- GIVEN a verified representative linked to a minor
- WHEN they select the minor in the portal
- THEN they MUST see that minor's appointments

#### Scenario: Link after majority
- GIVEN a dependent turned 18
- WHEN the representative signs in
- THEN access to that dependent MUST be suspended until the patient authorizes it

#### Scenario: Representative for an adult
- GIVEN an adult patient
- WHEN a member of the staff invites or links a representative for them
- THEN the system MUST refuse

#### Scenario: Birth date corrected
- GIVEN a representative of a patient whose birth date is corrected so that the patient is an adult
- WHEN the representative asks for the patient's data
- THEN the system MUST refuse at once

#### Scenario: Contact data of a record edited by reception
- GIVEN a member of reception who changes the email or the birth date of a patient's record
- WHEN they then invite the patient or a representative to the portal, within seven days
- THEN the system MUST refuse reception, and allow an owner or an administrator
- AND the previous email of the record MUST have been told of the change, without a link

#### Scenario: A record that had no email is given one
- GIVEN a patient whose record had no email, and a member of reception who sets one
- WHEN, after more than seven days, somebody registers through the public form with the document number and that email
- THEN no code MUST be sent, and the answer MUST be the same as for any other mismatch
- AND reception MUST be refused when it invites the patient, while an owner or an administrator MUST be able to, which opens the registration and writes `portal.registration.opened`

#### Scenario: The worker is stopped and the week ends
- GIVEN a patient whose email was replaced, whose notice to the previous email has not been told, and more than seven days have passed with the sweep not running
- WHEN somebody registers through the public form with the document number and the new email, or reception invites the patient
- THEN no code MUST be sent and reception MUST be refused
- AND an owner or an administrator inviting the patient MUST be able to, which opens the registration

#### Scenario: A later birth date
- GIVEN a representative of a minor who turns 18 on a given day
- WHEN reception corrects the birth date to a later one
- THEN the representative MUST lose access on the original day

#### Scenario: Minor with no email on the record
- GIVEN a minor whose record has no email
- WHEN reception invites or links a representative for them
- THEN the system MUST refuse, and allow an owner or an administrator

### Requirement: Appointments in the portal

A patient MUST see their upcoming and past appointments with date, time, professional, location, appointment type and, for virtual appointments, the video link when available (`teleconsultation`). A patient MAY confirm or cancel an upcoming appointment within the organization's cancellation policy. The portal MAY offer booking through `online-booking`. Past policy windows MUST be enforced on the server.

#### Scenario: Cancel within policy
- GIVEN an appointment outside the organization's cancellation cut-off
- WHEN the patient cancels it
- THEN the appointment MUST be cancelled and the slot freed (`waitlist` MAY then be triggered)

#### Scenario: Cancel after cut-off
- GIVEN an appointment inside the cancellation cut-off
- WHEN the patient tries to cancel in the portal
- THEN the system MUST refuse and show the organization's contact instructions

### Requirement: Documents shared with the patient

The portal MUST list only documents that a professional or authorized staff member explicitly shared with the patient. Unshared attachments MUST NOT be visible. Downloads MUST use links valid for 5 minutes and bound to the authenticated portal session (see `documents`); a link copied to another session or device MUST NOT work. Files MUST NOT be embedded in lists or served via permanent public URLs. The portal MUST NOT list or show clinical note content, diagnoses or anamnesis.

#### Scenario: Unshared document
- GIVEN a document in the patient file not marked as shared
- WHEN the patient lists documents
- THEN it MUST NOT appear

#### Scenario: Expired link
- GIVEN a download link older than its validity
- WHEN it is opened
- THEN the system MUST refuse and require a fresh request from the authenticated portal

#### Scenario: Link used from another session
- GIVEN a download link issued to patient P1's portal session
- WHEN it is opened from a different session or without a session
- THEN the system MUST refuse

#### Scenario: No clinical notes in the portal
- GIVEN a patient with signed encounters
- WHEN they browse every portal section
- THEN no clinical note content is offered
- AND the portal offers the formal copy request instead

### Requirement: Consents, prescriptions and invoices

The portal MUST show the patient's consents (pending, signed, revoked) with signing and revocation as defined in `informed-consent`, issued prescriptions with download as defined in `e-prescription`, and their invoices and receipts as defined in `e-invoicing-afip` and `billing-payments`. A patient MUST see only their own items. The portal MUST NOT show payer portions owed by a payer as if owed by the patient.

#### Scenario: Sign a consent in the portal
- GIVEN a pending consent request
- WHEN the patient reads the full text and accepts
- THEN the consent MUST be stored as signed and appear in the list

#### Scenario: Download a prescription
- GIVEN an issued prescription
- WHEN the patient downloads it
- THEN the download MUST be audited and the link MUST be valid for 5 minutes and bound to the portal session

### Requirement: Personal data access and rectification

The portal MUST show the patient's demographic and contact data and MUST let the patient submit a rectification request or change allowed contact fields. Changes to identity fields (name, DNI, date of birth) MUST be requests that staff review and approve. Every change MUST be audited with before and after values. The portal MUST let the patient see the status of their data-processing consent and request a copy of their clinical history, which is fulfilled by the organization outside the portal.

#### Scenario: Update contact phone
- GIVEN a patient edits their phone
- WHEN they save
- THEN the phone MUST be updated and the change audited

#### Scenario: Request identity correction
- GIVEN a patient notices a wrong surname
- WHEN they submit a rectification request
- THEN it MUST appear as pending for staff
- AND the record MUST remain unchanged until approved

#### Scenario: Request clinical history copy
- GIVEN a patient asks for a copy of their clinical history
- WHEN they submit the request
- THEN the organization MUST be notified without any clinical content in the notification

### Requirement: Privacy of portal messages

Messages originating from the portal (invitations, one-time codes, document available notices, consent requests) MUST be sent by email only; WhatsApp is reserved for appointment reminders, confirmations and waitlist offers, and no SMS channel exists. They MUST contain no clinical content and MUST NOT reveal the specialty or reason for a visit. They MUST link to the authenticated portal.

#### Scenario: Notification wording
- GIVEN a new consent is requested
- WHEN the message is sent
- THEN it is an email
- AND it MUST say only that a document is waiting in the portal

### Requirement: Tenant isolation across organizations

A person who is a patient in more than one organization MUST have a separate portal identity per organization. Data from one organization MUST NOT appear in another organization's portal view. The organization context MUST come from the sign-in session and MUST NOT be changeable from request parameters.

#### Scenario: Same person in two organizations
- GIVEN a person registered as a patient in organizations X and Y
- WHEN they sign in to X's portal
- THEN only X's data MUST be visible

### Requirement: Audit

Sign-ins, failures, reads of consents, prescriptions, invoices and documents, downloads, data changes and denied cross-patient attempts MUST be recorded in `audit-log` with actor, organization, timestamp and resource.

#### Scenario: Audit of document download
- GIVEN a patient downloads a shared document
- WHEN the download is served
- THEN an audit entry MUST exist with the patient, document and timestamp

### Requirement: Portal deactivation and read-only tenant

An organization MUST be able to deactivate a portal identity (or a single representative link) without deleting the patient record. Deactivation MUST revoke active sessions. When the tenant is read-only (`subscriptions`), the portal MUST remain available for reading, sign-in, and the patient-protective writes in the read-only allowlist of `tenancy` (cancelling appointments, consent revocation, ending the access of a representative, rectification requests, channel opt-out), while every other write, including features that create billable or clinical records, MUST be blocked.

#### Scenario: Deactivate portal access
- GIVEN a patient with an active session
- WHEN an admin deactivates portal access
- THEN the session MUST end and further sign-ins MUST fail
- AND the patient record MUST remain

### Requirement: Mobile experience and language

The portal MUST be usable at a 360 px viewport, installable as part of the PWA, and MUST show explicit loading, empty and error states. All copy MUST be Spanish (es-AR) from externalized strings. The portal MUST apply the organization's branding from `tenant-branding`.

#### Scenario: Empty state
- GIVEN a patient with no documents
- WHEN they open the documents section
- THEN an empty state in Spanish MUST explain that nothing has been shared yet
