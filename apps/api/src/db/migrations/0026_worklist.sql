CREATE TABLE "worklist_item" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"location_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"detail_enc" "bytea",
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	CONSTRAINT "worklist_item_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "worklist_item_kind_check" CHECK ("kind" in ('pending_approval', 'identity_review', 'reminder_not_sent', 'reminder_not_delivered', 'reply_to_review', 'waitlist_manual_contact')),
	CONSTRAINT "worklist_item_subject_type_check" CHECK ("worklist_item"."subject_type" in ('appointment', 'waitlist_entry', 'inbound_message')),
	CONSTRAINT "worklist_item_status_check" CHECK ("worklist_item"."status" in ('open', 'resolved', 'dismissed')),
	CONSTRAINT "worklist_item_resolution_check" CHECK (("worklist_item"."status" = 'open' and "worklist_item"."resolved_at" is null and "worklist_item"."resolved_by" is null)
        or ("worklist_item"."status" <> 'open' and "worklist_item"."resolved_at" is not null and "worklist_item"."resolved_by" is not null)),
	CONSTRAINT "worklist_item_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "worklist_item_location_fkey" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "worklist_item_open_key" ON "worklist_item" USING btree ("tenant_id","kind","subject_type","subject_id") WHERE "worklist_item"."status" = 'open';--> statement-breakpoint
CREATE INDEX "worklist_item_queue_idx" ON "worklist_item" USING btree ("tenant_id","status","created_at") WHERE "worklist_item"."status" = 'open';--> statement-breakpoint
CREATE INDEX "worklist_item_subject_idx" ON "worklist_item" USING btree ("tenant_id","subject_type","subject_id");
--> statement-breakpoint
ALTER TABLE "worklist_item" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "worklist_item" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "worklist_item" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- Items are resolved or dismissed with an actor, never deleted (scheduling, "Reception worklist").
REVOKE DELETE, TRUNCATE ON "worklist_item" FROM app_rw;
