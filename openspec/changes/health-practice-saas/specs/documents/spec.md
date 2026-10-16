# Documents Specification (delta)

Stage 2. Covers patient attachments: upload, validation, private storage, access through short-lived links, classification, replacement and retention.

**Reads from other capabilities** (not defined here): clinical-access rules (`authorization`, `clinical-records`), audit trail (`audit-log`), patient identity (`patients`), organization isolation (`tenancy`).

## Quick reference

| Topic | Rule |
|---|---|
| Storage | Private. Never publicly addressable. |
| Access | Through links valid for 5 minutes and bound to the requester's session, issued after an authorization check. A link is never a bearer URL. |
| Malware | Every upload is scanned. Nothing is available until the scan passes (fail closed). |
| Lists | Metadata only. File content is never embedded in lists. |
| Types and size | Whitelisted types, capped size (defaults below, configurable by the platform) |
| Deletion | No hard delete. Replaced or hidden with a retained original. |

Default limits (platform-configurable): maximum 20 MB per file; allowed types PDF, JPEG, PNG, WebP, plain text and DOCX.

## ADDED Requirements

### Requirement: Upload and association

An authorized user MUST be able to upload a document to a patient of their organization, optionally linking it to an encounter or an appointment. Each document MUST record uploader, upload time (server clock), original file name, size, detected content type, category and the patient and organization it belongs to. Organization and uploader MUST come from the authenticated session. A single upload request MUST accept a bounded number of files (default 10). A document MUST belong to exactly one patient.

#### Scenario: Professional attaches a lab result
- GIVEN a professional with access to patient X
- WHEN they upload a PDF of 2 MB categorized "lab result" linked to an encounter
- THEN the document is stored and appears in X's document list with its metadata
- AND the upload is audited

#### Scenario: Patient from another organization
- GIVEN a user in organization A
- WHEN they upload a document to a patient identifier of organization B
- THEN the system responds as not found and stores nothing

#### Scenario: Too many files
- GIVEN the per-request limit is 10
- WHEN a user submits 11 files in one request
- THEN the request is rejected and no file is stored

---

### Requirement: Type and size validation

The system MUST accept only whitelisted file types and MUST reject all others. The type MUST be determined from file content, not from the file name or the declared type alone; a mismatch between declared and detected type MUST be rejected. Files larger than the size cap MUST be rejected before being fully stored. Executable, script and archive formats MUST NOT be allowed. File names MUST be sanitized and MUST NOT influence the storage location. A rejected upload MUST leave no stored object and no orphan record. The rejection message MUST state the reason (type or size) in es-AR. The system MUST scan every upload for malware before it becomes available. A newly uploaded document MUST start quarantined and MUST become available only after the scan passes; an infected file MUST be rejected or kept quarantined and never offered for download. If scanning is unavailable or fails, the document MUST stay quarantined and unavailable until it is scanned (the check fails closed); the system MUST NOT release an unscanned file.

#### Scenario: File too large
- GIVEN a size cap of 20 MB
- WHEN a user uploads a 35 MB PDF
- THEN the upload is rejected with a message stating the maximum size
- AND nothing is stored

#### Scenario: Disallowed type
- GIVEN the whitelist excludes executables
- WHEN a user uploads "report.exe"
- THEN the upload is rejected with a message listing the allowed types

#### Scenario: Disguised file
- GIVEN a file named "scan.pdf" whose content is an executable
- WHEN a user uploads it
- THEN the upload is rejected because the detected type is not allowed

#### Scenario: Path traversal in file name
- GIVEN a file named "../../other-tenant/file.pdf"
- WHEN a user uploads it
- THEN the stored name is sanitized and the file is stored only under the patient's own scope

#### Scenario: Infected file
- GIVEN an upload that the malware scan flags
- WHEN the scan completes
- THEN the document is rejected or quarantined, never offered for download, and the uploader is notified

#### Scenario: Scanner unavailable
- GIVEN the malware scanner cannot be reached
- WHEN a user uploads a PDF
- THEN the document is stored as quarantined and is not downloadable
- AND it becomes available automatically only after a successful scan

#### Scenario: Quarantined document in lists
- GIVEN a document still awaiting its scan
- WHEN the document list is shown
- THEN it appears with a "pending scan" marker and no download action

---

### Requirement: Private storage and short-lived access

Documents MUST be stored privately with encryption at rest and MUST NOT be reachable by any permanent public address. A download MUST first pass the authorization check for the specific document; on success the system issues a short-lived access link (validity 5 minutes) bound to the requesting authenticated session (a staff user's session, or a patient's portal session). Possession of the link alone MUST NOT be enough: an expired link, a link used from a different session or user, a link used without a session, or a link for a document the user is no longer authorized to read MUST be refused, so a forwarded link is useless. Document lists and patient views MUST return metadata only and MUST NOT embed file content. Each download MUST be audited.

#### Scenario: Authorized download
- GIVEN a professional authorized for a clinical document
- WHEN they request the file
- THEN they receive a short-lived link that serves the file
- AND the download is audited

#### Scenario: Expired link
- GIVEN a link issued 10 minutes ago with a 5-minute validity
- WHEN it is used
- THEN access is refused

#### Scenario: Shared link
- GIVEN a link issued to user U1
- WHEN user U2 tries to use it
- THEN access is refused

#### Scenario: Link used without a session
- GIVEN a link issued to U1 and pasted into a browser that has no session
- WHEN it is opened
- THEN access is refused

#### Scenario: Guessing identifiers
- GIVEN a user in organization A
- WHEN they request a document identifier from organization B
- THEN the system responds as not found without revealing whether it exists

#### Scenario: Lists carry no content
- GIVEN a patient with 50 documents
- WHEN a user opens the document list
- THEN each row shows name, category, size, date and uploader
- AND no file content is included in the response

---

### Requirement: Classification and access rules

Each document MUST be classified as clinical or administrative at upload by the uploader. Clinical documents (for example lab results, imaging, referrals, clinical reports) MUST follow the clinical-access rules: only health professionals within `clinical-records` rules can read them; a non-clinical owner/admin and reception MUST NOT read them. Administrative documents (for example ID copy, coverage card, signed administrative forms) MAY be read by reception and by users with patient-administration permission. Reception MAY see the existence, name and category of a clinical document only if the organization setting "reception sees clinical metadata" (`authorization`) is on; reception MUST NOT be able to download it. A non-clinical owner/admin MUST NOT see clinical document metadata linked to a patient. Uploads by reception MUST be restricted to administrative documents. Reclassification MUST be audited and MUST be done by a health professional.

#### Scenario: Reception uploads an ID copy
- GIVEN a reception user
- WHEN they upload a coverage card as "administrative"
- THEN the document is stored and readable by reception and professionals

#### Scenario: Reception tries to upload a clinical document
- GIVEN a reception user
- WHEN they select category "lab result"
- THEN the system rejects the upload

#### Scenario: Admin tries to download a clinical document
- GIVEN a non-clinical owner/admin
- WHEN they request a clinical document of any patient
- THEN access is denied and the attempt is audited

#### Scenario: Reception downloads a clinical document
- GIVEN a clinical document exists for patient X
- WHEN a reception user requests its file
- THEN access is denied and no link is issued

---

### Requirement: Immutability, replacement and removal

An uploaded document's content MUST NOT be modifiable. A user MAY upload a new version that is linked to the previous one; all versions MUST be retained. A user MAY hide a document from default views with a mandatory reason when it was uploaded in error; the file and its metadata MUST be retained and the hiding MUST be audited. A document MUST NOT be hard-deleted by users. Documents attached to a signed encounter MUST remain associated with it.

#### Scenario: Upload a corrected version
- GIVEN a document "lab-2026-10.pdf"
- WHEN the uploader adds a new version
- THEN the list shows the latest version and offers access to the previous version

#### Scenario: Hide a wrongly uploaded document
- GIVEN a document uploaded to the wrong patient
- WHEN an authorized user hides it with the reason "wrong patient"
- THEN it disappears from default views
- AND the file, metadata, reason and actor are retained and audited

#### Scenario: Hard delete requested
- GIVEN any role
- WHEN a hard delete of a document is requested
- THEN the request is rejected

---

### Requirement: Duplicate detection and interrupted uploads

The system SHOULD detect an identical file (same content hash) already stored for the same patient and warn the uploader, allowing them to proceed. Uploads that are interrupted or never completed MUST NOT leave visible records, and temporary data SHOULD be cleaned automatically.

#### Scenario: Duplicate warning
- GIVEN patient X already has file F
- WHEN a user uploads an identical file
- THEN the system warns of a duplicate and lets the user cancel or continue

#### Scenario: Interrupted upload
- GIVEN an upload that stops halfway due to a network failure
- WHEN the patient's document list is reloaded
- THEN no partial document appears

---

### Requirement: Retention, export and tenant lifecycle

Documents MUST be retained for at least the same period as clinical records (10 years after the patient's last encounter). In the read-only (non-payment) state, listing and downloading documents MUST remain available to authorized users and new uploads are refused per the allowlist in `tenancy`. On tenant cancellation, administrative documents MUST be included in the administrative export and clinical documents in the clinical export of the treating professionals, and all of them in the read-only retention archive (see `tenancy`). Access to archived documents MUST be audited.

#### Scenario: Read-only tenant can still download
- GIVEN an organization in read-only status after the grace period
- WHEN an authorized professional downloads a clinical document
- THEN the download succeeds
- AND new uploads are rejected with a read-only message

#### Scenario: Cancellation export
- GIVEN a tenant being cancelled
- WHEN the exports are generated
- THEN every document (including hidden ones) and its metadata, including previous versions, is included in the part of the export that matches its classification
