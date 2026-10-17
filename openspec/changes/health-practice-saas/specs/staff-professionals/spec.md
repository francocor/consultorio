# Delta for staff-professionals

Users, professional profiles, matricula, specialties, locations and working hours.

**Quick read**: staff are deactivated, never deleted. Only owner/admin manages staff and roles. A professional profile with a recorded matrícula is what makes a user a "health professional" for clinical access; a verified matrícula is needed only for e-prescription, and only the platform operator verifies.

## ADDED Requirements

### Requirement: Staff invitation and lifecycle

An owner/admin MUST be able to invite staff by email, assign roles, and deactivate or reactivate staff. Both the owner and the admin MAY invite a user with the professional role (D19, revised and confirmed by the owner of the product on 2026-10-17); an admin never invites an owner. When an admin who is not an owner invites a professional, the system MUST write the audit event `professional.added_by_admin` and email every active owner. Invitations MUST be delivered by email only, be single-use and expiring. Reception and other non-professional staff MUST be assigned to one or more locations (membership, see `authorization`). Staff MUST NOT be hard-deleted; deactivated staff MUST keep their historical records and authorship. Seats for reception and admin are unlimited.

#### Scenario: Invite and accept
- GIVEN an owner invites a reception user
- WHEN the invitee opens the valid link and sets a password
- THEN the account becomes active with exactly the role assigned

#### Scenario: Expired or reused invitation
- GIVEN an invitation that expired or was already used
- WHEN opened
- THEN it is refused

#### Scenario: Deactivation preserves history
- GIVEN a professional with past encounters is deactivated
- WHEN records are viewed
- THEN past entries still show that professional as author
- AND the professional can no longer sign in

#### Scenario: An admin invites a professional and the owners are told (D19, revised)
- GIVEN an admin and an owner
- WHEN the admin invites a user with the professional role
- THEN the invitation is sent and the invitee can accept it with exactly that role
- AND the audit event `professional.added_by_admin` is written
- AND every active owner receives an email, and the email names no clinical data
- AND the same invitation made by the owner is accepted without the event or the email
- AND an admin still cannot invite an owner

#### Scenario: Admin deactivates a departing professional
- GIVEN a professional who is leaving the organization
- WHEN an admin deactivates the professional
- THEN the system accepts, because deactivation is management of an existing member and not a grant of a role

#### Scenario: Cross-tenant invitation
- GIVEN an email already belongs to a user in organization 2
- WHEN organization 1 invites the same email
- THEN the membership in organization 1 is separate and exposes no organization 2 data

### Requirement: Only authorized users manage staff

Only owner/admin MAY create, edit, deactivate staff or assign roles, and both MAY invite or create a user with the professional role or add the professional role to a member, with the audit event and the email to the owners described above (D19, revised). Nobody below an owner MAY create an owner. A user MAY edit their own non-privileged profile fields (name, contact, password), but MUST NOT change their own roles, organization, granted permissions, matricula verification status or active state. The one exception is an owner who acts as a health professional by completing the professional profile (name, specialty, matricula and jurisdiction), which adds the professional role to their own membership (D21, revised and confirmed on 2026-10-17; see `authorization`).

#### Scenario: Professional edits own role
- GIVEN a professional
- WHEN the professional tries to change their own roles
- THEN the change is denied and audited

### Requirement: Professional profile

A user with the professional role MUST have a professional profile with: full name, discipline/specialty (one or more), professional registration (matricula) type, number and jurisdiction, and the locations where they practice. A recorded matricula (valid in format per the country module) is required to hold clinical privileges and is sufficient for all clinical work (encounters, signing, addenda), whether or not it has been verified. The system MUST NOT infer discipline from role.

#### Scenario: Professional without matricula
- GIVEN a user assigned the professional role without a matricula
- WHEN the profile is saved
- THEN the profile is incomplete
- AND the user MUST NOT be granted clinical access until the matricula is recorded

#### Scenario: Recorded but unverified matricula
- GIVEN a professional whose matricula is recorded and not yet verified
- WHEN they create and sign an encounter
- THEN the system allows it
- AND prescribing remains unavailable until the matricula is verified (`e-prescription`)

#### Scenario: Multiple specialties
- GIVEN a physician with two specialties
- WHEN the profile is saved
- THEN both specialties are stored and available to scheduling and templates

#### Scenario: Non-clinical owner
- GIVEN an owner/admin without a professional profile
- WHEN access is evaluated
- THEN the owner has no clinical privileges (see `authorization`)

#### Scenario: An owner acts as a professional by completing the profile (D21, revised)
- GIVEN an active owner without a professional profile, at any time after the organization was created
- WHEN the owner saves name, specialty, matricula and jurisdiction as their professional profile
- THEN the owner holds both the owner and the professional roles and the matricula is recorded unverified
- AND the owner reads clinical data only through the professional role
- AND saving the profile without the matricula or its jurisdiction leaves the owner without the professional role

### Requirement: Matricula uniqueness and validation state

Within an organization, a matricula (type plus number plus jurisdiction) MUST be unique among active professionals. The profile MUST carry a verification state (unverified, verified) and the system MUST use the country module for format rules. A new matricula starts unverified. Only the platform operator MAY set the state to verified, after checking the registration with the issuing authority, and each change MUST be audited. No tenant user, including a professional on their own matricula and including owners/admins, MAY set or change the verification state. Changing the type, number or jurisdiction of a verified matricula MUST reset it to unverified. E-prescription privileges depend on a verified matricula (`e-prescription`); no other capability does.

#### Scenario: Duplicate matricula
- GIVEN an active professional with matricula M-1234
- WHEN another active professional is saved with the same matricula in the same organization
- THEN the system rejects it

#### Scenario: Self-verification denied
- GIVEN a professional with an unverified matricula
- WHEN the professional tries to mark it verified
- THEN the system denies it, with an audit entry

#### Scenario: Owner cannot verify
- GIVEN an owner/admin, who may also be a professional
- WHEN they try to mark any matricula in the organization as verified
- THEN the system denies it

#### Scenario: Operator verifies
- GIVEN a platform operator who confirmed the registration
- WHEN they mark the matricula verified
- THEN its state becomes verified and the change is audited
- AND the operator gains no access to tenant clinical data by doing so

#### Scenario: Matricula edited after verification
- GIVEN a professional with a verified matricula
- WHEN the number is changed
- THEN the state returns to unverified

### Requirement: Multi-location assignment

A professional MAY practice at one or more locations of the organization. Assignments MUST NOT reference locations of another organization.

#### Scenario: Assign to a foreign location
- GIVEN a location of organization 2
- WHEN organization 1's owner assigns it to a professional
- THEN the system rejects it as not found

### Requirement: Weekly working hours per location

A professional MUST be able to have recurring weekly working hours per location, with multiple intervals per day and exceptions for specific dates. Intervals MUST NOT overlap for the same professional across locations (compared as absolute instants when locations use different zones), and end MUST be after start. Times at a location MUST use that location's time zone, which is authoritative (`tenancy`).

#### Scenario: Overlapping intervals
- GIVEN Monday 09:00-13:00 at location A
- WHEN Monday 12:00-16:00 at location B is added for the same professional
- THEN the system rejects the overlap

#### Scenario: Invalid interval
- GIVEN an interval whose end is before its start
- WHEN saved
- THEN it is rejected with an es-AR message

#### Scenario: Date exception
- GIVEN a professional has a holiday on a given date
- WHEN an exception is recorded
- THEN that date has no working hours for the professional

### Requirement: Staff directory visibility

All active staff of the organization MAY see names and roles in the directory needed for operation. Contact details of staff and matricula SHOULD be limited to owner/admin and the professional, except matricula which MAY appear on documents issued by that professional.

#### Scenario: Reception reads directory
- GIVEN a reception user
- WHEN opening the staff directory
- THEN names, disciplines and locations are visible
- AND private contact details of other staff are not

### Requirement: Staff changes audited

Invitations, activation, deactivation, role changes, permission grants, location memberships and matricula changes (including verification) MUST be audited.

#### Scenario: Deactivation recorded
- GIVEN an owner deactivates a user
- WHEN done
- THEN the audit log records actor, subject and time
