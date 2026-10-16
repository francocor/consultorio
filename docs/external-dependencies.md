# External dependencies

Things outside the codebase that take calendar time and must start early. The lead-time track in slice S1.00 fills the owner, dates and status columns.

Status values: `not started`, `requested`, `in progress`, `approved`, `blocked`, `deferred`.

## Local-first policy (decided by the owner)

The owner decided to build and verify everything locally first. Real AFIP/ARCA, WhatsApp, e-prescription and legal work is **deferred**: no request has been filed, no account has been opened and no real credential exists. Until each dependency is approved, the code runs against the fake or local adapter named in the last column of the table (design section 6), and the demo guard refuses any real adapter on the demo tenant.

Deferring does not remove the lead time. Every row keeps its `Needed by` stage, and the calendar only starts counting on the day the owner files the request. Anything that needs a real third party (a certificate, a verified business account, a signed contract, a legal opinion) is an owner action, never a task for the code.

| Dependency                                          | Needed by                     | Why it is on the critical path                                                                                                            | Owner | Requested on | Status   | Local stand-in until approved                                    |
| --------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------ | -------- | ---------------------------------------------------------------- |
| AFIP/ARCA certificate and homologation access       | Stage 4                       | Electronic invoicing cannot be tested or released without a certificate and a homologation (test) environment.                            | Owner |              | deferred | `InvoiceIssuer` fake that returns a deterministic CAE.           |
| Meta WhatsApp Business verification (platform WABA) | Stage 3                       | Business verification and template approval take days to weeks. Reminders and the waitlist depend on them.                                | Owner |              | deferred | `WhatsAppSender` fake that only logs. Email through Mailpit.     |
| e-prescription provider (Q3)                        | Stage 5                       | An authorized platform registered under Ley 27.553 / ReNaPDiS must be chosen. Its API shape decides the `PrescriptionProvider` contract.  | Owner |              | deferred | `PrescriptionProvider` fake that returns a placeholder PDF.      |
| Mercado Pago account and preapproval                | Stage 6                       | Subscription billing. A spike validates changing the amount of a preapproval; a one-off payment is the fallback.                          | Owner |              | deferred | `PaymentsGateway` fake.                                          |
| Legal review of hosting (Q1)                        | Before the first real patient | Is São Paulo plus the AAIP model clauses acceptable, or does the first deployment start in an EU region? The code is the same either way. | Owner |              | deferred | None needed locally. Blocks any deployment that holds real data. |
| Legal review of erasure (Q7)                        | Before the first real patient | Confirm that governance-mode Object Lock with a privileged erasure role satisfies the retention duty and the erasure obligations.         | Owner |              | deferred | None needed locally. Blocks the archive slices of Stage 6 (D13). |

## How to use this file

1. When you start a request, fill in the date and move the status from `deferred` to `requested`.
2. Record decisions and contacts in the notes section below, never credentials. Secrets belong in the deployment environment, not in git.
3. A row is `approved` only when the dependency is usable in the environment that needs it (for example, a homologation certificate works against the AFIP test service).

## Notes

- Stage 1 (secure core) needs none of these dependencies. The first hard dependencies are WhatsApp (Stage 3) and AFIP/ARCA (Stage 4). The two legal reviews gate the first real patient, not the build.
- The adapters in the last column are the ones the demo tenant must resolve (design section 6, demo guard).
