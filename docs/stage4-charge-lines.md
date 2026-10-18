# Charge lines: what the invoicing track (C) uses of billing

Track A (billing) owns `charge` and `charge_line`. Track C (invoicing) builds invoices over charge lines and reads or moves them only through `apps/api/src/modules/billing/index.ts`. Do not import anything else from `modules/billing/`, and do not read the tables.

## The model in two lines

A charge is made of lines. A line has a `portion` (`patient` or `payer`), an `amount_cents` and an `invoiced_cents` that starts at 0 and may go up to the amount: an invoice covers lines of one or several charges, and a line can be invoiced in parts. The invariant of the design (section 3.5) is that, per line, pending + issued + manual invoice amounts, minus credit notes, never exceed the amount of the line.

All amounts are whole cents of ARS (`Money`).

## The API

```ts
import {
  readChargeLines,
  readChargeLinesOfCharges,
  readChargesForInvoicing,
  adjustInvoicedCents,
  ChargeLineAdjustmentError,
  type ChargeLineForInvoicing,
  type ChargeForInvoicing,
} from '../billing/index.js';
```

| Function                                      | What it does                                                                                                                                                                                                                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readChargeLines(tx, lineIds, { lock? })`     | The lines by id, ordered by id, each with the facts of its charge (`chargeStatus`, `patientId`, `appointmentId`, `locationId`, `professionalId`, `tenantPayerId`) and `uninvoicedCents`. `lock: true` takes `FOR UPDATE` on the lines until the end of the transaction. |
| `readChargeLinesOfCharges(tx, chargeIds)`     | Every line of some charges, by charge and position.                                                                                                                                                                                                                     |
| `readChargesForInvoicing(tx, chargeIds)`      | The charge facts an invoice prints: `appointmentTypeName` (the service), `serviceDate` (local day of the location), `status`, and the totals of the lines (`totalCents`, `patientCents`, `payerCents`, `invoicedCents`).                                                |
| `adjustInvoicedCents(tx, lineId, deltaCents)` | Adds `deltaCents` (negative for a credit note) to `invoiced_cents` under a row lock. Throws `ChargeLineAdjustmentError` with `reason`: `not_found`, `charge_voided` (only when `deltaCents > 0`), `exceeds_amount`, `below_zero`. A fraction throws `RangeError`.       |

All of them run in the transaction you pass (`tx`), so the organization comes from it and row level security applies: a line of another organization is simply not found.

## How to build an invoice over lines

1. In the transaction that creates the invoice, `readChargeLines(tx, ids, { lock: true })`. Locking in the order of the ids means two invoices over the same lines cannot deadlock.
2. Refuse any line whose `chargeStatus` is `voided` (a voided charge is final), and any amount above `uninvoicedCents`.
3. Insert the invoice and its `invoice_line` rows, and move `invoiced_cents`.

Migration `0444` (yours) adds the foreign key from `invoice_line.charge_line_id` to `charge_line` and a trigger that keeps `charge_line.invoiced_cents` in step with the invoice lines. Two ways to write the column exist; use ONE of them:

- With the trigger, never call `adjustInvoicedCents`: the trigger is the only writer.
- Without it, call `adjustInvoicedCents` from the code that inserts or reverses an `invoice_line`.

Either way the database enforces `0 <= invoiced_cents <= amount_cents` (check `charge_line_invoiced_check`) and a trigger (`charge_line_guard`) rejects any change to a line other than `invoiced_cents`, so the trigger of 0444 passes it without change. Lines of a voided charge cannot be added (`charge_line_insert_guard`).

## Things you can rely on

- A line is written once: description, portion, kind and amount never change. A correction to what is owed is a new line (`kind: 'manual'`), never an edit.
- `kind` tells what the line is: `service`, `payer_coverage`, `copago`, `plus`, `late_fee`, `manual`. The payer portion (`portion: 'payer'`) is a receivable from the payer; an invoice to the patient covers `patient` lines.
- The invoicing position of a charge (`not_invoiced`, `partly_invoiced`, `invoiced`) is derived from the lines in `ChargeDto.invoicing`; it is not a state of the charge.
- Voiding a charge asks the invoicing module before it proceeds: `modules/invoicing/index.ts` exports `invoiceLookup` (`hasIssuedInvoice(tx, chargeId)`), a stub today. Replace the stub with the real lookup at task 4.45 without changing its signature; billing already calls it from `void-charge.ts`.

## Test support

`apps/api/test/support/billing-world.ts` builds an organization with appointments at every stage, prices, payers and charges (`world.charge()`); the example of the API in use is `test/integration/charge-lines-api.test.ts`.
