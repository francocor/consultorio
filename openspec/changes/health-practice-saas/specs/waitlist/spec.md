# Waitlist Specification (delta)

Stage 3. Covers joining a waitlist, matching freed slots to waiting patients, time-limited offers and their expiry.

**Reads from other capabilities** (not defined here): slot freeing and booking rules (`scheduling`), message delivery and opt-out (`notifications`), patient registry and consent (`patients`), public flow (`online-booking`), audit (`audit-log`).

## Quick reference

| Topic | Rule |
|---|---|
| Trigger | A slot becomes free (cancellation, reschedule away, block removal). Expiry of a slot hold is not a trigger. |
| Manual follow-up | "Manual contact only" matches and slots unfit for automated offers go to the reception worklist (`scheduling`) as "waitlist manual contact" |
| Offer | One active offer per freed slot, in order of waiting, with an expiry |
| Default offer window | 30 minutes, shortened when the slot is near |
| Acceptance | First valid acceptance books the slot through normal scheduling rules |
| Privacy | Offers reveal only date, time, location, professional (per organization wording) |

## ADDED Requirements

### Requirement: Joining the waitlist

Reception, professionals and patients (through the waitlist self-join of `online-booking`, or the portal) MUST be able to add a patient to a waitlist. An entry MUST capture the patient, the appointment type, the preferred professional (or any professional), optionally preferred location, days of the week and time ranges, and an earliest and latest acceptable date. An entry MUST have an expiry date (default 60 days) after which it becomes inactive. A patient MUST NOT have duplicate active entries for the same type, professional and location; a duplicate MUST be rejected or merged. The system MUST require at least one reachable, non-opted-out notification channel for the patient, or the entry MUST be marked "manual contact only" for reception. A patient joining by themselves MUST accept the data-processing consent and be verified as in `online-booking`. Every entry MUST record the patient's explicit opt-in to receive waitlist offers and the channel(s) chosen; when staff create the entry, they MUST record the opt-in the patient gave, with the staff member as source, and an entry without that opt-in MUST be "manual contact only". The number of active entries per patient MUST be bounded (default 5).

#### Scenario: Reception adds an entry
- GIVEN a patient with a valid email and no active entry
- WHEN reception adds them to the waitlist for "Control" with any professional on weekday mornings
- THEN an active entry is created with an expiry of 60 days

#### Scenario: Duplicate entry
- GIVEN the patient already has an active entry for the same type, professional and location
- WHEN reception tries to add another
- THEN the system rejects it and shows the existing entry

#### Scenario: Patient with no reachable channel
- GIVEN a patient opted out of all channels
- WHEN reception adds them to the waitlist
- THEN the entry is created as "manual contact only" and appears in reception's worklist when a slot matches

#### Scenario: Entry limit
- GIVEN a patient has 5 active entries
- WHEN another is added
- THEN the system refuses and explains the limit

#### Scenario: Entry without offers opt-in
- GIVEN reception adds a patient who has not agreed to receive waitlist offers
- WHEN the entry is saved
- THEN it is marked "manual contact only"
- AND no automated offer will be sent for it

---

### Requirement: Matching freed slots

When a slot becomes free, the system MUST find active waitlist entries that match its professional, location, appointment type duration, date range and time preferences. The slot MUST still satisfy all `scheduling` rules (working hours, blocks, conflicts, lead time). Matching entries MUST be ordered by waiting time (oldest first); the organization MAY set priority overrides (for example clinical urgency flagged by a professional) that are applied before waiting time and MUST be audited. A patient with an existing appointment overlapping the slot MUST be skipped. A slot that is booked directly by staff or online before an offer is accepted MUST invalidate any open offer for it. A slot starting sooner than the minimum offer lead time (default 1 hour) MUST NOT be offered through automated messages and SHOULD be shown to reception as available for calling.

#### Scenario: Cancellation triggers matching
- GIVEN a cancelled appointment frees P's slot on Thursday 10:00 and three entries match
- WHEN the cancellation is saved
- THEN the oldest entry receives an offer first

#### Scenario: Preferences filter candidates
- GIVEN an entry that accepts only afternoon times
- WHEN a morning slot is freed
- THEN that entry is not offered the slot

#### Scenario: Patient already booked at that time
- GIVEN a waiting patient has another appointment overlapping the freed slot
- WHEN matching runs
- THEN that patient is skipped

#### Scenario: Slot taken directly
- GIVEN an open offer for a freed slot
- WHEN reception books the slot for someone else
- THEN the offer is invalidated and the waiting patient is told the slot is no longer available if they try to accept

#### Scenario: Slot too close to start
- GIVEN a slot freed 30 minutes before its start and a minimum offer lead time of 1 hour
- WHEN matching runs
- THEN no automated offer is sent
- AND reception sees the slot with the matching entries for manual calling

---

### Requirement: Offers with expiry

The system MUST send one offer at a time for each freed slot, to the best-matching entry, through the patient's permitted channel(s) following `notifications` rules. Each offer MUST have an expiry (default 30 minutes), which MUST NOT be later than the minimum lead time before the slot start. The offer MUST provide accept and decline actions through an unguessable single-use link. When the offer is accepted before expiry, the system MUST book the appointment through the normal scheduling validations and MUST remove the matched entry; if the booking fails validations, the patient MUST be told and the offer MUST be considered closed. When the offer is declined or expires without a response, the system MUST mark it and move on to the next matching entry immediately. The offer text MUST show only date, time, location and, unless the organization hides it, the professional's name, and MUST contain no clinical content. A patient who declines MAY remain on the waitlist; a patient who lets three consecutive offers expire SHOULD be flagged for reception. If no entry accepts, the slot MUST remain freely bookable.

#### Scenario: Accepted in time
- GIVEN an offer expiring in 30 minutes
- WHEN the patient accepts after 10 minutes and the slot is still free
- THEN the appointment is booked, the waitlist entry is closed, and the patient receives the booking confirmation

#### Scenario: Offer expires
- GIVEN an offer sent 31 minutes ago and not answered
- WHEN the expiry passes
- THEN the offer is marked expired and the next matching entry receives an offer

#### Scenario: Acceptance after expiry
- GIVEN an expired offer
- WHEN the patient opens the link and tries to accept
- THEN the system rejects the acceptance, states the offer expired, and keeps the patient on the waitlist

#### Scenario: Offer shortened by proximity
- GIVEN a slot starting in 90 minutes, a default offer window of 30 minutes and a lead time of 1 hour
- WHEN the offer is created
- THEN the offer expires no later than 30 minutes from creation, ensuring one hour remains before the start

#### Scenario: Concurrent acceptance
- GIVEN the offer is open to one patient but reception books the slot at the same moment as the patient accepts
- WHEN both requests are processed
- THEN exactly one appointment is created and the other actor is told the slot is no longer available

#### Scenario: Nobody accepts
- GIVEN all matching entries decline or expire
- WHEN the last offer closes
- THEN the slot remains free for normal booking and no further offers are sent for it

---

### Requirement: Opt-out and consent in offers

Offers MUST NOT be sent through a channel on which the patient has opted out. An opt-out on any channel is an opt-out of every channel (`notifications`, owner decision B7), so it MUST close every entry of the patient as "patient opted out". An entry created for a patient who is already opted out of all channels MUST be "manual contact only". Offers are not plain service reminders: they MUST NOT be sent without the patient's recorded opt-in to waitlist offers, and a WhatsApp offer additionally requires the WhatsApp opt-in of `notifications`. Offers are sent by WhatsApp or email only, never by SMS, and MUST respect quiet hours (an offer that would fall in quiet hours is deferred to their end only if the minimum offer lead time still holds; otherwise it is not sent automatically and the slot is shown to reception). While the tenant is read-only no offer MUST be sent. A patient replying to stop receiving waitlist messages MUST be removed from active offers immediately, and the entry SHOULD be closed with the reason "patient opted out".

#### Scenario: Opted-out patient is not offered anything
- GIVEN a patient who opted out on any channel
- WHEN a slot matching their entry is freed
- THEN no offer is sent on any channel and the entry is already closed as "patient opted out"

#### Scenario: Offer in quiet hours
- GIVEN a slot is freed at 22:00 for the next day at 12:00 and the entry has the offers opt-in
- WHEN matching runs
- THEN the offer is sent at 08:00, the end of quiet hours, with an expiry that keeps the minimum lead time

#### Scenario: Offer cannot be deferred
- GIVEN a slot is freed at 22:00 for the next day at 08:30 and the minimum offer lead time is 1 hour
- WHEN matching runs
- THEN no automated offer is sent
- AND reception sees the slot with the matching entries

#### Scenario: Patient stops waitlist messages
- GIVEN a patient with two active entries and no other channel for offers than WhatsApp
- WHEN the patient replies "BAJA" to an offer
- THEN both entries stop receiving automated offers (they close as "patient opted out")
- AND the opt-out is recorded as in `notifications`, for every channel

---

### Requirement: Managing and closing entries

Authorized staff MUST be able to view, edit preferences of, pause and close entries. Entries MUST be closed automatically when fulfilled (the patient was booked in a matching slot, whether through an offer or otherwise), expired, or cancelled, and each closure MUST record the reason. Closed entries MUST be retained for reporting and MUST NOT be hard-deleted. A booking made for the patient directly with the same type and professional SHOULD close the corresponding entry after confirmation by the user. The list of entries MUST be visible only within the organization and only to roles with scheduling permission. Entry data MUST NOT contain clinical details.

#### Scenario: Pause an entry
- GIVEN an active entry
- WHEN reception pauses it during the patient's holiday
- THEN no offers are sent for it until it is resumed or it expires

#### Scenario: Fulfilled by direct booking
- GIVEN a patient on the waitlist for "Control" with professional P
- WHEN reception books that patient for a "Control" with P
- THEN the system suggests closing the entry and, upon confirmation, closes it with reason "fulfilled"

#### Scenario: Entry expiry
- GIVEN an entry older than its expiry date
- WHEN the nightly process runs
- THEN the entry is closed with reason "expired" and is retained

#### Scenario: Cross-tenant list
- GIVEN an admin in organization A
- WHEN they request waitlist entries of organization B
- THEN no entry is returned

---

### Requirement: Fairness, audit and metrics

Every offer, acceptance, decline, expiry, priority override and manual change MUST be audited with actor (or "system"), time and result. The system MUST record offer response times and fill outcomes so that `reports-dashboard` can report the number of slots recovered through the waitlist. An offer MUST NOT be created twice for the same patient and the same slot.

#### Scenario: Audit of an accepted offer
- GIVEN an accepted offer
- WHEN an admin reviews the trail
- THEN it shows offer creation, delivery channel, acceptance time and resulting appointment

#### Scenario: No duplicate offer
- GIVEN a patient declined an offer for slot S
- WHEN matching runs again for S after a reschedule event
- THEN the same patient does not receive another offer for S

#### Scenario: Recovered slots metric
- GIVEN 12 slots were filled through offers in a month
- WHEN the report is requested
- THEN the waitlist count of recovered slots is 12

---

### Requirement: Self-join cannot forge consent

A public join MUST NOT record the agreement to receive offers on a record that already had the typed document: the entry is created for reception to call (reason "no offers opt-in"), because the visitor proved an email address, not who the document belongs to. For a patient the join registers, the agreement of the form MAY be recorded, and a WhatsApp choice MUST be only a request (see notifications, "WhatsApp opt-in from a public form"). A patient who opts out on any channel MUST leave the waitlist at once, because the opt-out is for every channel (owner decision B7, which replaces the earlier rule that kept the entries of a patient who still had another channel): all their entries close with reason "patient opted out" and their offers end. The opt-out is applied in the transaction of the opt-out, but a failure of the waitlist MUST NOT undo the patient's opt-out: it is reported and the opt-out stands. Staff MUST see only the entries of the places they work at and, for a professional, of the calendars they may work in; an entry outside that scope answers not found. An online booking cancelled within thirty minutes of being made MUST NOT start a match, and a slot MUST get at most five offers.

#### Scenario: Self-join with a document on file
- GIVEN a patient on file with document D
- WHEN a visitor verifies an email and joins the waitlist with document D
- THEN the entry exists as manual contact only, with no offers agreement recorded
- AND the record of the patient is unchanged

#### Scenario: Opt-out leaves the list
- GIVEN a patient with two entries and an open offer
- WHEN the patient opts out on any channel
- THEN both entries close as "patient opted out" and the offer ends

#### Scenario: Opt-out of one channel leaves the list
- GIVEN a patient with an entry, an email that was not refused and a recorded WhatsApp opt-in
- WHEN the patient opts out of WhatsApp (for example replying "BAJA")
- THEN the entry closes as "patient opted out", because email is opted out as well

#### Scenario: Scope
- GIVEN reception assigned to one place and an entry for another
- WHEN reception lists the waitlist
- THEN the entry is not in the list and its detail answers not found

#### Scenario: Book and cancel at once
- GIVEN an online booking cancelled ten minutes after it was made
- THEN no match is queued and nobody on the waitlist is offered the slot
