# Teleconsultation Specification (delta)

Stage 3. Covers video links attached to virtual appointments, delivered to the patient and the professional. Video infrastructure is a third-party provider and is out of scope (non-goal: in-house video).

**Reads from other capabilities** (not defined here): appointment lifecycle (`scheduling`), message delivery (`notifications`), clinical notes (`clinical-records`), role permissions (`authorization`), audit (`audit-log`), integration switch per tenant (`tenancy`).

## Quick reference

| Topic | Rule |
|---|---|
| Scope | A link per virtual appointment. The product stores no audio or video. |
| Access | Patient and the assigned professional only, through unguessable links |
| Lifecycle | Created with the appointment, regenerated on reschedule, revoked on cancellation |
| Fallback | If the provider fails, the professional can paste a manual link |
| Clinical content | Never sent to the provider |

## ADDED Requirements

### Requirement: Virtual appointment mode

An appointment type MUST be configurable as in person or virtual. A virtual appointment MUST have a video link before its reminders are sent. The system MUST create the link through the configured video provider when the virtual appointment is created or when its mode changes to virtual. The link MUST be tied to exactly one appointment. The video session name or metadata sent to the provider MUST NOT contain the patient's name, national identifier, diagnosis or any clinical data; it MUST use an opaque identifier. Changing a virtual appointment to in person MUST revoke the link.

#### Scenario: Link created with the appointment
- GIVEN a virtual appointment type
- WHEN reception books it
- THEN the appointment holds a video link
- AND the provider session carries only an opaque identifier

#### Scenario: Mode changed to in person
- GIVEN a virtual appointment with a link
- WHEN reception changes the appointment to in person
- THEN the link is revoked and reminders no longer include it

#### Scenario: No clinical data to the provider
- GIVEN an appointment for patient "Ana Gomez" with a recorded diagnosis
- WHEN the link is created
- THEN no patient name or diagnosis is sent to the provider

---

### Requirement: Link access and validity

The address given to the patient and the professional MUST be a platform join address for the appointment, not the video provider's own session address. The platform join address MUST forward to the provider session only while the join window is open and MUST NOT disclose the provider session address outside it. The provider session identifier (room name) MUST change whenever the appointment is rescheduled, so an old address can never reach the new session. The same platform join address MUST wrap a manual fallback link. Only the assigned professional and the appointment's patient MUST be able to obtain the link. The professional MUST see a "Join" action on the appointment while it is within the join window (default from 15 minutes before the start until 60 minutes after the scheduled end). The patient link MUST be delivered through `notifications` and through the single-appointment page of the confirmation link; it MUST be unguessable and MUST be valid only for the join window. Opening a link outside the window MUST show a clear message with the allowed time. Reception and a non-clinical owner/admin MAY see that an appointment is virtual and whether a link exists, but MUST NOT be offered the join action as a participant unless they are the assigned professional. The link MUST NOT be exposed in lists and calendars visible to other roles.

#### Scenario: Professional joins within the window
- GIVEN a virtual appointment at 10:00
- WHEN the assigned professional opens it at 09:50
- THEN a "Join" action leads to the video session

#### Scenario: Patient opens early
- GIVEN the join window starts at 09:45
- WHEN the patient opens the link at 09:00
- THEN the page tells the patient the session opens at 09:45 and does not start a session

#### Scenario: Link after the window
- GIVEN the appointment ended two hours ago
- WHEN the link is opened
- THEN the system shows that the session is closed

#### Scenario: Provider address not exposed early
- GIVEN the join window opens at 09:45
- WHEN the patient opens the platform join address at 09:00
- THEN no provider session address is revealed in the page or the response

#### Scenario: Room changes on reschedule
- GIVEN a virtual appointment with provider room R1
- WHEN it is rescheduled
- THEN the new session uses a different room R2
- AND an old join address cannot reach R2

#### Scenario: Another professional
- GIVEN a virtual appointment of professional P1
- WHEN professional P2 requests the link
- THEN the request is denied unless P2 is the assigned professional

#### Scenario: Link not exposed in calendar
- GIVEN reception views the day calendar
- WHEN it contains virtual appointments
- THEN each shows a "virtual" marker and no video link

---

### Requirement: Link lifecycle on reschedule and cancellation

Rescheduling a virtual appointment MUST invalidate the previous link and generate a new link bound to the new time; reminders MUST then contain only the new link. Cancelling, a no-show or finishing an appointment MUST close the link for new joins. Reassigning the appointment to another professional MUST invalidate the old link for the previous professional. Links MUST NOT be reused across appointments.

#### Scenario: Reschedule regenerates the link
- GIVEN a virtual appointment on Tuesday with link L1
- WHEN it is moved to Thursday
- THEN L1 stops working and a new link L2 is bound to Thursday
- AND the patient receives L2 in the updated reminder

#### Scenario: Cancelled appointment
- GIVEN a virtual appointment with link L
- WHEN the appointment is cancelled
- THEN L no longer lets anyone join

#### Scenario: Reassignment
- GIVEN a virtual appointment reassigned from P1 to P2
- WHEN P1 tries to join through the old link
- THEN access is denied

---

### Requirement: Provider failure and manual fallback

If link creation fails, the system MUST retry transient failures and, if it still fails, MUST mark the appointment as "link pending" and show reception and the assigned professional an actionable alert. The assigned professional or reception MUST be able to attach a manual link (https only) to the appointment as a fallback; the manual link MUST be validated for format and allowed provider domains configured by the platform. Reminders MUST NOT be sent for a virtual appointment without a link unless the message states that the link will be sent separately. The integration MUST be switchable per tenant; when it is off, virtual types MAY still be used with manual links.

#### Scenario: Provider down
- GIVEN the provider returns an error on creation
- WHEN retries are exhausted
- THEN the appointment is marked "link pending" and the professional and reception see an alert

#### Scenario: Manual link
- GIVEN an appointment in "link pending"
- WHEN the professional pastes a valid https link from an allowed domain
- THEN the appointment holds that link and reminders include it

#### Scenario: Unsafe manual link
- GIVEN a pasted link with a non-https scheme or an unlisted domain
- WHEN the user saves
- THEN the system rejects it

#### Scenario: Integration off
- GIVEN the video integration is disabled for the tenant
- WHEN reception books a virtual appointment
- THEN no provider call occurs and the appointment is marked "link pending" until a manual link is attached

---

### Requirement: Privacy and consent in teleconsultation

The product MUST NOT record or store audio or video of a session, and MUST NOT enable provider-side recording by default. Before the first virtual appointment, the patient MUST be informed in es-AR that the consultation takes place over a third-party video service, and the information MUST be shown on the join page. Clinical notes taken during a virtual appointment MUST be stored only in `clinical-records` and follow its access rules; the video provider MUST NOT receive them. Link usage events (created, opened, revoked, joined by the professional) MUST be audited without storing the link token itself in clear text. The organization's choice of provider MUST be disclosed in the tenant's data-processing information where required by the data-transfer rules.

#### Scenario: Patient information on join
- GIVEN a patient opens the join page for the first time
- WHEN the page loads
- THEN it displays, in es-AR, a notice that the session uses a third-party video service and is not recorded by the product

#### Scenario: Recording not enabled
- GIVEN a session created by the product
- WHEN the provider session settings are inspected
- THEN recording is disabled

#### Scenario: Audit without secrets
- GIVEN a link opened by the professional
- WHEN an auditor reviews the trail
- THEN it shows the event, actor and time
- AND the link token is not present in clear text

#### Scenario: Cross-tenant link
- GIVEN a user in organization A
- WHEN they request the video link of an appointment in organization B
- THEN the system responds as not found

---

### Requirement: Virtual appointment attendance

The attendance lifecycle of `scheduling` MUST apply unchanged to virtual appointments. The professional MAY mark a virtual appointment "in progress" when joining. If the patient did not join within a configurable time after the start (default 15 minutes), the professional or reception MAY mark a no-show. The system SHOULD record whether the patient opened the link as administrative information visible to the professional and reception; it MUST NOT infer attendance automatically.

#### Scenario: Patient does not join
- GIVEN a virtual appointment started 20 minutes ago and the patient never opened the link
- WHEN the professional marks no-show
- THEN the status becomes "no-show"

#### Scenario: Professional starts session
- GIVEN the patient is checked in virtually
- WHEN the professional joins
- THEN the professional may set the status to "in progress"

#### Scenario: No automatic attendance
- GIVEN a patient who opened the link but never joined the call
- WHEN the appointment end time passes
- THEN the status does not change automatically
