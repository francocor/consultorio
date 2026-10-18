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
  clock (`runDueAttempts`, every 30 seconds) waits 1 minute, doubling up to 6 hours. After an outcome
  that is not known (a timeout after the authority may have answered) the module asks `findIssued` for
  the number it expects before it sends anything again, and then calls `issue` with the same
  idempotency key. A voucher is never issued twice: this is the part to review most closely against
  the real service, because ARCA has no idempotency key of its own (see "Design points" below).
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
  again, and answer the voucher it finds when its data (type, point of sale, number, total, date)
  matches the request. The module already calls `findIssued` first; the adapter makes it true.
- **Numbers are the authority's.** A manual voucher (made in ARCA's web tool during an outage) takes a
  number in the same series. The module registers it as `manual` and refuses a collision, leaving the
  invoice pending for a person; keep that behaviour.
- **Rate limits and timeouts.** Keep a timeout shorter than the job lock so a hung call becomes an
  unknown outcome, not a stuck job.

## Rollback

Set `AFIP_PROVIDER=off` (nothing is issued; invoices already issued are untouched and stay readable,
downloadable and creditable once the service is back) or `AFIP_PROVIDER=local` with
`ALLOW_LOCAL_PROVIDERS=true` in a staging or demo deployment. A voucher that ARCA authorized is never
deleted or edited by the product: the way back from a wrong one is a credit note.
