-- Judgment day, Stage 4, round 6 (finding R6-1). `invoice.last_sent_at`: when the last request of a
-- wait was sent, written by the mark BEFORE the authority is called. "Nothing was issued for this
-- invoice" is believed only after a settle time has passed since then, because a request the caller
-- gave up on (a timeout, a process that died) may still be being processed by the authority and
-- finish after the lookup. Nullable and mutable like the other columns of the wait; an invoice marked
-- before the column existed has none, and the application falls back to its last attempt. Stage 4 is
-- not deployed, so no data fix is written. 0480 to 0483 are not edited.
ALTER TABLE "invoice" ADD COLUMN "last_sent_at" timestamp with time zone;
