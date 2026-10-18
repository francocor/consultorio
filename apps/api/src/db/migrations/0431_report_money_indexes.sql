-- Stage 4, B reports: report_money_indexes
-- The financial and cash reports (S4.14) own no tables; these indexes serve what they read from
-- billing and invoicing. Indexes only: no table, column, trigger or policy changes here
-- (benchmark: docs/perf/reports.md).

-- The charges of a period are found through their appointments; a charge is looked up by its
-- appointment, voided ones included (the unique index of the charge leaves the voided ones out).
CREATE INDEX "charge_report_idx" ON "charge" USING btree ("tenant_id","appointment_id");--> statement-breakpoint

-- Money received and given back in a period, for the whole organization. The existing indexes of
-- these tables begin with the location or the charge.
CREATE INDEX "payment_report_idx" ON "payment" USING btree ("tenant_id","paid_at");--> statement-breakpoint
CREATE INDEX "payment_reversal_report_idx" ON "payment_reversal" USING btree ("tenant_id","reversed_at");--> statement-breakpoint

-- The vouchers of a period by the date printed on them. Only issued and registered vouchers are
-- vouchers; a pending invoice and a rejected attempt never appear in a report.
CREATE INDEX "invoice_report_idx" ON "invoice" USING btree ("tenant_id","issue_date") WHERE "status" IN ('issued', 'manual');
