# Runbook: from the AFIP simulator to the real ARCA service

Audience: whoever turns on real electronic invoicing for an organization. Status of task 4.68 and 4.69
(`S4.D`): **deferred, owner action**. Nothing here has been run against ARCA (formerly AFIP): no
certificate, no homologation access and no real credential exist, and the real adapter
(`adapters/afip-wsfe/`) is not written. This page says what is already in place, what changes the day
the adapter arrives, and how to go back. Check every step against the current ARCA documentation
before relying on it: the rules of the authority change, and this page was written without access to
the live service.

## What runs today

| Where                                                                          | Who issues the vouchers                                                                                                                                                | What the voucher is                                                                    |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| A demonstration organization                                                   | The in-memory fake (`adapters/afip-fake`). The resolver gives it to every `is_demo` organization, whatever the configuration.                                          | A test document: "simulated" on every screen, a watermark in the PDF, no fiscal value. |
| Any other organization, `AFIP_PROVIDER=local` (the default outside production) | The local simulator (`adapters/afip-local`): numbering, CAE, outage modes and a console, state in Postgres.                                                            | The same: a test document, always in homologation.                                     |
| Any other organization, `AFIP_PROVIDER=afip` or `off`                          | Nobody. The customer slot of the `invoiceIssuer` port is empty (`main/wiring/invoicing.ts`), so the invoicing screens say that the environment has no billing service. | Nothing is issued. Invoices that were already issued stay readable.                    |

Production refuses `local` unless `ALLOW_LOCAL_PROVIDERS=true`, and the production default is `off`.

## What is already built for the real service

You do not write these again; the real adapter plugs into them.

- **The port.** `InvoiceIssuer` (`packages/contracts/src/ports.ts`): `issue(request, idempotencyKey)`,
  `findIssued(ref)` and `lastAuthorized(series)` (the last number the authority authorized in a series,
  JD-S4 R5-1). `adapters/invoice-issuer.contract.ts` is the suite every adapter passes; the fake
  and the simulator already do. The real adapter must pass it too.
- **Outage and double issue.** An invoice is requested in one transaction and submitted by a job
  (`afip.issue`, category `afip_submission`, so it also runs for a read-only organization). A retry
  clock (`runDueAttempts`, every 30 seconds) waits 1 minute, doubling up to 6 hours (an invoice that is
  `awaiting_reconciliation` waits at most 5 minutes: see "A held series does not wait"). BEFORE every call
  to the authority the core asks `lastAuthorized` (the authority's own last number for the series) and
  marks the invoice `awaiting_reconciliation` with it (`invoice.authority_last_at_mark`) and the number
  after it (`expected_number`), in a commit of its own on a connection of its own (`markIntent`); only a
  definite answer (issued, rejected, or "nothing was issued") clears the mark. If `lastAuthorized`
  cannot answer, nothing is sent. If the process dies after the authority answered, or the outcome is
  unknown, the next attempt finds the mark and RECONCILES (see "Reconciliation uses the authority's
  count") BEFORE it sends anything: a voucher whose type, point of sale, number, total, date, issuer
  CUIT, recipient document and (for a credit note) associated voucher match the invoice is adopted and
  `issue` is not called; no answer, or an answer that refuses the question, means nothing is sent. The
  transaction of the job stays open across the call (it holds only advisory locks, no row lock): the
  mark is what survives a crash, and it is committed before the call, not at its end. A voucher is never
  issued twice: this is the part to review most closely against the real service, because ARCA has no
  idempotency key of its own (see "Design points" below).
- **Reconciliation uses the authority's count (JD-S4 R5-1, R5-2).** The core used to INFER the last
  number of the authority from the vouchers recorded here, so a manual voucher registered out of band
  (or a mistyped high number) moved the inference and an invoice could be sent a second time. It now
  asks the authority. A waiting invoice is reconciled in this order: (a) `lastAuthorized` now; if it
  cannot answer, the invoice stays waiting and nothing is sent. (b) The candidate numbers are the ones
  AFTER `authority_last_at_mark` up to that last number, examined LOWEST FIRST (so a look-alike above
  the invoice's own voucher is never adopted instead of it): a number that an invoice of ours records
  is not asked about (it is that invoice's), except a voucher registered by hand, which is asked about
  and whose CAE is compared, since a person typed its number (a different CAE that matches this
  invoice parks it); a number remembered as a voucher of somebody else (`orphaned`, `unmatched`) is
  skipped; any other is looked up with `findIssued`. A voucher that matches this invoice and cannot be
  another waiting invoice's is adopted. A voucher that matches this invoice AND an invoice replaced or
  parked without knowing whether it was issued (the same anonymous consumer with the same fee on the
  same day) parks it as `voucher_ambiguous` with its outcome unknown. A voucher that states a fact that
  differs is foreign: it is remembered as `unmatched` and the next number is examined. A voucher that
  leaves out a field the comparison needs (and states nothing against the invoice) is UNCLEAR, not
  foreign: the invoice is parked, because it could be the invoice's. A lookup that cannot answer keeps
  the invoice waiting; a number the authority says exists and then does not return parks it. (c) When
  every candidate was examined and none is the invoice's, it was NOT issued: sending is safe, and the
  new mark starts a new wait from that last number. At most 20 numbers are asked about; more parks the
  invoice (`voucher_ambiguous`, with the range in the worklist item). An authority whose last number is
  BELOW the one at the mark (a restore, a reset of a simulator) parks it too. An invoice marked before
  migration 0482 (no `authority_last_at_mark`) is parked with its outcome unknown instead of being
  guessed; Stage 4 is not deployed, so only development data can be in that state. The parked item
  names the numbers in doubt (`candidates`, or `candidatesFrom`/`candidatesTo` when the range is too
  wide to list).
- **One invoice of a series at a time (JD-S4 R2-1).** Two invoices sent together would each be
  waiting for a voucher in the same range of numbers and could take each other's voucher for their own
  (same total, same day, same recipient is common: a clinic with a fixed fee). Issuance is serialized
  per series (organization, point of sale, voucher type): an attempt takes the advisory lock
  `afip-attempt-series|<tenant>|<point of sale>|<type>` right after the lock of its invoice and keeps it
  to the end of its transaction, which spans the call; whoever does not get it answers `skipped` and the
  sweeper tries again. On top of that, while one invoice of the series is `awaiting_reconciliation` (its
  answer may have been lost) no other invoice of the series is sent (the older one that waits goes
  first): they are put back one minute and tried again after the first one was adopted, parked or
  replaced. A long outage therefore holds the whole series, which is the point: the authority numbers by
  itself and nothing can be sent until the unknown one is settled. The series of the authority is the
  one of the issuer CUIT, point of sale, type and environment, and every local query about a series
  filters by the CUIT of the snapshot of the invoice and by the environment (a voucher registered by
  hand is always `production`, so it belongs to the series by point of sale and type); the advisory lock
  stays coarser (organization, point of sale, type), which only serializes more.
- **A held series does not wait for a long backoff (JD-S4 R3-1).** An invoice that is
  `awaiting_reconciliation` is only ever ASKED about (a lookup sends nothing), so its backoff is capped
  at 5 minutes (1, 2, 4, 5, 5 ...) instead of 6 hours: the whole series waits for it, and a probe is
  cheap. An invoice that is held back writes only its own next attempt (one minute) and does NOT lock
  its charge lines; it also brings the blocker (the oldest invoice of the series that waits for
  reconciliation) forward, setting its next attempt to now, at most once a minute (the blocker's own
  `last_attempt_at` decides), with `FOR UPDATE SKIP LOCKED` so it never waits for a row somebody holds.
  After an outage ends the series therefore moves within minutes. A lookup that keeps answering
  `rejected` (a bad token, a wrong environment) keeps the blocker probing every 5 minutes: that is
  visible, see the next point.
- **A stalled series is surfaced (JD-S4 R3-2, R4).** Once the blocker has been WAITING for 2 hours
  (counted from its first mark, `invoice.awaiting_since`, which a later mark keeps and the end of the
  wait clears; the number of attempts does not count, because the invoices held behind it bring its
  probes forward) and while it holds at least one invoice, ONE `invoice_attention` item is opened on it
  (reason `outcome_unknown`; reception sees it). The item says nothing of how many wait: that number is
  live in the invoice (below), and filtered by what the reader may see. The invoice stays as it is. A
  person who dismisses the item is not shown it again during the same wait. Every way out of the wait
  closes it: `outcome_settled` when the blocker is issued, rejected, or the authority says for certain
  that nothing was issued; `parked` when the invoice is parked with the doubt still there (the park
  opens its own item with the real reason); a replacement closes it too (`replaced_by_manual`).
  `InvoiceDto` carries `heldBy` (`{ id, requestedAt }` of the blocker, only when the reader may see it)
  on a held invoice and `blocksSeries` (how many wait, counting only the invoices the reader may see) on
  the blocker; the web says "espera a otra factura" with a link, and the blocker says how many wait
  behind it and offers the manual path. The attempts that end without an answer are audited
  (`invoice.attempted`) for the first 6 and then once per clock hour.
- **Who the issuer is.** The invoice keeps the issuer (CUIT, business name, tax condition, address,
  start of the activity) as it was when it was requested (`invoice.issuer_snapshot`). The request to
  the authority, its fingerprint and the PDF use that snapshot, so editing the fiscal profile while an
  invoice waits for reconciliation neither makes the authority reject it (`10099`) nor changes a
  document. The key the authority sees is derived from the organization and the invoice
  (`issuerKeyOf`), never the key the client sent, and `InvoiceRequest.tenantRef` lets a simulator
  keep the series of two organizations apart (the real adapter ignores it).
- **Credentials.** Each organization loads its own certificate and private key in Settings >
  Facturación electrónica (`PUT /invoicing/credentials`). They are checked (the key matches the
  certificate, the CUIT of the subject is the CUIT of the fiscal profile, the dates), stored encrypted
  with the data key of the organization, never logged and never returned. A job
  (`fiscal.credential_watch`) emails the owners when a certificate is about to expire. The state
  (`valid`, `expiring`, `expired`, `invalid`) is derived, never stored.
- **Environment per point of sale.** `point_of_sale.environment` is `homologation` or `production`.
  While the issuer is a simulator the module forces homologation, so no screen can claim a production
  voucher. With a real issuer the value is the one the owner chose.
- **The voucher rules of Argentina** (`country/ar/afip`): type by issuer and recipient condition,
  credit notes with the letter of the invoice, recipient identification, the QR of the voucher
  (`invoice-qr.ts`), and the numbering a credit note needs.
- **The number a request is for (JD-S4 R6-1).** `InvoiceRequest.expectedNumber` is the number after
  the last one the authority had authorized when the invoice was marked (`lastAuthorized`). It replaces
  the old `lastKnownNumber` hint, which is gone. The issuer issues EXACTLY that number or refuses with
  `{ status: 'not_next' }` and issues nothing; both simulators do it. The in-memory fake of the demo has
  no memory after a restart, so the wiring tells it where to learn what the organization holds
  (`FakeInvoiceIssuer.rememberFrom`, the highest number the invoices record per point of sale and
  type): that is for the simulator only, the real authority never needs it. The local (Postgres)
  simulator keeps its numbering across restarts, but a console "reset" starts it again at 1: the next
  invoice then collides with the numbers the organization holds and is parked (`number_taken`).

## What the owner must obtain (per organization that will issue)

1. An ARCA (AFIP) clave fiscal with the administrator role for the CUIT, and the service
   "Administración de Certificados Digitales" enabled.
2. A **homologation** certificate (the testing environment) and, later, a **production** certificate,
   each made from a key the organization generates (the repository has `pnpm dev:afip-cert` for a
   self-signed development one, which ARCA does not accept). The private key never leaves the owner
   until it is loaded in Settings.
3. The web service of electronic invoicing for that CUIT (`wsfe`) associated to the certificate, in
   each environment.
4. A **point of sale of the type "web services"** for the CUIT (a point of sale made for the web tool
   or for a fiscal printer cannot be used by the service). Its number goes into the fiscal profile.
5. The tax condition of the organization as ARCA has it (monotributo, responsable inscripto, exento).

A certificate expires (ARCA gives it a limited life): the owner renews before the date the watch job
warns about. An expired certificate keeps new invoices pending (they are not lost) until a new one is
loaded.

## What changes the day the adapter arrives

1. **Write the adapter** (`adapters/afip-wsfe/`, task 4.68) and make it pass
   `invoice-issuer.contract.ts` and recorded SOAP fixtures. It talks to two services:
   - WSAA (authentication): signs a login request with the certificate and key of the organization and
     gets a token and a signature valid for about twelve hours. Cache them per certificate and
     service, in memory, and ask again a few minutes before they expire.
   - WSFEv1 (vouchers): `FECompUltimoAutorizado` (the last number for a point of sale and type),
     `FECAESolicitar` (request the CAE), `FECompConsultar` (find a voucher by number, for
     `findIssued`). The endpoint depends on the environment of the point of sale.
2. **Credentials for the adapter.** The adapter serves every organization, so the wiring must give it
   a reader that returns the active certificate and key of the organization that owns the CUIT of the
   request (the module already stores them; decrypt with the data key of that organization, in memory
   only, and never log them). This is the one piece of plumbing that does not exist yet.
3. **Register it.** In `main/wiring/invoicing.ts` the customer slot becomes
   `real: <the adapter>` for `AFIP_PROVIDER=afip` (the demo slot stays the fake). Leave `local` and
   `off` as they are.
4. **Configuration.** `AFIP_PROVIDER=afip` in staging first. Production keeps refusing `local`.
5. **No screen changes.** `isSimulatedIssuer` is false for the real adapter, so the "simulated"
   banners and the watermark disappear by themselves, and the environment of the point of sale is no
   longer forced to homologation. Vouchers made in homologation keep saying they are test documents.

## Cut-over, in order

1. **Staging, homologation.** Load the homologation certificate for a test CUIT, point of sale in
   homologation, `AFIP_PROVIDER=afip`. Run `apps/api/test/external/afip-homologation.test.ts`
   (task 4.69, tagged to run only in staging). Issue each type the organization will use (the
   letter C, or A and B), a credit note, and a rejection (a wrong buyer CUIT). Check the CAE and its
   expiry, the number in order, and that the QR of the PDF opens on ARCA's check.
2. **Outage.** Block the egress to ARCA from staging: the invoice stays pending, flagged by its age,
   and is issued once when the block is lifted. The simulator console cannot do this for the real
   service, so this check is manual.
3. **Review the open assumptions** (below) with the accountant of the first organization.
4. **Production, one organization.** Production certificate, point of sale in `production`, the
   organization's `integrations.einvoicing` switch on. Issue one real voucher and check it in ARCA's
   "Comprobantes en línea".
5. **Everyone else**, one at a time.

## Open assumptions to confirm before the first real voucher

- The amount from which a consumer must be identified (`IDENTIFICATION_THRESHOLD_CENTS` in
  `country/ar/afip/invoice-type.ts`) is the value the simulator uses; confirm it against the current
  ARCA resolution.
- Health services are treated as exempt from VAT for letters A and B, and an exempt issuer is given
  letter C. Both are decisions of the invoicing track, not of the specification: an accountant must
  confirm them (`domain/invoice-amounts.ts`, `breakdownFor`).
- The wording of the lines is generic ("Servicios de salud", the appointment type's invoice
  description); never clinical.
- The time of the server must be right (use NTP): WSAA refuses a request whose time is off.

## Design points the real adapter must handle

- **No idempotency key at ARCA.** `issue` called twice must not issue twice. After a timeout the
  adapter has to ask `FECompUltimoAutorizado` and `FECompConsultar` before it sends `FECAESolicitar`
  again, and answer the voucher it finds when its data matches the request. The module already calls
  `findIssued` first; the adapter makes it true.
- **What `findIssued` must say (JD-S4 R2-1).** The lookup the real adapter provides returns, besides
  the number, the CAE and its expiry, ALL of: `totalCents` (`ImpTotal`), `issueDate` (`CbteFch`),
  `issuerCuit` (the CUIT of the credential the adapter asked with: `FECompConsultar` does not repeat
  it, so the adapter answers the CUIT it authenticated as), `buyerDocument` (`DocTipo` and `DocNro`
  as `{ type: 'cuit' | 'dni', number }`, or `null` when the voucher has none: 99/0) and
  `associatedVoucher` (`CbtesAsoc`: type, point of sale and number of the voucher a credit note
  cancels, or `null`). The module adopts a voucher it did not just request only when every one of them
  matches its invoice; a field the adapter leaves out (`undefined`) is never a match, and, when nothing
  stated contradicts the invoice, the voucher is UNCLEAR and parks the invoice instead of adopting it
  or looking past it (`voucher_ambiguous`). A field that is stated and differs makes the voucher
  foreign. Two invoices with the same fee on the same day differ only in these. When the real adapter
  has a CAE or an issuer reference for the voucher it asked for, it should also compare it: the facts
  are a business decision (a foreign voucher with identical facts is taken for the invoice's, and the
  lowest candidate wins), and a reference of the voucher itself is the only thing that tells identical
  vouchers apart.
  The adapter must also answer a refused or failed lookup with `retryable` or `rejected`, never with
  `null`: `null` means "nothing is issued at that number". A `rejected` lookup (bad token, wrong
  environment) is treated as "cannot tell": nothing is sent and the mark stays.
- **What `lastAuthorized` must say (JD-S4 R5-1).** The real adapter implements it with
  `FECompUltimoAutorizado` (the last number authorized for the CUIT of the credential, the point of
  sale and the voucher type). It answers `{ status: 'ok', number }` with the number the authority
  gives, and `number: 0` ONLY when the authority says the series has no voucher yet (an empty series is
  an answer). A failed or refused call is `retryable` or `rejected`: it must NEVER be turned into 0 or
  into an `ok`, because the core sends a request only after it has this number, and a 0 where there
  were vouchers would make it look for its own voucher nowhere. The same applies to a "no voucher"
  lookup in `findIssued`: it maps to `null`, never an error turned into `null`. The contract suite
  (`invoice-issuer.contract.ts`) states the cases both adapters must pass, among them the round trip:
  a voucher that was issued and then found must match the facts of its own request. `adapters/invoice-issuer.contract.ts` states all of this and the real
  adapter must pass it.
- **Serialization is per series, and it is the module's.** The adapter does not need a lock of its
  own for numbering, but it must not assume parallel `issue` calls for one point of sale and type: the
  module sends one at a time per series (see "One invoice of a series at a time").
- **The CUIT of the credential is the CUIT of the invoice.** The request names the CUIT the invoice
  was requested with (`issuer_snapshot`); the credential of the real adapter follows the live fiscal
  profile. If the organization changed its CUIT, an invoice that waits is parked (`needs_attention`,
  worklist reason `issuer_mismatch`) and a credit note over an older invoice is refused
  (`invoice_issuer_mismatch`) instead of signing for one CUIT and naming another. Retried invoices
  take the live issuer, so they are not affected. Nothing resumes a parked invoice: loading the
  certificate of the original CUIT does not make it go on. The only way out is to register the voucher
  by hand (`replacesInvoiceId`), and the worklist text says so (JD-S4 R3-4).
- **Numbers are the authority's.** A manual voucher (made in ARCA's web tool during an outage) takes a
  number in the same series. The module registers it as `manual` and refuses a collision. When the
  authority answers an invoice with a number (or a CAE) that is already one of ours, the invoice is
  NOT retried: every retry could issue another real voucher. It is parked in `needs_attention`, no
  attempt touches it again, and an item `invoice_attention` is opened in the worklist (reception, the
  whole organization), with an audit entry (`invoice.needs_attention`) and an error log line with the
  number and the CAE (never a message). A person decides: register the voucher that exists by hand
  (`replacesInvoiceId` is accepted for a parked invoice), or issue a credit note for it in ARCA.
  Because the numbers of the other environment start again at 1, **the environment of a point of sale
  cannot change once invoices went through it** (`point_of_sale_has_invoices`): create a new point of
  sale for production instead.
- **A voucher for an invoice somebody closed.** If the authority answers after the invoice was closed
  (a person replaced it with a manual voucher while the request was in flight) the voucher exists and
  nothing records it. The attempt answers `orphaned`, writes `invoice.voucher_orphaned` (type, point of
  sale, number, CAE), logs the same and opens the worklist item. The way back is a credit note in ARCA.
  In practice it cannot happen through the product: a manual entry that replaces an invoice takes the
  advisory lock of the attempts (`conflict` if an attempt holds it), and refuses an invoice that is
  `awaiting_reconciliation` (`invoice_awaiting_reconciliation`) until the authority is asked.
- **A manual voucher in place of an invoice whose outcome is unknown (JD-S4 R2-2).** During a real
  outage every attempt ends in an unknown outcome (a timeout), the mark stays, and the invoice cannot
  be reconciled until the service is back. The fallback that exists for that case would then be
  closed. The owner or an admin can register the manual voucher anyway with
  `acknowledgeUnknownOutcome: true` (the web dialog shows the warning and a confirmation box after
  the server answered `invoice_awaiting_reconciliation`). The replacement writes
  `invoice.replaced_unresolved` (type, point of sale, expected number), closes the invoice as
  rejected and opens an `invoice_attention` item (reason `replaced_unresolved`) asking a person to
  look in ARCA for a voucher at that number: if it exists the organization holds two vouchers for one
  service and one is cancelled with a credit note in ARCA. The product does not look for it by itself
  afterwards (a closed invoice has no mark), but it REMEMBERS the number (`invoice_stray_voucher`,
  migrations 0480 and 0481): a record for people and for the screens, and the way a later
  reconciliation knows that a voucher at that number may be that invoice's. It no longer decides
  whether anything is sent (the authority's count does: see "Reconciliation uses the authority's
  count"). The same table keeps the number of a voucher that arrived for an invoice somebody had
  closed (`orphaned`) and the foreign vouchers a reconciliation passed (`unmatched`). When a
  reason applies twice to one number, the FIRST one written wins (a number is remembered once); the
  precedence is by time, not by importance.
- **A remembered number where nothing was ever issued (JD-S4 R4-1, R5-1).** The number of an invoice
  that was replaced or parked without knowing (`replaced_unresolved`, `parked_unknown`) may hold a
  voucher or nothing. Round 4 inferred which from the local rows (a stray was "confirmed" by any higher
  number recorded), and a manual voucher registered out of band confirmed it wrongly. Round 5 removes
  the inference: the next invoice is marked with the authority's own last number, so a voucher of the
  replaced invoice that exists is BELOW that mark and a number where nothing was issued is simply the
  next number. A remembered number only matters inside the window of a reconciliation: a voucher found
  there that matches the invoice AND an invoice remembered at that number or below it (same facts)
  parks the invoice as `voucher_ambiguous`; one that matches only this invoice is adopted, and when it
  sits at a number remembered for another invoice, that invoice's worklist item (`replaced_unresolved`,
  which told a person to look for the voucher and cancel it) is resolved (`voucher_adopted_by_other`)
  and the audit trail records `invoice.voucher_adopted` on the adopting invoice, naming the other one
  (JD-S4 R5-A-F5).
- **A parked invoice remembers what it knows (JD-S4 R4-3, R5-1).** Parking an invoice writes the
  numbers that nobody may take later: the number of the voucher that collided with a number or a CAE we
  hold (`number_taken`, `cae_taken` after an authorized answer) is certain (`unmatched`), like the
  foreign vouchers a reconciliation passes; the number a parked invoice expected while its outcome was
  unknown (`issuer_mismatch`) is uncertain (`parked_unknown`). A replacement of an invoice that was
  PARKED with its outcome still unknown (reasons `issuer_mismatch` and `voucher_ambiguous` after a lost
  answer; the audit entry and the item say `outcomeUnknown: true`, and the row keeps the number it
  expected and the authority's last number at its mark) needs the same acknowledgement. An attempt that
  finds the mark after a definite "down" (the authority said it has issued nothing since the mark, and
  then refused the request for certain) clears it, and the replacement then needs no acknowledgement.
  A manual voucher may replace only the same invoice: the same voucher type, total, lines, recipient and
  recipient document (`invoice_replacement_mismatch`).
- **A credit note parked for a person has a way out (JD-S4 R5-B-W2).** A credit note that was parked
  (`needs_attention`: the authority answered with a number or a CAE we hold, or the issuer changed)
  counts against the invoice it cancels, so the invoice could neither be credited again nor released. The
  owner or an admin registers the credit note made outside the system IN PLACE OF it: `POST
/invoices/manual` with a credit note type (`NCA`, `NCB`, `NCC`), `replacesInvoiceId` (the parked note)
  and `associatedVoucher` (type, point of sale and number of the voucher it cancels). It is refused
  (`invoice_replacement_mismatch`) unless the parked note has the same type, cancels the same voucher
  and has the same total; it is refused for a note that is not parked, and for a note whose outcome is
  unknown it needs `acknowledgeUnknownOutcome` like an invoice does. The new note is `manual`, covers
  exactly what the parked one covered, keeps its reason and its issuer, and the parked one is closed as
  rejected. A registered credit note takes back the amount invoiced of the charge lines like an issued
  one (migration 0483). The web dialog for manual vouchers does not offer a credit note yet: the API does.
- **The connection of the mark.** The mark is committed on a second connection while the attempt
  holds its own, so the runtime pool is opened with a connection timeout (10 seconds) and the mark
  gives up after a lock timeout (`markLockTimeoutMs`, 5 seconds): a pool full of attempts fails and
  the sweeper retries, it does not wait on itself. The mark's timeout is at least 1 millisecond (a
  zero would switch the lock timeout off). A mark that gives up on a lock logs it. Size the pool for the
  number of attempts the worker runs at once plus one connection each with `DB_POOL_MAX` (6 to 100,
  default 10; the API and the worker both read it). The configuration refuses fewer than 6
  (`MIN_DB_POOL_MAX`; 6 is a FLOOR, not a recommended size, and a deployment that set a smaller value
  now refuses to start): each of the 2 attempts the worker runs at once holds 2 connections, and 2 more
  serve the sweeper and the other jobs. With fewer, two attempts would each hold one connection and wait
  for the other's (JD-S4 R4-B-T5). A value of `markLockTimeoutMs` that is not a finite number is the
  default (5 seconds), not an error (JD-S4 R4-B-T4).
- **A foreign voucher in the window (INFO, JD-S4 R3-B-T3, R5-1).** If somebody issues a voucher outside
  the product while an invoice waits (another tool of the issuer, a person on the website of the
  authority), the reconciliation finds a voucher that states another recipient or total, remembers it
  (`unmatched`) and goes on: the invoice is NOT parked for it. If the invoice's own voucher is among the
  candidates it is adopted; if none is, the invoice was not issued and is sent with the new count of the
  authority. A foreign voucher that looks exactly like the invoice (same facts) cannot be told from it
  by the facts alone: since round 6 the invoice is parked (`voucher_ambiguous`, with both candidates)
  instead of the lowest one winning, which is why the real adapter should compare a CAE or an issuer
  reference when it has one (JD-S4 R6-4).
- **The pin: `CbteDesde` and error 10016 (JD-S4 R6-1).** A request that the caller gave up on (a
  timeout, a process that died) may still be processed by ARCA and finish AFTER the lookup that found
  nothing; sending again would then issue two vouchers for one invoice. ARCA has no idempotency key, so
  the number is the key. The real adapter MUST send the request with `CbteDesde` = `CbteHasta` =
  `request.expectedNumber` (never a number it computes itself) and map ARCA's refusal of a number that
  is not the next one (error **10016**, "El numero o fecha del comprobante no se corresponde con el
  proximo a autorizar") to `{ status: 'not_next', message }`. Of two requests for one number only one can
  win; the other is refused and issued nothing. After a `not_next` the module asks for the last number
  again and examines the numbers in between, so the voucher of the first request is found and adopted. Two
  traps: 10016 also covers a date that is not acceptable (ARCA ties both to "the next one to authorize"),
  so validate `issueDate` against the allowed window BEFORE sending, or a bad date would answer
  `not_next` for ever (the stall item opens after two hours of waiting); and a `not_next` is NEVER a
  `rejected` (that closes the invoice) nor a `retryable` with `outcomeUnknown: false` (that clears the
  mark and forgets the window).
- **SETTLE: "nothing was issued" is believed late (JD-S4 R6-1).** Defence in depth for an adapter that
  does not pin, and for the pin itself. After a request is sent (the mark is committed BEFORE the call,
  and stamps `invoice.last_sent_at`, migration 0484) the module does not send again until `SETTLE`
  has passed since then, whatever the lookup says; until then it only asks and adopts a voucher that
  appeared (`IssueDeps.settleMs`, default 10 minutes). It must be longer than the timeout of the
  adapter plus the tail of ARCA: set the adapter timeout well under it. The pull-forward of a blocker
  never goes earlier than that. A crash between the mark and the call leaves the mark with the time, and
  the sweeper looks again a minute later: it asks, it does not send. The wait of an invoice
  (`awaiting_since`) is NOT restarted by a resend, so a request that keeps timing out opens the stall
  item after two hours.
- **The fixture round trip is a requirement (JD-S4 R6-6).** A false "this voucher is foreign" makes the
  module send its own invoice again. Before the real adapter is registered it must pass tests that feed
  it RECORDED responses of `FECompConsultar` and `FECompUltimoAutorizado` (taken from homologation) for
  an anonymous buyer (`DocTipo` 99, `DocNro` 0, which the module reads as "no buyer"), a buyer with a
  DNI, a buyer with a CUIT, the CUIT of the issuer and a credit note with `CbtesAsoc`, and assert that
  each voucher it returns matches the facts of the request that made it (`voucherMatches`): the contract
  suite has the cases, and the recorded fixtures must pass them with the real parser. A voucher that is
  different ONLY in the buyer is `unclear` and parks the invoice; anything else that differs (total,
  date, issuer, the voucher a note cancels) makes it foreign.
- **Rate limits and timeouts.** Keep a timeout shorter than the job lock so a hung call becomes an
  unknown outcome, not a stuck job, and shorter than SETTLE.

## Before you switch an organization from the simulator

- **Drain the simulated invoices first.** An invoice still pending when the issuer changes would be
  sent to the real service with the numbering of the simulator in its head (the `expected_number` of
  a lost answer is a simulator's number). Wait until nothing is pending (the invoices screen shows
  none, or run the retries until they are issued or rejected), and register by hand or reject what is
  left.
- **A mistyped manual number moves the series of a simulator.** The number of a manual voucher is
  whatever the person typed; a very high one makes the simulator number after it
  (the fake learns from the recorded numbers). The real adapter must validate the number against
  `FECompUltimoAutorizado` before it accepts a manual entry; the simulator does not.
- **The certificate chain is not validated.** `parseCredential` checks the key, the CUIT of the
  subject and the dates, not that the certificate was issued by the ARCA CA. It only matters once the
  real adapter exists: validate the chain there (a certificate that ARCA would not accept is better
  refused when it is loaded).
- **The invoice PDF needs a bucket from the start.** Without a bucket the `invoice.pdf` job is not
  registered, an invoice has no document, and adding a bucket later does not render the PDFs of the
  invoices already issued: turn the bucket on before the first real voucher, or queue
  `invoice.pdf` for the issued invoices that have no `invoice_document` (the job is idempotent).
- **The simulator tables have no row level security, by design.** `local_afip_control`,
  `local_afip_voucher` and `local_afip_request` stand in for the tax authority, which is outside
  every organization; they carry a `tenant_ref` (an opaque reference, not a foreign key) that keeps
  the series apart, and nothing reads them in production (the guard refuses the simulator there).
  Do not grant them to a role that serves requests of an organization. The console lists the
  vouchers of every organization, each with its `tenantRef`, or only one organization's with
  `?tenantRef=<organization id>`.
- **Simulator rows from before migration 0494 and 0497 are incomplete (simulator only).** The
  `local_afip_*` rows written before 0494 have `tenant_ref = ''`, so an invoice of a deployment that
  was still in flight when 0494 arrived is looked up under another reference and could be issued once
  more by the simulator; and the vouchers from before 0497 have no buyer document nor associated
  voucher (their lookup says "no document" and "not a credit note"). Neither exists in production
  (the guard refuses the simulator there). Drain the pending invoices before a deploy that crosses
  those migrations, or reset the simulator from the console.

## Upgrade notes (judgment day, Stage 4, round 5)

- **`DB_POOL_MAX` below 6 refuses to start**, in the API and in the worker. 6 is a floor (2 connections
  for each of the 2 attempts the worker runs at once, and 2 for the sweeper and the other jobs), not a
  size: the default is 10, and a busy worker wants more. Check the value of every deployment before the
  upgrade.
- **Migrations 0482 and 0483** (track `4jd`): `invoice.authority_last_at_mark` (nullable), and the
  condition of `app.refresh_invoiced` on the status of a credit note. An invoice that is
  `awaiting_reconciliation` when the code arrives has no `authority_last_at_mark` and is parked with its
  outcome unknown (`voucher_ambiguous`) instead of being guessed: register by hand the voucher that
  exists, or let the owner replace it with the acknowledgement. Stage 4 is not deployed, so this only
  touches development data.
- **The real adapter must implement `lastAuthorized`** (`FECompUltimoAutorizado`) before it is
  registered; see "What `lastAuthorized` must say".

## Upgrade notes (judgment day, Stage 4, round 6)

- **Migrations 0484 and 0485** (track `4jd`): `invoice.last_sent_at` (when the last request of a wait
  was sent) and `invoice.lookup_misses` (how many times in a row a number the authority says it issued
  had no voucher). An invoice `awaiting_reconciliation` when the code arrives has no `last_sent_at`; the
  module falls back to its last attempt, so it is not sent again before SETTLE either.
- **`InvoiceRequest.lastKnownNumber` is gone**, replaced by `expectedNumber` (a pin), and `IssueResult`
  has a new `not_next` status. An adapter written against round 5 must implement both: see "The pin".
- **A very rare change in what is parked.** A voucher that is the same in everything but the recipient
  document is `voucher_ambiguous` (parked) instead of foreign (sent again); two vouchers that both fit
  are parked instead of the lowest one being adopted; a lookup that answers nothing at a number it says
  it issued is asked again three times before the invoice is parked.
- **Changing the CUIT of the fiscal profile is not blocked.** Invoices keep the issuer they were
  requested with. The unique index of the numbers (organization, point of sale, type) does not know the
  CUIT: a point of sale belongs to one CUIT on the website of the authority, so a CUIT change needs a new
  point of sale; if the old one is used the authority repeats numbers and the invoice is parked
  (`number_taken`) with a person alerted. Nothing is recorded twice.

## Rollback

Set `AFIP_PROVIDER=off` (nothing is issued; invoices already issued are untouched and stay readable,
downloadable and creditable once the service is back) or `AFIP_PROVIDER=local` with
`ALLOW_LOCAL_PROVIDERS=true` in a staging or demo deployment. A voucher that ARCA authorized is never
deleted or edited by the product: the way back from a wrong one is a credit note.
