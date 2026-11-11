ALTER TABLE "invoice" ADD COLUMN "issuer_snapshot" jsonb;
--> statement-breakpoint
-- Judgment day, Stage 4, round 1 (finding C7). The issuer of a voucher (CUIT, business name, tax
-- condition, address and the start of the activity) is part of what the authority is asked and of what
-- the PDF prints; the fiscal profile that holds them can be edited at any time. The invoice now keeps
-- the issuer as it was when the invoice was requested, in this column, and the request, its
-- fingerprint and the document use it. It is written once, with the invoice, and never changes: the
-- guard below (0444 replaced) adds it to what a pending invoice may not move. It is nullable because a
-- manual voucher of an organization with no fiscal profile has no issuer to snapshot.
CREATE OR REPLACE FUNCTION app.guard_invoice() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF OLD.status <> 'pending' THEN
      RAISE EXCEPTION 'an issued, registered or rejected invoice is closed; a correction is a credit note'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.status NOT IN ('pending', 'issued', 'rejected') THEN
      RAISE EXCEPTION 'a pending invoice is issued or rejected, nothing else' USING ERRCODE = '42501';
    END IF;
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.type IS DISTINCT FROM OLD.type
       OR NEW.point_of_sale IS DISTINCT FROM OLD.point_of_sale
       OR NEW.issue_date IS DISTINCT FROM OLD.issue_date
       OR NEW.environment IS DISTINCT FROM OLD.environment
       OR NEW.simulated IS DISTINCT FROM OLD.simulated
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
       OR NEW.recipient_kind IS DISTINCT FROM OLD.recipient_kind
       OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
       OR NEW.tenant_payer_id IS DISTINCT FROM OLD.tenant_payer_id
       OR NEW.recipient_name IS DISTINCT FROM OLD.recipient_name
       OR NEW.recipient_tax_condition IS DISTINCT FROM OLD.recipient_tax_condition
       OR NEW.recipient_doc_type IS DISTINCT FROM OLD.recipient_doc_type
       OR NEW.recipient_doc_number IS DISTINCT FROM OLD.recipient_doc_number
       OR NEW.total_cents IS DISTINCT FROM OLD.total_cents
       OR NEW.net_cents IS DISTINCT FROM OLD.net_cents
       OR NEW.vat_cents IS DISTINCT FROM OLD.vat_cents
       OR NEW.exempt_cents IS DISTINCT FROM OLD.exempt_cents
       OR NEW.location_ids IS DISTINCT FROM OLD.location_ids
       OR NEW.credit_note_of_id IS DISTINCT FROM OLD.credit_note_of_id
       OR NEW.reason IS DISTINCT FROM OLD.reason
       OR NEW.previous_attempt_id IS DISTINCT FROM OLD.previous_attempt_id
       OR NEW.issuer_snapshot IS DISTINCT FROM OLD.issuer_snapshot
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'what an invoice asks for does not change' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
-- Backfill of the invoices that exist: the issuer is the one of the fiscal profile today, the best
-- fact there is for a voucher requested before this column. A migration has no tenant context, so the
-- block goes organization by organization and sets it for each (the policies apply as they always do,
-- FORCE row level security is never lifted). The guard of the invoices is switched off for the length
-- of the block, because an issued invoice is closed to any write; `invoice` is a Stage 4 table, small
-- wherever this runs for the first time. Only rows still without a snapshot are touched.
ALTER TABLE "invoice" DISABLE TRIGGER invoice_guard;
--> statement-breakpoint
DO $$
DECLARE
  tenants uuid[];
  one uuid;
BEGIN
  PERFORM set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true);
  PERFORM set_config('app.scope', 'platform', true);
  SELECT coalesce(array_agg(id), '{}') INTO tenants FROM tenant;
  PERFORM set_config('app.scope', '', true);
  FOREACH one IN ARRAY tenants LOOP
    PERFORM set_config('app.tenant_id', one::text, true);
    UPDATE invoice i
       SET issuer_snapshot = jsonb_build_object(
             'cuit', p.cuit,
             'businessName', p.business_name,
             'taxCondition', p.tax_condition,
             'address', p.address,
             'activityStartedOn', p.activity_started_on)
      FROM fiscal_profile p
     WHERE p.tenant_id = i.tenant_id AND i.issuer_snapshot IS NULL;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$$;
--> statement-breakpoint
ALTER TABLE "invoice" ENABLE TRIGGER invoice_guard;
