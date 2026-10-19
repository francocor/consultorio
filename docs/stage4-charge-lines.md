# Charge lines: what the invoicing track (C) uses of billing

Track A (billing) owns `charge`, `charge_line` and the payers. Track C (invoicing) builds invoices over charge lines and reads them only through `apps/api/src/modules/billing/index.ts`. Do not import anything else from `modules/billing/`, and do not read billing tables.

## The model in two lines

A charge is made of lines. A line has a `portion` (`patient` or `payer`), an `amount_cents` and an `invoiced_cents` that starts at 0 and may go up to the amount: an invoice covers lines of one or several charges, and a line can be invoiced in parts. The invariant of the design (section 3.5) is that, per line, pending + issued + manual invoice amounts, minus credit notes, never exceed the amount of the line.

All amounts are whole cents of ARS (`Money`).

## The API

```ts
import {
  readChargeLines,
  readChargeLinesOfCharges,
  readChargesForInvoicing,
  type ChargeLineForInvoicing,
  type ChargeForInvoicing,
  type ChargePayer,
} from '../billing/index.js';

interface ChargePayer {
  id: string; // tenant_payer.id, the payer in the organization's list
  name: string;
  cuit: string | null; // the 11 digits, or null until the organization enters it
}

interface ChargeLineForInvoicing {
  id: string;
  chargeId: string;
  chargeStatus: 'pending' | 'partially_paid' | 'paid' | 'voided';
  patientId: string;
  appointmentId: string;
  locationId: string;
  professionalId: string;
  payer: ChargePayer | null; // null for a private patient
  position: number;
  kind: 'service' | 'payer_coverage' | 'copago' | 'plus' | 'late_fee' | 'manual';
  portion: 'patient' | 'payer';
  description: string;
  amountCents: number;
  invoicedCents: number;
  uninvoicedCents: number; // amountCents - invoicedCents
}
```

| Function                                             | What it does                                                                                                                                                                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readChargeLines(tx, lineIds, { lock? })`            | The lines by id, ordered by id. With `lock: true` the rows are locked `SELECT ... FOR UPDATE OF charge_line` inside the transaction you pass, until it ends.                                                                      |
| `readChargeLinesOfCharges(tx, chargeIds, { lock? })` | Every line of some charges, by charge and position; same `lock` option.                                                                                                                                                           |
| `readChargesForInvoicing(tx, chargeIds)`             | The charge facts an invoice prints: `payer`, `appointmentTypeName` (the service), `serviceDate` (local day of the location), `status`, and the totals of the lines (`totalCents`, `patientCents`, `payerCents`, `invoicedCents`). |

All of them run in the transaction you pass (`tx`), so the organization comes from it and row level security applies: a line of another organization is simply not found. A line of a payer that was deactivated still names it (deactivated payers stay).

The payer CUIT is set by the organization in billing's payer settings (`PATCH /billing/payers/:id { cuit }`, `pricing.manage`) and validated through the country pack (`getCountryPack('AR').validateTaxId`: 11 digits, assigned prefix, modulo-11 check digit). It is stored normalized, as digits. The platform `payer` catalog has none. A Factura A to a payer is addressed with `payer.cuit`; when it is `null` the invoicing module refuses and points to the payer settings.

## Who writes `invoiced_cents`

Billing never writes it. Your migration `0444` keeps `charge_line.invoiced_cents` in step with the invoice lines with a trigger, and that trigger is the only writer. The column exists with default 0 (migration 0412), so the trigger only updates it. What the database guarantees for you:

- `charge_line_invoiced_check`: `0 <= invoiced_cents <= amount_cents`. A trigger update that would go beyond it fails with `23514`.
- `charge_line_guard` (BEFORE UPDATE): any change to a line other than `invoiced_cents` (amount, portion, description, kind, position) fails with `42501`, so your trigger passes it, and nothing else can move a line.
- `charge_line_insert_guard`: no line is added to a voided charge.
- The application role has UPDATE on `charge_line` (your trigger runs as the invoker), no DELETE, no TRUNCATE.

A test (`charge-lines-api.test.ts`) fails if code under `modules/billing/` ever updates a charge line or names `invoiced_cents` in a write.

## How to build an invoice over lines

1. In the transaction that creates the invoice, `readChargeLines(tx, ids, { lock: true })`. Locking in the order of the ids means two invoices over the same lines cannot deadlock.
2. Refuse any line whose `chargeStatus` is `voided` (a voided charge is final), and any amount above `uninvoicedCents`.
3. Insert the invoice and its `invoice_line` rows; your trigger moves `invoiced_cents`.

The foreign key from `invoice_line.charge_line_id` to `charge_line` needs the statement that lifts FORCE row level security for the length of the `ADD CONSTRAINT` (see `docs/migration-ranges.md`); `0444` must come after `0412` in the journal, which the run order guarantees.

## Things you can rely on

- A line is written once: description, portion, kind and amount never change. A correction to what is owed is a new line (`kind: 'manual'`), never an edit.
- `kind` tells what the line is. The payer portion (`portion: 'payer'`) is a receivable from the payer; an invoice to the patient covers `patient` lines.
- The invoicing position of a charge (`not_invoiced`, `partly_invoiced`, `invoiced`) is derived from the lines in `ChargeDto.invoicing`; it is not a state of the charge.
- Voiding a charge asks the invoicing module first: `modules/invoicing/index.ts` exports `invoiceLookup` (`hasIssuedInvoice(tx, chargeId)`), a stub today. Replace the stub with the real lookup at task 4.45 without changing its signature; billing already calls it from `void-charge.ts`.

## Test support

`apps/api/test/support/billing-world.ts` builds an organization with appointments at every stage, prices, payers and charges (`world.charge()`); the example of the API in use is `test/integration/charge-lines-api.test.ts`.
