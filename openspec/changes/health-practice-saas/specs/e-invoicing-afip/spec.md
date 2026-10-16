# Delta for e-invoicing-afip

> Stage 4 (Revenue). New capability. AFIP electronic invoices (factura electronica) and credit notes with CAE, behind the Argentina country pack (`country-rules-ar`). Charges and payments are owned by `billing-payments`.
> Fallback required by the proposal: manual invoice entry when AFIP is unavailable or not yet configured.

## Quick map

| Area | Requirements |
|---|---|
| Setup | Fiscal configuration, environments, certificate lifecycle |
| Issue | Invoice type selection, issuing with CAE, recipient rules |
| Correct | Immutability, credit notes, voided/rejected invoices |
| Resilience | AFIP outage, retries without duplicates, manual fallback |
| Output | Invoice document, patient delivery |
| Cross-cutting | Access control, privacy, audit, read-only tenant, UI language |

## ADDED Requirements

### Requirement: Fiscal configuration per organization

An organization MUST be able to configure its fiscal identity: CUIT, tax condition (monotributista, responsable inscripto, or exento), business name, fiscal address, start-of-activities date and one or more points of sale. Invoicing MUST be unavailable until the configuration is complete and validated. The CUIT MUST be validated by the country pack check digit rule. Each point of sale MUST be associated with its own environment, homologation or production; the environment is a property of the point of sale, not of the organization, so one organization MAY have a point of sale in homologation and another in production. The environment MUST be explicit and visible on every invoice screen.

#### Scenario: Incomplete configuration
- GIVEN an organization with no point of sale configured
- WHEN a user tries to issue an invoice
- THEN the system MUST block issuing and direct the owner to complete the fiscal configuration

#### Scenario: Invalid CUIT
- GIVEN an owner enters a CUIT with an invalid check digit
- WHEN they save
- THEN the system MUST reject it with a validation message

#### Scenario: Homologation labeling
- GIVEN a point of sale in homologation
- WHEN an invoice is issued
- THEN the invoice and UI MUST be clearly marked as test and MUST NOT be presentable as a valid fiscal document

#### Scenario: Environment per point of sale
- GIVEN point of sale 1 in production and point of sale 2 in homologation
- WHEN a user issues an invoice through point of sale 2
- THEN it is sent to the homologation service and marked as test
- AND invoices of point of sale 1 are unaffected

### Requirement: Fiscal credentials lifecycle

The system MUST store the organization's AFIP certificate and key securely and MUST NOT expose them to any user after upload, including owner/admin. The system MUST warn the owner at least 30 days before certificate expiry and MUST report the credential state (valid, expiring, expired, invalid). Authorization to AFIP services MUST be limited to the organization's own CUIT.

#### Scenario: Certificate near expiry
- GIVEN a certificate expiring in 20 days
- WHEN the owner opens the invoicing settings or dashboard
- THEN a warning with the expiry date MUST be visible

#### Scenario: Expired certificate
- GIVEN an expired certificate
- WHEN a user tries to issue an invoice
- THEN the system MUST block the attempt with a message identifying the credential problem
- AND the manual entry fallback MUST be offered

### Requirement: Invoice type selection

The system MUST select the invoice type from the issuer's tax condition and the recipient's tax condition, following the rules in the country pack. A monotributista issuer MUST issue Factura C. A responsable inscripto issuer MUST issue Factura A to a recipient responsable inscripto and Factura B to other recipients. Users MUST NOT be able to select a type that the rules forbid for the issuer.

#### Scenario: Monotributista issues Factura C
- GIVEN an organization whose tax condition is monotributista
- WHEN a user issues an invoice for a private patient
- THEN the invoice type MUST be Factura C

#### Scenario: Responsable inscripto to a company
- GIVEN an organization that is responsable inscripto
- AND a recipient with a CUIT registered as responsable inscripto
- WHEN an invoice is issued
- THEN the invoice type MUST be Factura A

#### Scenario: Responsable inscripto to a consumer
- GIVEN an organization that is responsable inscripto and a recipient who is a consumer final
- WHEN an invoice is issued
- THEN the invoice type MUST be Factura B

#### Scenario: Forbidden type
- GIVEN a monotributista organization
- WHEN a user tries to force Factura A
- THEN the system MUST refuse

### Requirement: Recipient identification

The system MUST require the recipient data needed by the invoice type: CUIT and tax condition for Factura A, and name plus document number where AFIP rules require identification for Factura B or C. A payer (obra social or prepaga) MAY be the recipient for its payer portion, using the payer's CUIT from the catalog. The invoice MUST be issued to the person or entity that actually owes the amount.

#### Scenario: Missing recipient CUIT for Factura A
- GIVEN a Factura A is required
- WHEN the recipient has no CUIT
- THEN the system MUST refuse issuing and request the missing data

#### Scenario: Invoice to a payer
- GIVEN a charge with a payer portion
- WHEN the organization invoices the payer portion
- THEN the recipient MUST be the payer and the amount MUST equal the payer portion only

### Requirement: Issuing an invoice with CAE

The system MUST allow issuing an invoice for a charge or a set of charge lines (`billing-payments`) with a positive amount. An invoice is made of invoice lines; each invoice line references a charge line and an amount, so one invoice MAY cover lines from several charges of the same recipient and one charge line MAY be invoiced across several invoices (for example partially, or the patient portion and the payer portion to different recipients). On successful AFIP authorization the invoice MUST store the CAE, the CAE expiry date, the point of sale and the assigned invoice number, and MUST be in state "issued". The invoiced amount of a line MUST NOT exceed the not-yet-invoiced amount of the referenced charge line.

An invoice (and each credit note) MUST be in exactly one of these states: **pending** (submitted or queued, not yet authorized), **issued** (authorized, with CAE), **rejected** (refused by AFIP, no CAE) and **manual** (registered from outside the system). While pending, internal retry progress (queued, retrying, awaiting reconciliation with AFIP) is a documented sub-state of pending and MUST NOT be presented to users or counted in reports as a separate state.

#### Scenario: Successful issuance
- GIVEN a paid charge of 20000 ARS and valid fiscal configuration
- WHEN a user issues the invoice
- THEN the invoice MUST have a CAE and number
- AND the charge MUST show as invoiced

#### Scenario: Over-invoicing attempt
- GIVEN a charge of 20000 ARS already invoiced for 20000 ARS
- WHEN a user attempts another invoice for the same lines
- THEN the system MUST refuse

#### Scenario: One invoice for lines of two charges
- GIVEN two charges of the same patient on the same day, each with one 10000 ARS line
- WHEN a user issues one invoice referencing both lines
- THEN a single invoice of 20000 ARS exists with two invoice lines
- AND both charges show their lines as invoiced

#### Scenario: One line invoiced in two parts
- GIVEN a 20000 ARS charge line
- WHEN a first invoice of 12000 ARS and a second of 8000 ARS reference it
- THEN the line is fully invoiced and a third invoice for it is refused

#### Scenario: Retry progress is not a separate state
- GIVEN an invoice in the pending state that is being retried
- WHEN the pending list is shown
- THEN it is listed as "pending" with its age
- AND no separate retry state is shown to the user

### Requirement: Invoice immutability

An issued invoice MUST NOT be edited or deleted. Its amounts, recipient, lines and fiscal numbers MUST be preserved indefinitely and for at least the legal retention period. Corrections MUST be made only through credit notes.

#### Scenario: Attempt to edit
- GIVEN an issued invoice
- WHEN any user attempts to modify its amount or recipient
- THEN the system MUST refuse the change
- AND offer the credit note flow

### Requirement: Credit notes

The system MUST issue credit notes (Nota de Credito) of the matching type (A, B or C) linked to the original invoice, with its own CAE and number. A credit note MAY be partial or total. The cumulative credited amount MUST NOT exceed the original invoice amount. A reason MUST be required. Issuing a credit note MUST update the related charge's invoiced balance and MUST be restricted to owner/admin by default.

#### Scenario: Total credit note
- GIVEN an issued Factura C of 20000 ARS
- WHEN the admin issues a total credit note with a reason
- THEN a Nota de Credito C of 20000 ARS referencing the invoice MUST exist with its own CAE
- AND the original invoice MUST remain unchanged

#### Scenario: Cumulative limit
- GIVEN an invoice of 20000 ARS with an earlier credit note of 15000 ARS
- WHEN a credit note of 8000 ARS is attempted
- THEN the system MUST refuse

#### Scenario: Reception cannot issue credit notes
- GIVEN a reception user
- WHEN they attempt to issue a credit note
- THEN the system MUST deny it and audit the denial

### Requirement: Voided and rejected invoices

An invoice that AFIP rejects MUST NOT be treated as issued. It MUST be kept as a rejected attempt with the AFIP error message, MUST NOT carry a CAE, and MUST NOT count in reports or fiscal totals. A user MUST be able to correct the data and retry, creating a new attempt linked to the previous one. An invoice already authorized with a CAE MUST NOT be "voided"; only a credit note cancels its effect.

#### Scenario: AFIP rejects the invoice
- GIVEN an invoice request with an invalid recipient CUIT
- WHEN AFIP rejects it
- THEN the attempt MUST be stored as "rejected" with the reason
- AND the charge MUST remain not invoiced

#### Scenario: Attempt to void an authorized invoice
- GIVEN an invoice with a CAE
- WHEN a user attempts to delete or void it
- THEN the system MUST refuse and offer a credit note

### Requirement: AFIP outage handling and no duplicate issuance

When AFIP services are unavailable, time out, or return an indeterminate result, the system MUST keep the request in a "pending" state in a retry queue, MUST inform the user that the invoice is not yet issued, and MUST retry automatically with back-off. Before retrying an indeterminate attempt, the system MUST check with AFIP whether the invoice number was already authorized, so that the same invoice is never issued twice. Invoice numbers MUST be assigned in the sequence required by AFIP for each point of sale and type. Pending invoices MUST be visible in a list with their age.

#### Scenario: AFIP is down at issuance
- GIVEN AFIP is unreachable
- WHEN reception requests an invoice
- THEN the invoice MUST be saved as "pending"
- AND the user MUST be told it will be issued when the service recovers
- AND payment and cash register operations MUST NOT be blocked

#### Scenario: Timeout with unknown outcome
- GIVEN a request timed out and AFIP may have authorized it
- WHEN the retry runs
- THEN the system MUST first query AFIP for the last authorized number and reconcile
- AND MUST NOT create a second invoice for the same request

#### Scenario: Prolonged outage
- GIVEN a pending invoice older than a configured threshold
- WHEN the owner views the invoicing dashboard
- THEN the system MUST flag it and offer the manual entry fallback

### Requirement: Manual invoice entry fallback

When AFIP issuance is disabled for the organization, not configured, or has failed beyond the configured threshold, an owner/admin MUST be able to register an invoice issued outside the system, entering type, point of sale, number, CAE, date, recipient and amount. Only owner/admin MAY enter a CAE manually; reception and professionals MUST NOT, even if they can issue invoices through AFIP. Manually registered invoices MUST be in the state "manual", MUST be immutable once saved, and MUST be validated for format and uniqueness of type, point of sale and number within the organization.

#### Scenario: Register an invoice issued in the AFIP web tool
- GIVEN AFIP integration has failed for the day
- WHEN the admin registers an externally issued invoice with number and CAE
- THEN the invoice MUST be stored in the state "manual" and linked to the charge lines

#### Scenario: Reception cannot enter a CAE
- GIVEN a reception user
- WHEN they try to register a manual invoice with a CAE
- THEN the system MUST deny it and audit the denial

#### Scenario: Duplicate manual number
- GIVEN a manual entry with a type, point of sale and number that already exists
- WHEN the admin saves
- THEN the system MUST reject it

### Requirement: Invoice document and delivery

The system MUST generate a printable invoice document containing the fiscal data required by AFIP, including CAE, CAE expiry and the QR code. The invoice description MUST use generic service wording (for example "Consulta profesional") and MUST NOT contain diagnoses or clinical details. The patient MUST be able to download their own invoices from `patient-portal`. Messages that deliver invoices MUST be sent by email only (WhatsApp is reserved for appointment reminders and waitlist offers) and MUST contain no clinical content.

#### Scenario: Invoice content privacy
- GIVEN an invoice generated for a psychology appointment
- WHEN the document is produced
- THEN the lines MUST show only the generic service description configured for the appointment type
- AND no clinical note content or diagnosis MUST appear

#### Scenario: Patient downloads own invoice
- GIVEN a patient signed in to the portal
- WHEN they open their invoices
- THEN only invoices addressed to them MUST be listed

### Requirement: Access control and audit

Issuing invoices MUST be allowed to owner/admin and reception. Fiscal configuration, credential upload, credit notes and manual entries MUST be restricted to owner/admin. All issuance attempts, rejections, retries, credit notes, manual entries and configuration changes MUST be recorded in `audit-log`. Each organization's invoices MUST be isolated from every other organization, including numbering and credentials.

#### Scenario: Audit of issuance
- GIVEN an invoice is issued
- WHEN the operation completes
- THEN an audit entry MUST exist with actor, charge, invoice number, outcome and timestamp

#### Scenario: Cross-tenant credential use
- GIVEN organization X and organization Y
- WHEN a request is made in X's session
- THEN only X's CUIT and credentials MUST be used

### Requirement: Read-only tenant and feature control

When the tenant is read-only (`subscriptions`), issuing new invoices and credit notes MUST be blocked, while viewing and downloading existing invoices MUST remain available. Pending invoices already queued before the tenant became read-only MUST still be submitted to AFIP and reconciled, so that already-recorded fiscal obligations are not lost (this is part of the read-only allowlist in `tenancy`). E-invoicing MUST be enable-able per organization and disabling it MUST NOT affect existing invoices.

#### Scenario: Read-only tenant
- GIVEN a read-only tenant
- WHEN reception tries to issue an invoice
- THEN the system MUST refuse
- AND existing invoices MUST still be downloadable

#### Scenario: Queued invoice still submitted
- GIVEN an invoice in the pending state queued before the tenant became read-only
- WHEN the retry job runs while the tenant is read-only
- THEN it is submitted to AFIP and ends as issued or rejected

### Requirement: Language

All UI copy and generated documents related to invoicing MUST use Spanish (es-AR) with the official AFIP terminology.

#### Scenario: Error message
- GIVEN AFIP returns an error
- WHEN it is shown to the user
- THEN the user-facing message MUST be in Spanish and MUST NOT expose credentials or internal identifiers
