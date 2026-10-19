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

- **The port.** `InvoiceIssuer` (`packages/contracts/src/ports.ts`): `issue(request, idempotencyKey)` and
  `findIssued(ref)`. `adapters/invoice-issuer.contract.ts` is the suite every adapter passes; the fake
  and the simulator already do. The real adapter must pass it too.
- **Outage and double issue.** An invoice is requested in one transaction and submitted by a job
  (`afip.issue`, category `afip_submission`, so it also runs for a read-only organization). A retry
  clock (`runDueAttempts`, every 30 seconds) waits 1 minute, doubling up to 6 hours. BEFORE every call
  to the authority the invoice is marked `awaiting_reconciliation` with the number it is expected to
  get, in a commit of its own on a connection of its own (`markIntent`); only a definite answer
  (issued, rejected, or "nothing was issued") clears the mark. If the process dies after the authority
  answered, or the outcome is unknown, the next attempt finds the mark and asks `findIssued` for that
  number BEFORE it sends anything: a voucher whose type, point of sale, number, total, date, issuer
  CUIT, recipient document and (for a credit note) associated voucher match the invoice is adopted
  and `issue` is not called; one that does not match parks the invoice for a person; no answer, or an
  answer that refuses the question, means nothing is sent. The transaction of the job stays open
  across the call (it holds only advisory locks, no row lock): the mark is what survives a crash, and
  it is committed before the call, not at its end. A voucher is never issued twice: this is the part
  to review most closely against the real service, because ARCA has no idempotency key of its own
  (see "Design points" below).
- **One invoice of a series at a time (JD-S4 R2-1).** The number an invoice is expected to get is the
  one after the highest the organization holds, so two invoices sent together would expect the same
  one and could take each other's voucher for their own (same total, same day, same recipient is
  common: a clinic with a fixed fee). Issuance is serialized per series (organization, point of sale,
  voucher type): an attempt takes the advisory lock `afip-attempt-series|<tenant>|<point of sale>|<type>`
  right after the lock of its invoice and keeps it to the end of its transaction, which spans the
  call; whoever does not get it answers `skipped` and the sweeper tries again. On top of that, while
  one invoice of the series is `awaiting_reconciliation` (its answer may have been lost) no other
  invoice of the series is sent (the older one that waits goes first): they are put back one minute
  and tried again after the first one was adopted, parked or replaced. A long outage therefore holds
  the whole series, which is the point: the authority numbers by itself and nothing can be sent until
  the unknown one is settled. When the number an invoice was expecting turns out to be the voucher
  of another invoice of ours, the attempt asks about the numbers that follow (up to five) and judges
  each one the same way before it sends: it sends only when the authority holds nothing there.
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
- **A hint for simulators.** `InvoiceRequest.lastKnownNumber` is the highest voucher number the
  organization holds for the point of sale and type. A simulator that lost its memory numbers after
  it. The real adapter ignores it: the authority decides the number.

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
  matches its invoice; a field the adapter leaves out (`undefined`) counts as a MISMATCH and parks the
  invoice instead of adopting. Two invoices with the same fee on the same day differ only in these.
  The adapter must also answer a refused or failed lookup with `retryable` or `rejected`, never with
  `null`: `null` means "nothing is issued at that number" and is the only answer that lets the module
  send. A `rejected` lookup (bad token, wrong environment) is treated as "cannot tell": nothing is
  sent and the mark stays. `adapters/invoice-issuer.contract.ts` states all of this and the real
  adapter must pass it.
- **Serialization is per series, and it is the module's.** The adapter does not need a lock of its
  own for numbering, but it must not assume parallel `issue` calls for one point of sale and type: the
  module sends one at a time per series (see "One invoice of a series at a time").
- **The CUIT of the credential is the CUIT of the invoice.** The request names the CUIT the invoice
  was requested with (`issuer_snapshot`); the credential of the real adapter follows the live fiscal
  profile. If the organization changed its CUIT, an invoice that waits is parked (`needs_attention`,
  worklist reason `issuer_mismatch`) and a credit note over an older invoice is refused
  (`invoice_issuer_mismatch`) instead of signing for one CUIT and naming another. Retried invoices
  take the live issuer, so they are not affected.
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
  afterwards (a closed invoice has no mark). An attempt that finds the mark after a definite "down"
  (the authority was asked, held nothing, and then refused the request for certain) clears it, and
  the replacement then needs no acknowledgement. A manual voucher may replace only the same invoice:
  not a credit note, the same voucher type, total, lines, recipient and recipient document
  (`invoice_replacement_mismatch`).
- **The connection of the mark.** The mark is committed on a second connection while the attempt
  holds its own, so the runtime pool is opened with a connection timeout (10 seconds) and the mark
  gives up after a lock timeout (`markLockTimeoutMs`, 5 seconds): a pool full of attempts fails and
  the sweeper retries, it does not wait on itself. Size the pool for the number of attempts the worker
  runs at once plus one connection each.
- **Rate limits and timeouts.** Keep a timeout shorter than the job lock so a hung call becomes an
  unknown outcome, not a stuck job.

## Before you switch an organization from the simulator

- **Drain the simulated invoices first.** An invoice still pending when the issuer changes would be
  sent to the real service with the numbering of the simulator in its head (the `expected_number` of
  a lost answer is a simulator's number). Wait until nothing is pending (the invoices screen shows
  none, or run the retries until they are issued or rejected), and register by hand or reject what is
  left.
- **A mistyped manual number moves the series of a simulator.** The number of a manual voucher is
  whatever the person typed; a very high one makes the simulator number after it
  (`lastKnownNumber`). The real adapter must validate the number against
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

## Rollback

Set `AFIP_PROVIDER=off` (nothing is issued; invoices already issued are untouched and stay readable,
downloadable and creditable once the service is back) or `AFIP_PROVIDER=local` with
`ALLOW_LOCAL_PROVIDERS=true` in a staging or demo deployment. A voucher that ARCA authorized is never
deleted or edited by the product: the way back from a wrong one is a credit note.
