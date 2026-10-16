# Delta for audit-log

Append-only record of who read or changed what, and when.

**Quick read**: 100% of clinical record reads and writes are logged. Entries are immutable, tenant-scoped and retained at least 10 years. The log itself never holds clinical content.

## ADDED Requirements

### Requirement: Mandatory events

The system MUST record an audit entry for: every read and write of clinical records; every read of patient identity data in bulk or by export; authentication events (including patient portal sign-ins by one-time code); role, permission, location-membership and sharing changes; patient assignment and removal; matrícula verification; the "reception sees clinical metadata" setting; exports and archive access; support access by the platform operator; and denied access to clinical data or across tenants.

#### Scenario: Clinical read is logged
- GIVEN a professional opens a patient's clinical record
- WHEN the record is displayed
- THEN an entry exists with actor, organization, patient, action "read", resource and timestamp

#### Scenario: Clinical write is logged
- GIVEN a professional saves a clinical entry
- WHEN the save succeeds
- THEN an entry exists with action "create" or "update" and the resource version

#### Scenario: Failed action still audited when security-relevant
- GIVEN a reception user is denied clinical notes
- WHEN the denial occurs
- THEN a denied entry exists

#### Scenario: Logging failure blocks the clinical action
- GIVEN the audit trail cannot be written
- WHEN a clinical read or write is requested
- THEN the action MUST NOT proceed without an audit entry

### Requirement: Synchronous, fail-closed writing

The audit entry for an action in the mandatory list MUST be durably written as part of that action, before the action's result is returned to the caller (synchronous write). If the entry cannot be written, the action MUST fail and its effects MUST NOT persist (fail closed). This applies to clinical reads and writes, role, permission and sharing changes, exports, archive access and support access. A denied attempt MUST be recorded even though the request itself fails and rolls back: its audit entry MUST be persisted independently of the outcome of the request's own transaction. If a denial cannot be recorded, the denial MUST still be returned (access is never granted because auditing failed) and the failure MUST raise an alert to the platform operator.

#### Scenario: Audit write fails on a clinical read
- GIVEN the audit store is unavailable
- WHEN a professional opens a clinical entry
- THEN the read fails with a generic error and no content is returned

#### Scenario: Denied attempt survives rollback
- GIVEN a request that is denied and whose own transaction is rolled back
- WHEN the denial is processed
- THEN the denied entry exists in the audit log

#### Scenario: Denial recording fails
- GIVEN a denied clinical access attempt and an audit store that cannot be written
- WHEN the denial is processed
- THEN access is still denied
- AND an alert is raised for the platform operator

#### Scenario: Entry is durable before the response
- GIVEN a successful clinical write
- WHEN the caller receives the success response
- THEN the audit entry for the write already exists

### Requirement: Entry content

Each entry MUST include timestamp, acting user and role, organization, action, resource type and identifier, outcome (allowed or denied), and origin. For change events the entry MUST identify what changed, and SHOULD record changed field names. The entry MUST NOT contain clinical note content, passwords, tokens or secrets.

#### Scenario: Update entry shows what changed, not content
- GIVEN a patient's phone number is edited
- WHEN the entry is written
- THEN it lists the field name and references versions
- AND it contains no clinical note text

### Requirement: Append-only and tamper-evident

Audit entries MUST NOT be edited or deleted by any user, role or operator through the product. The audit log MUST be tamper-evident: entries MUST be chained in a verifiable sequence and sealed shortly after being written, so that an integrity verification can detect any alteration, removal or reordering. The verification MUST be runnable on demand by the platform and its result reviewable by the platform operator. Sealing happens asynchronously and MUST NOT delay or block the synchronous write above; an entry not yet sealed is still durable and visible. The only permitted removal is the demo tenant reset (`demo-tenant`), which MUST NOT break the verification of any other tenant's entries or of platform-level entries.

#### Scenario: Attempt to edit or delete an entry
- GIVEN an owner viewing the audit log
- WHEN the owner tries to modify or delete an entry
- THEN no such action exists and any attempt through any path is refused

#### Scenario: Tampering is detected
- GIVEN an entry altered or removed directly in storage
- WHEN the integrity verification runs
- THEN it reports the broken sequence and where it breaks

#### Scenario: Unsealed entries are still visible
- GIVEN a new entry that has not been sealed yet
- WHEN an authorized owner filters the log
- THEN the entry appears and is marked as pending sealing

### Requirement: Retention of at least 10 years

Audit entries about clinical records MUST be retained for at least 10 years after the patient's last encounter. Entries MUST survive user deactivation and tenant cancellation, remaining in the retention archive. The explicit exceptions to retention are those listed in `tenancy` (demo reset, unverified signup purge, legally required erasure, abandoned online-booking submissions); no other path removes audit entries.

#### Scenario: Deactivated actor
- GIVEN a staff member was deactivated
- WHEN their past entries are viewed
- THEN the entries remain with the actor's identity preserved

### Requirement: Tenant-scoped access to the log

An organization's audit log MUST be visible only to that organization's owner/admin (and to the platform operator only under an explicit support grant). The audit log MUST NOT reveal clinical content to a non-clinical admin.

#### Scenario: Cross-tenant view
- GIVEN owners of organizations 1 and 2
- WHEN each views the audit log
- THEN each sees only their own organization's entries

#### Scenario: Admin sees activity, not content
- GIVEN a non-clinical admin viewing entries about clinical reads
- WHEN they are displayed
- THEN the admin sees who accessed which patient and when, never the notes

### Requirement: Searchable and exportable log

Authorized viewers MUST be able to filter by user, patient, action, outcome and date range, and export the filtered set. Exports MUST themselves be audited.

#### Scenario: Filter by patient
- GIVEN a patient requests to know who accessed their record
- WHEN an authorized owner filters by that patient
- THEN all access entries for that patient are listed in time order

#### Scenario: Export is audited
- GIVEN an owner exports the audit log
- WHEN the export completes
- THEN an export entry is written
