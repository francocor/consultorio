# Runbook: the sole owner who also needs the professional role

Audience: the operator on call and support. Scope: an organization whose only owner wants to work
as a health professional and can no longer add the role to themselves.

## Why it happens

During onboarding the owner can add the professional role to themselves (decision D21). That door
closes when the wizard is finished, or 30 days after the organization was created, whichever comes
first (`isSelfRoleOpen`). After that, nobody changes their own roles (authorization, "No
self-assignment or silent escalation of roles"): the API answers `onboarding_role_closed` for the
wizard step and `self` for a role change on one's own membership. An organization with a single
owner and no other member who may hand out the role has no way in from inside the product.

## Recovery

1. **Preferred, no operator needed.** The owner invites a second person with the `owner` role
   (`POST /staff/invitations`, "Staff", "Invite"). Once that person accepts, they change the roles of
   the first owner and add `professional` (an admin cannot add it; only an owner can). The first owner
   then completes the professional profile and the matricula, which opens the clinical gate. The
   second owner can be removed afterwards; the organization always keeps at least one active owner.
2. **Operator action, only when nobody else can be invited.** Add the role to the membership with the
   owner database connection, inside a transaction, and write the audit entry for it by hand with the
   operator as the actor and the support ticket in the reason. There is no reviewed script for this
   yet; until there is one, ask for a second reviewer before running it.

## Never

- Do not reopen the window by editing the creation date of the organization or the state of the
  wizard: both are evidence, and the 30 days are a deliberate limit.
- Do not give the role to an admin account to "borrow" clinical access. The professional gate needs
  an active profile with a recorded matricula of the person who treats patients.
