# ASVS Level 2: Stage 1 checklist

Scope: the secure core delivered in Stage 1 (organizations, identity, staff, patients, anamnesis, audit, branding, operator console, demo organization) measured against OWASP ASVS 4.0.3 Level 2. Anything that belongs to a later stage (patient portal, online booking, payments, e-prescriptions, uploads of clinical documents) is marked **Later** and is not claimed.

How to read it: **Met** has a test or a file you can open; **Partial** says what is missing; **Accepted** is a decision recorded with its reason; **Later** is out of scope for this stage. Paths are relative to the repository root.

Reviewed on 2026-10-16 by one author in a separate pass over the code after implementing it (not an independent reviewer: see the limits at the end). Findings of that pass and what was done with each are in "Review findings".

## V1 Architecture

| Requirement                                          | Status | Evidence                                                                                                                                                                |
| ---------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 Secure development lifecycle, threat modelling   | Met    | Specs, design and two gate reviews: `openspec/changes/health-practice-saas/` (`design.md`, `gate-review-1.md`, `gate-review-2.md`)                                      |
| 1.2 Authentication architecture                      | Met    | ADR-004 and ADR-008 in `design.md`; separate staff, patient and operator sessions                                                                                       |
| 1.4 Access control architecture, trusted enforcement | Met    | One server-side guard for every route (`apps/api/src/platform/http/auth-guard.ts`, `platform/authz/guard.ts`); row level security as the second line (ADR-002, ADR-003) |
| 1.6 Cryptographic architecture                       | Met    | Per-organization data keys wrapped by a KMS key (`platform/crypto/tenant-keys.ts`, `key-management.ts`); the local key is refused in production (`main/config.ts`)      |
| 1.7 Logging architecture                             | Met    | Append-only hash-chained audit trail (`platform/audit/`), redacting application logs (`main/logger.ts`)                                                                 |
| 1.9 Communications architecture                      | Later  | TLS is terminated by the reverse proxy: contract in `docs/dev-setup.md` ("Reverse proxy contract"). Deployment is a later stage                                         |
| 1.14 Configuration architecture                      | Met    | Environment-only configuration validated at boot (`main/config.ts` and its tests); no secret in the repository (gitleaks in CI and in the pre-commit hook)              |

## V2 Authentication

| Requirement                                                | Status  | Evidence                                                                                                                                                                                                                         |
| ---------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1.1 Passwords of at least 12 characters, 2.1.2 up to 128 | Met     | `packages/contracts/src/password.ts` (12 and 128); `apps/api/src/modules/identity/domain/password-policy.test.ts`. Operators need 14 (`modules/operator/application/operators.ts`)                                               |
| 2.1.7 Reject common and breached passwords                 | Met     | 100,000-entry list held by the platform (`apps/api/assets`); optional range query that never sends the password (`AUTH_BREACH_CHECK`)                                                                                            |
| 2.1.8 Strength guidance, 2.1.12 reveal option              | Met     | `apps/web/src/features/auth/components/PasswordHints.tsx`, `PasswordInput.tsx`                                                                                                                                                   |
| 2.1.9 No composition rules, 2.1.11 paste allowed           | Met     | Policy is length + list + not containing the email (`password-policy.ts`); fields accept paste                                                                                                                                   |
| 2.2.1 Anti-automation of credential attacks                | Met     | Lock after 10 failures for 15 minutes with a growing delay (`identity/application/lockout.ts`), per client and per tenant limits (`platform/http/rate-limit.ts`); `test/integration/lockout.test.ts`, `login-rate-limit.test.ts` |
| 2.2.3 Notify on security-relevant changes                  | Partial | Changes are audited and sessions end everywhere on a password change; no email to the person yet (notifications arrive in Stage 3)                                                                                               |
| 2.3.1 No default or shared passwords                       | Met     | Accounts come from invitations; the public demo password exists only for a flagged demo organization and the seed refuses production with it (`db/seed/demo/seed.ts`, `demo-seed.test.ts`)                                       |
| 2.4.1 Memory-hard password hashing                         | Met     | Argon2id, 19 MiB, 2 passes (`modules/identity/infrastructure/argon2.ts`); wrong password and unknown account cost the same (`verifyOrDummy`)                                                                                     |
| 2.5.1-2.5.4 Recovery without hints, single-use links       | Met     | Reset link: single use, 30 minutes, previous links revoked (`platform/tokens/kinds.ts`, `identity/application/password-reset.ts`); same answer whether or not the account exists; `test/integration/password-reset.test.ts`      |
| 2.7 / 2.8 Time-based one-time passwords                    | Met     | TOTP with replay protection (`platform/crypto/totp.ts`, `lastStep`), mandatory for owners, admins and professionals after 7 days, recovery codes stored as hashes (`recovery-codes.ts`); `two-factor*.test.ts`                   |
| 2.10 Service authentication                                | Met     | The operator console has its own accounts, cookie, database role and audit trail; second factor with no grace period (`modules/operator/`, `test/integration/operator-*.test.ts`)                                                |

## V3 Session management

| Requirement                                      | Status   | Evidence                                                                                                                                                                                                                                          |
| ------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1.1 No session token in the URL                | Met      | Opaque `HttpOnly` cookie (`platform/http/session-cookie.ts`)                                                                                                                                                                                      |
| 3.2.1 New session at sign-in, 3.2.2 high entropy | Met      | 256-bit random token, only its SHA-256 is stored (`identity/application/sessions.ts`); rotation when the scope changes; `sessions.test.ts`                                                                                                        |
| 3.2.3 Token only in a protected cookie           | Met      | `HttpOnly; SameSite=Lax; Path=/`, `Secure` outside local http, no `Domain`: host-only, never shared between organizations (`session-cookie.test.ts`)                                                                                              |
| 3.3.1 Logout and expiry invalidate the session   | Met      | Server-side revocation; password change ends every session in every organization (`app.revoke_user_sessions`); `sessions.test.ts`                                                                                                                 |
| 3.3.2 Re-authentication after inactivity         | Accepted | 12 hours idle, 7 days absolute (ADR-004) against the 30-minute idle guidance of Level 2. Compensated by mandatory second factor for privileged roles, instant revocation and a visible session list. Revisit before the first production customer |
| 3.4.4 `__Host-` cookie prefix                    | Partial  | The cookie is host-only with the right attributes but is named `sid` so that plain-http local development works; a `__Host-sid` name in secure mode is listed in "Open items"                                                                     |
| 3.7.1 Re-authentication for sensitive operations | Met      | Replacing the second factor and regenerating recovery codes need the password (`identity/application/reauthentication.ts`)                                                                                                                        |

## V4 Access control

| Requirement                                      | Status | Evidence                                                                                                                                                                                                                                                    |
| ------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1.1 Enforced on a trusted service layer        | Met    | A route without `auth` or `permission` fails at boot (`auth-guard.ts`); `test/policy/route-role-matrix.test.ts` runs every route as every role                                                                                                              |
| 4.1.3 Least privilege                            | Met    | Permission catalog and role bundles (`packages/contracts/src/roles.ts`); clinical permissions cannot be granted (`GRANTABLE`, database CHECK)                                                                                                               |
| 4.1.5 Fail securely                              | Met    | `current_setting('app.tenant_id')` without a default: a query outside a tenant context raises instead of returning rows (`platform/db/tenant-context.ts`, `tenant-context.test.ts`)                                                                         |
| 4.2.1 Object-level access (IDOR)                 | Met    | Row level security on every tenant table, forced, with a policy (`test/tenancy/rls-catalog.test.ts`); generated cross-tenant tests (`test/tenancy/isolation.generated.test.ts`); care-relationship backstop for clinical rows (`clinical-backstop.test.ts`) |
| 4.2.2 CSRF protection                            | Met    | `SameSite=Lax` plus an `Origin`/`Host` check on every state change (`platform/http/csrf-origin.ts`, test)                                                                                                                                                   |
| 4.3.1 Administrative interfaces use multi-factor | Met    | The operator console requires password plus code; support access needs a time-boxed grant from the organization (`operator-support.test.ts`)                                                                                                                |
| 4.3.2 Deletion of tenant data is controlled      | Met    | No code or database grant deletes tenant data except the listed ephemeral tables (`test/policy/no-delete.test.ts`, `no-delete.allowlist.json`, `test/integration/no-delete-privileges.test.ts`)                                                             |

## V5 Validation, sanitization and encoding

| Requirement                                     | Status | Evidence                                                                                                                                                                                                                      |
| ----------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.1.3 / 5.1.4 Positive validation, strict types | Met    | Every request body, query and param has a strict Zod schema shared with the web (`packages/contracts`); unknown keys are rejected; tenant ids are never accepted from a client (`test/policy/no-tenant-in-contracts.test.ts`) |
| 5.2 Sanitization and sandboxing                 | Met    | No `innerHTML`, `dangerouslySetInnerHTML`, `eval` in the web code; React escapes output; uploaded logos are decoded and re-encoded                                                                                            |
| 5.3.4 Injection-safe data access                | Met    | Drizzle parameterized queries; tenant context set with bound `set_config` parameters; no string-built SQL with user input (`no-delete.test.ts` also scans for raw SQL deletes)                                                |

## V6 Stored cryptography

| Requirement                                    | Status | Evidence                                                                                                                                               |
| ---------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 6.1.1 / 6.1.3 Sensitive data encrypted at rest | Met    | Anamnesis content is AES-256-GCM encrypted with the organization's data key, bound to table, column and row id (`anamnesis.content_enc`, `aes-gcm.ts`) |
| 6.2 Approved algorithms and modes              | Met    | AES-256-GCM, SHA-256, Argon2id, HMAC-SHA1 only inside TOTP as the standard requires (`aes-gcm.test.ts`, `totp.test.ts`)                                |
| 6.3 Cryptographic randomness                   | Met    | `crypto.randomBytes` / `randomInt` for tokens, codes and demo passwords                                                                                |
| 6.4 Key and secret management                  | Met    | KMS-wrapped data keys, keys are never deleted, `unwrap` bound to the organization (`tenant-keys.test.ts`, `key-management.ts`)                         |

## V7 Error handling and logging

| Requirement                                         | Status | Evidence                                                                                                                                                                                                         |
| --------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7.1.1 / 7.1.2 No credentials or health data in logs | Met    | Redaction of cookies, tokens and request bodies; query strings dropped (`main/logger.ts`, `logger.test.ts`); audit metadata rejects secret-looking keys (`audit-actions.ts`)                                     |
| 7.2 Log content                                     | Met    | Who, what, when, outcome, request id, address (`platform/audit/writer.ts`); mandatory events are listed and checked (`test/policy/audit-coverage.test.ts`)                                                       |
| 7.3 Log protection                                  | Met    | Append-only by trigger and privilege, SHA-256 hash chain sealed by a separate role, nightly verification (`audit-table.test.ts`, `audit-sealer.test.ts`, `audit-verify.test.ts`); the platform has its own chain |
| 7.4.1 Generic error messages                        | Met    | `application/problem+json` with a translation key and a request id, no stack, no SQL (`platform/http/problem.ts`)                                                                                                |

## V8 Data protection

| Requirement                                | Status   | Evidence                                                                                                                                                                                                                                      |
| ------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8.1.1 / 8.2.1 No caching of sensitive data | Met      | `Cache-Control: no-store` on every API answer unless a route chooses otherwise (`platform/http/security-headers.ts`); the web never persists the query cache or stores data in browser storage (lint rule in `packages/config/eslint/web.js`) |
| 8.2.2 Browser storage                      | Met      | Only the color scheme, the sidebar state and the organization's theme tokens are stored (`shared/lib/preferences.ts`, `theme-boot.ts`)                                                                                                        |
| 8.3.1 Sensitive data not in the URL        | Accepted | Emailed single-use tokens travel in the query string (`/reset-password?token=`): short-lived, single use, redacted from logs, `Referrer-Policy: no-referrer`                                                                                  |
| 8.3.4 Data minimization in each view       | Met      | Reception sees a safety alert as "consult the professional", never its content; the audit trail holds no clinical content (`PatientSummaryDto.hasSafetyFlag`, `AuditEventDto`)                                                                |

## V9 Communications

| Requirement              | Status | Evidence                                                                                                                                                                                                |
| ------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9.1 / 9.2 TLS everywhere | Later  | Terminated by the reverse proxy. The API sends `Strict-Transport-Security` when cookies are secure (`security-headers.ts`); production configuration requires secure cookies and rejects plaintext SMTP |

## V10 Malicious code

| Requirement                         | Status | Evidence                                                                                  |
| ----------------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| 10.2 Dependencies and integrity     | Met    | Frozen lockfile in CI, dependency audit job, secret scan job (`.github/workflows/ci.yml`) |
| 10.3 Deployed application integrity | Later  | Image signing and provenance belong to the deployment stage                               |

## V11 Business logic

| Requirement                                    | Status | Evidence                                                                                                                                            |
| ---------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11.1.4 Anti-automation of business flows       | Met    | Per client and per tenant limits, login limits, single-use links (`rate-limit.ts`, `login-rate-limit.test.ts`)                                      |
| 11.1.6 Sequential order of steps               | Met    | Invitation, reset and enrollment tokens are single use and bound to their purpose (`action-tokens.test.ts`)                                         |
| 11.1.x Demo content cannot reach real services | Met    | A demo organization's email goes to a fake sender and a misconfigured registry fails at boot (`main/adapter-resolver.ts`, test iterates every port) |

## V12 Files and resources

| Requirement                          | Status | Evidence                                                                                                                                                  |
| ------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 12.1 Upload limits                   | Met    | 512 KB and 2048 px for logos (`LOGO_MAX_BYTES`), checked in the web and on the server                                                                     |
| 12.2.1 File type verified by content | Met    | The image is decoded and re-encoded to PNG; SVG and anything else is refused with 415 before parsing (`modules/tenancy/branding/logo.ts`, `logo.test.ts`) |
| 12.5 / 12.6 Safe download            | Met    | The public logo is served with `nosniff` and `default-src 'none'; sandbox` (`branding-routes.ts`)                                                         |
| Clinical documents                   | Later  | Document upload arrives with the clinical record                                                                                                          |

## V13 API and web service

| Requirement                      | Status | Evidence                                                                                                                     |
| -------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 13.1.1 Same controls on all URLs | Met    | One guard registered before every route; the route inventory is tested (`route-categories.test.ts`, `public-routes.test.ts`) |
| 13.2.1-13.2.3 REST hygiene, CSRF | Met    | Methods match intent; JSON bodies only; Origin check; no CORS is enabled at all (same origin through the proxy)              |
| 13.2.5 Content type enforced     | Met    | Fastify rejects unsupported media types; uploads accept only the three image types                                           |

## V14 Configuration

| Requirement                               | Status  | Evidence                                                                                                                                                                                                                                                   |
| ----------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 14.1 Build and deploy                     | Met     | One CI workflow: typecheck, lint, unit, integration, Docker image smoke test, end-to-end with axe, Lighthouse budgets, audit, secret scan                                                                                                                  |
| 14.2 Dependencies                         | Met     | Dependency audit job in CI                                                                                                                                                                                                                                 |
| 14.3 Unintended disclosure                | Met     | Unknown hosts and unknown routes answer the same generic 404 (`tenant-host.test.ts`); no stack traces; no server banner of interest                                                                                                                        |
| 14.4.1-14.4.6 Response headers            | Met     | `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Cross-Origin-Resource-Policy`, a deny-all `Content-Security-Policy` and HSTS on every API answer (`security-headers.test.ts`). The web bundle gets its headers from the proxy (see below) |
| 14.4.7 Content Security Policy of the web | Partial | The contract is documented (`docs/dev-setup.md`: one inline theme script to hash, everything else same-origin). Enforcing it is the deployment stage's job; the build output is compatible with `default-src 'self'`                                       |
| 14.5 Request validation                   | Met     | Host allow-list by organization, Origin check, strict schemas                                                                                                                                                                                              |

## Review findings

A second pass over identity, authorization, tenancy, audit, the operator console and the new demo reset, reading the code again instead of trusting the tests that were written with it. Everything below is fixed in the same change unless it says otherwise.

| #   | Finding                                                                                                                                                                                                                                              | Severity         | Resolution                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | The API sent no security headers: answers carrying health data could be cached, framed or sniffed                                                                                                                                                    | High             | Fixed: `platform/http/security-headers.ts`, applied to every answer; routes that choose their own cache policy keep it                                                                                           |
| F2  | Minimum password length was 10 (ASVS 2.1.1 asks for 12)                                                                                                                                                                                              | Medium           | Fixed: 12 in the contract, the policy, the web hints and the tests                                                                                                                                               |
| F3  | `/public/boot` was cacheable for 60 s. After a branding change the next reload repainted the OLD look over the new one, so "applies after reload" was false for a minute                                                                             | Medium           | Fixed: revalidated on every load with an ETag (304 when unchanged); covered by an integration test and the Playwright spec                                                                                       |
| F4  | The application role could delete rows from `location`, `professional`, `professional_hours`, `membership_location`, `permission_grant`, `tenant_feature` and `tenant`; nothing in the code does, but the database should say the same as the policy | Medium           | Fixed: DELETE and TRUNCATE revoked (migration 0018); an integration test pins the exact list of tables the role may still delete from, each with a reason                                                        |
| F5  | A demo organization's emails could go through the real provider (invitations created by the operator, password resets)                                                                                                                               | Medium           | Fixed: messages carry their organization; the routed sender sends demo mail to a fake and refuses a message that does not say whose it is                                                                        |
| F6  | The new privileged reset could be reached by the application role                                                                                                                                                                                    | High (prevented) | Designed out: `EXECUTE` is revoked from `PUBLIC` and `app_rw` and granted only to `app_operator`; the audit trigger exception requires the owner role, a matching setting and a demo flag; tested by trying each |
| F7  | The session cookie is not named `__Host-sid`                                                                                                                                                                                                         | Low              | Open (see below)                                                                                                                                                                                                 |
| F8  | Idle timeout of 12 hours against the 30 minutes of the Level 2 guidance                                                                                                                                                                              | Low              | Accepted by ADR-004 with compensating controls; to be revisited with the owner                                                                                                                                   |
| F9  | Single-use tokens remain in the address bar of the emailed link                                                                                                                                                                                      | Low              | Accepted: single use, short life, redacted from logs, no referrer                                                                                                                                                |
| F10 | `app.demo_reset` takes brief exclusive locks while it lifts row security table by table; run against a busy production database it would stall other organizations                                                                                   | Low              | Accepted: only the operator can call it, only for demo organizations, and a deployed demo lives on its own schedule. Documented in the migration                                                                 |

## Open items before the first production customer

1. Name the session cookie `__Host-sid` when cookies are secure (needs the test helpers to learn the name; ASVS 3.4.4).
2. Decide the idle timeout with the owner (ASVS 3.3.2).
3. Enforce the Content Security Policy of the web bundle at the proxy, with the hash of the theme script (ASVS 14.4.7).
4. Send an email to the person when their password or second factor changes (ASVS 2.2.3), together with the notifications module.
5. Give the scheduled demo reset (job) an operator-role connection in the worker, and decide how a deployed demo hands its rotated passwords to the people who need them.

## Limits of this review

It was written by the same author who implemented the stage, after the fact, from the code and the tests. It is a structured self-review, not a penetration test and not an independent audit. The sub-agent "fresh context" review the plan asks for was not available to this author (no delegation tool in this executor), so the orchestrator should run it before Stage 2 and record its report next to this file.
