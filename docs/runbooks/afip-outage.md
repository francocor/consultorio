# Runbook: an outage of ARCA (AFIP)

Audience: whoever is on call, and the owner of an organization that issues invoices. Scope: what the
platform does by itself when the tax authority does not answer, what a person may do, and what a person
must never do. Task 6.46. The switch from the simulator to the real service is
`docs/runbooks/afip-switch-to-real.md`; this page is about the day the real one fails.

## What the platform does by itself

An invoice is requested from the authority by a job (`afip.issue`). While the authority does not answer:

- The invoice stays **pending**. The patient is not asked for anything and the charge is not lost: the
  invoice is issued when the authority is back, with the next number of its series.
- The job tries again with a growing wait: one minute, then double each time, never more than six hours
  between two tries. The invoices behind the first one in the same series wait for it, because the
  numbers are consecutive.
- An invoice whose outcome is **unknown** (the request left, no answer came) is not sent again: it is
  only asked about, every few minutes (never more than five), until the authority says whether the
  voucher exists. Sending again could issue it twice. After ten minutes without proof a "nothing was
  issued" answer is still not believed, because a request the platform gave up on may still be being
  processed on the other side.
- After the **outage threshold** of the organization (24 hours unless the organization changed it in its
  invoicing settings) the invoice is flagged as an outage on the invoices screen, and the metric
  `invoices_pending_past_threshold` counts it (alert `InvoicesPendingPastOutageThreshold`). After two
  hours with an unknown outcome a person is told.
- Nothing about the patient, the charge or the clinical record is blocked by the outage. Reading and
  charging go on; only the voucher waits.

## What to check first

1. Is it the authority or us? The status of ARCA is public. If many organizations have invoices pending
   at the same time and none issued in an hour, it is almost certainly the authority.
2. Is it one organization? Its certificate may have expired, its point of sale may be wrong or its
   homologation may be pending. The invoice shows the code the authority gave, not a free text; the
   fix is the owner's (`docs/runbooks/afip-switch-to-real.md`, "What the owner must obtain").
3. Is the worker running? An invoice that waits for a worker that is down looks like an outage. See
   `docs/runbooks/incident.md`, "The worker is silent".

## What the owner of the organization can do

When the outage is long and the patient needs a voucher now, the owner or an administrator can register
a **manual voucher**: the one issued by hand on the web of ARCA, typed in with its number and its CAE.

- It replaces the pending invoice only if it is the same one: the same type and total, for the same
  recipient and document and covering the same lines. The pending invoice is closed as rejected in the
  same step.
- If the outcome of the pending invoice is unknown, the screen asks for an explicit acknowledgement
  ("the outcome is unknown"). The replacement is then audited as `invoice.replaced_unresolved`, and a
  person is told to look for the first voucher in ARCA afterwards: if both exist, one of them has to be
  cancelled with a credit note.

## What nobody should do

- Do not issue the same voucher by hand on the web of ARCA **and** wait for the platform to issue it.
  Pick one. If the manual one is chosen, replace the pending invoice (above) so the platform stops
  trying.
- Do not edit an invoice or a number in the database, and do not skip a number of the series. The
  database refuses it; the right fix is always a credit note.
- Do not switch an organization to the simulator to "get invoices out": a simulated invoice has no
  fiscal validity. The simulator is marked on every screen and production refuses it.

## When the authority is back

The queue drains by itself, oldest first. Watch `invoices_pending_past_threshold` go to zero. An invoice
that ended `rejected` or `needs attention` is a person's decision (the screen says why). Record the
outage in the operations log: when it began, when it ended, how many invoices waited, whether any manual
voucher was used.
