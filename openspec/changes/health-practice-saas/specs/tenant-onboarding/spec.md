# Delta for tenant-onboarding

> New capability in two parts that ship in different stages.
> **Part A, Stage 2 (Practice core)**: tenant first run for every new organization, whether created by the platform operator or (from Stage 6) by signup. It covers initial roles, the setup wizard, the solo fast path and the first-run checklist. It carries the Stage 2 success criterion "a new solo professional books a first appointment within 10 minutes of first login". It does not depend on signup, trial or payment.
> **Part B, Stage 6 (Growth)**: self-service signup, email verification, abuse protection, trial and payment on signup, abandoned signups.
> The shell that hosts the checklist is defined in `app-shell-ux`. Plans, trial and payment belong to `subscriptions`. Until Stage 6 the platform operator creates tenants by hand (`tenancy`) and Part A applies to those tenants.

## Quick map

| Part | Area | Requirements |
|---|---|---|
| A (Stage 2) | Creation | Operator-created tenants, initial roles |
| A (Stage 2) | Guided first run | Setup wizard, solo fast path, first-run checklist, staff invitation |
| A (Stage 2) | Cross-cutting | Authorization and audit, mobile and language |
| B (Stage 6) | Signup | Self-service signup, email verification, abuse protection |
| B (Stage 6) | Commercial | Trial and payment on signup |
| B (Stage 6) | Resilience and legal | Provider outage, abandoned signups, privacy and legal acceptance |

## ADDED Requirements

## Part A: Guided first run (Stage 2)

### Requirement: Operator-created tenants

Until self-service signup exists, and afterwards for tenants created by the operator, the platform operator MUST be able to create an organization with a named owner. The owner MUST receive a single-use, expiring invitation by email to set their own password; no password MUST be preset or known to the operator. On first sign-in the owner MUST land in the first-run experience of this part. No other user MUST have any access to the new tenant.

#### Scenario: Operator creates a tenant
- GIVEN a platform operator
- WHEN they create an organization with an owner email
- THEN the owner receives an invitation link and sets their own password
- AND on first sign-in the owner is taken to the setup wizard

#### Scenario: Tenant isolation at creation
- GIVEN two tenants created minutes apart
- WHEN each owner signs in
- THEN each MUST see only their own organization

### Requirement: Tenant defaults and initial roles

On creation the system MUST set the organization's country to Argentina, default time zone and locale es-AR, and MUST give the first user the owner role. The first run MUST ask whether the owner is also a health professional. If yes, a professional profile MUST be created for the owner, whose matrícula is recorded to unlock clinical work and verified before prescribing (`staff-professionals`, `e-prescription`), and who MUST read clinical data only through the professional role. If no, the owner MUST NOT gain clinical access.

#### Scenario: Owner is also a professional
- GIVEN the owner answers that they are a health professional
- WHEN the first run completes the profile step
- THEN the owner MUST have both the owner role and a professional profile

#### Scenario: Owner is not a professional
- GIVEN the owner answers that they are not a health professional
- WHEN the first run completes the profile step
- THEN the owner MUST have no clinical read access
- AND the wizard MUST prompt them to add at least one professional

### Requirement: Setup wizard

After the first sign-in the owner MUST be guided through a setup wizard with these steps: organization profile and branding, first location, professionals and staff invitations, working hours, and appointment types. When `billing-payments` is available in the deployment, the wizard MUST also offer a step for prices and for payers or private-only configuration; a step that belongs to a capability that is not available MUST NOT be shown. Each step MUST be skippable except those required to book the first appointment (at least one location, one professional with working hours and one appointment type). Progress MUST be saved after each step. The wizard MUST be resumable and reachable later from settings. Validation errors MUST be shown inline in Spanish.

#### Scenario: Resume
- GIVEN an owner who left at step 3
- WHEN they sign in again
- THEN the wizard MUST resume at step 3 with previous answers preserved

#### Scenario: Skip an optional step
- GIVEN the branding step
- WHEN the owner skips it
- THEN the organization MUST use the neutral default branding
- AND a checklist item MUST remain visible to complete it later

#### Scenario: Required step
- GIVEN the owner has not created a location
- WHEN they try to finish the wizard
- THEN the system MUST block completion and indicate the missing prerequisites

#### Scenario: Step for an unavailable capability
- GIVEN a deployment where billing is not yet available
- WHEN the owner runs the wizard
- THEN no price or payer step is shown

### Requirement: Fast path for solo professionals

For a solo professional the wizard MUST offer a short path that creates the location, working hours and a default appointment type with sensible defaults, so that the first appointment can be booked within 10 minutes of first login. The short path MUST NOT require the matrícula, branding or any payment step; those remain as checklist items. Sensible defaults MUST be editable afterwards.

#### Scenario: Solo path
- GIVEN an owner who is the only professional
- WHEN they choose the short path
- THEN the system MUST create defaults and take them to the calendar ready to book

#### Scenario: First appointment within 10 minutes
- GIVEN a new solo professional on a phone who signs in for the first time
- WHEN they take the short path and book a first appointment for a patient they register
- THEN the whole journey from first sign-in to the booked appointment is completable within 10 minutes without help

### Requirement: First-run checklist

The first-run checklist hosted by the shell (`app-shell-ux`) MUST list the remaining setup actions for the organization and MUST mark each item complete from real data, not from clicks. The checklist MUST include: create a location, set a professional's working hours, create an appointment type, register a first patient, book a first appointment, record the professional's matrícula, invite staff, and set branding; items for capabilities that are not available MUST NOT appear. It MUST be shown to owners/admin until completed or dismissed, MUST stay reachable from help after dismissal, and each item MUST link to the screen that completes it. Progress MUST be saved per organization.

#### Scenario: Item completes from data
- GIVEN a checklist with "create a location" pending
- WHEN the owner creates a location through the normal settings screen
- THEN the item shows as complete without further action

#### Scenario: Dismiss and return
- GIVEN an owner who dismissed the checklist
- WHEN they open help
- THEN the checklist is reachable with its current progress

#### Scenario: Non-owner does not see it
- GIVEN a reception user
- WHEN they sign in to a new organization
- THEN no first-run checklist is shown

### Requirement: Staff invitation from the first run

The owner MUST be able to invite professionals, reception and admin staff by email with a role during the wizard (the invitation rules of `staff-professionals` apply). An invitation MUST NOT allow choosing a higher role than the inviter may grant. When `subscriptions` is active, inviting an additional active professional MUST display the plan impact before sending.

#### Scenario: Invite reception
- GIVEN an owner
- WHEN they invite a user with the reception role
- THEN the invitee MUST receive a link that grants only the reception role

#### Scenario: Invite beyond plan limit
- GIVEN subscriptions are active and the plan limit of active professionals is reached
- WHEN the owner invites another professional
- THEN the system MUST explain the limit and the upgrade path before sending

### Requirement: First-run authorization and audit

Wizard actions MUST be limited to the owner (and admins explicitly granted). Professional, reception and patient roles MUST NOT access the wizard. Tenant creation by the operator, wizard changes, invitations and checklist dismissal MUST be recorded in `audit-log`.

#### Scenario: Non-owner opens the wizard
- GIVEN a reception user
- WHEN they open the setup wizard route
- THEN the system MUST deny access

### Requirement: Mobile experience and language

The wizard and the checklist MUST work at a 360 px viewport with explicit loading, empty and error states. All copy MUST be Spanish (es-AR) from externalized strings. Branding MUST default to the platform theme until the owner sets organization branding (`tenant-branding`).

#### Scenario: Phone completion
- GIVEN a 360 px device
- WHEN the owner completes the short path
- THEN no step MUST require horizontal scrolling

## Part B: Self-service signup (Stage 6)

### Requirement: Self-service signup

A visitor MUST be able to create a new organization without operator involvement by providing organization name, owner name, email address and password, and by accepting the terms of service and the data-processing terms. The organization identifier (slug) MUST be generated automatically from the name and made unique by the system; the visitor MUST NOT choose or reserve it. Signup MUST be available only when the deployment is in multi-tenant mode and signup is enabled by configuration. In single-tenant deployments the signup route MUST NOT exist. On activation, the defaults and initial roles of Part A apply.

#### Scenario: Successful signup
- GIVEN a visitor on the signup page
- WHEN they submit valid data and accept the terms
- THEN an unverified organization and owner account MUST be created with an automatically generated identifier
- AND a verification message MUST be sent

#### Scenario: Terms not accepted
- GIVEN a visitor who does not accept the terms
- WHEN they submit
- THEN the system MUST reject the signup

#### Scenario: Single-tenant deployment
- GIVEN a deployment configured as single-tenant
- WHEN anyone requests the signup route
- THEN the system MUST respond that it does not exist

#### Scenario: Two organizations with the same name
- GIVEN an organization named "Centro Salud" already exists
- WHEN another visitor signs up with the same name
- THEN a distinct identifier is generated
- AND the response does not reveal that the name was already used

### Requirement: Email verification before activation

The owner account MUST verify its email address through a single-use, expiring link before the tenant is activated. An unverified tenant MUST NOT be able to store patient data, send messages, or use paid features. Re-sending verification MUST be rate limited. Signup MUST NOT reveal whether an email already has an account.

#### Scenario: Verification completes
- GIVEN an unverified owner
- WHEN they open the valid link
- THEN the tenant MUST become active and the owner MUST be taken to the wizard of Part A

#### Scenario: Existing email
- GIVEN an email already used by an account
- WHEN someone signs up with it
- THEN the response MUST NOT confirm the email is registered
- AND the existing owner MAY be notified

#### Scenario: Expired link
- GIVEN a verification link past its expiry
- WHEN it is opened
- THEN the system MUST offer a new link

### Requirement: Signup abuse protection

Signup and verification endpoints MUST be protected by rate limiting and an automated-abuse challenge (for example a privacy-respecting CAPTCHA such as Cloudflare Turnstile). Disposable or repeated signups from the same source SHOULD be throttled. The system MUST NOT allow a signup to choose or reserve another organization's name or identifier in a way that exposes the existence of other tenants.

#### Scenario: Burst of signups
- GIVEN many signup requests in a short time from one source
- WHEN the threshold is exceeded
- THEN further requests MUST be throttled with a generic message

#### Scenario: Failed challenge
- GIVEN a signup submission that fails the abuse challenge
- WHEN it is received
- THEN the system MUST reject it and create no organization or account

### Requirement: Trial and payment on signup

A new tenant MUST start in a trial of 14 days (the value comes from the active plan, see `subscriptions`). The owner MUST be able to subscribe at any time during onboarding, so that signup, payment and use are possible on the same day. The wizard MUST show the trial end date and what happens when it ends.

#### Scenario: Subscribe on day one
- GIVEN an active tenant in trial
- WHEN the owner completes subscription payment
- THEN the tenant MUST move to an active paid state without losing wizard progress or data

### Requirement: Provider outage and abandoned signups

If the email provider is unavailable, the signup MUST be saved and the verification email MUST be retried; the visitor MUST be told to wait and be able to request another message. If the payment provider is unavailable during onboarding, the wizard MUST continue and payment MUST be deferrable. Unverified signups MUST be purged after a defined period; they contain no patient data. This purge is one of the listed exceptions to the no-hard-delete rule (`tenancy`). Tenants that were verified MUST NOT be purged by this process.

#### Scenario: Email provider down
- GIVEN the email provider is unavailable
- WHEN a visitor signs up
- THEN the signup MUST be stored
- AND the verification message MUST be retried automatically

#### Scenario: Payment provider down
- GIVEN Mercado Pago is unavailable
- WHEN the owner reaches the payment step
- THEN the system MUST allow continuing the wizard
- AND MUST show that payment can be completed later

#### Scenario: Abandoned unverified signup
- GIVEN a signup never verified within the retention window
- WHEN the cleanup runs
- THEN the unverified tenant and owner record MUST be removed

### Requirement: Privacy and legal acceptance

The system MUST record which version of the terms and data-processing terms was accepted, with date and user. The wizard MUST NOT request or store patient data. Onboarding messages MUST NOT contain health data and MUST be sent by email. Data entered MUST be encrypted in transit and at rest. The owner's data processing role as data controller for patient data MUST be stated in the data-processing terms shown at signup.

#### Scenario: Acceptance record
- GIVEN an owner accepts version 2 of the terms
- WHEN the tenant is created
- THEN the record MUST store version 2, timestamp and owner identity

### Requirement: Signup audit

Signup, verification, tenant activation and acceptance events MUST be recorded in `audit-log`, and the signup page and verification link MUST be the only unauthenticated onboarding entry points (`identity-access`).

#### Scenario: Audit of activation
- GIVEN an owner verifies their email
- WHEN the tenant is activated
- THEN an audit entry records the activation, time and origin
