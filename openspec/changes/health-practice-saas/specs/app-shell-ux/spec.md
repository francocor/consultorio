# Delta for app-shell-ux

Role-driven layout, installable PWA, i18n, UX states and the shell hook that hosts the guided first run (content in `tenant-onboarding`, Part A).

**Quick read**: one layout adapts to the user's role. Mobile-first, installable, Spanish (es-AR) UI with externalized strings. Every screen has clear empty, loading and error states. The UI never replaces server-side authorization.

## ADDED Requirements

### Requirement: Single layout driven by role

The system MUST provide one application shell whose navigation and visible actions are derived from the user's roles and permissions. Users MUST see only navigation entries they can use. Hidden entries MUST NOT be the only protection (see `authorization`).

#### Scenario: Reception navigation
- GIVEN a reception user signs in
- WHEN the shell renders
- THEN navigation shows schedule, patients and payments areas
- AND no clinical-notes entry point is offered

#### Scenario: Non-clinical admin navigation
- GIVEN a non-clinical owner/admin signs in
- WHEN the shell renders
- THEN settings, staff, branding and audit areas appear
- AND no clinical-notes entry point is offered

#### Scenario: Read-only tenant banner
- GIVEN a tenant in read-only state
- WHEN an owner signs in
- THEN a banner explains the state and the way to resolve it
- AND controls for refused actions are disabled with an explanation

#### Scenario: Multi-role user
- GIVEN a user who is both owner and professional
- WHEN the shell renders
- THEN navigation combines both roles' areas
- AND clinical areas remain governed by the professional role

#### Scenario: Direct URL to a forbidden area
- GIVEN a user types the address of an area their role cannot use
- WHEN the page loads
- THEN a clear "no access" state is shown and no data is fetched for it

### Requirement: Mobile-first responsive layout

Core flows MUST be usable at a 360 px viewport width without horizontal scrolling and MUST scale to tablet and desktop. Touch targets SHOULD be comfortably tappable.

#### Scenario: Small phone
- GIVEN a 360 px wide screen
- WHEN a user performs a core flow such as opening the schedule or finding a patient
- THEN the flow completes without horizontal scrolling or clipped actions

### Requirement: Installable PWA

The application MUST be installable as a progressive web app with the active organization's name and icon (see `tenant-branding`). The application MUST NOT cache or retain protected health data on the device beyond what the session needs, and MUST clear it on sign-out. Offline use of clinical data is NOT required.

#### Scenario: Install prompt branded
- GIVEN a user visits tenant 1's app on a supported browser
- WHEN installing
- THEN the installed app shows tenant 1's name and icon

#### Scenario: Sign-out clears local data
- GIVEN a user signs out on a shared device
- WHEN the sign-out completes
- THEN no patient or clinical data remains accessible from device-side storage or caches

#### Scenario: Offline
- GIVEN the device is offline
- WHEN the user opens the app
- THEN an offline state is shown
- AND no previously viewed protected data is displayed without a valid session

### Requirement: Performance budget

On a typical 4G connection, the 75th-percentile page load SHOULD be under 2.5 seconds for core pages.

#### Scenario: Measured load
- GIVEN real-user measurement on 4G
- WHEN p75 page load is computed over a reporting period
- THEN it is below 2.5 seconds

### Requirement: Spanish (Argentina) UI with externalized strings

All user-facing text MUST be in Spanish (es-AR), using es-AR formats for dates, numbers and currency (ARS). All strings MUST be externalized so other locales can be added without code changes. Code, identifiers and internal logs remain in English.

#### Scenario: Default locale
- GIVEN any user
- WHEN the interface renders
- THEN all labels, messages, validation errors and emails are es-AR

#### Scenario: Missing translation
- GIVEN a string key has no es-AR value
- WHEN verification runs
- THEN the gap is reported and the build MUST NOT ship an untranslated key to users

### Requirement: Clear empty, loading and error states

Every data screen MUST present distinct empty, loading and error states with plain-language, actionable es-AR copy. Error states MUST NOT expose technical detail, identifiers of protected data or other tenants' information.

#### Scenario: Empty list
- GIVEN a new organization with no patients
- WHEN the patients screen opens
- THEN an empty state explains what the screen is for and offers the primary next action

#### Scenario: Failed load
- GIVEN a request fails
- WHEN the screen handles it
- THEN a retryable error is shown with no stack trace or internal detail

#### Scenario: Expired session mid-use
- GIVEN a session expires while a form is open
- WHEN the user submits
- THEN the user is guided to sign in again with a clear message

### Requirement: Accessibility baseline

Interactive controls MUST be keyboard operable, labelled for assistive technology, and meet legible color contrast. Status MUST NOT be conveyed by color alone.

#### Scenario: Keyboard-only use
- GIVEN a keyboard-only user
- WHEN navigating the shell and forms
- THEN every action is reachable and focus is visible

### Requirement: Guided first run hook

The shell MUST provide a place to host the guided first-run experience for a new organization (Stage 2), shown to owners/admin until completed or dismissed, on phone and desktop. The shell owns the hosting, dismissal and help entry; the content and completion rules of the setup wizard and checklist are defined by `tenant-onboarding` (Part A), so that the Stage 2 success criterion (first appointment within 10 minutes) stays traceable to one capability. Non-owner roles MUST NOT see it.

#### Scenario: First run shown once
- GIVEN a newly created organization
- WHEN the owner first signs in
- THEN the first-run checklist of `tenant-onboarding` is available
- AND dismissing it keeps it reachable from help

#### Scenario: Reception does not see the first run
- GIVEN a reception user of a new organization
- WHEN the shell renders
- THEN no first-run entry is offered

### Requirement: Sensitive data not exposed through the shell

Browser history entries, page titles, notification text and shared links MUST NOT include clinical content or patient health details.

#### Scenario: Page title
- GIVEN a professional has a patient's clinical record open
- WHEN the browser title is read
- THEN it carries no diagnosis or clinical text
