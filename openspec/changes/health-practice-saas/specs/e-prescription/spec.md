# Delta for e-prescription

> Stage 5 (Clinical compliance). New capability. Prescriptions under Ley 27.553, issued through an authorized e-prescription provider behind the Argentina country pack (`country-rules-ar`). The system never acts as its own prescription authority.
> Interim fallback from the proposal: external provider links, as in the legacy app.

## Quick map

| Area | Requirements |
|---|---|
| Who may prescribe | Verified matrícula (verified by the platform operator), provider connection |
| Issue | Prescription content, issuing, lifecycle |
| Correct | Immutability, cancellation |
| Resilience | Provider outage, interim fallback |
| Delivery | Patient access, message privacy |
| Cross-cutting | Clinical access, audit, tenant isolation, retention, language |

## ADDED Requirements

### Requirement: Prescriber eligibility

Only a professional with a verified matrícula (national or provincial registration) whose profile permits prescribing MUST be able to issue a prescription. A recorded but unverified matrícula is enough for clinical work in general (`staff-professionals`) but is not enough to prescribe. The verification state is set only by the platform operator, never by the professional or by an owner/admin, MUST come from `staff-professionals` and MUST be checked at the moment of issuing. Owner/admin and reception users who are not health professionals MUST NOT be able to create, issue or read prescriptions. A user who is both owner and professional MUST prescribe only through their professional role, and owner status MUST NOT help them become verified.

#### Scenario: Verified professional prescribes
- GIVEN a professional with a verified matrícula
- WHEN they start a prescription for a patient
- THEN the prescription form MUST be available

#### Scenario: Professional without verified matrícula
- GIVEN a professional whose matrícula is recorded but unverified
- WHEN they try to issue a prescription
- THEN the system MUST refuse
- AND MUST explain that matrícula verification by the platform is required
- AND the professional's other clinical work is unaffected

#### Scenario: Matrícula reset after edit
- GIVEN a professional whose verified matrícula number was changed
- WHEN they try to issue a prescription
- THEN the system MUST refuse until the platform verifies it again

#### Scenario: Non-clinical admin
- GIVEN a non-clinical owner/admin
- WHEN they open prescriptions or call the prescription API
- THEN the system MUST deny access and audit the denial

### Requirement: Authorized provider connection

The system MUST issue prescriptions only through an authorized e-prescription provider. Each organization (or each professional, as the provider requires) MUST complete the provider registration before issuing. Provider credentials MUST be stored securely and MUST NOT be visible to users after saving. The feature MUST be enable-able per organization.

#### Scenario: Provider not connected
- GIVEN an organization that has not configured the provider
- WHEN a professional tries to issue a prescription
- THEN the system MUST block issuing and direct them to the setup, or show the interim external link where enabled

### Requirement: Prescription content

A prescription MUST be linked to a patient and an encounter context when available, and MUST include the data the provider requires: patient identification (full name, DNI, coverage if any), prescriber identification (name, matrícula, specialty), date, and one or more medications identified by generic name (international nonproprietary name), with dose, form, quantity and instructions. The system MUST validate required fields before submitting. The system MUST NOT issue a prescription for a patient who is not registered in the organization.

#### Scenario: Missing required field
- GIVEN a draft prescription without a quantity
- WHEN the professional submits
- THEN the system MUST reject it and point to the missing field

#### Scenario: Patient coverage included
- GIVEN a patient with active payer coverage
- WHEN the prescription is created
- THEN the coverage data MUST be pre-filled for the provider if the provider supports it

### Requirement: Issuing and status lifecycle

On successful submission the provider MUST return an identifier, and the prescription MUST be stored with that identifier, the issue date and the status "issued". The system MUST reflect provider-reported status changes (for example dispensed, expired, cancelled) when the provider makes them available. A prescription MUST have exactly one status at a time.

#### Scenario: Successful issue
- GIVEN a valid draft
- WHEN the professional signs and submits it
- THEN the prescription MUST be "issued" with the provider identifier
- AND it MUST appear in the patient's prescription list

#### Scenario: Provider reports dispensed
- GIVEN an issued prescription
- WHEN the provider reports it as dispensed
- THEN the system MUST show the status "dispensed"

### Requirement: Immutability and cancellation

An issued prescription MUST NOT be edited. A mistaken prescription MUST be cancelled through the provider with a mandatory reason, and a new prescription MAY be issued. Cancelled prescriptions MUST remain visible with their reason. Prescriptions MUST NOT be hard-deleted.

#### Scenario: Edit attempt
- GIVEN an issued prescription
- WHEN the professional tries to change a dose
- THEN the system MUST refuse and offer cancel and reissue

#### Scenario: Cancellation fails at provider
- GIVEN the provider rejects the cancellation
- WHEN the professional attempts it
- THEN the prescription MUST remain "issued"
- AND the error MUST be shown

### Requirement: Provider outage handling

When the provider is unavailable or returns an indeterminate result, the system MUST keep the prescription as a "draft" or "pending submission", MUST NOT show it as issued, and MUST NOT present any locally generated document as a valid prescription. The system MUST allow retry. Before retrying an indeterminate submission the system MUST check the provider so the same prescription is never issued twice. Where enabled, the system MAY offer the interim fallback of opening the provider's website to issue manually, and the professional MAY then register the resulting prescription identifier.

#### Scenario: Provider down
- GIVEN the provider is unreachable
- WHEN the professional submits
- THEN the prescription MUST stay pending and not be issued
- AND the professional MUST see a clear message and a retry action

#### Scenario: Timeout with unknown outcome
- GIVEN a submission timed out
- WHEN the professional retries
- THEN the system MUST reconcile with the provider first
- AND MUST NOT issue a duplicate

#### Scenario: Manual fallback registration
- GIVEN the professional issued the prescription directly in the provider's website
- WHEN they register its identifier
- THEN the prescription MUST be stored flagged "registered manually"

### Requirement: Clinical access rules

Prescriptions are clinical data. Prescription content MUST be readable only by the prescribing professional and the patient's other treating professionals (care relationship, `authorization`). Prescriptions MUST NOT follow organization sharing (D17): a professional who neither prescribed nor treats the patient MUST NOT read them, whatever the sharing setting or shared scope. Reception MUST NOT read prescription content, though reception MAY see that a prescription exists only if the organization setting "reception sees clinical metadata" is on. A platform operator MUST have no default access.

#### Scenario: Reception cannot read content
- GIVEN a reception user viewing a patient file
- WHEN they open the prescriptions area
- THEN medication names and instructions MUST NOT be shown

#### Scenario: Treating professional reads
- GIVEN professional B did not prescribe but has an appointment with the patient and sharing is off
- WHEN B requests the prescription
- THEN the system MUST grant read access

#### Scenario: Sharing disabled and no relationship
- GIVEN professional C did not prescribe, has no care relationship with the patient and sharing is off
- WHEN C requests the prescription
- THEN the system MUST deny access

#### Scenario: Sharing enabled and no relationship
- GIVEN the organization enabled sharing with every template in the shared scope
- AND professional C did not prescribe and has no care relationship with the patient
- WHEN C requests the prescription
- THEN the system MUST deny access and audit the denial

### Requirement: Patient access and delivery

The patient MUST be able to view and download their issued prescriptions from `patient-portal`. Any notification about a prescription MUST be sent by email only (WhatsApp is reserved for appointment reminders and waitlist offers), MUST contain no clinical content (no medication names or diagnoses) and MUST only inform that a document is available and link to the authenticated portal. Download links MUST be valid for 5 minutes and tied to the authenticated portal session of the patient (see `documents`).

#### Scenario: Notification text
- GIVEN a prescription is issued
- WHEN the patient is notified
- THEN the notification is an email saying a document is available
- AND MUST NOT include medication names
- AND no WhatsApp message is sent

#### Scenario: Another patient's prescription
- GIVEN patient P1 signed in
- WHEN P1 requests a prescription of patient P2
- THEN the system MUST respond as if it does not exist

### Requirement: Audit, retention and tenant isolation

Issuing, cancelling, viewing, downloading and failed attempts MUST be recorded in `audit-log`. Prescriptions and their audit trail MUST be retained for at least 10 years after the patient's last encounter and MUST be included in the tenant cancellation export. Prescription data MUST be isolated by organization and encrypted in transit and at rest.

#### Scenario: Audit of a read
- GIVEN a professional opens a prescription
- WHEN the view completes
- THEN an audit entry MUST exist with actor, patient, prescription and timestamp

### Requirement: Read-only tenant and language

When the tenant is read-only (`subscriptions`, allowlist in `tenancy`), issuing and cancelling prescriptions MUST be blocked, while professionals MUST still be able to read and export existing prescriptions. All UI copy MUST be Spanish (es-AR).

#### Scenario: Read-only tenant
- GIVEN a tenant in read-only state
- WHEN a professional tries to issue a prescription
- THEN the system MUST refuse
- AND reading existing prescriptions MUST still work
