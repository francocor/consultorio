CREATE TABLE "appointment_type" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"duration_minutes" smallint NOT NULL,
	"buffer_minutes" smallint DEFAULT 0 NOT NULL,
	"mode" text DEFAULT 'in_person' NOT NULL,
	"price_reference" text,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"color" text,
	"professional_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"specialties" text[] DEFAULT '{}'::text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "appointment_type_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "appointment_type_duration_check" CHECK ("appointment_type"."duration_minutes" > 0 and "appointment_type"."duration_minutes" <= 1440),
	CONSTRAINT "appointment_type_buffer_check" CHECK ("appointment_type"."buffer_minutes" >= 0 and "appointment_type"."buffer_minutes" <= 1440),
	CONSTRAINT "appointment_type_mode_check" CHECK ("appointment_type"."mode" in ('in_person', 'virtual')),
	CONSTRAINT "appointment_type_color_check" CHECK ("appointment_type"."color" is null or "appointment_type"."color" ~ '^#[0-9a-fA-F]{6}$'),
	CONSTRAINT "appointment_type_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")
);
--> statement-breakpoint
CREATE TABLE "professional_hours_exception" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"professional_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"date_from" date NOT NULL,
	"date_to" date NOT NULL,
	"reason" text,
	"location_id" uuid,
	"weekday" smallint,
	"start_minute" smallint,
	"end_minute" smallint,
	"created_by" uuid NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "professional_hours_exception_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "professional_hours_exception_range_check" CHECK ("professional_hours_exception"."date_to" >= "professional_hours_exception"."date_from"),
	CONSTRAINT "professional_hours_exception_interval_check" CHECK (("professional_hours_exception"."location_id" is null and "professional_hours_exception"."weekday" is null and "professional_hours_exception"."start_minute" is null and "professional_hours_exception"."end_minute" is null)
        or ("professional_hours_exception"."location_id" is not null and "professional_hours_exception"."weekday" is not null
            and "professional_hours_exception"."start_minute" is not null and "professional_hours_exception"."end_minute" is not null
            and "professional_hours_exception"."weekday" between 1 and 7 and "professional_hours_exception"."start_minute" >= 0 and "professional_hours_exception"."end_minute" <= 1440 and "professional_hours_exception"."end_minute" > "professional_hours_exception"."start_minute")),
	CONSTRAINT "professional_hours_exception_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "professional_hours_exception_professional_fkey" FOREIGN KEY ("tenant_id","professional_id") REFERENCES "public"."professional"("tenant_id","id"),
	CONSTRAINT "professional_hours_exception_location_fkey" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "schedule_block" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"professional_id" uuid,
	"location_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"series_id" uuid,
	"created_by" uuid NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" uuid,
	CONSTRAINT "schedule_block_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "schedule_block_interval_check" CHECK ("schedule_block"."ends_at" > "schedule_block"."starts_at"),
	CONSTRAINT "schedule_block_scope_check" CHECK ("schedule_block"."professional_id" is not null or "schedule_block"."location_id" is not null),
	CONSTRAINT "schedule_block_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "schedule_block_professional_fkey" FOREIGN KEY ("tenant_id","professional_id") REFERENCES "public"."professional"("tenant_id","id"),
	CONSTRAINT "schedule_block_location_fkey" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "tenant_day_off" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"day" date NOT NULL,
	"name" text NOT NULL,
	"location_id" uuid,
	"created_by" uuid NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" uuid,
	CONSTRAINT "tenant_day_off_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "tenant_day_off_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "tenant_day_off_location_fkey" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id")
);
--> statement-breakpoint
CREATE INDEX "appointment_type_active_idx" ON "appointment_type" USING btree ("tenant_id","name") WHERE "appointment_type"."active";--> statement-breakpoint
CREATE INDEX "professional_hours_exception_live_idx" ON "professional_hours_exception" USING btree ("tenant_id","professional_id","date_from") WHERE "professional_hours_exception"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "schedule_block_live_idx" ON "schedule_block" USING btree ("tenant_id","starts_at") WHERE "schedule_block"."removed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_day_off_live_idx" ON "tenant_day_off" USING btree ("tenant_id","day",coalesce("location_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "tenant_day_off"."removed_at" is null;
--> statement-breakpoint
ALTER TABLE "appointment_type" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "appointment_type" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "appointment_type" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "schedule_block" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "schedule_block" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "schedule_block" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "tenant_day_off" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_day_off" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_day_off" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "professional_hours_exception" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "professional_hours_exception" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "professional_hours_exception" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- Scheduling configuration is ended (deactivated, removed), never deleted: appointments and the
-- history of what was bookable depend on it.
REVOKE DELETE, TRUNCATE ON "appointment_type" FROM app_rw;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "schedule_block" FROM app_rw;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "tenant_day_off" FROM app_rw;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "professional_hours_exception" FROM app_rw;
