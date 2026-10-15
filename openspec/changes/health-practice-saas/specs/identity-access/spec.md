# Delta for identity-access

Authentication, mandatory 2FA for privileged roles, sessions, passwordless patient sign-in and audited password reset.

**Quick read**: no unauthenticated endpoint outside an explicit public allowlist (login, public booking, token links, webhooks). Staff sign in with password plus 2FA where required; patients sign in with an email one-time code and have no password. Credentials are never exposed or defaulted. Every credential event is audited.

## ADDED Requirements

### Requirement: Authentication required by default

Every endpoint and resource MUST require an authenticated, verified session, except the explicit public allowlist below. Tokens or session credentials MUST be verified on every request. Webhooks MUST authenticate the sender through a verifiable signature or equivalent.

The public allowlist is exactly: staff login and password-reset entry points; invitation acceptance; signup and email verification (`tenant-onboarding`); public booking pages at organization and professional level, and the public waitlist self-join (`online-booking`); single-purpose token links for one resource (appointment confirm, cancel and reschedule; waitlist offer accept and decline; video join; notification opt-out; WhatsApp opt-in requested by email); patient portal activation, by invitation or by verified registration, and one-time-code sign-in (`patient-portal`); and provider webhooks. Every token link MUST be unguessable, bound to a single resource and purpose, expire, be rate limited, and reveal nothing beyond what its purpose needs. Any endpoint not on the allowlist MUST require authentication.

#### Scenario: Token link reveals only its purpose
- GIVEN a confirmation link for appointment A
- WHEN an anonymous visitor opens it
- THEN only appointment A's date, time, location and professional are shown
- AND no other appointment, patient or tenant data can be reached with it

#### Scenario: Endpoint outside the allowlist
- GIVEN an endpoint that is not on the public allowlist
- WHEN it is called without a session
- THEN the system responds with an authentication-required result

#### Scenario: Anonymous request to a protected resource
- GIVEN no valid session
- WHEN a request targets any protected resource
- THEN the system MUST respond with an authentication-required result and disclose no data

#### Scenario: Tampered or unsigned credential
- GIVEN a request carrying an altered, unsigned or foreign-issued credential
- WHEN the system evaluates it
- THEN the request MUST be rejected as unauthenticated

#### Scenario: Unsigned webhook
- GIVEN a webhook call without a valid sender signature
- WHEN the system receives it
- THEN the call MUST be rejected and no state changes

### Requirement: Credential-based login

A staff user (owner/admin, professional, reception) MUST sign in with identifier and password. Passwords MUST be stored only in a salted, slow, one-way form and MUST NOT be recoverable or logged. Login failures MUST NOT reveal whether the identifier exists.

#### Scenario: Successful login
- GIVEN an active user with valid credentials and no 2FA enrolled
- WHEN the user submits them
- THEN a session is created bound to that user's organization and roles

#### Scenario: Wrong password and unknown identifier look the same
- GIVEN one attempt with a wrong password and one with an unknown identifier
- WHEN both are submitted
- THEN both receive the same generic failure message and comparable behavior

#### Scenario: Deactivated user
- GIVEN a deactivated user with a correct password
- WHEN the user attempts to sign in
- THEN access MUST be refused with the same generic failure
- AND the attempt is audited

### Requirement: Password policy

The system MUST enforce a minimum password strength and MUST reject known-weak or default values such as "1234". Common and known-breached passwords MUST be rejected by checking against a list held by the platform itself; the candidate password MUST NOT be sent to a third party for this check. The system MUST NOT assign a default or shared password to any account.

#### Scenario: Weak password rejected
- GIVEN a user choosing a password
- WHEN the password is too short or appears in the platform's common-password list
- THEN the system MUST reject it with an actionable es-AR message

#### Scenario: No default password on provisioning
- GIVEN an owner invites a new staff member
- WHEN the account is created
- THEN no password is preset
- AND the invitee sets their own through a single-use, expiring link

### Requirement: Account lockout and throttling

The system MUST apply two complementary protections to repeated failed logins: a progressive delay (backoff) that grows with consecutive failures per account and per source, and a temporary lock of the account after a defined number of consecutive failures. A wrong or reused second-factor code MUST count as a failure toward the same lock, just like a wrong password. Locked accounts MUST NOT authenticate even with the correct password until the lock expires or an authorized recovery completes. Lock and unlock events MUST be audited.

#### Scenario: Backoff before lockout
- GIVEN a user with several consecutive failed attempts below the lock threshold
- WHEN the next attempt is made immediately
- THEN the system delays or refuses it according to the backoff schedule
- AND the response looks the same as for an unknown identifier

#### Scenario: Account locks after repeated failures
- GIVEN a user with N consecutive failed attempts
- WHEN the threshold is reached
- THEN the account is locked and further attempts fail without checking credentials
- AND the user is told, generically, that they can retry later or reset the password

#### Scenario: Second-factor failures lock the account
- GIVEN a user with the correct password who submits wrong 2FA codes repeatedly
- WHEN the failures reach the lock threshold
- THEN the account is locked as for wrong passwords and the lock is audited

#### Scenario: Correct password while locked
- GIVEN a locked account
- WHEN the correct password is submitted
- THEN access MUST still be refused

#### Scenario: Lock does not leak existence
- GIVEN an unknown identifier attempted repeatedly
- WHEN throttling applies
- THEN the response is indistinguishable from throttling of a real account

### Requirement: Two-factor authentication

2FA MUST be mandatory for professionals and for owners/admins. Each such user has a grace period of 7 days counted from their first sign-in; during the grace period they MUST be prompted to enroll at every sign-in, and after it ends they MUST complete enrollment before reaching any application data. For reception users 2FA is optional (they MAY enroll) unless the organization requires it for all members, in which case the same 7-day grace period applies. When enrolled, login MUST require a valid second factor after the password. The system MUST provide single-use recovery codes at enrollment. Resetting or replacing 2FA MUST require re-authentication and MUST be audited. A user in a mandatory role MUST NOT be able to turn 2FA off; they MAY only replace the factor. Patients do not use 2FA; they sign in with an email one-time code (see below).

#### Scenario: Grace period for a new professional
- GIVEN a professional who signed in for the first time 3 days ago and has not enrolled
- WHEN they sign in
- THEN they reach the application and are prompted to enroll

#### Scenario: Grace period over
- GIVEN an owner who signed in for the first time 8 days ago and has not enrolled
- WHEN they sign in with the correct password
- THEN they MUST complete 2FA enrollment before reaching any application data

#### Scenario: Reception without the organization requirement
- GIVEN a reception user and an organization that does not require 2FA
- WHEN the user signs in without 2FA
- THEN access is granted

#### Scenario: Mandatory role cannot disable 2FA
- GIVEN a professional with 2FA enrolled
- WHEN they try to disable it
- THEN the system refuses and offers to replace the factor

#### Scenario: Login with 2FA
- GIVEN a user with 2FA enrolled
- WHEN the correct password is submitted
- THEN no session is granted until a valid second factor is provided

#### Scenario: Invalid or reused second factor
- GIVEN a pending 2FA challenge
- WHEN an invalid or already-used code is submitted
- THEN the challenge fails, counts toward lockout and grants no session

#### Scenario: Recovery code is single-use
- GIVEN a user who lost the second factor
- WHEN a recovery code is used
- THEN it works once and cannot be reused

#### Scenario: Organization requires 2FA
- GIVEN an organization that requires 2FA and a reception member without it whose grace period has ended
- WHEN the member signs in
- THEN the member MUST complete enrollment before reaching any application data

### Requirement: Passwordless patient sign-in by email one-time code

A patient (portal identity, see `patient-portal`) MUST sign in with a one-time code sent to the verified email address of that portal identity. Patients MUST NOT have a password. The code MUST be single-use, expire after a short period (default 10 minutes), be invalidated after a bounded number of wrong attempts (default 5), and requests for codes MUST be rate limited per identity and per source. The code MUST be delivered by email only; SMS and WhatsApp MUST NOT be used for one-time codes. The response to a code request MUST be identical whether or not the email belongs to a portal identity. Portal sessions are a separate session class from staff sessions and MUST NOT grant any staff capability. Code requests, sign-ins, failures and lockouts MUST be audited.

#### Scenario: Sign in with a valid code
- GIVEN a portal identity with a verified email
- WHEN the patient requests a code and enters it within its validity
- THEN a portal session is created for that identity's organization

#### Scenario: Code reused or expired
- GIVEN a code that was already used or has expired
- WHEN it is submitted
- THEN sign-in fails and no session is created

#### Scenario: Unknown email
- GIVEN an email that belongs to no portal identity
- WHEN a code is requested
- THEN the response is identical to the one for a known email
- AND no message is sent

#### Scenario: Code guessing
- GIVEN a code with 5 wrong attempts
- WHEN another attempt is made
- THEN the code is invalidated and a new one must be requested

#### Scenario: Staff password does not open the portal
- GIVEN a reception user who is also a patient
- WHEN they use their staff credentials on the portal sign-in
- THEN access is refused, because they must use their separate portal identity

### Requirement: Session management

Sessions MUST expire after inactivity and after a maximum lifetime. Users MUST be able to view their active sessions and revoke any of them. Logging out MUST invalidate the session server-side. Sensitive actions (changing password, 2FA settings, role changes) SHOULD require recent re-authentication.

#### Scenario: Expired session
- GIVEN a session past its inactivity or maximum lifetime
- WHEN a request uses it
- THEN the request MUST be rejected and the user redirected to sign in
- AND unsaved-work loss MUST be minimized by clear messaging in es-AR

#### Scenario: Remote revocation
- GIVEN a user with two active sessions
- WHEN the user revokes one
- THEN that session fails on its next request

#### Scenario: Revocation on credential change
- GIVEN a user changes their password
- WHEN the change completes
- THEN all other sessions of that user are invalidated

#### Scenario: Deactivated user's sessions
- GIVEN an owner deactivates a user
- WHEN the user's existing session makes its next request
- THEN the request MUST be rejected

### Requirement: Audited, non-enumerating password reset

Password reset MUST NOT be callable to change another user's password without proof of control of the account. Reset MUST use a single-use, short-lived token delivered by email to the account's verified email address (never by WhatsApp or SMS). The reset request response MUST be identical whether or not the account exists. Reset completion, token issue and failures MUST be audited. Completing a reset MUST NOT bypass 2FA enrollment, and MUST invalidate existing sessions.

#### Scenario: Request for existing and unknown accounts
- GIVEN reset is requested for one existing and one unknown identifier
- WHEN both are submitted
- THEN both receive the same neutral response

#### Scenario: Expired or reused token
- GIVEN a reset token that expired or was already used
- WHEN it is submitted
- THEN the reset MUST fail and the password stays unchanged

#### Scenario: Reset of a 2FA-enrolled account
- GIVEN a user with 2FA who completes a password reset
- WHEN the user next signs in
- THEN 2FA is still required

#### Scenario: No public reset by identifier alone
- GIVEN an anonymous actor knowing only a victim's identifier
- WHEN the actor calls any reset endpoint
- THEN the victim's password MUST remain unchanged

### Requirement: Authentication events audited

Successful and failed logins, lockouts, 2FA changes, session revocations and password changes MUST be written to the audit log with timestamp, user (if known), organization (if known) and origin.

#### Scenario: Failed login recorded
- GIVEN a failed login
- WHEN the attempt completes
- THEN an audit entry exists without the attempted password

### Requirement: Secrets are never committed or exposed

Credentials, signing keys and provider secrets MUST be supplied through configuration at runtime and MUST NOT appear in source control, logs, responses or exports.

#### Scenario: Error response
- GIVEN an internal failure during authentication
- WHEN the system responds
- THEN the response contains no secret, hash or stack detail
