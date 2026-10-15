# Clinical Records Specification (delta)

Stage 2. Covers encounter notes, specialty templates, signing, immutability with addenda, versioning, access rules, audit and retention for clinical content.

**Reads from other capabilities** (not defined here): who is a health professional and what each role may read (`authorization`), patient identity and anamnesis (`patients`), attachments (`documents`), the append-only trail (`audit-log`), appointments (`scheduling`).

## Quick reference

| Topic | Rule |
|---|---|
| Who can read | Only health professionals, within clinical-access rules. Never a non-clinical owner/admin. Never reception. |
| Scope of reading | Treating professionals (care relationship); other professionals read-only and only under the sharing scope (`authorization`) |
| Care relationship sources | (1) an identity-confirmed appointment that is scheduled, confirmed, checked in, in progress, attended or no-show; (2) an encounter; (3) an explicit assignment. Pending approval, cancelled and identity-unconfirmed appointments never count (`authorization`). |
| Signed entries | Immutable. Corrected only by addenda, which only treating professionals may add. |
| Read-only tenant | Reading and exporting stay available. New encounters and other clinical writes are refused, except rectification addenda by treating professionals (D16). |
| Deletion | Never. Wrong entries are marked "entered in error" and retained. |
| Search | Per patient, over one patient's record only. No cross-patient clinical text search in v1. |
| Retention | At least 10 years after the patient's last encounter |
| Audit | 100% of reads and writes, including denied attempts |

## ADDED Requirements

### Requirement: Encounter notes

A health professional MUST be able to create an encounter note for a patient of their organization, optionally linked to an appointment. A generic encounter MUST support at least: reason for consultation, symptoms or findings, measurements (free-form key/value with units), diagnosis, treatment or plan, and medications. The author MUST be taken from the authenticated session and recorded together with the creation time from the server clock. Opening an encounter from an appointment in progress SHOULD prefill patient and appointment references. An encounter MUST belong to exactly one patient and one organization.

#### Scenario: Create a generic encounter from an appointment
- GIVEN a professional with an appointment "in progress" for patient X
- WHEN they open "New encounter" from the appointment
- THEN a draft encounter is created for patient X linked to the appointment
- AND author and server timestamp are recorded

#### Scenario: Author cannot be spoofed
- GIVEN a request body that contains a different author identifier
- WHEN the professional saves the encounter
- THEN the author is the authenticated professional and the body value is ignored

#### Scenario: Patient of another organization
- GIVEN a professional in organization A
- WHEN they try to create an encounter for a patient of organization B
- THEN the system responds as if the patient does not exist and creates nothing

---

### Requirement: Clinical access restriction

Only users holding a health-professional role MUST be able to read the content of clinical entries. A non-clinical owner/admin MUST NEVER read clinical content on any path (screen, search, export, report, API), and no organization setting SHALL grant it. Reception MUST NEVER read clinical content, titles, diagnoses or snippets. A user who is both owner/admin and professional MUST read clinical data only through the professional role and its rules. By default a professional MUST read clinical records only of patients they treat, where "treating professional" and "care relationship" are defined by `authorization`. The care relationship MUST come only from these sources: (1) an appointment with the professional whose identity is confirmed and whose status is scheduled, confirmed, checked in, in progress, attended or no-show; (2) an encounter by the professional; (3) an explicit assignment. Pending-approval, cancelled and identity-unconfirmed appointments MUST NOT create one. If the organization enables sharing, other professionals of the organization MAY read the records read-only, within the sharing scope and per-entry visibility defined by `authorization` (including the default exclusion of psychology entries and entries restricted to their author), and every such shared read MUST be audited with a distinct marker. Demographics are not clinical content and are organization-wide. The platform operator MUST NOT have default access; any support access MUST be explicit, time-boxed and audited.

#### Scenario: Non-clinical admin is denied
- GIVEN a user whose only role is owner/admin
- WHEN they request a patient's encounters through the screen or the API
- THEN access is denied with no clinical data in the response
- AND the denied attempt is audited

#### Scenario: Reception sees attendance but not content
- GIVEN a reception user viewing a patient who has attended an encounter
- WHEN they open the patient's record
- THEN they see attendance and schedule data
- AND no clinical entry content, title or diagnosis is shown

#### Scenario: Professional reads a colleague's patient without sharing
- GIVEN sharing is off and patient Y is only attended by professional P2
- WHEN professional P1 requests Y's encounters
- THEN access is denied and audited

#### Scenario: Shared read when sharing is on
- GIVEN the organization enabled sharing, the generic template is in the shared scope and P1 is not Y's treating professional
- WHEN P1 opens Y's encounters
- THEN the content is shown read-only
- AND the audit entry is marked as a shared read with reader, patient and entries accessed

#### Scenario: Colleague with an appointment is a treating professional
- GIVEN sharing is off and reception booked a scheduled appointment of Y with P1
- WHEN P1 opens Y's encounters
- THEN the content is shown, because P1 is now a treating professional

#### Scenario: Unconfirmed online booking gives no access
- GIVEN sharing is off and Y's only link to P1 is an online booking matched to Y's existing record whose identity is not yet confirmed
- WHEN P1 opens Y's encounters
- THEN access is denied and audited

#### Scenario: Owner who is also a professional
- GIVEN a user with both owner/admin and professional roles
- WHEN they open a patient who is not theirs while sharing is off
- THEN access is denied, because owner status adds no clinical rights

#### Scenario: Cross-tenant clinical read
- GIVEN a professional in organization A
- WHEN they request an encounter identifier belonging to organization B
- THEN the system responds as not found

---

### Requirement: Draft, signing and immutability

An encounter MUST start as a draft. A draft MAY be edited only by its author. Retaining intermediate draft revisions is optional (MAY); what is mandatory is that the content at the moment of signing is retained in full and that the draft carries a revision marker used to detect concurrent edits. Signing MUST be performed by the author, MUST record the signer, the server time and the template version, and MUST make the entry immutable. A signed entry MUST NOT be modifiable or deletable by any role, via any path, including the platform operator. The system SHOULD require a recent re-authentication to sign (see `identity-access`). The system MUST reject a signature on an entry that is empty of required fields defined by its template. Concurrent edits to the same draft MUST be detected and the later saving session MUST be warned and not overwrite silently.

#### Scenario: Sign a draft
- GIVEN a complete draft by professional P
- WHEN P signs it
- THEN the status becomes "signed" with signer and server timestamp
- AND subsequent edit attempts are rejected

#### Scenario: Edit attempt on a signed entry
- GIVEN a signed encounter
- WHEN any user (including the author or an administrator) sends an update or delete
- THEN the request is rejected, the entry is unchanged, and the attempt is audited

#### Scenario: Only the author edits the draft
- GIVEN a draft by P1
- WHEN P2 (even with shared read access) tries to edit it
- THEN the edit is rejected

#### Scenario: Missing required fields
- GIVEN a draft that lacks the template's required field "reason for consultation"
- WHEN the author tries to sign
- THEN signing is rejected and the missing field is indicated

#### Scenario: Concurrent draft edits
- GIVEN the same draft open in two sessions by the author
- WHEN the second session saves after the first already saved
- THEN the second save is flagged as based on an outdated revision and nothing is overwritten without the author's decision

---

### Requirement: Addenda and corrections

A treating professional (care relationship, see `authorization`) MUST be able to add an addendum to a signed entry. Shared access is read-only: a professional who can read the entry only because of organization-wide sharing MUST NOT be able to add an addendum. An addendum MUST be a separate, signed-on-save entry linked to the original, with its own author, server timestamp and a mandatory reason. The original entry and all previous addenda MUST remain unchanged and visible, and the entry view MUST present the original together with its addenda in chronological order. An addendum itself MUST be immutable; corrections to it are made with a further addendum. If an entry was created on the wrong patient or is invalid as a whole, its author, or another treating professional, MUST be able to mark it "entered in error" with a reason. "Entered in error" is a status of the entry (alongside draft and signed) recorded as a history event; the entry MUST stay retained and readable by authorized professionals but MUST be excluded from the default timeline and from exports unless explicitly included. Marking an entry in error MUST NOT alter its content.

#### Scenario: Correct a diagnosis with an addendum
- GIVEN a signed encounter with diagnosis "A"
- WHEN the author adds an addendum with the reason "Corrected diagnosis" and the text "Diagnosis is B"
- THEN the original still shows "A"
- AND the addendum is displayed after it with author and time

#### Scenario: Addendum without reason
- GIVEN a signed encounter
- WHEN a professional submits an addendum with no reason
- THEN the addendum is rejected

#### Scenario: Another treating professional adds an addendum
- GIVEN P2 has a care relationship with the patient and can read P1's signed entry
- WHEN P2 adds an addendum to P1's signed entry
- THEN the addendum is attributed to P2 and the original is unchanged

#### Scenario: Shared reader cannot add an addendum
- GIVEN sharing is on and P3 can read the record only through sharing
- WHEN P3 tries to add an addendum to P1's signed entry
- THEN the action is denied and audited

#### Scenario: Entry on the wrong patient
- GIVEN a signed encounter recorded on patient X by mistake
- WHEN the author marks it "entered in error" with a reason
- THEN it disappears from X's default timeline
- AND it is still retained, retrievable by authorized professionals and audited

---

### Requirement: Version history

The system MUST keep the full history of every clinical entry: all addenda, "entered in error" marks and, for specialty templates, all changes to structured data (for example odontogram changes). The history MUST be viewable by authorized professionals, with actor and server time per change. Version history MUST NOT be removable.

#### Scenario: Browse history
- GIVEN an encounter with one original and two addenda
- WHEN an authorized professional opens its history
- THEN all three versions appear in order with authors and times

#### Scenario: History cannot be purged
- GIVEN any role including owner/admin
- WHEN a request is made to delete a historical version
- THEN the request is rejected

---

### Requirement: Specialty templates

The system MUST provide clinical templates selectable per encounter. It MUST include a generic template and specialty templates for odontology (odontogram), psychology, physiotherapy and nutrition. A template MUST define its fields, required fields and version. An entry MUST be bound to the exact template version used at creation, so later template changes do not alter existing entries. An organization MUST be able to enable or disable templates, and each professional SHALL be offered the templates matching their specialties plus the generic one. A professional with several specialties MUST be able to use the templates of all of them. Template labels MUST be es-AR. Specialty template choice MUST be possible even for a professional whose specialty is not listed, falling back to generic.

#### Scenario: Offer templates by specialty
- GIVEN a professional registered as physiotherapist and nutritionist
- WHEN they start an encounter
- THEN the generic, physiotherapy and nutrition templates are offered
- AND the odontogram and psychology templates are not

#### Scenario: Template changes do not alter old entries
- GIVEN a signed entry created with physiotherapy template version 1
- WHEN the platform publishes version 2 with a new field
- THEN the old entry still renders using version 1

#### Scenario: Template disabled by the organization
- GIVEN the organization disabled the psychology template
- WHEN a psychologist starts an encounter
- THEN the psychology template is not offered and existing entries stay readable

---

### Requirement: Odontogram template

The odontology template MUST provide a tooth chart using FDI notation covering permanent and primary dentition. For each tooth the professional MUST be able to record a condition (for example healthy, caries, restoration, crown, extraction, implant, missing) and, per surface, findings and treatments. Each odontogram entry MUST record the date and author. The current state of the odontogram MUST be derived from the chronological series of signed entries and MUST NOT overwrite earlier signed states. The chart MUST allow free-text notes and a treatment plan.

#### Scenario: Record a finding on a tooth surface
- GIVEN an odontology encounter in draft for patient X
- WHEN the professional marks tooth 16, occlusal surface, as "caries"
- THEN the finding is stored on the draft with date and author

#### Scenario: Evolving odontogram
- GIVEN a signed encounter showing tooth 16 with "caries"
- WHEN a later signed encounter records tooth 16 as "restoration"
- THEN the current chart shows "restoration"
- AND the earlier signed encounter still shows "caries"

#### Scenario: Invalid tooth code
- GIVEN an odontogram in edit
- WHEN a tooth code outside the FDI set is submitted
- THEN the input is rejected with a validation message

---

### Requirement: Psychology template

The psychology template MUST support session records with at least: session date, modality (in person or virtual), topics addressed, observations, risk assessment (none, low, medium, high) and plan or tasks. If the risk is recorded as medium or high, the author SHOULD be prompted for a follow-up note before signing. Access to psychology entries MUST follow the same clinical-access rules; sharing, when enabled by the organization, MUST apply to psychology entries only if the organization explicitly includes this template in the shared scope (see the visibility model in `authorization`). By default psychology entries SHALL NOT be shared with professionals who do not treat the patient. The author MAY additionally restrict any entry to the author alone, at creation or while it is a draft (`authorization`).

#### Scenario: Record a session with risk
- GIVEN a psychologist creating a session entry
- WHEN they set risk to "high"
- THEN the system prompts for a follow-up note before allowing signature

#### Scenario: Sharing excludes psychology by default
- GIVEN sharing is on and no template scope is configured
- WHEN a non-treating professional opens the patient's record
- THEN psychology entries are not shown to them

---

### Requirement: Physiotherapy template

The physiotherapy template MUST support: pain intensity on a 0-10 numeric scale, affected region, range of motion per joint (value and unit), functional tests, procedures applied per session, session number within a treatment plan, and plan goals. Pain values outside 0-10 MUST be rejected. The system SHOULD present the evolution of pain and range of motion across sessions for the same region.

#### Scenario: Valid session
- GIVEN a physiotherapy encounter in draft
- WHEN the professional records pain 6, region "right knee" and session 3 of 10
- THEN the values are saved

#### Scenario: Out-of-range pain
- GIVEN a physiotherapy encounter in draft
- WHEN pain 11 is submitted
- THEN the input is rejected

---

### Requirement: Nutrition template

The nutrition template MUST support: weight, height, calculated body mass index, waist circumference (optional), dietary habits, allergies and intolerances, goals, and a meal plan. BMI MUST be computed by the system from weight and height and MUST NOT be directly editable. Weight and height MUST be positive and plausibly bounded (a value outside configured limits MUST prompt a confirmation). The system SHOULD present the evolution of weight and BMI over time for the patient.

#### Scenario: BMI is computed
- GIVEN a nutrition encounter with weight 70 kg and height 1.75 m
- WHEN the professional saves
- THEN BMI is shown as 22.9
- AND the BMI field cannot be edited manually

#### Scenario: Implausible value
- GIVEN a nutrition encounter in draft
- WHEN height 17.5 m is entered
- THEN the system requires a correction or an explicit confirmation before saving

---

### Requirement: Patient clinical timeline and anamnesis link

A professional who may read a patient's clinical record MUST see a chronological timeline of the patient's signed encounters, addenda and attachments, limited to what the visibility model allows them to read. The timeline MUST show the anamnesis maintained by `patients` for context and MUST NOT duplicate it as clinical entries. Opening the timeline MUST audit a read per entry shown.

Search over clinical content MUST be per patient: it is offered inside one patient's record, runs only over that patient's entries the user is authorized to read, and MUST NOT return entries of other patients. Cross-patient search over clinical text (searching the content of all patients at once) is out of scope for v1 and MUST NOT be offered through any screen or API. Searching for patients by name, document or phone is demographic search handled by `patients` and never matches clinical content.

#### Scenario: Timeline order
- GIVEN a patient with three signed encounters
- WHEN their treating professional opens the timeline
- THEN encounters appear in chronological order with addenda attached

#### Scenario: Per-patient search
- GIVEN professional P1 is a treating professional of patient X
- WHEN P1 searches X's record for the term "hypertension"
- THEN only X's readable entries containing the term are returned

#### Scenario: Search honors visibility
- GIVEN X has an entry restricted to its author P2 that contains "hypertension"
- WHEN P1 searches X's record for the term
- THEN that entry is not returned and no match count reveals it

#### Scenario: No cross-patient clinical search
- GIVEN a professional with many patients
- WHEN they look for a way to search all patients' notes for "hypertension"
- THEN no such search exists on any screen or API

#### Scenario: Reception cannot search clinical content
- GIVEN a reception user
- WHEN they submit a clinical-content search
- THEN the system denies the request

---

### Requirement: Audit of clinical access

Every read, creation, signature, addendum and "entered in error" action on clinical records MUST be written to the audit log (`audit-log`), with actor, organization, patient, entry, action and server time. Denied attempts MUST be audited as well. Audit entries MUST NOT contain clinical content. A user MUST NOT be able to turn off clinical audit. A clinical read or write MUST NOT complete unless its audit entry was durably written (see `audit-log`).

#### Scenario: Read audited
- GIVEN a treating professional
- WHEN they open an encounter
- THEN an audit entry records actor, patient, entry and action "read"

#### Scenario: Audit has no clinical payload
- GIVEN an audit entry for a signed encounter
- WHEN an auditor inspects it
- THEN it holds identifiers and metadata only, never the diagnosis or note text

---

### Requirement: Retention and availability

Clinical entries, addenda, versions and their audit trail MUST be retained for at least 10 years after the patient's last encounter. They MUST NOT be hard-deleted. When an organization is in read-only status due to non-payment, reading and exporting clinical records MUST remain available to authorized professionals, and creating or changing clinical records is governed by the read-only allowlist in `tenancy`. Because rectification is a patient right under Ley 26.529 (D16), a treating professional MAY add an addendum marked as a rectification of a patient's request while the tenant is read-only. New encounters, drafts, signatures, other addenda and "entered in error" marks MUST be refused. When an organization is cancelled, clinical records MUST be delivered through the clinical part of the cancellation export (each professional receives the records of their own patients; PDF and structured data) and MUST be placed in the platform's read-only retention archive (see `tenancy`). A patient request for rectification of clinical data MUST be satisfied through an addendum, not by editing the original.

#### Scenario: Delete request
- GIVEN any role
- WHEN a hard delete of a clinical entry is requested
- THEN the request is rejected and nothing changes

#### Scenario: Read-only tenant keeps clinical access
- GIVEN an organization in read-only status after the grace period
- WHEN a treating professional opens and exports a patient's record
- THEN both actions succeed
- AND creating a new encounter is rejected with a message that the account is read-only

#### Scenario: Rectification request
- GIVEN a patient asks the professional to correct a mis-recorded allergy in a signed entry
- WHEN the professional processes the request
- THEN the correction is stored as an addendum and the original is unchanged

#### Scenario: Rectification while read-only
- GIVEN an organization in read-only status and a patient who asks their treating professional to rectify a signed entry
- WHEN the professional adds an addendum marked as a rectification
- THEN the addendum is stored and audited

#### Scenario: Ordinary addendum while read-only
- GIVEN an organization in read-only status
- WHEN a treating professional adds an addendum that is not a rectification
- THEN it is refused with a message that the account is read-only
