CREATE TABLE "invoice" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"point_of_sale" integer NOT NULL,
	"number" bigint,
	"status" text DEFAULT 'pending' NOT NULL,
	"delivery_state" text,
	"cae" text,
	"cae_expires_on" date,
	"issue_date" date NOT NULL,
	"environment" text NOT NULL,
	"simulated" boolean DEFAULT false NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"recipient_kind" text NOT NULL,
	"patient_id" uuid,
	"tenant_payer_id" uuid,
	"recipient_name" text,
	"recipient_tax_condition" text NOT NULL,
	"recipient_doc_type" text,
	"recipient_doc_number" text,
	"total_cents" bigint NOT NULL,
	"net_cents" bigint NOT NULL,
	"vat_cents" bigint DEFAULT 0 NOT NULL,
	"exempt_cents" bigint DEFAULT 0 NOT NULL,
	"location_ids" uuid[] NOT NULL,
	"credit_note_of_id" uuid,
	"reason" text,
	"previous_attempt_id" uuid,
	"rejection_message" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"expected_number" bigint,
	"issued_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	CONSTRAINT "invoice_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "invoice_type_check" CHECK ("type" in ('FA', 'FB', 'FC', 'NCA', 'NCB', 'NCC')),
	CONSTRAINT "invoice_status_check" CHECK ("status" in ('pending', 'issued', 'rejected', 'manual')),
	CONSTRAINT "invoice_delivery_state_check" CHECK (("status" = 'pending') = ("delivery_state" is not null) and ("delivery_state" is null or "delivery_state" in ('queued', 'retrying', 'awaiting_reconciliation'))),
	CONSTRAINT "invoice_environment_check" CHECK ("environment" in ('homologation', 'production')),
	CONSTRAINT "invoice_point_of_sale_check" CHECK ("invoice"."point_of_sale" between 1 and 99999),
	CONSTRAINT "invoice_voucher_check" CHECK (("status" in ('issued', 'manual')) = ("number" is not null) and ("status" in ('issued', 'manual')) = ("cae" is not null) and ("number" is null or "number" > 0) and ("cae" is null or "cae" ~ '^[0-9]{14}$') and ("status" <> 'issued' or "cae_expires_on" is not null) and ("status" in ('issued', 'manual') or ("cae_expires_on" is null and "issued_at" is null))),
	CONSTRAINT "invoice_rejection_check" CHECK (("invoice"."status" = 'rejected') = ("invoice"."rejection_message" is not null)),
	CONSTRAINT "invoice_recipient_kind_check" CHECK (("invoice"."recipient_kind" = 'patient' and "invoice"."patient_id" is not null and "invoice"."tenant_payer_id" is null)
        or ("invoice"."recipient_kind" = 'payer' and "invoice"."tenant_payer_id" is not null and "invoice"."patient_id" is null)),
	CONSTRAINT "invoice_recipient_tax_condition_check" CHECK ("recipient_tax_condition" in ('consumidor_final', 'responsable_inscripto', 'monotributo', 'exento')),
	CONSTRAINT "invoice_recipient_document_check" CHECK (("recipient_doc_type" is null) = ("recipient_doc_number" is null) and ("recipient_doc_type" is null or "recipient_doc_type" in ('cuit', 'dni'))),
	CONSTRAINT "invoice_total_check" CHECK ("invoice"."total_cents" > 0),
	CONSTRAINT "invoice_breakdown_check" CHECK ("invoice"."net_cents" >= 0 and "invoice"."vat_cents" >= 0 and "invoice"."exempt_cents" >= 0
        and "invoice"."net_cents" + "invoice"."vat_cents" + "invoice"."exempt_cents" = "invoice"."total_cents"),
	CONSTRAINT "invoice_credit_note_check" CHECK (("type" in ('NCA', 'NCB', 'NCC')) = ("credit_note_of_id" is not null) and ("credit_note_of_id" is null or ("reason" is not null and length(btrim("reason")) > 0))),
	CONSTRAINT "invoice_attempts_check" CHECK ("invoice"."attempts" >= 0 and ("invoice"."expected_number" is null or "invoice"."expected_number" > 0)),
	CONSTRAINT "invoice_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "invoice_patient_fkey" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient"("tenant_id","id"),
	CONSTRAINT "invoice_payer_fkey" FOREIGN KEY ("tenant_id","tenant_payer_id") REFERENCES "public"."tenant_payer"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "invoice_document" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"delivered_at" timestamp with time zone,
	"delivery_skipped_reason" text,
	CONSTRAINT "invoice_document_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "invoice_document_size_check" CHECK ("invoice_document"."size_bytes" > 0),
	CONSTRAINT "invoice_document_delivery_check" CHECK (not ("invoice_document"."delivered_at" is not null and "invoice_document"."delivery_skipped_reason" is not null)),
	CONSTRAINT "invoice_document_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")
);
--> statement-breakpoint
CREATE TABLE "invoice_line" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"charge_line_id" uuid NOT NULL,
	"charge_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"description" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	CONSTRAINT "invoice_line_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "invoice_line_amount_check" CHECK ("invoice_line"."amount_cents" > 0),
	CONSTRAINT "invoice_line_description_check" CHECK (length(btrim("invoice_line"."description")) between 1 and 200),
	CONSTRAINT "invoice_line_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")
);
--> statement-breakpoint
-- The check of the rows when a foreign key is added runs as the table owner, and FORCE ROW LEVEL
-- SECURITY binds the owner on every table involved: the tenant policy of charge_line would read an
-- `app.tenant_id` nobody set (22P02). Row level security is lifted on charge_line for the length of
-- this statement, inside the migration's transaction, and put back at once (see migration 0030).
ALTER TABLE "charge_line" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_charge_line_fkey" FOREIGN KEY ("tenant_id","charge_line_id") REFERENCES "public"."charge_line"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_line" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_credit_note_of_fkey" FOREIGN KEY ("tenant_id","credit_note_of_id") REFERENCES "public"."invoice"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_previous_attempt_fkey" FOREIGN KEY ("tenant_id","previous_attempt_id") REFERENCES "public"."invoice"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_document" ADD CONSTRAINT "invoice_document_invoice_fkey" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoice"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_invoice_fkey" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoice"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_idempotency_key" ON "invoice" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_number_key" ON "invoice" USING btree ("tenant_id","point_of_sale","type","number") WHERE "invoice"."number" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_previous_attempt_key" ON "invoice" USING btree ("tenant_id","previous_attempt_id") WHERE "invoice"."previous_attempt_id" is not null;--> statement-breakpoint
CREATE INDEX "invoice_status_idx" ON "invoice" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "invoice_patient_idx" ON "invoice" USING btree ("tenant_id","patient_id","created_at");--> statement-breakpoint
CREATE INDEX "invoice_credit_note_of_idx" ON "invoice" USING btree ("tenant_id","credit_note_of_id") WHERE "invoice"."credit_note_of_id" is not null;--> statement-breakpoint
CREATE INDEX "invoice_due_idx" ON "invoice" USING btree ("tenant_id","next_attempt_at") WHERE "invoice"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_document_invoice_key" ON "invoice_document" USING btree ("tenant_id","invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_line_charge_line_key" ON "invoice_line" USING btree ("tenant_id","invoice_id","charge_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_line_position_key" ON "invoice_line" USING btree ("tenant_id","invoice_id","position");--> statement-breakpoint
CREATE INDEX "invoice_line_charge_line_idx" ON "invoice_line" USING btree ("tenant_id","charge_line_id");--> statement-breakpoint
CREATE INDEX "invoice_line_charge_idx" ON "invoice_line" USING btree ("tenant_id","charge_id");
--> statement-breakpoint
ALTER TABLE "invoice" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "invoice" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invoice" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "invoice_line" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "invoice_line" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invoice_line" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "invoice_document" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "invoice_document" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invoice_document" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- An invoice, a credit note and the attempts at them are never deleted: they are issued, rejected or
-- corrected by a credit note (e-invoicing-afip, "Invoice immutability"). A line is written with its
-- invoice and never touched again.
REVOKE DELETE, TRUNCATE ON "invoice" FROM app_rw;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "invoice_line" FROM app_rw;
--> statement-breakpoint
REVOKE UPDATE ON "invoice_line" FROM app_rw;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "invoice_document" FROM app_rw;
--> statement-breakpoint
-- Only a pending invoice moves: its retry bookkeeping, and its way out (issued or rejected). Issued,
-- manual and rejected invoices are closed, even to a write of the same value, and what a pending
-- invoice asks for (type, amounts, recipient, key) never changes. A correction is a credit note.
CREATE FUNCTION app.guard_invoice() RETURNS trigger
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
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'what an invoice asks for does not change' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER invoice_guard
  BEFORE UPDATE ON "invoice"
  FOR EACH ROW EXECUTE FUNCTION app.guard_invoice();
--> statement-breakpoint
-- A credit note cancels an issued or registered invoice, with the letter of that invoice, and the
-- notes of an invoice (the pending ones too, not the rejected) never add up to more than it. A retry
-- follows a rejected attempt. The application serializes these writes with the lock on the charge
-- lines; this is the backstop for whatever the application does.
CREATE FUNCTION app.guard_invoice_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    original invoice%ROWTYPE;
    credited bigint;
    previous text;
    expected text;
  BEGIN
    IF NEW.credit_note_of_id IS NOT NULL THEN
      SELECT * INTO original FROM invoice
       WHERE tenant_id = NEW.tenant_id AND id = NEW.credit_note_of_id;
      IF FOUND THEN
        IF original.status NOT IN ('issued', 'manual') OR original.credit_note_of_id IS NOT NULL THEN
          RAISE EXCEPTION 'only an issued or registered invoice is cancelled by a credit note'
            USING ERRCODE = '23514';
        END IF;
        expected := CASE original.type
          WHEN 'FA' THEN 'NCA' WHEN 'FB' THEN 'NCB' WHEN 'FC' THEN 'NCC' END;
        IF NEW.type IS DISTINCT FROM expected THEN
          RAISE EXCEPTION 'a credit note has the letter of the invoice it cancels'
            USING ERRCODE = '23514';
        END IF;
        SELECT coalesce(sum(total_cents), 0) INTO credited FROM invoice
         WHERE tenant_id = NEW.tenant_id AND credit_note_of_id = NEW.credit_note_of_id
           AND status <> 'rejected';
        IF credited + NEW.total_cents > original.total_cents THEN
          RAISE EXCEPTION 'the credit notes of an invoice cannot add up to more than the invoice'
            USING ERRCODE = '23514';
        END IF;
      END IF;
    END IF;
    IF NEW.previous_attempt_id IS NOT NULL THEN
      SELECT status INTO previous FROM invoice
       WHERE tenant_id = NEW.tenant_id AND id = NEW.previous_attempt_id;
      IF FOUND AND previous <> 'rejected' THEN
        RAISE EXCEPTION 'only a rejected attempt is retried' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER invoice_insert_guard
  BEFORE INSERT ON "invoice"
  FOR EACH ROW EXECUTE FUNCTION app.guard_invoice_insert();
--> statement-breakpoint
-- The lines of an invoice are written in the transaction that creates it, name the charge of their
-- charge line, and, for a credit note, stay within what the cancelled invoice billed for that line.
CREATE FUNCTION app.guard_invoice_line_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    owner invoice%ROWTYPE;
    line_charge uuid;
    billed bigint;
    credited bigint;
  BEGIN
    SELECT * INTO owner FROM invoice WHERE tenant_id = NEW.tenant_id AND id = NEW.invoice_id;
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
    IF owner.created_at <> now() THEN
      RAISE EXCEPTION 'the lines of an invoice are written with it' USING ERRCODE = '42501';
    END IF;
    SELECT charge_id INTO line_charge FROM charge_line
     WHERE tenant_id = NEW.tenant_id AND id = NEW.charge_line_id;
    IF FOUND AND line_charge IS DISTINCT FROM NEW.charge_id THEN
      RAISE EXCEPTION 'the charge of an invoice line is the charge of its charge line'
        USING ERRCODE = '23514';
    END IF;
    IF owner.credit_note_of_id IS NOT NULL THEN
      SELECT amount_cents INTO billed FROM invoice_line
       WHERE tenant_id = NEW.tenant_id AND invoice_id = owner.credit_note_of_id
         AND charge_line_id = NEW.charge_line_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'a credit note covers lines of the invoice it cancels' USING ERRCODE = '23514';
      END IF;
      SELECT coalesce(sum(il.amount_cents), 0) INTO credited
        FROM invoice_line il
        JOIN invoice note ON note.tenant_id = il.tenant_id AND note.id = il.invoice_id
       WHERE il.tenant_id = NEW.tenant_id AND note.credit_note_of_id = owner.credit_note_of_id
         AND il.charge_line_id = NEW.charge_line_id AND note.status <> 'rejected';
      IF credited + NEW.amount_cents > billed THEN
        RAISE EXCEPTION 'a credit note cannot credit more of a line than the invoice billed'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER invoice_line_insert_guard
  BEFORE INSERT ON "invoice_line"
  FOR EACH ROW EXECUTE FUNCTION app.guard_invoice_line_insert();
--> statement-breakpoint
CREATE FUNCTION app.refuse_invoice_line_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    RAISE EXCEPTION 'an invoice line is written once' USING ERRCODE = '42501';
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER invoice_line_update_guard
  BEFORE UPDATE ON "invoice_line"
  FOR EACH ROW EXECUTE FUNCTION app.refuse_invoice_line_update();
--> statement-breakpoint
-- The ONLY writer of charge_line.invoiced_cents (billing never writes it). What a line has invoiced
-- is what the invoices cover (pending, issued and registered ones; a rejected attempt releases its
-- lines) minus what the credit notes took back once ISSUED: a note that is still pending releases
-- nothing. charge_line_invoiced_check keeps the result between zero and the amount of the line, so
-- no sequence of writes can over-invoice a line.
CREATE FUNCTION app.refresh_invoiced(p_tenant uuid, p_line uuid) RETURNS void
  LANGUAGE plpgsql
  AS $$
  BEGIN
    UPDATE charge_line SET invoiced_cents = (
      SELECT coalesce(sum(CASE WHEN i.type IN ('NCA', 'NCB', 'NCC') THEN -il.amount_cents
                               ELSE il.amount_cents END), 0)
        FROM invoice_line il
        JOIN invoice i ON i.tenant_id = il.tenant_id AND i.id = il.invoice_id
       WHERE il.tenant_id = p_tenant AND il.charge_line_id = p_line
         AND CASE WHEN i.type IN ('NCA', 'NCB', 'NCC') THEN i.status = 'issued'
                  ELSE i.status IN ('pending', 'issued', 'manual') END
    )
    WHERE tenant_id = p_tenant AND id = p_line;
  END
  $$;
--> statement-breakpoint
-- Called by the triggers below, which run as the application role (new functions are not executable
-- by it by default, see migration 0019). It runs as its caller, so row level security applies, and
-- all it can do is recompute the amount from the invoices.
GRANT EXECUTE ON FUNCTION app.refresh_invoiced(uuid, uuid) TO app_rw;
--> statement-breakpoint
CREATE FUNCTION app.invoice_line_refresh() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    PERFORM app.refresh_invoiced(NEW.tenant_id, NEW.charge_line_id);
    RETURN NULL;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER invoice_line_refresh
  AFTER INSERT ON "invoice_line"
  FOR EACH ROW EXECUTE FUNCTION app.invoice_line_refresh();
--> statement-breakpoint
CREATE FUNCTION app.invoice_status_refresh() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    covered uuid;
  BEGIN
    -- In the order of the ids, like every writer of the lines.
    FOR covered IN
      SELECT charge_line_id FROM invoice_line
       WHERE tenant_id = NEW.tenant_id AND invoice_id = NEW.id
       ORDER BY charge_line_id
    LOOP
      PERFORM app.refresh_invoiced(NEW.tenant_id, covered);
    END LOOP;
    RETURN NULL;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER invoice_status_refresh
  AFTER UPDATE OF status ON "invoice"
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION app.invoice_status_refresh();
--> statement-breakpoint
-- The PDF of an invoice is written once; afterwards only the delivery can be recorded, once.
CREATE FUNCTION app.guard_invoice_document() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
       OR NEW.object_key IS DISTINCT FROM OLD.object_key
       OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR OLD.delivered_at IS NOT NULL
       OR OLD.delivery_skipped_reason IS NOT NULL THEN
      RAISE EXCEPTION 'the document of an invoice is written once; its delivery is recorded once'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER invoice_document_guard
  BEFORE UPDATE ON "invoice_document"
  FOR EACH ROW EXECUTE FUNCTION app.guard_invoice_document();
