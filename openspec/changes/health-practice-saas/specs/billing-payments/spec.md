# Delta for billing-payments

> Stage 4 (Revenue). New capability. Covers pricing, payers, charge capture, payments, the daily cash register per location and exports. Fiscal documents belong to `e-invoicing-afip`. Reporting belongs to `reports-dashboard`.
> Out of scope: direct electronic claims to obras sociales. Payer portions are tracked and exported only.

## Quick map

| Area | Requirements |
|---|---|
| Pricing | Price catalog, payer coverage pricing, price snapshot |
| Charges | Charge capture, charge lifecycle, voiding |
| Money in | Payments, duplicate protection, refunds |
| Cash | Daily cash register per location, closing, immutability |
| Out | Exports |
| Cross-cutting | Access control, tenant isolation, read-only tenant, privacy, audit, currency, UI language |

## ADDED Requirements

### Requirement: Price catalog per organization

The system MUST let an organization define prices per appointment type. A price MAY vary by professional, specialty, location and payer. Each price MUST have an effective-from date. A private (particular) price MUST always be definable. Currency is ARS.

#### Scenario: Private price applies when no payer is set
- GIVEN an appointment type "Consulta" with a private price of 20000 ARS
- AND a patient with no coverage
- WHEN a charge is captured for that appointment
- THEN the charge amount owed by the patient MUST be 20000 ARS

#### Scenario: Price specific to a professional overrides the general price
- GIVEN a general price of 20000 ARS and a price of 25000 ARS for professional A on the same appointment type
- WHEN a charge is captured for an appointment with professional A
- THEN the 25000 ARS price MUST be used
- AND for an appointment with professional B the 20000 ARS price MUST be used

#### Scenario: Price lookup finds no matching price
- GIVEN an appointment type with no price defined for the patient's payer or private fallback
- WHEN a charge is captured
- THEN the system MUST NOT create a charge with an implied zero amount
- AND the system MUST require a user with billing permission to enter the amount explicitly, and the entry MUST be audited

### Requirement: Payer and plan catalog with coverage pricing

The system MUST maintain a per-organization list of payers (obras sociales and prepagas) and their plans, seeded from the Argentina country pack (`country-rules-ar`). For each payer and plan the organization MUST be able to define, per appointment type, the amount the payer covers and the amount the patient pays as copago, or a plus (surcharge over the payer-covered amount). A payer MAY be deactivated and MUST NOT then be offered for new charges, while historical charges MUST remain intact.

#### Scenario: Copago split
- GIVEN payer "OSDE" plan "210" with a payer-covered amount of 15000 ARS and a copago of 3000 ARS for "Consulta"
- AND a patient with active coverage under that plan
- WHEN a charge is captured for a "Consulta" appointment
- THEN the patient portion MUST be 3000 ARS
- AND the payer portion MUST be 15000 ARS and be tracked as receivable from the payer

#### Scenario: Plus on top of payer coverage
- GIVEN a payer configuration that defines a plus of 5000 ARS
- WHEN a charge is captured for a patient of that payer
- THEN the patient portion MUST include the plus
- AND the plus MUST be shown as a distinct line from any copago

#### Scenario: Deactivated payer
- GIVEN a payer that was deactivated yesterday
- WHEN reception selects a payer for a new charge
- THEN the deactivated payer MUST NOT be selectable
- AND existing charges referencing it MUST still display and export correctly

### Requirement: Price snapshot on charges

When a charge is created, the system MUST store a snapshot of the applied prices, payer, plan, copago and plus. Later changes to the price catalog MUST NOT alter existing charges.

#### Scenario: Price change after capture
- GIVEN a captured charge of 20000 ARS
- WHEN the organization changes the catalog price to 22000 ARS
- THEN the existing charge MUST remain 20000 ARS
- AND new charges MUST use 22000 ARS

### Requirement: Charge capture per appointment

The system MUST allow capturing one charge per billable appointment, made of one or more charge lines. Each charge line MUST record its description, amount, portion (patient or payer) and its invoiced amount, so that invoices can cover lines of one or several charges and a line can be invoiced in parts (`e-invoicing-afip`). A charge MUST reference the appointment, patient, professional, location and payer (or private). Capture MUST be possible from check-in onward, that is, for appointments whose status is "checked in", "in progress" or "attended" (statuses as defined by `scheduling`), so that payment can be collected at the desk before or after the consultation. The system MUST NOT create more than one active charge for the same appointment unless the user explicitly adds lines to the existing charge. The charge's invoicing position (not invoiced, partly invoiced, invoiced) is derived from its lines and is not one of the charge states.

#### Scenario: Charge created at check-in
- GIVEN an appointment in status "checked in"
- WHEN reception captures the charge
- THEN a charge MUST exist in state "pending" referencing the appointment
- AND the captured-by user and timestamp MUST be recorded
- AND the patient can pay before the consultation starts

#### Scenario: Charge created after attendance
- GIVEN an appointment marked "attended"
- WHEN reception captures the charge
- THEN a charge MUST exist in state "pending" referencing the appointment

#### Scenario: Capture before check-in is refused
- GIVEN an appointment in status "scheduled" or "confirmed"
- WHEN a user tries to capture a charge
- THEN the system MUST reject it and indicate that the patient must be checked in first

#### Scenario: Appointment ends without service after charge capture
- GIVEN a charge captured at check-in and the appointment then becomes "no-show" or "cancelled"
- WHEN the status changes
- THEN the charge MUST be flagged for review
- AND it MUST NOT be voided or refunded automatically; an authorized user decides, following the void and refund rules

#### Scenario: No-show is not billable by default
- GIVEN an appointment marked "no-show" with no prior charge
- WHEN reception tries to capture a charge
- THEN the system MUST reject the capture
- AND the organization MAY enable a configurable late-cancellation or no-show fee, in which case the fee MUST appear as an explicit line item

#### Scenario: Double capture
- GIVEN an appointment that already has an active charge
- WHEN a user attempts to capture a second charge for it
- THEN the system MUST reject the new charge and point to the existing one

### Requirement: Charge lifecycle and voiding

A charge MUST be in exactly one state: pending, partially paid, paid, or voided. State MUST derive from recorded payments and refunds. A charge MAY be voided only by a user with permission and a mandatory reason. A voided charge MUST remain visible and MUST NOT be deleted. If an electronic invoice has been issued for the charge, voiding the charge MUST require a credit note issued through `e-invoicing-afip` first.

#### Scenario: Void an unpaid charge
- GIVEN a pending charge with no payments and no invoice
- WHEN an authorized user voids it with a reason
- THEN the charge MUST be in state "voided"
- AND the void MUST be audited with user, timestamp and reason

#### Scenario: Void a charge that has an issued invoice
- GIVEN a charge with an issued electronic invoice
- WHEN a user attempts to void it
- THEN the system MUST refuse until a credit note covering the invoiced amount exists

#### Scenario: Void a charge with payments
- GIVEN a charge with a recorded payment
- WHEN a user voids it
- THEN the system MUST require the payment to be refunded or reassigned first

### Requirement: Payment recording

The system MUST record payments against a charge, with method (cash, debit card, credit card, bank transfer, digital wallet or payment link), amount, date and the user who recorded it. Partial payments and multiple payments per charge MUST be supported. The sum of payments MUST NOT exceed the patient portion of the charge unless the excess is explicitly recorded as a patient credit balance.

#### Scenario: Partial payment
- GIVEN a charge with a patient portion of 10000 ARS
- WHEN reception records 4000 ARS cash
- THEN the charge MUST be "partially paid" with 6000 ARS outstanding

#### Scenario: Overpayment
- GIVEN an outstanding amount of 3000 ARS
- WHEN reception records 5000 ARS
- THEN the system MUST either reject it or require the user to confirm a 2000 ARS credit balance
- AND it MUST NOT silently mark the charge as overpaid

#### Scenario: Payer portion is not a patient payment
- GIVEN a charge with a payer portion
- WHEN the patient pays the full patient portion
- THEN the charge's patient side MUST be settled
- AND the payer portion MUST remain receivable from the payer until settled via the payer settlement process

### Requirement: Duplicate payment protection

The system MUST prevent the same payment from being recorded twice. A submission retried by the client (double click, network retry) MUST be idempotent. Where a payment carries an external reference (for example a transfer or card voucher number), the same reference MUST NOT be accepted twice within an organization without an explicit override that is audited.

#### Scenario: Retried submission
- GIVEN reception submits a 5000 ARS payment and the connection drops before the response
- WHEN the client retries the identical submission
- THEN exactly one payment MUST exist

#### Scenario: Same voucher number entered twice
- GIVEN a payment recorded with voucher "004512"
- WHEN another payment with voucher "004512" is entered
- THEN the system MUST warn and require an explicit, audited override with a reason

### Requirement: Refunds and payment reversals

The system MUST record refunds and payment reversals as separate append-only entries linked to the original payment, with reason, amount and user. A reversal MUST NOT exceed the original payment amount net of earlier reversals. Original payment records MUST NOT be edited or deleted.

#### Scenario: Partial refund
- GIVEN a 10000 ARS payment
- WHEN an authorized user refunds 4000 ARS with a reason
- THEN a refund entry of 4000 ARS MUST exist linked to the payment
- AND the original payment MUST remain unchanged

#### Scenario: Refund exceeds paid amount
- GIVEN a 10000 ARS payment already refunded 8000 ARS
- WHEN a refund of 3000 ARS is attempted
- THEN the system MUST reject it

### Requirement: Daily cash register per location

The system MUST provide a cash register per location. A user with permission MUST be able to open a register with an opening cash amount and close it with the counted cash amount. At most one register MUST be open per location at a time. Cash payments and cash refunds MUST be recorded against the open register of the location where they are taken; if none is open, the system MUST block cash entries and offer to open one. Non-cash payments MUST appear in the register's daily summary by method.

#### Scenario: Open and close the day
- GIVEN no open register at location "Centro"
- WHEN reception opens it with 5000 ARS
- AND records cash payments totalling 30000 ARS
- AND closes it counting 35000 ARS
- THEN expected cash MUST equal 35000 ARS
- AND the difference MUST be 0
- AND the closing MUST record user and timestamp

#### Scenario: Cash payment with no open register
- GIVEN location "Centro" has no open register
- WHEN reception tries to record a cash payment
- THEN the system MUST refuse the cash entry
- AND offer to open the register

#### Scenario: Closing with a difference
- GIVEN an expected cash amount of 35000 ARS
- WHEN reception closes counting 34000 ARS
- THEN the system MUST require a reason for the 1000 ARS difference
- AND the difference MUST be stored with the closing

#### Scenario: Second register at the same location
- GIVEN an open register at location "Centro"
- WHEN another user tries to open one at "Centro"
- THEN the system MUST refuse

### Requirement: Closed register immutability

A closed cash register and the entries it contains MUST NOT be edited or deleted. Corrections MUST be made as adjustment entries (reversal plus new entry) in the currently open register, linked to the original entry with a reason.

#### Scenario: Correction after close
- GIVEN a closed register containing a payment recorded with the wrong amount
- WHEN an authorized user corrects it
- THEN a reversal and a corrected entry MUST be created in the open register
- AND the closed register MUST remain unchanged

### Requirement: Exports

The system MUST export charges, payments and payer-receivable portions for a chosen period, location, professional and payer, in a spreadsheet-compatible format and as a printable document. A payer settlement export MUST list the payer portions grouped by payer, with patient identifier (DNI), appointment date, service and amount, so the organization can bill the payer outside the system. Exports MUST NOT contain clinical content (notes, diagnoses, prescriptions). Every export MUST be audited with user, filters and timestamp.

#### Scenario: Payer settlement export
- GIVEN charges for payer "OSDE" in March
- WHEN an authorized user exports the settlement for March
- THEN the file MUST include only OSDE payer portions for March
- AND it MUST NOT include any clinical note content

#### Scenario: Empty period
- GIVEN no charges match the filters
- WHEN the user requests an export
- THEN the system MUST show an explicit empty state and MUST NOT produce a misleading blank file

### Requirement: Billing access control

Billing access MUST be enforced on the server according to `authorization`. Reception and owner/admin MUST be able to capture charges, record payments and operate the cash register (reception within its assigned locations, see `authorization`). A professional MUST see charges and payments of their own appointments only, and MUST NOT operate the cash register unless the cash-register permission is granted to them through `authorization`. Voiding, refunds and price catalog changes MUST be restricted to owner/admin by default. A patient MUST see only their own charges and receipts through `patient-portal`. No billing screen or API MUST expose clinical note content.

#### Scenario: Professional views another professional's revenue
- GIVEN professional A and professional B in the same organization
- WHEN professional A requests B's charges
- THEN the system MUST deny the request

#### Scenario: Reception cannot void or change prices by default
- GIVEN a reception user
- WHEN they attempt to void a paid charge or edit the price catalog
- THEN the system MUST deny the action and audit the denial

### Requirement: Tenant isolation and multi-specialty support

All billing data MUST belong to exactly one organization and MUST be unreachable from any other organization. Organization and user identity MUST come only from the authenticated session. Pricing MUST support organizations with several specialties and locations without cross-effects between them.

#### Scenario: Cross-tenant charge access
- GIVEN a charge in organization X
- WHEN a user authenticated in organization Y requests it by identifier
- THEN the system MUST respond as if it does not exist

### Requirement: Read-only tenant behavior

When the tenant is read-only due to non-payment (`subscriptions`), the system MUST block creating or changing charges, payments and registers, following the shared allowlist in `tenancy`. Viewing and exporting existing billing data MUST remain available. Submission to AFIP of invoices already queued is allowed (`e-invoicing-afip`).

#### Scenario: Grace period expired
- GIVEN a tenant in read-only state
- WHEN reception tries to record a payment
- THEN the system MUST refuse with a message explaining the account state
- AND exporting last month's charges MUST still work

### Requirement: Audit and privacy of financial data

Creation, change, voiding, refund, override, cash register open/close and export actions MUST be recorded in the `audit-log` with actor, organization, timestamp and affected record. Payment records MUST NOT store full card numbers. Patient financial data MUST be handled as personal data under Ley 25.326 and MUST be encrypted in transit and at rest.

#### Scenario: Audit of a refund
- GIVEN an authorized user refunds a payment
- WHEN the refund is saved
- THEN an audit entry MUST exist with actor, payment, amount, reason and timestamp

### Requirement: Argentine currency and presentation

Amounts MUST be stored and calculated in ARS with two-decimal precision and a deterministic rounding rule. All user-visible copy for billing MUST be Spanish (es-AR), including number and date formats (for example `1.234,50` and `dd/mm/yyyy`), using externalized strings.

#### Scenario: Amount formatting
- GIVEN a charge of 1234.5 ARS
- WHEN it is displayed in the UI
- THEN it MUST appear as "$ 1.234,50"
