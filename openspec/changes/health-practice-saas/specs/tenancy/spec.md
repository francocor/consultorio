# Delta for tenancy

Organizations, locations, tenant isolation, single-tenant deployment configuration, cancellation export and retention archive.

**Quick read**: every record belongs to exactly one organization. Tenant identity comes only from the authenticated session. Isolation failures are treated as data breaches.

## ADDED Requirements

### Requirement: Organization as the tenant boundary

The system MUST model every customer as an organization, including a solo professional (an organization with one member). Every tenant-owned record MUST belong to exactly one organization. A record MUST NOT be reassignable to another organization through the product.

#### Scenario: Solo professional is an organization
- GIVEN a new solo professional signs up or is created by the platform operator
- WHEN the account is provisioned
- THEN an organization exists with that professional as its only member and owner
- AND every record the professional creates belongs to that organization

#### Scenario: Record has no organization
- GIVEN a request attempts to create a tenant-owned record
- WHEN no organization can be derived from the authenticated session
- THEN the system MUST reject the request and persist nothing

### Requirement: Tenant identity derived only from the session

The system MUST derive organization and user identity exclusively from the authenticated session. The system MUST ignore or reject any organization or user identifier supplied in a request body, query string, header or path that conflicts with the session.

#### Scenario: Forged organization identifier in the body
- GIVEN user A of organization 1 is authenticated
- WHEN A sends a request with a body that names organization 2
- THEN the system MUST NOT read or write any organization 2 data
- AND the attempt MUST be recorded in the audit log as a denied cross-tenant attempt

#### Scenario: Forged identifier in the query string
- GIVEN user A of organization 1 is authenticated
- WHEN A requests a record by an identifier that belongs to organization 2
- THEN the system MUST respond as if the record does not exist
- AND the response MUST NOT reveal that the record exists in another organization

### Requirement: Cross-tenant isolation on every data path

No data MUST ever be visible across organizations. This applies to reads, writes, searches, lists, counts, exports, reports, file downloads, background jobs, notifications and the audit log. The system MUST enforce isolation centrally so that a single missing check in one feature cannot expose another tenant's data.

#### Scenario: Search never crosses tenants
- GIVEN patients named "Gomez" exist in organizations 1 and 2
- WHEN a user of organization 1 searches for "Gomez"
- THEN only organization 1 patients are returned

#### Scenario: Aggregates never include other tenants
- GIVEN organizations 1 and 2 each hold records
- WHEN a user of organization 1 views any count, total or report
- THEN the values MUST be computed from organization 1 records only

#### Scenario: Automated cross-tenant coverage
- GIVEN the set of data-access paths that exist at release time
- WHEN the verification suite runs
- THEN every path MUST have a cross-tenant test asserting that organization 2 data is not exposed to organization 1

### Requirement: Locations within an organization

An organization MUST be able to own one or more locations. Each location MUST belong to exactly one organization and MUST have an IANA time zone (default America/Argentina/Buenos_Aires, taken from the country module). The location's time zone is authoritative for everything that happens at that location (working hours, appointments, blocks, reminders, cash register days); an organization-level time zone is only the default offered for new locations. Non-professional staff MUST be assignable to locations (membership), as defined in `authorization`. Locations MUST be deactivated rather than deleted when records reference them.

#### Scenario: Location time zone is authoritative
- GIVEN an organization whose default is America/Argentina/Buenos_Aires and a location configured with another IANA zone
- WHEN working hours and appointments at that location are shown
- THEN they are evaluated and displayed in the location's zone

#### Scenario: Organization with several locations
- GIVEN an owner of organization 1
- WHEN the owner creates locations "Centro" and "Norte"
- THEN both locations belong to organization 1 and are visible only to its members

#### Scenario: Deactivating a location in use
- GIVEN a location referenced by existing records
- WHEN the owner deactivates it
- THEN the location is hidden from new selections
- AND existing records that reference it MUST remain intact and readable

### Requirement: Multi-specialty organizations

An organization MUST be able to include professionals of different disciplines. Tenancy rules MUST NOT depend on the discipline of any member.

#### Scenario: Mixed disciplines in one center
- GIVEN an organization with a physician, a psychologist and a dentist
- WHEN each signs in
- THEN each sees only data allowed by the authorization rules, with the same isolation guarantees

### Requirement: Single-tenant deployment by configuration

The same build MUST run either as a multi-tenant platform or as a single-tenant instance, selected by configuration only. A single-tenant instance MUST host exactly one organization and MUST enforce the same isolation, authorization and audit rules as multi-tenant mode. A single-tenant instance MAY configure its own WhatsApp sender; otherwise the platform's sender is used (see `notifications`). WhatsApp usage MUST be metered in single-tenant mode as well (see `subscriptions`).

#### Scenario: Single-tenant instance
- GIVEN an instance configured as single-tenant
- WHEN it starts
- THEN it serves one organization only
- AND no code change or alternate build is required

#### Scenario: Attempt to create a second organization in single-tenant mode
- GIVEN an instance configured as single-tenant that already has its organization
- WHEN an actor attempts to create another organization
- THEN the system MUST reject the request

### Requirement: Platform operator has no default clinical access

The platform operator MUST be able to create and manage tenants but MUST NOT have default access to tenant clinical data. Any support access to tenant data MUST be explicit, time-boxed and audited, and MUST remain subject to the clinical-access rules in `authorization`.

#### Scenario: Operator opens tenant data without grant
- GIVEN a platform operator with no active support grant for organization 1
- WHEN the operator tries to read organization 1 patient or clinical data
- THEN access MUST be denied and the attempt audited

#### Scenario: Time-boxed support grant
- GIVEN an organization owner has granted support access for a stated period
- WHEN the period ends
- THEN the grant MUST expire automatically
- AND every access during the grant MUST appear in the audit log, visible to the organization

#### Scenario: Support grant never opens clinical notes
- GIVEN an active support grant
- WHEN the operator requests clinical note content
- THEN access MUST be denied, because clinical notes are readable by health professionals only

### Requirement: Tenant cancellation export

When a tenant cancels, the system MUST provide a complete export, split into two parts, each as a human-readable PDF form plus structured data:

- **Administrative export**: delivered to the owner. It covers organization configuration, staff, patient demographics and coverage, schedule and attendance, billing, payments, invoices, and the audit log. It MUST contain no clinical content.
- **Clinical export**: delivered to health professionals, never to a non-clinical admin. Each professional receives the clinical records (entries, addenda, anamnesis, clinical documents, prescriptions, consents) of their own patients, meaning the patients with whom they have a care relationship (`authorization`). A patient treated by several professionals appears in each one's export.

If no professional remains for a patient's records (for example a deactivated professional or a non-professional owner), the platform MUST keep custody of those records under the contract and MUST release them only to the patient themselves (identity verified) or to a verified professional (matrícula verified, see `staff-professionals`). Release of custodied records MUST be audited, MUST be automated, and MUST NOT allow the platform operator to read the content.

#### Scenario: Cancelling tenant requests export
- GIVEN an organization that has cancelled
- WHEN an authorized owner requests the export
- THEN the owner receives the administrative export as PDF plus structured data
- AND each professional of the organization can obtain their clinical export
- AND every export event is recorded in the audit log

#### Scenario: Export is scoped
- GIVEN organizations 1 and 2 exist
- WHEN organization 1 exports
- THEN the export MUST contain no organization 2 data

#### Scenario: Owner who is not a professional
- GIVEN a cancelled organization whose owner is not a health professional
- WHEN the owner requests the export
- THEN the owner receives only the administrative export
- AND no clinical content is delivered to the owner

#### Scenario: Solo professional receives own records
- GIVEN a solo professional organization that cancels
- WHEN the professional requests the clinical export
- THEN the professional receives the records of all their patients

#### Scenario: No professional remains
- GIVEN patient X whose only treating professional was deactivated before cancellation
- WHEN the tenant is archived
- THEN X's records stay in platform custody
- AND they are released only to X after identity verification or to a verified professional, with an audit entry
- AND the operator cannot read the content during release

### Requirement: Retention archive after cancellation

After cancellation the platform MUST keep an encrypted, read-only archive of the tenant's records for the 10-year legal retention period, under contract. Records in the archive MUST NOT be modified or hard-deleted during that period, with a single exception: a legally required erasure (for example a court order) MAY be performed by a specifically privileged role through a documented, audited procedure. Ordinary users, tenant roles and the routine operator role MUST NOT be able to remove archived records. Any access to the archive MUST be audited. (The exact legal basis of the erasure exception is pending legal counsel.)

#### Scenario: Archive is read-only
- GIVEN an archived organization
- WHEN any actor attempts to create, edit or delete an archived record
- THEN the system MUST reject the attempt

#### Scenario: Archive access is audited
- GIVEN an archived organization
- WHEN an authorized party reads archive content
- THEN an audit entry records who, what, when and the stated reason

#### Scenario: Archive retained for the full period
- GIVEN an archive whose last encounter was less than 10 years ago
- WHEN a routine purge is attempted
- THEN the system MUST refuse the purge

#### Scenario: Legally required erasure
- GIVEN a documented legal order to erase a patient's archived records
- WHEN the privileged role executes the documented procedure
- THEN the erasure succeeds and is audited with the legal reference
- AND the same attempt by an ordinary operator or tenant role is refused

### Requirement: Retention exceptions are explicit and exhaustive

The rule "records are never hard-deleted" MUST have exactly these four exceptions, each audited where it touches an audit trail:

1. The demo tenant reset (`demo-tenant`).
2. The purge of unverified signups, which contain no patient data (`tenant-onboarding`).
3. The legally required erasure of archived records (above).
4. The purge of abandoned, unverified online-booking and waitlist self-join submissions that never became patient records (`online-booking`).

No other path MAY hard-delete tenant records.

#### Scenario: Unlisted deletion path
- GIVEN any feature that would remove tenant records permanently
- WHEN the feature is not one of the listed exceptions
- THEN it MUST NOT hard-delete and MUST deactivate or hide instead

### Requirement: Read-only tenant and its allowlist

When a tenant is read-only (non-payment or ended trial after grace, see `subscriptions`), the state MUST be enforced on the server for every capability using one shared allowlist. Every capability MUST refer to this list and MUST NOT define its own. Allowed in read-only, exactly:

1. All reads, including clinical records, documents (requesting a download link counts as a read), prescriptions, invoices and reports.
2. Audit writes.
3. Authentication and session management, for staff and patients.
4. Every export, including the cancellation export.
5. The owner's subscription and payment management.
6. Patient-protective writes: cancellation of an appointment by or for the patient (by staff, in the portal or through a token link), revocation of a consent, submission of a rectification request, and channel opt-out, including the notification opt-out link.
7. Rectification addenda added by treating professionals (`clinical-records`), because rectification is a patient right under Ley 26.529.
8. Submission to AFIP of invoices queued before the tenant became read-only.
9. Webhooks from providers (payments, messaging delivery and opt-outs, e-prescription status).

Everything else, including creating or editing patients, appointments, status changes (including check-in), new encounters and other clinical writes, documents, charges, payments, invitations and the sending of messages, MUST be refused with a message that the account is read-only. Public booking and waitlist pages MUST show the generic "not available" page instead of a read-only message (`online-booking`). Tenancy state MUST NOT delete or hide data.

Background jobs MUST re-check the tenant's status when they run. A message scheduled to be sent during the read-only period MUST NOT be sent, and MUST NOT be sent after recovery; it is cancelled with the reason "tenant read-only". Actions refused during read-only MUST NOT be replayed on recovery.

#### Scenario: Read-only tenant
- GIVEN a tenant in read-only state after the grace period
- WHEN a professional opens a patient's clinical record or requests an export
- THEN access is granted under the normal authorization rules
- AND create and update operations are refused

#### Scenario: Patient-protective write is allowed
- GIVEN a read-only tenant
- WHEN a patient cancels an appointment or revokes a consent from the portal
- THEN the action succeeds and is recorded

#### Scenario: Rectification addendum is allowed, a new encounter is not
- GIVEN a read-only tenant
- WHEN a treating professional adds a rectification addendum and then tries to start a new encounter
- THEN the addendum is stored
- AND the new encounter is refused with a message that the account is read-only

#### Scenario: Public booking on a read-only tenant
- GIVEN a read-only tenant
- WHEN a visitor opens its public booking or waitlist page
- THEN the generic "not available" page is shown

#### Scenario: Queued message does not survive recovery
- GIVEN a reminder was due while the tenant was read-only
- WHEN the tenant recovers after payment
- THEN the reminder is not sent
- AND it appears as cancelled with the reason "tenant read-only"

#### Scenario: Queued AFIP submission still goes out
- GIVEN an invoice queued as pending before the tenant became read-only
- WHEN the retry job runs while the tenant is read-only
- THEN the submission to AFIP proceeds
