# Delta for reports-dashboard

> Stage 4 (Revenue). New capability. Operational and financial reports with charts. Reports are read-only views over data owned by other capabilities.

## Quick map

| Area | Requirements |
|---|---|
| Content | Operational reports, financial reports, no-show rate |
| Behavior | Filters, consistency with sources, charts with tables, empty/error states |
| Safety | Role scoping, no clinical content, tenant isolation, audit |
| Output | Export |

## ADDED Requirements

### Requirement: Operational reports

The system MUST provide reports on appointments per period, location, professional and specialty, including counts by appointment status (pending approval, scheduled, confirmed, checked in, in progress, attended, no-show, cancelled, exactly as defined in `scheduling`), occupancy of available slots, new versus returning patients, and slots recovered through the waitlist. "Rescheduled" is not a status: the report MAY show a separate count of appointments that were rescheduled, derived from appointment history. The no-show rate MUST be shown as no-show appointments divided by the sum of attended and no-show appointments in the period (no-show / (attended + no-show)). Cancelled appointments, and appointments not yet in a final attendance state, MUST be excluded from both numerator and denominator.

#### Scenario: No-show rate
- GIVEN 88 attended and 12 no-show appointments in a month
- WHEN an admin opens the operational report for that month
- THEN the no-show rate MUST be shown as 12%

#### Scenario: Cancellations do not affect the rate
- GIVEN the same month also has 30 cancelled appointments
- WHEN the operational report is generated
- THEN the no-show rate is still 12%
- AND the 30 cancellations are shown in their own count

#### Scenario: Rescheduled appointments are derived
- GIVEN 10 appointments that were moved during the month and are now attended
- WHEN the report is generated
- THEN they count as attended in the status counts
- AND the separate "rescheduled" figure shows 10, derived from history

#### Scenario: Appointments not yet in a final state
- GIVEN appointments in the period still in "scheduled" state in the past
- WHEN the report is generated
- THEN those appointments MUST be excluded from the rate
- AND the report MUST indicate how many were excluded

### Requirement: Financial reports

The system MUST provide reports on charged amounts, collected amounts, outstanding amounts and payer receivables, grouped by period, location, professional, payer and appointment type. Figures MUST be derived from `billing-payments` records and MUST reflect refunds and credit notes (`e-invoicing-afip`) as reductions.

#### Scenario: Credit note reduces invoiced total
- GIVEN invoices totalling 100000 ARS and a credit note of 20000 ARS in the same month
- WHEN the financial report is generated
- THEN net invoiced MUST be 80000 ARS

#### Scenario: Voided charge excluded
- GIVEN a voided charge of 20000 ARS
- WHEN the financial report is generated
- THEN the voided charge MUST NOT count toward charged amounts
- AND voided totals MAY be shown as a separate figure

### Requirement: Cash register report

The system MUST show, per location and day, opening amount, payments by method, refunds, expected cash, counted cash and difference, using data from closed and open registers.

#### Scenario: Day with a cash difference
- GIVEN a closed register with a 1000 ARS difference
- WHEN the cash report for that day is opened
- THEN the difference and its reason MUST be shown

### Requirement: Filters and period selection

Reports MUST support filtering by date range, location, professional, specialty and payer where relevant, and the applied filters MUST be visible on screen and in exports. The system MUST reject date ranges that are inverted or exceed a documented maximum span, with a clear message.

#### Scenario: Inverted range
- GIVEN a user sets "to" earlier than "from"
- WHEN they apply the filter
- THEN the system MUST show a validation message and MUST NOT run the report

### Requirement: Consistency with source records

Every figure in a report MUST be reproducible from the underlying records for the same filters. Users MUST be able to drill down from a total to the list of records that compose it, subject to the viewer's permissions.

#### Scenario: Drill-down matches total
- GIVEN a collected total of 500000 ARS for professional A in a month
- WHEN the admin drills down
- THEN the listed payments MUST sum to 500000 ARS

### Requirement: Role-scoped visibility

Reports MUST be scoped by role on the server. Owner/admin MUST see all operational and financial reports of the organization. A professional MUST see operational and financial figures for their own appointments only. Reception MUST see operational reports and the cash register report of the locations they work in, and MUST NOT see revenue by professional. A patient MUST have no access to reports.

#### Scenario: Professional scope
- GIVEN professional A requests the organization-wide revenue report
- WHEN the request is processed
- THEN the system MUST return only A's own figures or deny the request

#### Scenario: Reception and revenue per professional
- GIVEN a reception user
- WHEN they request revenue by professional
- THEN the system MUST deny the request

### Requirement: No clinical content in reports

Reports, charts and their exports MUST NOT contain clinical note content, diagnoses, prescriptions or consent content. Aggregates MAY use appointment types and specialties. Patient-level rows MAY appear only where required by a billing drill-down and MUST then show identification and financial data only.

#### Scenario: Admin report cannot expose clinical data
- GIVEN a non-clinical admin
- WHEN they open any report or drill-down
- THEN no clinical note content MUST be reachable from it

### Requirement: Charts with accessible table alternative

Each chart MUST have an equivalent table view of the same data. Charts MUST be legible at a 360 px viewport width. Colors MUST NOT be the only means of distinguishing series.

#### Scenario: Mobile view
- GIVEN a viewport of 360 px
- WHEN the dashboard is opened
- THEN charts MUST render without horizontal page scroll
- AND the table view MUST be available

### Requirement: Empty, loading and error states

Reports MUST show explicit loading, empty and error states. Empty results MUST NOT render as zero-valued charts that imply real data. A failure of one report widget MUST NOT block the others.

#### Scenario: New organization with no data
- GIVEN an organization with no appointments
- WHEN the dashboard opens
- THEN each widget MUST show an empty state with a pointer to the first action

#### Scenario: One widget fails
- GIVEN the revenue widget fails to load
- WHEN the dashboard renders
- THEN other widgets MUST still render and the failed widget MUST offer a retry

### Requirement: Report export

Users MUST be able to export a report as spreadsheet-compatible data and as a printable document, including the applied filters and generation timestamp. Exports MUST be limited to what the user is allowed to see on screen and MUST be audited.

#### Scenario: Export respects scope
- GIVEN professional A exports the revenue report
- WHEN the file is generated
- THEN it MUST contain only A's records

### Requirement: Tenant isolation and audit

Report queries MUST only read data of the organization in the authenticated session. Report access and exports involving patient-level data MUST be recorded in `audit-log`.

#### Scenario: Cross-tenant filter injection
- GIVEN a request that includes another organization's identifier in the query
- WHEN the report runs
- THEN the identifier MUST be ignored or rejected and only the session's organization MUST be used

### Requirement: Read-only tenant and language

Reports MUST remain available when the tenant is read-only. All report copy MUST be Spanish (es-AR) with `dd/mm/yyyy` dates and ARS formatting, using externalized strings.

#### Scenario: Read-only tenant
- GIVEN a tenant in read-only state
- WHEN an admin opens the dashboard
- THEN the reports MUST load normally
