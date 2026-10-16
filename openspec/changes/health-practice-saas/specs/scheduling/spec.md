# Scheduling Specification (delta)

Stage 2. Covers calendars, appointment types, blocks and holidays, booking rules, overbooking, rescheduling, cancellation and the attendance lifecycle.

**Reads from other capabilities** (not defined here): working hours and locations (`staff-professionals`, `tenancy`), holiday catalog (`country-rules-ar`), role permissions (`authorization`), change trail (`audit-log`), patient identity (`patients`).

## Quick reference

| Topic | Rule |
|---|---|
| Time storage | Every appointment is an absolute instant, shown in the location's time zone |
| Statuses | Exactly eight: pending approval, scheduled, confirmed, checked in, in progress, attended, no-show, cancelled. "Rescheduled" is not a status; it is derived from history. |
| Default conflict policy | Capacity of 1: no two occupying appointments (or holds) overlap for one professional, buffer included. Overbooking is off by default. |
| Overbooking | A per-professional maximum number of simultaneous appointments (at least 2), checked at every instant, not a per-day cap |
| Outside working hours | Rejected, unless an authorized user overrides it with a reason |
| Deletion | Appointments are never hard-deleted, only cancelled |
| Calendar content | Shows administrative data only, never clinical content |
| Identity confirmation | Online matches of existing patients and a professional's self-booking of an existing patient start unconfirmed; another staff member confirms at identity review or check-in (D14); in a solo practice the professional may self-confirm at in-person check-in (D18) |
| Reception worklist | One queue for items that need a person: pending approvals, identity reviews, unsent or undelivered reminders, replies to review, manual-contact waitlist items |
| Read-only tenant | Only the allowlist in `tenancy` is permitted; patient-protective cancellation always is |

## ADDED Requirements

### Requirement: Calendar views

The system MUST provide day, week and month calendar views per professional and per location. A user with calendar access SHALL be able to switch between a single professional, several professionals, and a whole location. The views MUST show only appointments within the user's organization and permitted professionals. Calendar entries MUST show administrative data only (patient name, appointment type, status, time) and MUST NOT show any clinical note content. The week and day views MUST be usable at a 360 px width.

#### Scenario: Reception sees a location's day
- GIVEN a reception user in organization A with access to location "Centro"
- WHEN they open the day view for location "Centro"
- THEN appointments of all professionals working at "Centro" in organization A are listed
- AND no appointment from organization B is listed
- AND no clinical note content is shown

#### Scenario: Professional sees only their own calendar by default
- GIVEN a professional with no delegated calendar access
- WHEN they open the calendar
- THEN only their own appointments are shown

#### Scenario: Calendar on a narrow screen
- GIVEN a viewport width of 360 px
- WHEN the user opens the day view
- THEN the appointments are readable and the main actions (book, check in, cancel) are reachable without horizontal scrolling

---

### Requirement: Appointment types

An organization MUST be able to define appointment types. Each type SHALL have a name, a duration in minutes, a mode (in person or virtual), an optional price reference (resolved by `billing-payments`), optional buffer time in minutes after the appointment (preparation or cleanup time that keeps the professional occupied but is not part of the appointment's duration, price or displayed length), and an optional restriction to specific professionals or specialties. A type MUST be deactivatable. Deactivating a type MUST NOT alter existing appointments of that type. A type's duration MUST be greater than zero. Appointment-type names and descriptions MUST be editable in es-AR with no hardcoded labels.

#### Scenario: Create a type with a duration
- GIVEN an owner/admin in organization A
- WHEN they create the type "First consultation" with duration 45 minutes in person
- THEN the type is available for booking with a 45-minute slot length

#### Scenario: Reject an invalid duration
- GIVEN an owner/admin creating an appointment type
- WHEN they submit a duration of 0 or a negative number
- THEN the system rejects the request with a validation message and creates no type

#### Scenario: Deactivated type keeps history
- GIVEN 5 existing appointments of type "Control"
- WHEN the type "Control" is deactivated
- THEN the 5 appointments keep their type and details
- AND "Control" is not offered for new bookings

---

### Requirement: Booking an appointment

The system MUST allow an authorized user (reception, professional, owner/admin acting on scheduling) to book an appointment for an existing patient with a professional, a location, an appointment type and a start time. The end time SHALL be derived from the type's duration. The professional, patient and location MUST belong to the actor's organization; organization identity MUST come from the authenticated session only. A booking MUST record who created it and when. A booking in the past MUST be rejected unless the actor has the permission to register past appointments, and such an entry MUST be audited. When a professional books an appointment with themselves for a patient whose record already existed, nobody else has checked who the patient is: the appointment MUST start with its identity unconfirmed (`authorization`) and MUST open an identity review on the reception worklist. Bookings made by any other staff member, and bookings that create the patient record in the same action, start confirmed.

#### Scenario: Professional books themselves for an existing patient
- GIVEN professional B and an existing patient P
- WHEN B books P with themselves
- THEN the appointment is created with its identity unconfirmed
- AND an identity review item appears on the reception worklist
- AND B gains no care relationship with P from it until another staff member confirms the identity

#### Scenario: Reception books an existing patient
- GIVEN an existing patient, a professional with a free slot, and a reception user
- WHEN reception selects the patient, type and a free slot and confirms
- THEN an appointment in status "scheduled" is created with the creator and timestamp recorded
- AND an audit entry exists for the creation

#### Scenario: Cross-tenant reference is refused
- GIVEN a reception user in organization A
- WHEN a booking request references a patient or professional identifier from organization B
- THEN the system rejects the request as not found
- AND no appointment is created

#### Scenario: Booking in the past
- GIVEN a reception user without permission to register past appointments
- WHEN they book an appointment starting yesterday
- THEN the system rejects the booking with a message stating the time is in the past

---

### Requirement: Conflict detection and overbooking policy

Each professional has a capacity: the maximum number of simultaneous appointments, which is 1 by default. An appointment occupies its professional during its occupied range, which is the interval from start to end plus the type's buffer. Appointments in the statuses pending approval, scheduled, confirmed, checked in, in progress and attended occupy their range; cancelled and no-show appointments MUST NOT. Active slot holds (see below) also occupy their range. The system MUST reject a booking if, at any instant inside the new occupied range, the number of occupying appointments and holds of that professional would exceed the capacity. An organization MAY enable overbooking per professional by setting the capacity to a maximum number of simultaneous appointments (an integer of at least 2); it is a count of simultaneous appointments at any instant, never a per-day total. A professional MUST NOT be booked at two different locations at overlapping times, whatever the capacity. Concurrent bookings of the same slot MUST result in exactly one success; the other MUST receive a conflict response and no partial record.

The buffer applies in both directions of the check: a new appointment's own buffer also counts, so it cannot start inside the buffer of an earlier occupying appointment, and its own buffer cannot run into a later appointment.

#### Scenario: Double booking is rejected
- GIVEN professional P has a scheduled appointment from 10:00 to 10:30
- WHEN reception tries to book P from 10:15 to 10:45
- THEN the system rejects the booking as a conflict
- AND shows the conflicting time range without any clinical data

#### Scenario: Back-to-back appointments are allowed
- GIVEN professional P has an appointment from 10:00 to 10:30 and the type has no buffer
- WHEN reception books P from 10:30 to 11:00
- THEN the booking succeeds

#### Scenario: Buffer blocks the next start
- GIVEN professional P has an appointment from 10:00 to 10:30 of a type with a 10-minute buffer
- WHEN reception tries to book P from 10:30 to 11:00
- THEN the booking is rejected because P is occupied until 10:40
- AND booking from 10:40 succeeds

#### Scenario: Own buffer runs into a later appointment
- GIVEN professional P has an appointment from 11:00 to 11:30
- WHEN reception books P from 10:30 to 11:00 with a type that has a 10-minute buffer
- THEN the booking is rejected because the buffer reaches 11:10

#### Scenario: Attended appointment still occupies its range
- GIVEN professional P has an attended appointment from 10:00 to 10:30
- WHEN a user registers another appointment for P from 10:15 to 10:45
- THEN the booking is rejected as a conflict

#### Scenario: Cancelled slot is reusable
- GIVEN P has a cancelled appointment from 10:00 to 10:30
- WHEN reception books P at 10:00
- THEN the booking succeeds

#### Scenario: Overbooking within the limit
- GIVEN overbooking is enabled for P with a maximum of 2 simultaneous appointments
- AND P has one appointment at 10:00
- WHEN reception books a second appointment at 10:00
- THEN the booking succeeds
- WHEN reception books a third appointment at 10:00
- THEN the booking is rejected because the maximum is reached

#### Scenario: Overbooking is evaluated per instant, not per day
- GIVEN overbooking is enabled for P with a maximum of 2, and P has appointments 10:00-10:30 and 10:15-10:45
- WHEN reception books a third from 10:20 to 10:40
- THEN the booking is rejected because 3 would be simultaneous at 10:20
- AND a booking from 11:00 to 11:30 succeeds, however many appointments P has that day

#### Scenario: Active hold counts toward capacity
- GIVEN P has capacity 1 and an active hold on Tuesday 10:00-10:30
- WHEN reception tries to book P for Tuesday 10:00 without an explicit override
- THEN the booking is rejected as a conflict

#### Scenario: Two receptionists book the same slot simultaneously
- GIVEN two reception users submit a booking for the same free slot of P at the same moment
- WHEN both requests are processed
- THEN exactly one appointment is created
- AND the other user receives a conflict message and can choose another slot

#### Scenario: Professional at two locations
- GIVEN P has an appointment at location "Norte" from 10:00 to 10:30
- WHEN reception books P at location "Sur" from 10:00 to 10:30
- THEN the booking is rejected as a conflict

---

### Requirement: Slot holds

A slot hold is a short-lived reservation of a time range for a professional, created while someone completes a booking (for example the public flow in `online-booking`). A hold is not an appointment: it has no patient, no status among the eight appointment statuses and no history entry, and it MUST NOT appear in calendars as an appointment or in any report. While active, a hold MUST occupy its range exactly as an occupying appointment does (capacity and buffer). A hold MUST expire automatically after its duration (default 10 minutes) and then free the range; expiry is not an event visible to patients. Converting a hold into an appointment MUST re-run the booking validations. Authorized staff MAY book over an active hold only with an explicit override that invalidates the hold. Holds MUST be bounded per source (default 1 at a time); a new hold from the same source releases the previous one. Holds and bookings from public flows (`online-booking`, waitlist offers) MUST use a capacity of 1 and MUST NOT use overbooked capacity. Hold expiry MUST NOT trigger waitlist offers.

#### Scenario: Hold expires
- GIVEN a hold created 11 minutes ago with a 10-minute duration
- WHEN another user books the same slot
- THEN the booking succeeds

#### Scenario: Hold is not an appointment
- GIVEN an active hold on professional P
- WHEN reception opens P's calendar and the daily report
- THEN the hold is not listed as an appointment and is not counted in any appointment figure

#### Scenario: Override of a hold
- GIVEN an active hold on P's Tuesday 10:00 slot
- WHEN an authorized staff member books that slot with the override
- THEN the appointment is created and the hold is invalidated
- AND the holder, if they try to finish, is told the slot is no longer available

### Requirement: Working hours and out-of-hours bookings

The system MUST offer only free slots inside the professional's working hours at the chosen location. A booking outside working hours MUST be rejected by default. A user holding the explicit permission to override (granted through `authorization`) MAY create an out-of-hours appointment, MUST provide a reason, and the appointment MUST be flagged as out-of-hours and audited. Working hours set for a date range MUST take precedence over the weekly default for that range. Changing working hours MUST NOT silently cancel or move existing appointments; affected appointments MUST be listed for resolution.

#### Scenario: Booking outside working hours
- GIVEN P works Monday 09:00-13:00 at "Centro"
- WHEN reception tries to book P on Monday at 15:00 at "Centro"
- THEN the booking is rejected with a message that the time is outside working hours

#### Scenario: Authorized override
- GIVEN a user with the out-of-hours override permission
- WHEN they book P on Monday at 15:00 and enter the reason "Urgent follow-up"
- THEN the appointment is created and flagged out-of-hours
- AND the reason and actor are audited

#### Scenario: Working hours shrink with existing appointments
- GIVEN P has appointments on Friday afternoon
- WHEN an admin removes Friday afternoon from P's working hours
- THEN the existing Friday appointments remain
- AND the system shows the list of appointments now outside working hours for reception to resolve

---

### Requirement: Blocks and holidays

An authorized user MUST be able to create blocks (non-bookable intervals) for a professional or a whole location, with a reason and optional recurrence. The system MUST support a holiday calendar combining the country holiday catalog from `country-rules-ar` with organization-defined days off. Slots inside a block or on a holiday MUST NOT be bookable unless an authorized user overrides it with a reason (audited). Creating a block that overlaps existing appointments MUST NOT cancel them silently; the system MUST list the affected appointments and require the user to resolve them (keep, reschedule or cancel).

#### Scenario: Block prevents booking
- GIVEN P has a block "Vacation" from 2026-12-20 to 2026-12-31
- WHEN reception tries to book P on 2026-12-22
- THEN no slots are offered and a direct booking is rejected citing the block

#### Scenario: National holiday
- GIVEN 2026-12-25 is in the national holiday catalog
- WHEN reception looks for slots on that date
- THEN the date is marked as a holiday and no slots are offered by default

#### Scenario: Block over existing appointments
- GIVEN P has 3 appointments on 2026-11-10
- WHEN an admin creates a full-day block on 2026-11-10
- THEN the system lists the 3 affected appointments and asks to keep, reschedule or cancel each
- AND none is changed until the admin decides

---

### Requirement: Time zones and daylight saving

Each location MUST have an IANA time zone, defaulting to America/Argentina/Buenos_Aires, and that location time zone is authoritative over any organization-level default (`tenancy`). Appointments MUST be stored as absolute instants and rendered in the location's time zone, regardless of the viewer's device zone. Working hours, blocks and reminders MUST be evaluated in the location's time zone. When a location's zone observes daylight saving time, a local time that does not exist (spring forward) MUST be rejected for booking, and an ambiguous local time (fall back) MUST require the user to pick the intended occurrence. Appointment durations MUST be measured in elapsed time, not wall-clock difference.

#### Scenario: Viewer in another zone
- GIVEN an appointment at 10:00 in America/Argentina/Buenos_Aires
- WHEN a user whose device is set to another time zone opens the calendar
- THEN the appointment is shown at 10:00 location time, labelled with the location's zone

#### Scenario: Non-existent local time
- GIVEN a location whose zone skips 02:00-03:00 on a given date
- WHEN reception books a slot at 02:30 that day
- THEN the booking is rejected as an invalid local time

#### Scenario: Ambiguous local time
- GIVEN a location whose zone repeats 01:00-02:00 on a given date
- WHEN reception books a slot at 01:30 that day
- THEN the system asks which occurrence is meant and stores the chosen instant

---

### Requirement: Rescheduling

An authorized user MUST be able to move an appointment to another time, professional or location. The same validations as booking (conflict, working hours, blocks) MUST apply to the new time. The original time MUST be retained in the appointment history. "Rescheduled" is not an appointment status: a moved appointment keeps its current status among the eight, and the fact that it was rescheduled MUST be derivable from its history (this is what reports count, see `reports-dashboard`). Rescheduling MUST trigger recomputation of reminders (see `notifications`) and, if the appointment was virtual, regeneration of the video link (see `teleconsultation`). A reschedule MUST NOT be allowed for appointments already attended.

#### Scenario: Move to a free slot
- GIVEN an appointment on Tuesday 10:00
- WHEN reception moves it to Wednesday 11:00 with a free slot
- THEN the appointment shows Wednesday 11:00
- AND the history keeps Tuesday 10:00 with actor and timestamp
- AND pending reminders for Tuesday are cancelled and new ones are scheduled

#### Scenario: Move to an occupied slot
- GIVEN Wednesday 11:00 is occupied for the same professional
- WHEN reception tries to move the appointment there
- THEN the move is rejected and the original appointment is unchanged

#### Scenario: Reschedule an attended appointment
- GIVEN an appointment in status "attended"
- WHEN a user tries to reschedule it
- THEN the system rejects the action

#### Scenario: Rescheduled is derived, not a status
- GIVEN a scheduled appointment moved from Tuesday to Thursday
- WHEN its status and history are read
- THEN the status is still "scheduled"
- AND the history shows the move

---

### Requirement: Cancellation

An authorized user MUST be able to cancel an appointment, choosing who cancelled (patient, professional or organization) and a reason from a configurable list with optional free text. Cancellation MUST keep the appointment record, free the slot and cancel pending reminders. Cancelling a virtual appointment MUST revoke its video link. A cancellation made less than the organization's configured late-cancellation window before the start MUST be flagged as late. Cancelling MUST trigger the waitlist process (see `waitlist`). A cancelled appointment MUST NOT be hard-deleted.

#### Scenario: Patient cancels in time
- GIVEN an appointment starting in 3 days and a late-cancellation window of 24 hours
- WHEN reception cancels it with cancelled-by "patient"
- THEN the status becomes "cancelled" and the slot becomes free
- AND the cancellation is not flagged late

#### Scenario: Late cancellation
- GIVEN an appointment starting in 2 hours and a late-cancellation window of 24 hours
- WHEN reception cancels it
- THEN the cancellation is recorded and flagged as late

#### Scenario: Cancel an already attended appointment
- GIVEN an appointment in status "attended"
- WHEN a user tries to cancel it
- THEN the system rejects the action

---

### Requirement: Attendance lifecycle

Each appointment MUST have exactly one status among: pending approval, scheduled, confirmed, checked in, in progress, attended, no-show, cancelled. "Pending approval" applies only to online bookings that the organization requires staff to approve (see `online-booking`); a pending appointment MUST hold its slot. Allowed transitions are:

| From | To |
|---|---|
| pending approval | scheduled, cancelled |
| scheduled | confirmed, checked in, no-show, cancelled |
| confirmed | checked in, no-show, cancelled |
| checked in | in progress, no-show, cancelled |
| in progress | attended |
| attended, no-show, cancelled | none (terminal), except an authorized correction described below |

Reception MUST be able to check in a patient. When the appointment's identity is unconfirmed, check-in MUST ask the staff member to confirm the patient's identity. A check-in by a staff member other than the appointment's professional, with that confirmation, MUST mark the identity confirmed (D14), close the identity review item, and be audited. A check-in by the appointment's own professional MUST NOT confirm the identity, with one exception (D18). When the organization has exactly one active professional and no other active staff member who could confirm, that professional MAY confirm the identity at in-person check-in, after seeing the patient and the ID document. This confirmation MUST be audited with a distinct "self_confirmed" marker. Whether the exception applies MUST be evaluated at the moment of confirmation, and earlier self-confirmations stay valid if staff join later. A professional MUST be able to start and finish an appointment. The "today's patients" list for a professional MUST show checked-in patients for that professional only. Every transition MUST record actor, timestamp and previous status. An authorized user MAY correct a terminal status (for example no-show marked by mistake), providing a reason, and the correction MUST be audited. A correction from no-show or cancelled to a status that occupies the professional's time MUST be validated against conflicts like a booking and MUST be rejected if the range is now taken. A no-show MUST NOT be assignable before the appointment start time. The no-show rate MUST be derivable from these statuses for `reports-dashboard` (no-show divided by attended plus no-show; cancellations excluded). The eight statuses above are the only appointment statuses; every other capability MUST use these names with these meanings.

#### Scenario: Check-in and attendance
- GIVEN a scheduled appointment today
- WHEN reception checks the patient in
- THEN the status becomes "checked in"
- AND the patient appears in the professional's today list
- WHEN the professional starts and then finishes the appointment
- THEN the status becomes "in progress" and then "attended"

#### Scenario: Check-in confirms identity
- GIVEN an online appointment matched to existing patient P with its identity unconfirmed
- WHEN reception checks P in and confirms P's identity
- THEN the appointment's identity becomes confirmed and the identity review item closes
- AND the confirmation is audited with the reception user as actor

#### Scenario: Professional's own check-in does not confirm
- GIVEN an organization with reception staff, and professional B who booked existing patient P with themselves with the identity unconfirmed
- WHEN B checks P in
- THEN the status becomes "checked in"
- AND the identity stays unconfirmed

#### Scenario: Solo practice self-confirms at check-in
- GIVEN an organization whose only active staff member is professional S, and an appointment of S with the identity unconfirmed
- WHEN S checks the patient in person, sees the ID document and confirms the identity
- THEN the identity becomes confirmed and the identity review item closes
- AND the audit entry carries the "self_confirmed" marker

#### Scenario: Invalid transition
- GIVEN an appointment in status "cancelled"
- WHEN a user tries to set it to "checked in"
- THEN the system rejects the transition

#### Scenario: Premature no-show
- GIVEN an appointment starting in 3 hours
- WHEN reception marks it as no-show
- THEN the system rejects the action because the start time has not passed

#### Scenario: Correct a mistaken no-show
- GIVEN an appointment marked no-show
- WHEN an authorized user changes it to "attended" with the reason "Patient arrived late"
- THEN the status changes and the previous status, reason and actor are audited

#### Scenario: Correction blocked by a conflict
- GIVEN a no-show appointment at 10:00 whose slot was rebooked for someone else
- WHEN an authorized user tries to change it to "attended"
- THEN the correction is rejected and the conflicting appointment is shown

#### Scenario: Another professional's patients are hidden
- GIVEN patients checked in for professional P2
- WHEN professional P1 opens "today's patients"
- THEN none of P2's checked-in patients appear

---

### Requirement: Recurring appointments

The system SHOULD allow booking a series of appointments (for example weekly sessions) with a count or end date. Each occurrence MUST be validated independently using the same rules as a single booking. When some occurrences conflict, the system MUST report which ones failed and MUST let the user skip them or abort the whole series before anything is created. Each occurrence MUST be individually reschedulable and cancellable without altering the others.

#### Scenario: Series with one conflict
- GIVEN a weekly series of 6 sessions where the 4th falls on a block
- WHEN reception submits the series
- THEN the system reports session 4 as conflicting and creates nothing until the user chooses to skip it or abort

#### Scenario: Cancel one occurrence
- GIVEN a created series of 6 sessions
- WHEN reception cancels session 3
- THEN only session 3 is cancelled

---

### Requirement: Reception worklist

The system MUST provide one reception worklist per organization, filtered to the locations each reception user is assigned to and visible to owner/admin. It holds every item that needs a person. Other capabilities MUST add their items here rather than keep separate queues. The item kinds are exactly:

| Kind | Added by | Meaning |
|---|---|---|
| Pending approval | `online-booking` | An online booking awaiting staff approval |
| Identity review | `online-booking`, this capability | An appointment matched to an existing patient with its identity unconfirmed, with any submitted data that differs from the record (`patients`) |
| Reminder not sent | `notifications` | A reminder that could not be sent: quiet hours made deferral impossible, the patient has no reachable channel, or WhatsApp is off and there is no email |
| Reminder not delivered | `notifications` | Every permitted channel failed |
| Reply to review | `notifications` | A patient reply that is ambiguous or cannot be matched to exactly one appointment (messages from unknown numbers are ignored, not listed) |
| Waitlist manual contact | `waitlist` | A freed slot matching manual-contact-only entries, or one too close to its start or inside quiet hours for an automated offer |

Each item MUST show only administrative data, never clinical content, and MUST link to the action that resolves it. Items MUST be resolved or dismissed by a person with a recorded actor and time, MUST NOT be hard-deleted, and MUST be audited. An identity review MUST NOT be resolved as confirmed by the appointment's own professional. The only self-confirmation path is in-person check-in in a solo practice (D18, see the attendance lifecycle).

#### Scenario: Items from several capabilities in one place
- GIVEN a pending online booking, an undelivered reminder and a manual-contact waitlist match at location "Centro"
- WHEN a reception user assigned to "Centro" opens the worklist
- THEN all three items are listed, each with its kind and a link to resolve it

#### Scenario: Location filter
- GIVEN a worklist item for location "Norte"
- WHEN a reception user assigned only to "Centro" opens the worklist
- THEN the item is not shown

#### Scenario: Professional cannot confirm their own identity review
- GIVEN an identity review for an appointment of professional B
- WHEN B tries to resolve it as confirmed
- THEN the action is denied and audited

---

### Requirement: Scheduling authorization and audit

Scheduling data access MUST follow `authorization`: reception, professionals and owner/admin MAY manage appointments in their scope; a patient MUST NOT access scheduling data except their own appointments through `patient-portal` or `online-booking`. Creation, rescheduling, cancellation, status changes, overrides and calendar views of another professional's data MUST generate audit entries (`audit-log`). Appointments MUST NOT be hard-deleted, and users or professionals who are deactivated MUST keep their appointment history. Appointment records MUST carry no clinical content; any clinical content belongs to `clinical-records`.

#### Scenario: Audit of a status change
- GIVEN an appointment in status "scheduled"
- WHEN reception marks it as "checked in"
- THEN an audit entry records actor, organization, appointment and the old and new status

#### Scenario: Deactivated professional
- GIVEN a professional with past appointments
- WHEN the professional is deactivated
- THEN the past appointments remain visible in history
- AND future appointments are listed for reassignment or cancellation

#### Scenario: Client cannot set identity
- GIVEN a booking request whose body includes a different "createdBy" or organization identifier
- WHEN the system processes it
- THEN the creator and organization are taken from the authenticated session and the body values are ignored

### Requirement: Read-only tenant behavior

When the tenant is read-only (`subscriptions`), scheduling MUST follow the shared allowlist in `tenancy`: calendars and appointment history remain readable; booking, rescheduling, status changes (including check-in), blocks, working-hours changes and automated reminders are refused. Cancellation of an appointment by or for the patient is a patient-protective write and MUST remain possible, including through the patient portal and token links; it frees the slot but MUST NOT send waitlist offers or other automated messages while read-only.

#### Scenario: Booking while read-only
- GIVEN a read-only tenant
- WHEN reception tries to book an appointment
- THEN the system refuses with a message that the account is read-only

#### Scenario: Patient cancels while read-only
- GIVEN a read-only tenant and a patient with an upcoming appointment
- WHEN the patient cancels from the portal
- THEN the appointment becomes "cancelled"
- AND no waitlist offer message is sent
