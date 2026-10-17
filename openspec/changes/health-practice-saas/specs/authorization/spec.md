# Delta for authorization

Roles, permission rules, clinical-access policy and sharing policy. All rules are enforced on the server.

**Quick read**: clinical notes are readable by health professionals only. A non-clinical admin never reads them, and no setting changes that. Roles are never self-assigned. Demographics are organization-wide; clinical content is scoped by care relationship and one sharing-scope model.

## Definitions (normative)

| Term | Meaning |
|---|---|
| Health professional | A user holding the professional role with an active professional profile that has a recorded matrícula (verified or not; see `staff-professionals`) |
| Care relationship | The link between a professional and a patient. It exists while at least one of these sources holds: (1) an appointment of the patient with the professional whose identity is confirmed and whose status is scheduled, confirmed, checked in, in progress, attended or no-show; (2) an encounter of the patient by the professional; (3) an explicit assignment of the patient to the professional. An appointment that is pending approval never creates one. A cancelled appointment never creates one, because it was never attended. An appointment whose identity is not confirmed never creates one. A no-show creates one only if the identity was already confirmed. |
| Identity confirmation | Applies to an appointment that matches an **existing** patient record without anyone checking who the patient is. There are two cases: an appointment created through the public online-booking flow and matched to an existing patient by document (`online-booking`), and an appointment that a professional books with themselves for an existing patient (`scheduling`). Such an appointment starts with its identity unconfirmed. It becomes confirmed only when a staff member other than the appointment's professional confirms the patient's identity, at the identity review (`patients`) or at check-in (`scheduling`), whichever comes first. **Solo-practice exception (D18):** when the organization has exactly one active professional and no other active staff member who could confirm, that professional MAY confirm the identity themselves at in-person check-in, after seeing the patient and the ID document. The confirmation is audited with a distinct "self_confirmed" marker. The reason: confirmation protects clinical history from other professionals of the same organization, and such an organization has none. Self-confirmations remain valid if staff join later; new confirmations then follow the general rule. Every other appointment is confirmed from creation, including an online booking that creates a new patient. |
| Treating professional | A health professional who has a care relationship with the patient |
| Sharing | An organization setting that lets other health professionals of the organization read (never write) clinical data of patients they do not treat |
| Sharing scope | The rules that bound what sharing exposes (defined below) |

## Role and access matrix (normative summary)

| Data | Owner/admin (non-clinical) | Professional | Reception | Patient |
|---|---|---|---|---|
| Organization settings, staff, branding | Full | None | None | None |
| Patient demographics, coverage | Read/write | Read org-wide; write for patients they treat | Read/write | Own only |
| Schedule, attendance | Read/write, all locations | Own schedule; org per policy | Read/write for assigned locations | Own only |
| Payments, cash register | Read/write | Own charges; cash register only if granted | Read/write for assigned locations | Own only |
| **Clinical notes content** | **Never** | **Treating professionals; other professionals read-only and only if sharing is on and the sharing scope allows** | **Never** | **Never shown in the portal in v1; formal copy on request** |
| Clinical metadata (existence, names, categories of clinical documents and prescriptions) | Never | Per clinical rules | Only if "reception sees clinical metadata" is on | Own only |
| Safety flag (for example "allergy on file") | None needed | Yes | Yes | Own only |
| Audit log | Read | None (own actions) | None | None |
| Grantable non-clinical permissions | Grants them | Can hold them | Can hold them | Not applicable |

## ADDED Requirements

### Requirement: Fixed role set

The system MUST support these roles: owner/admin, professional, reception and patient. A user MAY hold more than one role in one organization (for example owner and professional). The platform operator MUST be a distinct identity class outside tenant roles.

#### Scenario: Owner who is also a professional
- GIVEN a user holding owner and professional roles
- WHEN the user opens clinical data
- THEN access is evaluated only through the professional role
- AND owner privileges grant nothing additional over clinical content

#### Scenario: User without any role
- GIVEN an authenticated user with no active role in the organization
- WHEN the user requests any tenant data
- THEN access MUST be denied

### Requirement: Server-side enforcement on every request

Every permission decision MUST be made on the server using the roles of the authenticated session. The client MUST NOT be trusted for role, organization or ownership. Hiding a control in the interface MUST NOT be the only protection.

#### Scenario: Direct call bypassing the interface
- GIVEN a reception user
- WHEN the user calls a clinical-notes endpoint directly
- THEN the server denies it regardless of what the interface displays

#### Scenario: Role claim in the request
- GIVEN a request body that says role equals admin
- WHEN the server processes it
- THEN the claim is ignored and the session roles are used

### Requirement: No self-assignment or silent escalation of roles

A user MUST NOT be able to grant themselves a role or permission, or change their own role, organization or permissions, including during signup or profile edit. Only an owner/admin MAY assign or revoke staff roles and grantable permissions, and every change MUST be audited. An organization MUST always retain at least one active owner. One narrow exception exists (decision D21, revised and confirmed by the owner of the product on 2026-10-17): an active owner MAY act as a health professional at any time by completing a professional profile (name, specialty, and the matricula with its jurisdiction), and completing it adds the professional role, and only that role, to their own membership in the same transaction, audited as a role change with `via: owner_professional_profile`. There is no one-time limit, no closure when the wizard is finished and no age window. Nobody else, and no other role, can use the exception.

#### Scenario: Self-promotion attempt
- GIVEN a reception user
- WHEN the user submits a profile update that sets role to owner
- THEN the system rejects the change and audits the attempt

#### Scenario: The owner acts as a professional by completing the profile (decision D21)
- GIVEN an active owner, whenever they choose to do it (the first run, the day after, a year later)
- WHEN the owner completes the professional profile with name, specialty, matricula and jurisdiction
- THEN the professional role is added to their own membership and the profile is saved, in one transaction
- AND the change is audited as a role change that says `via: owner_professional_profile`
- AND the matricula is recorded unverified and opens clinical work (D1)
- AND repeating the request updates the profile and does not add a second role or a second audit entry

#### Scenario: The owner role needs the complete profile first (decision D21)
- GIVEN an active owner
- WHEN the owner submits the profile without the matricula, without its jurisdiction, with a malformed matricula, or with a matricula an active professional already holds
- THEN the request is refused and the owner has no professional role, no profile and no audit entry for it

#### Scenario: Nobody else self-assigns a role (decision D21)
- GIVEN an admin, a reception user, or a professional
- WHEN they try to use the owner-as-professional path, or an owner tries to change their own roles through the role-change endpoint
- THEN the system refuses, audits the denial and changes no role

#### Scenario: Removing the last owner
- GIVEN an organization with one active owner
- WHEN that owner tries to remove or deactivate themselves
- THEN the system MUST refuse until another owner exists

#### Scenario: Role change is audited
- GIVEN an owner assigns the reception role to a user
- WHEN the change is saved
- THEN an audit entry records actor, subject, previous and new roles

### Requirement: Owner and admin bring professionals in (D19, revised)

An owner and an admin MUST each be able to invite or create a user with the `professional` role, and to grant the `professional` role to an existing member. Nobody below an owner MAY create an owner or touch one. The ceiling limits what a person can hand out, and an admin MUST remain able to manage the professionals who already exist (edit their other roles, deactivate, reactivate). Because an admin who adds a professional could hold a second, clinical account, the system MUST NOT stay silent about it: when an admin who is not an owner adds a professional, by invitation or by granting the role, the system MUST write the audit event `professional.added_by_admin` and MUST email every active owner of the organization through the transactional email. The email MUST carry no clinical data. It MUST be sent after the change is committed, and a failure of the email provider MUST NOT undo the change. An owner who adds a professional triggers neither the event nor the email. The review flag of patient assignments to a professional added in the last 7 days (below) stays. Decision D19 was revised and confirmed by the owner of the product on 2026-10-17; the accepted residual risk is that clinical separation against a malicious admin is audited and notified rather than prevented.

#### Scenario: Admin invites a professional
- GIVEN an admin and two active owners (and one deactivated owner)
- WHEN the admin invites a user with the professional role
- THEN the invitation is sent
- AND the audit event `professional.added_by_admin` is written with `via: invitation`
- AND each active owner receives an email, and the deactivated owner and the admin do not

#### Scenario: Admin grants the professional role to a colleague
- GIVEN an admin and a reception user
- WHEN the admin adds the professional role to that user
- THEN the roles of the user change, the ordinary role change entry is written, and `professional.added_by_admin` is written with `via: role_grant`
- AND each active owner receives an email

#### Scenario: Owner brings a professional in
- GIVEN an owner
- WHEN the owner invites a user with the professional role, or adds the role to a member
- THEN the system accepts
- AND no `professional.added_by_admin` event is written and no email is sent

#### Scenario: The email provider is down
- GIVEN an admin who grants the professional role while the email provider rejects every message
- WHEN the change is saved
- THEN the change stays, and the audit event is the record

#### Scenario: Admin cannot create an owner
- GIVEN an admin
- WHEN the admin invites an owner, or adds the owner role to a member, or changes the roles of an owner
- THEN the system refuses and audits the denial

#### Scenario: Admin manages an existing professional
- GIVEN a professional who already works in the organization
- WHEN an admin deactivates the professional or changes their other roles
- THEN the system accepts, and no notification is sent because no professional was added

### Requirement: Clinical notes readable by health professionals only (hard rule)

Only health professionals MUST be able to read the content of clinical notes. A non-clinical owner/admin MUST NEVER be able to read clinical note content. No organization setting, sharing option, grantable permission, support grant, role combination or operator action MAY grant this access. The rule MUST hold on every path, including search, export, report, print, preview, notification content, attachments and API responses.

#### Scenario: Non-clinical admin denied
- GIVEN an owner/admin with no professional role
- WHEN the admin requests a patient's clinical notes by any path
- THEN access MUST be denied
- AND the denied attempt is audited

#### Scenario: No setting can enable it
- GIVEN every organization setting and every grantable permission
- WHEN the admin searches for a way to allow admin reading of clinical notes
- THEN no such option exists and no configuration changes the outcome

#### Scenario: Indirect leakage through search
- GIVEN a non-clinical admin searching for a term present only in clinical notes
- WHEN results are returned
- THEN no note text, snippet or match count derived from clinical content is returned

#### Scenario: Indirect leakage through reports and exports
- GIVEN a non-clinical admin generating a report or export
- WHEN the output is produced
- THEN it MUST contain no clinical note content

### Requirement: Clinical permissions are locked to health professionals

Permissions that read or write clinical content (the `clinical.*` group) MUST be assignable only through the professional role. They MUST NOT appear among the grantable permissions and MUST NOT be grantable to owner/admin or reception users.

#### Scenario: Attempt to grant a clinical permission to reception
- GIVEN an owner configuring a reception user's permissions
- WHEN the owner looks for a clinical permission to grant
- THEN none is offered
- AND a direct request to grant one is rejected and audited

### Requirement: Reception cannot read clinical note content

A reception user MUST NOT read the content of clinical notes. Reception MAY see demographics, coverage, the schedule, attendance and payments, and the minimal safety flag defined in `patients`.

#### Scenario: Reception opens a patient
- GIVEN a reception user viewing a patient record
- WHEN the record is displayed
- THEN demographics, coverage, appointments, attendance and payments are shown
- AND clinical note content, template data and clinical attachments are not

#### Scenario: Reception requests a note by identifier
- GIVEN a reception user who knows a note's identifier
- WHEN the user requests it
- THEN the server denies it

### Requirement: Organization setting "reception sees clinical metadata"

The organization MUST have one setting, "reception sees clinical metadata", off by default, that is the single switch for what reception may know about clinical items without reading their content. When on, reception MAY see that a clinical document, prescription or signed consent exists, together with its name or title, category and date. When off, reception sees none of that, except neutral consent status (pending, signed, revoked, dates) under a generic label. The setting MUST NOT allow reception to download or read any clinical content, MUST NOT affect non-clinical owner/admin (who never see clinical metadata linked to a patient), and changes to it MUST be audited. Other capabilities (`documents`, `e-prescription`, `informed-consent`) MUST rely on this setting and MUST NOT define their own.

#### Scenario: Setting off
- GIVEN the setting is off and patient X has a lab result document and a prescription
- WHEN reception opens X's file
- THEN no clinical document name, prescription entry or specific consent title is shown

#### Scenario: Setting on
- GIVEN the setting is on
- WHEN reception opens X's file
- THEN the existence, name and category of X's clinical documents are listed
- AND the file content cannot be opened or downloaded

#### Scenario: Setting does not reach the admin
- GIVEN the setting is on
- WHEN a non-clinical owner/admin opens a patient's file
- THEN no clinical metadata linked to the patient is shown to the admin

### Requirement: Demographics are organization-wide

Patient demographics and coverage MUST be readable by every health professional and every reception user of the organization, and by owner/admin, regardless of care relationship. Only clinical content MUST be scoped by care relationship and the sharing scope. A professional MAY edit demographics only of patients they treat, unless they hold the patient-administration permission.

#### Scenario: Professional finds any patient
- GIVEN professional B has no care relationship with patient P
- WHEN B searches for P by name
- THEN P's demographics are returned
- AND P's clinical content is not accessible to B unless the clinical rules allow it

### Requirement: Professional clinical access follows the care relationship

A health professional MUST read clinical content only of patients with whom they have a care relationship (they are a treating professional), within the visibility model below, unless the organization turns on sharing. Professionals MUST NOT edit other professionals' signed entries. The care relationship MUST be derived only from the sources in the definition; ending those facts (for example cancelling the only appointment before it is attended) ends the relationship, and the system MUST NOT keep a relationship that no fact supports. An appointment whose identity is not confirmed MUST NOT give the professional any access that depends on a care relationship, on any path, until the identity is confirmed. The appointment MUST be usable in the meantime for scheduling and administrative purposes. The patient-facing confirmation MUST NOT differ because of this rule.

#### Scenario: Professional reads a colleague's patient
- GIVEN sharing is off and patient P has no appointment, encounter or assignment with professional B
- WHEN B opens P's clinical record
- THEN access is denied

#### Scenario: Professional reads own patient
- GIVEN professional A has an encounter with patient P
- WHEN A opens P's clinical record
- THEN access is granted and audited

#### Scenario: Appointment creates the relationship
- GIVEN reception booked a scheduled appointment of patient P with professional A and there is no encounter yet
- WHEN A opens P's clinical record
- THEN access is granted as a treating professional

#### Scenario: Stranger books online with a victim's document
- GIVEN patient V exists with clinical records by other professionals, and has no care relationship with professional B
- AND a stranger completes a public online booking with B using V's DNI and their own email
- WHEN B opens V's clinical record
- THEN access is denied, because the appointment's identity is not confirmed
- AND the stranger sees the same confirmation a genuine patient would see
- AND an identity review for the appointment is waiting for reception

#### Scenario: Reception confirms the identity
- GIVEN the online appointment above, with identity not confirmed
- WHEN a reception user confirms the patient's identity at check-in
- THEN the appointment becomes identity confirmed
- AND B can read V's clinical record as a treating professional

#### Scenario: Professional books themselves for an existing patient
- GIVEN an organization with reception staff, and professional B with no care relationship with existing patient P
- WHEN B books an appointment of P with themselves
- THEN B gets no clinical access to P through that appointment
- AND B's own check-in of P does not confirm the identity
- AND access starts only when another staff member confirms P's identity

#### Scenario: Solo practice self-confirms at check-in
- GIVEN an organization whose only active staff member is professional S
- AND an online appointment of S matched to existing patient P with the identity unconfirmed
- WHEN S checks P in person, sees P's ID document and confirms the identity
- THEN the identity becomes confirmed and S can read P's clinical record as a treating professional
- AND the confirmation is audited with the "self_confirmed" marker

#### Scenario: Self-confirmation after staff join
- GIVEN S self-confirmed P's identity while the organization had no other staff
- WHEN a reception user joins the organization
- THEN P's confirmed appointment stays confirmed
- AND a later unconfirmed appointment of S must be confirmed by someone other than S

#### Scenario: No-show with confirmed identity
- GIVEN reception booked P with professional A, so the identity is confirmed, and the appointment was marked no-show
- WHEN A opens P's clinical record
- THEN access is granted as a treating professional

#### Scenario: No-show with unconfirmed identity
- GIVEN an online appointment matched to existing patient P that was never confirmed and was marked no-show
- WHEN professional A opens P's clinical record
- THEN access is denied

#### Scenario: Cancelled appointment never attended
- GIVEN patient P's only appointment with professional B was cancelled and P was never attended by B
- WHEN B opens P's clinical record
- THEN access is denied

#### Scenario: Pending online booking
- GIVEN patient P's only appointment with professional B is "pending approval"
- WHEN B opens P's clinical record
- THEN access is denied, because a pending appointment never creates a care relationship
- AND after approval, access also requires the identity to be confirmed when the booking matched an existing patient

### Requirement: Opening an encounter does not create access

Opening an encounter MUST NOT, by itself, give the professional a care relationship with the patient. The relationship MUST come from an appointment with confirmed identity, an explicit assignment or a signed encounter that already exists, with the single exception of a patient nobody has written about yet. An encounter that is still a draft MUST NOT count as a source. The database MUST refuse an encounter that the service would refuse. (Decision D20, orchestrator decision pending owner confirmation; the clinical-records spec has the full rule.)

#### Scenario: Opening an encounter to read a record
- GIVEN patient P has signed notes by professional A and professional B has no care relationship with P
- WHEN B posts an encounter for P in order to read P's record
- THEN the request is denied and audited, no encounter is created and B gains no access

#### Scenario: Backstop under the service
- GIVEN the same situation and a write that reaches the database without passing through the service
- WHEN the encounter is inserted
- THEN the database refuses it

### Requirement: Explicit patient assignment

An owner/admin or a user holding the patient-administration permission MUST be able to assign a patient to a professional and to remove that assignment. The assignment MUST create a care relationship for that professional. A professional MUST NOT be able to assign a patient to themselves. Assignment and removal MUST be audited. This action MUST be available from Stage 1, so that a professional can record anamnesis before any appointment exists.

#### Scenario: Assign before the first appointment
- GIVEN reception registered a new patient and no appointment exists
- WHEN an authorized user assigns the patient to professional A
- THEN A can read and edit the patient's anamnesis as a treating professional

#### Scenario: Professional tries to self-assign
- GIVEN professional B with no care relationship with patient P
- WHEN B attempts to assign P to themselves
- THEN the action is denied and audited

#### Scenario: Assignment to a recently added professional is flagged (D19)
- GIVEN professional A was added to the organization less than 7 days ago
- WHEN a user who does not hold the professional role assigns a patient to A
- THEN the assignment is created as usual
- AND a distinct `assignment.review_flag` audit event is written next to `assignment.created`
- AND no such event is written for a professional added 7 days ago or more, or when the actor is a professional

#### Scenario: Assignment removed
- GIVEN professional A treats patient P only through an explicit assignment
- WHEN the assignment is removed
- THEN A loses clinical access to P immediately
- AND entries A already signed remain attributed to A

### Requirement: One clinical visibility model (sharing scope)

Every clinical item MUST have one effective visibility level among: **author only**, **treating professionals**, and **organization** (all health professionals of the organization). The effective level is the narrower of the level chosen for the item and the ceiling set by the sharing scope:

- The author MAY narrow an entry to author only, but only at creation or while it is a draft; once signed, its visibility MUST NOT change. An author-only entry MUST be readable by its author alone and other readers MAY be shown that a restricted entry exists, without content.
- When sharing is off, the ceiling for all clinical items is treating professionals.
- When sharing is on, the ceiling is organization for the template kinds included in the shared scope, and treating professionals for the rest. The shared scope is an **inclusion list** of templates configured by the owner/admin: only templates on the list are shared. When sharing is first enabled, the list contains every template except psychology. A template added to the product later MUST NOT be shared until the owner/admin adds it. Adding psychology MUST be an explicit, audited choice.
- Items that are not template entries (anamnesis, clinical documents, signed consent content) follow the general ceiling: organization when sharing is on, treating professionals otherwise.
- **Prescriptions never follow sharing** (D17): only the prescriber and the patient's treating professionals MAY read them, whatever the sharing setting.

Readers who are not treating professionals MUST have read-only access. Sharing MUST NOT extend access to non-professionals, MUST NOT cross organizations, and every shared read MUST be audited with a distinct marker and the sharing basis. Toggling sharing and changing the shared scope MUST be audited and MUST take effect immediately. Clinical access rules MUST apply uniformly across disciplines: a specialty or template MUST NOT bypass the role rules, and it only changes the ceiling as described above.

#### Scenario: Sharing enabled
- GIVEN sharing is on and the generic template is in the shared scope
- WHEN professional B, who does not treat patient P, reads an encounter of professional A for P
- THEN access is granted read-only
- AND the audit entry marks the read as shared

#### Scenario: Psychology excluded by default
- GIVEN sharing is on and no scope was configured
- WHEN a non-treating professional opens the patient's record
- THEN psychology entries are not shown to them

#### Scenario: Author restricts an entry
- GIVEN sharing is on and a psychologist marks a draft entry author only
- WHEN another professional of the organization, treating or not, opens the patient
- THEN the entry content is not shown
- AND its existence MAY be indicated without content

#### Scenario: Restriction after signing
- GIVEN a signed entry with default visibility
- WHEN its author tries to mark it author only
- THEN the change is refused

#### Scenario: New template is not shared by default
- GIVEN sharing is on with the initial shared scope
- WHEN a new template becomes available in the product and a professional signs an entry with it
- THEN a non-treating professional cannot read that entry until the owner/admin adds the template to the shared scope

#### Scenario: Prescriptions stay out of sharing
- GIVEN sharing is on with every template in the shared scope
- WHEN professional C, who did not prescribe and does not treat the patient, opens the patient's prescriptions
- THEN access is denied

#### Scenario: Sharing does not widen to admin or reception
- GIVEN sharing is on
- WHEN an admin or reception user requests clinical notes
- THEN access remains denied

#### Scenario: Sharing disabled again
- GIVEN sharing is switched off
- WHEN professional B, who does not treat P, requests P's record
- THEN access is denied again immediately

#### Scenario: Shared reader cannot write
- GIVEN sharing is on and professional B does not treat patient P
- WHEN B tries to add an addendum or edit anything on P's record
- THEN the action is denied

#### Scenario: Treating professional adds an addendum
- GIVEN professional B treats patient P and professional A signed an entry for P
- WHEN B adds an addendum to A's entry
- THEN the addendum is attributed to B and the original is unchanged

### Requirement: Grantable non-clinical permissions

An owner/admin MUST be able to grant, per user, a fixed set of non-clinical permissions that organizations commonly delegate: register out-of-hours appointments (override), book over an active slot hold that another person is completing (override hold), register past appointments, access another professional's calendar (delegated calendar), operate the cash register, administer patients (including explicit patient assignment), and run the guided first run of the organization (onboarding). Each grant and revocation MUST be audited. A permission MUST apply only inside the organization and MUST NOT widen clinical access. Default grants MUST be: reception holds patient administration and cash register; the owner holds all; an admin holds all except running the guided first run, which needs an explicit grant; professionals hold none beyond their own calendar.

#### Scenario: Grant the cash register to a professional
- GIVEN a solo center where a professional also collects payments
- WHEN the owner grants that professional the cash-register permission
- THEN the professional can open and close registers
- AND the grant is audited

#### Scenario: Permission outside the fixed set
- GIVEN a request to grant "read clinical notes" as a permission
- WHEN processed
- THEN the system refuses it

#### Scenario: Overriding a slot hold needs its own permission
- GIVEN a reception user without the override-hold permission and a slot hold that another person is completing
- WHEN the reception user books that time asking to override the hold
- THEN the request is refused as forbidden and the hold stays active
- AND once the owner grants the permission, the same request succeeds and the hold ends as invalidated

#### Scenario: Running the first run needs its own permission
- GIVEN an admin without the onboarding permission
- WHEN the admin opens the setup wizard state
- THEN the request is refused as forbidden
- AND once the owner grants the permission, the same request succeeds

#### Scenario: Revocation takes effect at once
- GIVEN a reception user holding the past-booking permission
- WHEN the owner revokes it
- THEN the next past-dated booking attempt by that user is rejected

### Requirement: Membership in locations

Reception and other non-professional staff MUST be assigned to one or more locations of the organization. A reception user MUST see and operate the schedule, check-in, payments and cash register of the assigned locations only. Owner/admin MUST have access to all locations. Professionals MUST have access to the locations where they practice. Location membership MUST NOT affect organization-wide demographics or any clinical rule.

#### Scenario: Reception limited to assigned locations
- GIVEN a reception user assigned to location "Centro" only
- WHEN they open the day view for location "Norte"
- THEN access is denied

#### Scenario: Demographics stay organization-wide
- GIVEN the same reception user
- WHEN they search for a patient who is only seen at "Norte"
- THEN the patient's demographics are returned

### Requirement: Patient access limited to own data

A patient MUST access only their own data, and only the categories the patient portal exposes (see `patient-portal`). Clinical note content MUST NOT be exposed to patients through the product in v1; a patient obtains a formal copy of their clinical history by request to the organization (Ley 26.529).

#### Scenario: Patient requests another patient's record
- GIVEN an authenticated patient
- WHEN the patient requests another patient's data
- THEN the server responds as if it does not exist

#### Scenario: Patient requests clinical note content
- GIVEN an authenticated patient
- WHEN the patient requests the content of their own clinical notes through the portal
- THEN the product does not offer it and the request is denied
- AND the patient is pointed to the formal copy request

### Requirement: Default deny and least privilege

New endpoints, resources and permissions MUST be denied by default until explicitly granted to roles. An unknown or malformed permission check MUST fail closed.

#### Scenario: Permission evaluation error
- GIVEN the permission check cannot be evaluated
- WHEN a request arrives
- THEN access is denied

### Requirement: Denials are uniform and non-leaking

A denial MUST NOT reveal the content, existence or owner of the protected resource. Denials of clinical access and cross-tenant attempts MUST be audited.

#### Scenario: Denied note request
- GIVEN a user without clinical access requests a note
- WHEN the request is denied
- THEN the response carries no patient or note details
