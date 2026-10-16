# Delta for country-rules-ar

Argentina rules pack: identifiers, payer catalog, retention, legal adapters. Isolated behind a country module so other countries can be added later.

**Quick read**: country-specific behavior lives in one module selected per organization. Core capabilities ask the module; they never hardcode Argentine rules.

## ADDED Requirements

### Requirement: Country module isolation

All Argentina-specific rules MUST be provided through a country module (the CountryPack) selected per organization. The pack MUST provide at least: identifier formats and validation (DNI, CUIT/CUIL), the payer catalog, the holiday catalog, the professional registration (matrícula) formats and validation, the retention period, the legal integrations, the personal-data rules, and the date, currency, language and time-zone defaults. Core capabilities MUST obtain such rules from the module and MUST NOT embed them. Only the Argentina module is in scope now.

#### Scenario: Organization uses the AR pack
- GIVEN an organization with country Argentina
- WHEN a patient identifier is validated
- THEN the AR module's rules are applied

#### Scenario: Unsupported country
- GIVEN an attempt to create an organization with a country that has no module
- WHEN the request is processed
- THEN the system refuses it with a clear message

### Requirement: DNI validation and normalization

The module MUST validate DNI as a numeric identifier of plausible length, normalize it (no dots, spaces or separators) and treat the normalized value as the identity key for deduplication within an organization. Non-resident or missing-DNI cases MUST be supported through an alternative document type (for example passport) with an explicit type. A patient MAY also have no identity document at all (for example a newborn or an unidentified person); in that case no document type or number is stored and the identity key of the pack does not apply to that patient (see `patients`).

#### Scenario: Formatted DNI accepted
- GIVEN the input "30.123.456"
- WHEN it is saved
- THEN it is stored as "30123456"

#### Scenario: Invalid DNI
- GIVEN the input "12AB"
- WHEN validated
- THEN it is rejected with an es-AR message

#### Scenario: Foreign patient
- GIVEN a patient with a passport
- WHEN registered
- THEN the document type is stored explicitly and deduplication uses type plus number

### Requirement: CUIT/CUIL validation

The module MUST validate CUIT/CUIL by length, prefix and check digit, and MUST normalize it. Invalid values MUST be rejected.

#### Scenario: Valid CUIT
- GIVEN "20-12345678-6" with a correct check digit
- WHEN validated
- THEN it is accepted and normalized

#### Scenario: Wrong check digit
- GIVEN a CUIT whose check digit is incorrect
- WHEN validated
- THEN it is rejected

### Requirement: Payer catalog (obras sociales and prepagas)

The module MUST supply a catalog of payers (obras sociales, prepagas, and a private/self-pay option). Organizations MUST be able to enable the payers they work with and add custom entries. Coverage records reference payers by catalog entry.

#### Scenario: Catalog available
- GIVEN a new organization
- WHEN staff select coverage
- THEN catalog payers and "Particular" are offered

#### Scenario: Custom payer is tenant-scoped
- GIVEN organization 1 adds a custom payer
- WHEN organization 2 lists payers
- THEN the custom payer is not visible

### Requirement: Holiday catalog

The module MUST supply the catalog of national holidays of Argentina per year, including movable and bridge holidays, with a name and date for each, so that `scheduling` can mark them as non-bookable days. The catalog MUST be updatable by the platform without a release, and organizations MUST be able to add their own days off on top of it without altering the catalog. Provincial or local holidays are outside the catalog and MUST be addable by the organization.

#### Scenario: Holiday in the catalog
- GIVEN 2026-12-25 is in the national catalog
- WHEN `scheduling` asks the module for holidays of 2026
- THEN the date is returned with its name

#### Scenario: Organization adds a local day off
- GIVEN a local holiday that is not in the national catalog
- WHEN the owner adds it as an organization day off
- THEN it affects only that organization's calendar and the catalog is unchanged

#### Scenario: Catalog updated mid-year
- GIVEN the government declares an additional bridge day
- WHEN the platform updates the catalog
- THEN organizations see the new holiday without upgrading the application

### Requirement: Professional registration (matrícula) rules

The module MUST define the matrícula types (for example national and provincial), the jurisdictions, the number format per type and the validation of that format. This validation checks format and plausibility only; it does not prove the registration exists. Whether a registration is verified is decided by the platform operator (`staff-professionals`) and is required only for e-prescription. The module MUST expose the registration data that prescriptions need (`e-prescription`).

#### Scenario: Valid format
- GIVEN a matrícula type "provincial", a jurisdiction and a number in the expected format
- WHEN the profile is saved
- THEN the module accepts the format and the matrícula is recorded as unverified

#### Scenario: Invalid format
- GIVEN a number that does not fit the format of its type
- WHEN the profile is saved
- THEN the module rejects it with an es-AR message

### Requirement: Locale, currency and time-zone defaults

The module MUST provide the defaults for a new organization and location: locale es-AR, currency ARS with two-decimal precision, date format dd/mm/yyyy, number format with comma decimals and dot thousands, and the IANA time zone America/Argentina/Buenos_Aires for new locations.

#### Scenario: Defaults on a new location
- GIVEN a new organization with country Argentina
- WHEN a location is created without a time zone
- THEN it receives America/Argentina/Buenos_Aires

### Requirement: Retention rule

The module MUST define the clinical-record retention period, which for Argentina MUST be at least 10 years after the patient's last encounter. Records and their audit trail MUST NOT be hard-deleted within that period, except the explicit exceptions listed in `tenancy`. Users MUST be deactivated, not deleted.

#### Scenario: Deletion attempt inside retention
- GIVEN a clinical record whose last encounter was 3 years ago
- WHEN deletion is requested by any actor
- THEN the system refuses it

### Requirement: Legal adapters declared

The module MUST declare the legal integrations it requires (AFIP invoicing, e-prescription under Ley 27.553, professional registration) as adapters whose behavior is specified in later capabilities. If an adapter is unavailable, dependent features MUST degrade without blocking unrelated work.

#### Scenario: Adapter unavailable
- GIVEN the invoicing adapter is down
- WHEN a user works with patients or the schedule
- THEN those features operate normally

### Requirement: Personal data law alignment

Rules derived from Ley 25.326 and Ley 26.529 (data-processing consent and its text version, access and rectification, minimal data in messages, patient right to a formal copy of the clinical history, international data transfer disclosure) MUST be sourced from the module so they can differ per country. The pack MUST state which messages are service communications that need no data-processing consent (appointment reminders and confirmations) and which require explicit opt-in (WhatsApp, waitlist offers).

#### Scenario: Consent requirement from the pack
- GIVEN an AR organization registering a patient
- WHEN the patient is saved
- THEN the AR pack requires recorded data-processing consent (see `patients`)
