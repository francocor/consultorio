-- Stage 4, B reports: report_indexes
-- The reports module has no tables of its own; these indexes serve what it reads from scheduling.
-- Indexes only: no table, column, trigger or policy changes here (benchmark: docs/perf/reports.md).

-- A period of appointments for a whole organization, narrowed by status. The indexes of "appointment"
-- begin with the professional, the location or the patient; a report over the organization (the
-- owner's dashboard) begins with the tenant and the time.
CREATE INDEX "appointment_report_idx" ON "appointment" USING btree ("tenant_id","starts_at","status");--> statement-breakpoint

-- "Was it moved?" and "did the patient confirm?" are asked of the history appointment by appointment,
-- and a row of the history is rarely either one: two small partial indexes answer both without
-- reading the rest of the events (several per appointment).
CREATE INDEX "appointment_event_moved_idx" ON "appointment_event" USING btree ("tenant_id","appointment_id") WHERE "kind" = 'rescheduled';--> statement-breakpoint
CREATE INDEX "appointment_event_patient_confirmed_idx" ON "appointment_event" USING btree ("tenant_id","appointment_id") WHERE "kind" = 'status_changed' AND "to_status" = 'confirmed' AND "actor_kind" = 'patient';
