# Delta for informed-consent

> Stage 5 (Clinical compliance). New capability. Versioned consent templates and patient signatures. Distinct from the data-processing consent (Ley 25.326) captured by `patients`.

## Quick map

| Area | Requirements |
|---|---|
| Templates | Authoring, versioning, publishing |
| Signing | Request, signature capture, legal representatives, evidence |
| Lifecycle | Immutability, revocation |
| Access | Visibility rules, portal, audit |
| Cross-cutting | Tenant isolation, retention, read-only tenant, language |

## ADDED Requirements

### Requirement: Consent template authoring

An organization MUST be able to create consent templates with a title, body text, and optional association with a specialty or appointment type. Template management MUST be restricted to owner/admin and professionals. The system MAY provide starter templates per specialty. Templates MUST be scoped to the organization.

#### Scenario: Create a template
- GIVEN an admin
- WHEN they create a template for "Dental extraction"
- THEN it MUST be saved as draft until published

#### Scenario: Reception cannot author
- GIVEN a reception user
- WHEN they try to create or edit a template
- THEN the system MUST deny the action

### Requirement: Template versioning

Publishing a template MUST create an immutable numbered version. A published version MUST NOT be edited. Changing a template MUST create a new version. Previous versions MUST be retained. Only the latest published version MUST be offered for new signatures, but earlier versions MUST remain viewable.

#### Scenario: Edit after publishing
- GIVEN version 1 of a template is published and signed by patients
- WHEN an admin edits the template
- THEN version 2 MUST be created
- AND version 1 and its signatures MUST remain unchanged

#### Scenario: Retire a template
- GIVEN a template no longer in use
- WHEN an admin retires it
- THEN it MUST NOT be offered for new signatures
- AND existing signed consents MUST remain intact

### Requirement: Requesting a consent

A professional or reception user MUST be able to request a consent from a patient for a template, optionally tied to an appointment or encounter. The request MUST support signing in person on the organization's device and signing remotely via the patient portal. A request MUST have a state: pending, signed, declined, expired or revoked.

#### Scenario: Remote request
- GIVEN a patient with portal access
- WHEN a professional requests a consent
- THEN the consent MUST appear as pending in the portal
- AND any notification MUST be an email and contain no clinical content, including no template title

#### Scenario: Request expires
- GIVEN a pending request with an expiry date in the past
- WHEN the patient opens it
- THEN the system MUST show it as expired and MUST NOT allow signing

### Requirement: Signature capture and binding

A signature MUST bind to the exact template version shown to the signer. At signing the system MUST display the full text of that version and MUST require an explicit acceptance action. The system MUST record signer identity (patient or legal representative), template version, timestamp, signing method and signing context evidence, and MUST generate a content fingerprint of the signed document to prove it was not altered. A signed consent MUST be rendered as a printable document with the signature and evidence.

#### Scenario: In-person signature
- GIVEN a patient present at reception
- WHEN they review version 3 of a template and sign on the device
- THEN the record MUST reference version 3 with the signature, timestamp and fingerprint

#### Scenario: Template changed while the patient is signing
- GIVEN a patient opened version 2 and a version 3 was published meanwhile
- WHEN they submit the signature
- THEN the signature MUST bind to version 2, as shown to them

#### Scenario: Signature without reading
- GIVEN the signing screen
- WHEN the patient submits without the explicit acceptance action
- THEN the system MUST reject the signature

### Requirement: Minors, incapacitated patients and representatives

For minors or patients who cannot consent, the system MUST support signing by a legal representative, recording the representative's name, DNI and relationship. The system MUST NOT mark such a consent as signed by the patient.

#### Scenario: Minor patient
- GIVEN a patient flagged as a minor
- WHEN a consent is requested
- THEN the signing flow MUST require representative data

### Requirement: Immutability of signed consents

A signed consent MUST NOT be edited or deleted. Any correction MUST be made by a new request and signature. The signed document and its evidence MUST be retained for at least 10 years after the patient's last encounter.

#### Scenario: Edit attempt
- GIVEN a signed consent
- WHEN any user tries to change its content
- THEN the system MUST refuse

### Requirement: Revocation

A patient or legal representative MUST be able to revoke a signed consent, and a professional MUST be able to record a revocation requested in person. Revocation MUST be stored as a new event with date, actor and optional reason, linked to the original signed consent. The original MUST NOT be altered or removed. A revoked consent MUST NOT be treated as valid for any later procedure, and the system MUST warn professionals when a procedure requires a valid consent that is revoked. Revocation MUST NOT undo procedures that were already performed.

#### Scenario: Patient revokes from the portal
- GIVEN a patient with a signed consent
- WHEN they revoke it in the portal
- THEN the consent MUST show state "revoked" with the date
- AND the signed original and its evidence MUST remain stored

#### Scenario: Procedure scheduled after revocation
- GIVEN a revoked consent required for an appointment type
- WHEN the professional opens that appointment
- THEN the system MUST show a warning that no valid consent exists

#### Scenario: Revocation recorded in person
- GIVEN a patient revokes verbally at reception
- WHEN a professional records it with a reason
- THEN the event MUST be stored with the recording user identified

### Requirement: Visibility and access control

Signed consent content MUST be readable by the treating professionals (under the visibility model and sharing rules of `authorization`) and by the patient or their legal representative. A template title linked to a specific patient can reveal clinical information (for example a title naming a procedure or a test), so it MUST be treated as clinical metadata. Reception and non-clinical admin MAY see the status of a patient's consents (pending, signed, revoked, expired) and dates under a neutral label such as "Consent", and MUST NOT see the template title, any clinical details written into the consent, or the template text linked to the patient. Reception MAY additionally see the template title only when the organization setting "reception sees clinical metadata" (`authorization`) is on; a non-clinical admin never does. A patient MUST see only their own consents. Every read of a signed consent MUST be audited. Template authoring screens, which are not linked to a patient, are unaffected.

#### Scenario: Reception sees status only
- GIVEN a reception user viewing a patient file and the setting "reception sees clinical metadata" is off
- WHEN they open the consent list
- THEN status and dates MUST be shown under a neutral label
- AND the template title and procedure-specific clinical details MUST NOT be shown

#### Scenario: Title shown when the setting is on
- GIVEN the setting is on
- WHEN reception opens the same consent list
- THEN the template title is also shown
- AND the signed content still cannot be opened

#### Scenario: Admin never sees titles
- GIVEN a non-clinical owner/admin and the setting is on
- WHEN they view a patient's consent list
- THEN only the neutral label, status and dates are shown

#### Scenario: Patient views another patient's consent
- GIVEN patient P1 signed in to the portal
- WHEN they request a consent of P2
- THEN the system MUST respond as if it does not exist

### Requirement: Audit and tenant isolation

Template changes, requests, signatures, revocations, expirations and reads MUST be recorded in `audit-log`. Templates, signatures and evidence MUST be isolated by organization and encrypted at rest and in transit.

#### Scenario: Audit of a signature
- GIVEN a patient signs a consent
- WHEN the signature is stored
- THEN an audit entry MUST exist with patient, template version, method and timestamp

### Requirement: Read-only tenant, export and language

When the tenant is read-only (`subscriptions`, allowlist in `tenancy`), creating new templates and requests MUST be blocked, but reading and exporting existing consents MUST remain possible. Patients MUST still be able to revoke a consent in that state, because consent revocation is a patient-protective write. Signed consents MUST be included in the patient record export and in the clinical part of the tenant cancellation export (`tenancy`). All UI copy and template text defaults MUST be Spanish (es-AR).

#### Scenario: Read-only tenant and revocation
- GIVEN a tenant in read-only state
- WHEN a patient revokes a consent from the portal
- THEN the revocation MUST be accepted and recorded
