# Delta for patients

Patient registry, payer coverage, anamnesis, deduplication by DNI and data-processing consent.

**Quick read**: patients are tenant-owned and deduplicated by document where a document exists. Demographics are visible organization-wide to reception and to health professionals; anamnesis is clinical and is scoped by care relationship. Patients are never hard-deleted. Data-processing consent is captured at registration. A patient can be assigned explicitly to a professional from Stage 1.

## ADDED Requirements

### Requirement: Patient registry

The system MUST let authorized staff create, search, view and edit patients within their organization. A patient record MUST hold: names, birth date, contact data and, when the person has one, document type and number; it MAY hold sex/gender, address, an optional emergency contact and notes of administrative nature. A patient without any identity document (for example a newborn or an unidentified person) MUST be registrable: the record is then flagged "no document", and the document can be added later. A patient belongs to exactly one organization; the same person registered in two organizations is two separate records. Demographics and coverage of every patient MUST be readable by every health professional and reception user of the organization, regardless of care relationship (`authorization`).

#### Scenario: Register a patient
- GIVEN a reception user with valid data
- WHEN the patient is saved
- THEN the patient exists in the user's organization only

#### Scenario: Same person in two organizations
- GIVEN a person registered in organization 1
- WHEN organization 2 registers the same DNI
- THEN a separate record is created and neither organization sees the other's data

#### Scenario: Required fields missing
- GIVEN no name
- WHEN saving
- THEN the system rejects it listing missing fields in es-AR

#### Scenario: Patient without a document
- GIVEN a newborn with no identity document
- WHEN reception registers the patient with name and birth date
- THEN the patient is saved flagged "no document"
- AND the missing document does not block scheduling or care

#### Scenario: Professional finds any patient
- GIVEN a professional with no care relationship with a patient
- WHEN they search the registry by name
- THEN the patient's demographics are shown
- AND no clinical content is reachable unless the clinical rules allow it

### Requirement: Deduplication by document

Within an organization, the normalized document (type plus number) MUST be unique among patients that have a document; the uniqueness key applies only where a document is present, and patients flagged "no document" are never blocked by it. When a duplicate document is attempted, the system MUST block creation and show the existing patient's minimal identity to authorized staff so they can open it. For patients without a document, the system SHOULD warn of a possible duplicate when name and birth date match an existing patient, without blocking. The system SHOULD offer merge for accidental duplicates, preserving all history and audited.

#### Scenario: Duplicate DNI
- GIVEN patient with DNI 30123456 exists
- WHEN another is created as "30.123.456"
- THEN creation is blocked and the existing patient is offered

#### Scenario: Merge keeps history
- GIVEN two records for the same person are merged
- WHEN the merge completes
- THEN all history is retained under the surviving record
- AND the merge is audited

#### Scenario: Duplicate check across tenants does not leak
- GIVEN DNI 30123456 exists only in organization 2
- WHEN organization 1 registers that DNI
- THEN registration succeeds with no hint that it exists elsewhere

### Requirement: Identity review of matched bookings

When an appointment is attached to an existing patient without anyone checking who the patient is (an online booking matched by document, or a professional booking an existing patient with themselves, see `online-booking` and `scheduling`), the system MUST open an identity review on the reception worklist (`scheduling`). The review MUST show the patient's on-file identity next to the data the booking submitted, highlighting differences, and MUST NOT show clinical content. A staff member other than the appointment's professional MUST be able to: confirm the identity, which confirms the appointment's identity (`authorization`) and lets them choose which submitted differences, if any, to apply to the record, each change audited; or reject the match. A rejected match MUST NOT change the matched record. The staff member MUST then move the appointment to a separate patient record or cancel it, and no care relationship MAY arise with the matched patient from it. Until the review or a check-in confirms the identity, submitted data MUST NOT overwrite the record. Confirming at check-in (`scheduling`) closes the review in the same way. In an organization with exactly one active professional and no other active staff (D18), that professional MAY confirm the identity, but only at in-person check-in after seeing the patient and the ID document. The review then closes with the "self_confirmed" marker in the audit, and the professional MAY apply the submitted differences. Self-confirmations remain valid if staff join later.

#### Scenario: Confirm and apply a new phone number
- GIVEN an identity review showing a different phone number for patient P
- WHEN reception confirms P's identity and applies the new phone number
- THEN the appointment's identity is confirmed
- AND P's phone number is updated with the previous value kept in history

#### Scenario: Reject a match
- GIVEN an identity review where the submitted email and phone clearly belong to someone else
- WHEN reception rejects the match and moves the appointment to a new patient record
- THEN patient P's record is unchanged
- AND the appointment's professional gets no clinical access to P from it

#### Scenario: Solo practice confirms at check-in
- GIVEN a solo organization whose only active staff member is professional S, and an open identity review for patient P
- WHEN S checks P in person, sees P's ID document and confirms
- THEN the review closes, the identity is confirmed, and the audit marks it "self_confirmed"

#### Scenario: Solo professional cannot self-confirm from the worklist
- GIVEN the same solo organization
- WHEN S tries to confirm the identity review from the worklist without an in-person check-in
- THEN the action is denied

#### Scenario: Review hides clinical content
- GIVEN an identity review for a patient with clinical records
- WHEN reception opens it
- THEN only demographic and booking data are shown

### Requirement: Search and listing

Search MUST work by name, document and phone within the organization and return only demographic fields. Lists MUST be paginated and MUST NOT include clinical content. The registry search never matches or returns clinical content; searching clinical content is a separate, per-patient function inside one patient's record (`clinical-records`). Clinical-sharing policy limits clinical content only, never demographics.

#### Scenario: Find by partial name
- GIVEN several patients exist
- WHEN reception types part of a surname
- THEN matching patients of the organization are listed quickly with demographics only

### Requirement: Payer coverage

A patient MUST be able to have zero or more coverages, each linking to a payer from the catalog (see `country-rules-ar`) with plan, affiliate number and validity dates, and a flag for the primary coverage. "Particular" (self-pay) MUST be a valid choice. Coverage changes MUST be audited.

#### Scenario: Add coverage
- GIVEN a patient
- WHEN reception adds an obra social with affiliate number
- THEN the coverage is stored and marked primary if first

#### Scenario: Expired coverage
- GIVEN a coverage past its validity date
- WHEN displayed
- THEN it is flagged as expired and not used as default by later features

### Requirement: Anamnesis is clinical data

Anamnesis (medical history, allergies, medications, relevant antecedents) MUST be stored as clinical data. It MUST be readable and writable only by health professionals under the clinical-access rules in `authorization` (treating professionals through their care relationship, others only under the sharing scope and read-only), and every read and write MUST be audited. Reception and non-clinical admin MUST NOT read it. An authorized user MUST be able to assign a patient explicitly to a professional from Stage 1, before any appointment exists, so that the professional can record the anamnesis (`authorization`).

#### Scenario: Professional edits anamnesis
- GIVEN a professional with access to the patient
- WHEN anamnesis is updated
- THEN the change is saved with a new version and audited

#### Scenario: Anamnesis before the first appointment
- GIVEN a newly registered patient with no appointment
- WHEN reception assigns the patient to professional A
- THEN A can record the anamnesis and the assignment is audited

#### Scenario: Reception views patient
- GIVEN a reception user opens the patient
- WHEN the chart renders
- THEN anamnesis fields are not shown or returned

#### Scenario: Non-clinical admin views patient
- GIVEN a non-clinical owner/admin
- WHEN requesting anamnesis through any path
- THEN access is denied and audited

### Requirement: Safety alerts without clinical detail

The system MUST expose to reception a minimal safety flag (for example "allergy on file"), shown to reception whenever the anamnesis records a condition that needs safe handling, and MUST NOT reveal the clinical detail. The flag is a separate indicator maintained only by the system, recomputed every time a professional saves the anamnesis. No user MAY set or clear it by hand. Reading it MUST NOT require access to the anamnesis content, and it is not governed by the "reception sees clinical metadata" setting.

#### Scenario: Flag only
- GIVEN a patient with an allergy recorded
- WHEN reception views the patient
- THEN only the flag text "see professional" is shown, not the allergy details

#### Scenario: Flag follows the anamnesis
- GIVEN a professional removes the only allergy from the anamnesis
- WHEN the anamnesis is saved
- THEN the flag disappears for reception

#### Scenario: No manual toggle
- GIVEN any user, including a professional or an owner/admin
- WHEN they try to set or clear the safety flag directly
- THEN the system refuses, because the flag follows the anamnesis only

### Requirement: Data-processing consent

At registration, the system MUST capture and store the patient's data-processing consent (Ley 25.326) with timestamp, who recorded it and the consent text version. Consent MUST be revocable and its history preserved. Without recorded consent, the system MUST NOT send marketing or non-essential messages and SHOULD warn staff that consent is missing. Appointment reminders and confirmations are service communications, not non-essential messages: they are governed by the channel opt-out and, for WhatsApp, by the explicit opt-in (`notifications`), not by this consent. Waitlist offers are not service reminders and need their own opt-in (`waitlist`).

#### Scenario: Consent captured
- GIVEN a new patient
- WHEN reception records consent
- THEN timestamp, recorder and text version are stored

#### Scenario: Registration without consent
- GIVEN a patient saved without consent
- WHEN displayed
- THEN a missing-consent warning is shown and non-essential messages are blocked

#### Scenario: Revocation
- GIVEN a patient revokes consent
- WHEN recorded
- THEN the revocation is stored with date, history is preserved, and non-essential messaging stops

### Requirement: Access and rectification rights

The system MUST allow authorized staff to fulfil a patient's request to access and rectify personal data, producing the patient's data in a readable form. Rectification of clinical data MUST follow the immutability rules (corrections, not overwrites). Requests and fulfilment MUST be audited.

#### Scenario: Patient requests a copy
- GIVEN a patient asks for their data
- WHEN a professional of the organization generates it
- THEN a copy of the patient's data is produced and the generation is audited

#### Scenario: Rectify demographics
- GIVEN a patient's address was wrong
- WHEN staff correct it
- THEN the previous value is kept in history and the change audited

### Requirement: No hard deletion; deactivation instead

Patients MUST NOT be hard-deleted. A patient MAY be marked inactive; inactive patients are hidden from default lists but remain searchable by authorized staff and retain all history within the retention period.

#### Scenario: Delete request
- GIVEN a user requests to delete a patient with records
- WHEN processed
- THEN the system refuses deletion and offers deactivation

### Requirement: Patient data changes versioned and audited

Edits to demographics and coverage MUST keep prior values, and MUST record who changed them and when. Patient reads by role beyond a plain list or search SHOULD be audited.

#### Scenario: Edit history
- GIVEN demographics are edited twice
- WHEN history is viewed by authorized staff
- THEN both changes appear with actor and time

### Requirement: Minors and representatives

The system SHOULD allow a patient under legal age to link a guardian/representative contact, and MUST NOT grant the representative data access beyond what later patient-access capabilities define.

#### Scenario: Minor with guardian
- GIVEN a patient under 18
- WHEN reception registers them
- THEN a guardian contact can be recorded as an administrative contact only
