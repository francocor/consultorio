# External dependencies

Things outside the codebase that take calendar time and must start early. The lead-time track in slice S1.00 fills the owner, dates and status columns. Until then every row is `not started`.

Status values: `not started`, `requested`, `in progress`, `approved`, `blocked`.

| Dependency                                          | Needed by                     | Why it is on the critical path                                                                                                            | Owner | Requested on | Status      |
| --------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------ | ----------- |
| AFIP/ARCA certificate and homologation access       | Stage 4                       | Electronic invoicing cannot be tested or released without a certificate and a homologation (test) environment.                            |       |              | not started |
| Meta WhatsApp Business verification (platform WABA) | Stage 3                       | Business verification and template approval take days to weeks. Reminders and the waitlist depend on them.                                |       |              | not started |
| e-prescription provider (Q3)                        | Stage 5                       | An authorized platform registered under Ley 27.553 / ReNaPDiS must be chosen. Its API shape decides the `PrescriptionProvider` contract.  |       |              | not started |
| Mercado Pago account and preapproval                | Stage 6                       | Subscription billing. A spike validates changing the amount of a preapproval; a one-off payment is the fallback.                          |       |              | not started |
| Legal review of hosting (Q1)                        | Before the first real patient | Is São Paulo plus the AAIP model clauses acceptable, or does the first deployment start in an EU region? The code is the same either way. |       |              | not started |
| Legal review of erasure (Q7)                        | Before the first real patient | Confirm that governance-mode Object Lock with a privileged erasure role satisfies the retention duty and the erasure obligations.         |       |              | not started |

## How to use this file

1. When you start a request, fill in the owner and the date, and move the status to `requested`.
2. Record decisions and contacts in the notes section below, never credentials. Secrets belong in the deployment environment, not in git.
3. A row is `approved` only when the dependency is usable in the environment that needs it (for example, a homologation certificate works against the AFIP test service).

## Notes

_No notes yet._
