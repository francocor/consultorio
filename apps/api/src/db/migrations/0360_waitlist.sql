CREATE TABLE "waitlist_entry" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"patient_id" uuid NOT NULL,
	"appointment_type_id" uuid NOT NULL,
	"professional_id" uuid,
	"location_id" uuid,
	"weekdays" smallint[] DEFAULT '{}'::smallint[] NOT NULL,
	"time_ranges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"earliest_date" date,
	"latest_date" date,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"close_reason" text,
	"closed_at" timestamp with time zone,
	"manual_contact_only" boolean DEFAULT false NOT NULL,
	"manual_reason" text,
	"offers_opt_in_at" timestamp with time zone,
	"offers_opt_in_source" text,
	"offers_opt_in_by" uuid,
	"channels" text[] DEFAULT '{email}'::text[] NOT NULL,
	"priority" smallint DEFAULT 0 NOT NULL,
	"priority_set_at" timestamp with time zone,
	"priority_set_by" uuid,
	"consecutive_expired" smallint DEFAULT 0 NOT NULL,
	"flagged_at" timestamp with time zone,
	"source" text DEFAULT 'staff' NOT NULL,
	"created_by" uuid,
	"identity_unconfirmed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "waitlist_entry_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "waitlist_entry_status_check" CHECK ("status" in ('active', 'paused', 'offered', 'closed')),
	CONSTRAINT "waitlist_entry_close_check" CHECK (("status" = 'closed') = ("close_reason" is not null) and ("status" = 'closed') = ("closed_at" is not null) and ("close_reason" is null or "close_reason" in ('fulfilled', 'expired', 'cancelled', 'patient_opted_out'))),
	CONSTRAINT "waitlist_entry_manual_check" CHECK (("manual_contact_only") = ("manual_reason" is not null) and ("manual_reason" is null or "manual_reason" in ('no_offers_opt_in', 'no_reachable_channel', 'patient_opted_out', 'undeliverable'))),
	CONSTRAINT "waitlist_entry_opt_in_check" CHECK (("offers_opt_in_at" is null) = ("offers_opt_in_source" is null) and ("offers_opt_in_source" is null or "offers_opt_in_source" in ('staff', 'public_join')) and ("offers_opt_in_source" is distinct from 'staff' or "offers_opt_in_by" is not null)),
	CONSTRAINT "waitlist_entry_source_check" CHECK ("source" in ('staff', 'public_join')),
	CONSTRAINT "waitlist_entry_channels_check" CHECK (cardinality("channels") between 1 and 2 and "channels" <@ array['email', 'whatsapp']::text[]),
	CONSTRAINT "waitlist_entry_priority_check" CHECK ("waitlist_entry"."priority" between 0 and 2),
	CONSTRAINT "waitlist_entry_weekdays_check" CHECK ("waitlist_entry"."weekdays" <@ array[1,2,3,4,5,6,7]::smallint[]),
	CONSTRAINT "waitlist_entry_time_ranges_check" CHECK (jsonb_typeof("waitlist_entry"."time_ranges") = 'array' and jsonb_array_length("waitlist_entry"."time_ranges") <= 6),
	CONSTRAINT "waitlist_entry_dates_check" CHECK ("waitlist_entry"."earliest_date" is null or "waitlist_entry"."latest_date" is null or "waitlist_entry"."earliest_date" <= "waitlist_entry"."latest_date"),
	CONSTRAINT "waitlist_entry_expired_count_check" CHECK ("waitlist_entry"."consecutive_expired" >= 0),
	CONSTRAINT "waitlist_entry_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "waitlist_entry_patient_fkey" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient"("tenant_id","id"),
	CONSTRAINT "waitlist_entry_type_fkey" FOREIGN KEY ("tenant_id","appointment_type_id") REFERENCES "public"."appointment_type"("tenant_id","id"),
	CONSTRAINT "waitlist_entry_professional_fkey" FOREIGN KEY ("tenant_id","professional_id") REFERENCES "public"."professional"("tenant_id","id"),
	CONSTRAINT "waitlist_entry_location_fkey" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "waitlist_offer" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"entry_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"slot_key" text NOT NULL,
	"professional_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"appointment_type_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"freed_starts_at" timestamp with time zone NOT NULL,
	"freed_ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"end_reason" text,
	"send_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"channel" text,
	"delivered_at" timestamp with time zone,
	"message_id" text,
	"appointment_id" uuid,
	CONSTRAINT "waitlist_offer_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "waitlist_offer_status_check" CHECK ("status" in ('open', 'accepted', 'declined', 'expired', 'invalidated')),
	CONSTRAINT "waitlist_offer_end_check" CHECK (("status" = 'open') = ("closed_at" is null) and ("end_reason" is null or "end_reason" in ('slot_taken', 'slot_unavailable', 'undeliverable', 'patient_opted_out', 'entry_closed'))),
	CONSTRAINT "waitlist_offer_channel_check" CHECK ("channel" is null or "channel" in ('email', 'whatsapp')),
	CONSTRAINT "waitlist_offer_range_check" CHECK ("waitlist_offer"."ends_at" > "waitlist_offer"."starts_at"),
	CONSTRAINT "waitlist_offer_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "waitlist_offer_patient_fkey" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient"("tenant_id","id"),
	CONSTRAINT "waitlist_offer_professional_fkey" FOREIGN KEY ("tenant_id","professional_id") REFERENCES "public"."professional"("tenant_id","id"),
	CONSTRAINT "waitlist_offer_location_fkey" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id"),
	CONSTRAINT "waitlist_offer_type_fkey" FOREIGN KEY ("tenant_id","appointment_type_id") REFERENCES "public"."appointment_type"("tenant_id","id"),
	CONSTRAINT "waitlist_offer_appointment_fkey" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointment"("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "waitlist_offer" ADD CONSTRAINT "waitlist_offer_entry_fkey" FOREIGN KEY ("tenant_id","entry_id") REFERENCES "public"."waitlist_entry"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_entry_in_play_key" ON "waitlist_entry" USING btree ("tenant_id","patient_id","appointment_type_id",coalesce("professional_id", '00000000-0000-0000-0000-000000000000'::uuid),coalesce("location_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "waitlist_entry"."status" <> 'closed';--> statement-breakpoint
CREATE INDEX "waitlist_entry_matching_idx" ON "waitlist_entry" USING btree ("tenant_id","appointment_type_id","expires_at") WHERE "waitlist_entry"."status" = 'active';--> statement-breakpoint
CREATE INDEX "waitlist_entry_patient_idx" ON "waitlist_entry" USING btree ("tenant_id","patient_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_offer_entry_slot_key" ON "waitlist_offer" USING btree ("tenant_id","entry_id","slot_key");--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_offer_patient_slot_key" ON "waitlist_offer" USING btree ("tenant_id","patient_id","slot_key");--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_offer_open_slot_key" ON "waitlist_offer" USING btree ("tenant_id","slot_key") WHERE "waitlist_offer"."status" = 'open';--> statement-breakpoint
CREATE INDEX "waitlist_offer_entry_idx" ON "waitlist_offer" USING btree ("tenant_id","entry_id","created_at");--> statement-breakpoint
CREATE INDEX "waitlist_offer_due_idx" ON "waitlist_offer" USING btree ("expires_at") WHERE "waitlist_offer"."status" = 'open';
--> statement-breakpoint
ALTER TABLE "waitlist_entry" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "waitlist_entry" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "waitlist_entry" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "waitlist_offer" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "waitlist_offer" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "waitlist_offer" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- Entries and offers are closed with a reason, never deleted: they feed the reports of recovered slots (waitlist, "Managing and closing entries").
REVOKE DELETE, TRUNCATE ON "waitlist_entry" FROM app_rw;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "waitlist_offer" FROM app_rw;
