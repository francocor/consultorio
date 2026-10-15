# Delta for demo-tenant

Seed data and reset for the sales/demo organization.

**Quick read**: the demo is a normal tenant filled with fake data across modules, resettable in under a minute. It must never mix with real data or real people. Stage 1 delivers the scaffold; later stages add data for their modules.

## ADDED Requirements

### Requirement: Demo tenant is a normal, isolated organization

The demo tenant MUST be an ordinary organization flagged as demo, subject to the same isolation, authorization and audit rules as any tenant. It MUST NOT be reachable from, or share data with, real tenants. The demo flag MUST be set only by the platform operator when the organization is created and MUST NOT be changeable afterwards, so no real tenant can be turned into a demo tenant (which would unlock the reset path) and no demo tenant into a real one. The demo tenant is excluded from subscription, trial and billing logic (`subscriptions`).

#### Scenario: Demo isolation
- GIVEN a demo tenant and a real tenant
- WHEN a demo user lists patients
- THEN only demo data is returned

#### Scenario: Same authorization in demo
- GIVEN a demo reception user
- WHEN requesting clinical notes
- THEN access is denied exactly as in a real tenant

#### Scenario: Flag cannot be changed
- GIVEN a real tenant
- WHEN anyone attempts to set its demo flag, or to clear the flag of the demo tenant
- THEN the system refuses

#### Scenario: Demo is not subject to subscriptions
- GIVEN the demo tenant
- WHEN trial and billing jobs run
- THEN it is skipped and never enters grace or read-only

### Requirement: Fake data only

Demo data MUST be entirely fictitious. It MUST NOT include real people's names, documents, contacts or health data, or data copied from a real tenant. Identifiers MUST be recognizably synthetic and MUST NOT be valid real contact points (phones, emails) that could receive messages.

#### Scenario: No real contacts
- GIVEN the seeded patients
- WHEN their contact data is inspected
- THEN emails and phones are reserved/non-routable values

#### Scenario: Outbound messages suppressed
- GIVEN a demo tenant with reminders configured
- WHEN a message would be sent
- THEN no real email or WhatsApp message leaves the system

### Requirement: Demo tenants use only fake adapters

Every external integration of a demo tenant (email, WhatsApp, payments, AFIP invoicing, e-prescription and video) MUST be bound to a fake or sandbox adapter that never reaches a real recipient or authority. The system MUST refuse to configure real credentials or real adapters for a demo tenant, and MUST refuse to start a demo tenant's send, charge, invoice or prescription against a real provider even if configuration is wrong. Fake adapters MAY record what would have been sent so a demo can show it.

#### Scenario: Real credentials refused
- GIVEN the demo tenant
- WHEN an operator tries to save real WhatsApp credentials for it
- THEN the system refuses

#### Scenario: Misconfiguration cannot reach a provider
- GIVEN the demo tenant is somehow configured with a real adapter
- WHEN a reminder, invoice or prescription would be sent
- THEN the call is blocked and nothing leaves the system

#### Scenario: Demo shows what would be sent
- GIVEN a prospect watching the demo
- WHEN a reminder is triggered
- THEN the app shows the message as recorded by the fake adapter

### Requirement: Realistic coverage across modules

The seed MUST provide, for every module that exists at the time, realistic data: multiple locations, a multi-specialty staff (including each role), patients with coverages, and, as later stages add modules, appointments, clinical notes, payments and similar. Adding a module MUST include its demo data. Stage 1 seeds at least two roles' worth of users, locations, staff, professionals and patients.

#### Scenario: Stage 1 content
- GIVEN the demo is reset after Stage 1
- WHEN an owner signs in
- THEN branded organization, locations, professionals of different disciplines, reception, and patients with coverage exist

#### Scenario: New module without seed
- GIVEN a module is released with no demo data
- WHEN verification runs
- THEN the gap is reported

### Requirement: Reset on demand under one minute

An authorized operator MUST be able to reset the demo tenant to its initial seeded state on demand, through a privileged reset path that exists only for organizations carrying the demo flag. A reset MUST complete in under 1 minute and be repeatable with identical logical content. The reset MUST affect only the demo tenant and MUST NOT be reachable through any tenant-facing role.

#### Scenario: Reset restores state
- GIVEN a demo tenant with edited and added data
- WHEN reset runs
- THEN the data equals the seed state and completes in under 1 minute

#### Scenario: Reset targeted at a real tenant
- GIVEN a reset command aimed at a non-demo organization
- WHEN executed
- THEN the system refuses it and changes nothing

#### Scenario: Unauthorized reset
- GIVEN a tenant member or anonymous user
- WHEN a reset is requested
- THEN it is denied

### Requirement: Demo credentials and access are safe

Demo accounts MUST have role-labelled sign-in for each role. Demo credentials MUST be distinct from any real credentials, MUST be rotated by the reset where applicable, and demo accounts MUST NOT have platform-operator or cross-tenant privileges.

#### Scenario: Demo role switching
- GIVEN a prospect uses a prepared demo account per role
- WHEN each signs in
- THEN each sees the role-specific views

### Requirement: Demo resets and the retention rule

Because demo data is synthetic and flagged, the reset MAY remove demo records, including the demo tenant's own audit entries, as one of the listed exceptions to the no-hard-delete rule (`tenancy`). That exemption applies to the demo tenant only: the reset MUST NOT delete real tenant data or audit entries, and the integrity verification of the audit log (`audit-log`) MUST still succeed for every real tenant and for the platform-level entries after a reset. Every reset MUST be audited at platform level, and that platform-level entry MUST be retained.

#### Scenario: Reset audited
- GIVEN a reset runs
- WHEN complete
- THEN a platform-level audit entry records who and when

#### Scenario: Integrity check after reset
- GIVEN a reset of the demo tenant removed its audit entries
- WHEN the audit integrity verification runs
- THEN it succeeds for all real tenants and for the platform-level entries
- AND the reset itself appears as a platform-level entry

#### Scenario: Reset cannot touch audit of a real tenant
- GIVEN a reset command aimed at a real tenant's audit entries
- WHEN executed
- THEN the system refuses it and changes nothing
