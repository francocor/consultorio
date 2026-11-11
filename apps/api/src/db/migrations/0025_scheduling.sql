CREATE TABLE "appointment" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"patient_id" uuid NOT NULL,
	"professional_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"appointment_type_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"buffer_minutes" smallint DEFAULT 0 NOT NULL,
	"lane" smallint DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"source" text DEFAULT 'staff' NOT NULL,
	"booked_by" uuid,
	"identity_confirmed" boolean DEFAULT true NOT NULL,
	"identity_confirmed_by" uuid,
	"identity_confirmation" text,
	"out_of_hours" boolean DEFAULT false NOT NULL,
	"override_reason" text,
	"video_room" text,
	"series_id" uuid,
	"series_index" smallint,
	"cancelled_by_kind" text,
	"cancel_reason" text,
	"cancel_note" text,
	"cancelled_at" timestamp with time zone,
	"late_cancellation" boolean,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "appointment_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "appointment_status_check" CHECK ("status" in ('pending_approval', 'scheduled', 'confirmed', 'checked_in', 'in_progress', 'attended', 'no_show', 'cancelled')),
	CONSTRAINT "appointment_source_check" CHECK ("appointment"."source" in ('staff', 'online', 'waitlist_offer')),
	CONSTRAINT "appointment_interval_check" CHECK ("appointment"."ends_at" > "appointment"."starts_at"),
	CONSTRAINT "appointment_buffer_check" CHECK ("appointment"."buffer_minutes" >= 0),
	CONSTRAINT "appointment_lane_check" CHECK ("appointment"."lane" >= 1),
	CONSTRAINT "appointment_version_check" CHECK ("appointment"."version" >= 1),
	CONSTRAINT "appointment_identity_check" CHECK ("appointment"."identity_confirmation" is null
        or ("appointment"."identity_confirmed" and "appointment"."identity_confirmation" in ('staff', 'self_confirmed'))),
	CONSTRAINT "appointment_cancelled_by_check" CHECK ("appointment"."cancelled_by_kind" is null or "appointment"."cancelled_by_kind" in ('patient', 'professional', 'organization')),
	CONSTRAINT "appointment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "appointment_patient_fkey" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient"("tenant_id","id"),
	CONSTRAINT "appointment_professional_fkey" FOREIGN KEY ("tenant_id","professional_id") REFERENCES "public"."professional"("tenant_id","id"),
	CONSTRAINT "appointment_location_fkey" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id"),
	CONSTRAINT "appointment_type_fkey" FOREIGN KEY ("tenant_id","appointment_type_id") REFERENCES "public"."appointment_type"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "appointment_event" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"appointment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"actor_user_id" uuid,
	"actor_kind" text DEFAULT 'staff' NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "appointment_event_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "appointment_event_kind_check" CHECK ("appointment_event"."kind" in ('created', 'status_changed', 'rescheduled', 'reassigned', 'status_corrected', 'identity_confirmed', 'identity_rejected')),
	CONSTRAINT "appointment_event_actor_kind_check" CHECK ("appointment_event"."actor_kind" in ('staff', 'patient', 'system')),
	CONSTRAINT "appointment_event_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")
);
--> statement-breakpoint
CREATE TABLE "slot_hold" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"professional_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"buffer_minutes" smallint DEFAULT 0 NOT NULL,
	"lane" smallint DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"origin" text DEFAULT 'staff' NOT NULL,
	"source_key" text NOT NULL,
	"appointment_id" uuid,
	"created_by" uuid,
	CONSTRAINT "slot_hold_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "slot_hold_status_check" CHECK ("slot_hold"."status" in ('active', 'converted', 'expired', 'released', 'invalidated')),
	CONSTRAINT "slot_hold_origin_check" CHECK ("slot_hold"."origin" in ('public', 'staff')),
	CONSTRAINT "slot_hold_interval_check" CHECK ("slot_hold"."ends_at" > "slot_hold"."starts_at"),
	CONSTRAINT "slot_hold_buffer_check" CHECK ("slot_hold"."buffer_minutes" >= 0),
	CONSTRAINT "slot_hold_lane_check" CHECK ("slot_hold"."lane" >= 1),
	CONSTRAINT "slot_hold_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "slot_hold_professional_fkey" FOREIGN KEY ("tenant_id","professional_id") REFERENCES "public"."professional"("tenant_id","id"),
	CONSTRAINT "slot_hold_location_fkey" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "slot_occupancy" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"professional_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"lane" smallint NOT NULL,
	"during" "tstzrange" NOT NULL,
	"active" boolean NOT NULL,
	"appointment_id" uuid,
	"slot_hold_id" uuid,
	CONSTRAINT "slot_occupancy_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "slot_occupancy_lane_check" CHECK ("slot_occupancy"."lane" >= 1),
	CONSTRAINT "slot_occupancy_owner_check" CHECK (num_nonnulls("slot_occupancy"."appointment_id", "slot_occupancy"."slot_hold_id") = 1),
	CONSTRAINT "slot_occupancy_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "slot_occupancy_professional_fkey" FOREIGN KEY ("tenant_id","professional_id") REFERENCES "public"."professional"("tenant_id","id"),
	CONSTRAINT "slot_occupancy_location_fkey" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "appointment_event" ADD CONSTRAINT "appointment_event_appointment_fkey" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointment"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_hold" ADD CONSTRAINT "slot_hold_appointment_fkey" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointment"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_occupancy" ADD CONSTRAINT "slot_occupancy_appointment_fkey" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointment"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_occupancy" ADD CONSTRAINT "slot_occupancy_hold_fkey" FOREIGN KEY ("tenant_id","slot_hold_id") REFERENCES "public"."slot_hold"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_professional_time_idx" ON "appointment" USING btree ("tenant_id","professional_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointment_location_time_idx" ON "appointment" USING btree ("tenant_id","location_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointment_patient_time_idx" ON "appointment" USING btree ("tenant_id","patient_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointment_series_idx" ON "appointment" USING btree ("tenant_id","series_id","series_index") WHERE "appointment"."series_id" is not null;--> statement-breakpoint
CREATE INDEX "appointment_event_appointment_idx" ON "appointment_event" USING btree ("tenant_id","appointment_id","created_at");--> statement-breakpoint
CREATE INDEX "slot_hold_active_idx" ON "slot_hold" USING btree ("tenant_id","professional_id","expires_at") WHERE "slot_hold"."status" = 'active';--> statement-breakpoint
CREATE INDEX "slot_hold_source_idx" ON "slot_hold" USING btree ("tenant_id","source_key","created_at") WHERE "slot_hold"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "slot_occupancy_appointment_key" ON "slot_occupancy" USING btree ("appointment_id") WHERE "slot_occupancy"."appointment_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "slot_occupancy_hold_key" ON "slot_occupancy" USING btree ("slot_hold_id") WHERE "slot_occupancy"."slot_hold_id" is not null;--> statement-breakpoint
CREATE INDEX "slot_occupancy_active_idx" ON "slot_occupancy" USING btree ("tenant_id","professional_id") WHERE "slot_occupancy"."active";
--> statement-breakpoint
ALTER TABLE "appointment" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "appointment" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "appointment" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "appointment_event" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "appointment_event" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "appointment_event" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "slot_hold" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "slot_hold" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "slot_hold" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "slot_occupancy" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "slot_occupancy" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "slot_occupancy" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- The conflict surface (design 4.6): two ACTIVE occupancies of one professional in one lane may
-- not overlap. `during` includes the buffer, and ranges are half open, so back-to-back is allowed.
-- Deferrable so a re-lane of several rows can be checked once, at the end of its transaction.
ALTER TABLE "slot_occupancy" ADD CONSTRAINT "slot_occupancy_no_overlap"
  EXCLUDE USING gist ("tenant_id" WITH =, "professional_id" WITH =, "lane" WITH =, "during" WITH &&)
  WHERE ("active") DEFERRABLE INITIALLY IMMEDIATE;
--> statement-breakpoint
-- Capacity is the number of lanes: a lane above the professional's maximum is refused. A constraint
-- trigger, because it reads another table. Only active rows count; a freed row keeps its lane.
CREATE FUNCTION app.slot_occupancy_lane_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  capacity smallint;
BEGIN
  IF NOT NEW.active THEN
    RETURN NULL;
  END IF;
  SELECT p.max_simultaneous INTO capacity
    FROM public.professional p
   WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.professional_id;
  IF capacity IS NULL OR NEW.lane > capacity THEN
    RAISE EXCEPTION 'lane % is above the capacity of the professional', NEW.lane
      USING ERRCODE = '23514', CONSTRAINT = 'slot_occupancy_lane_capacity';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER slot_occupancy_lane_capacity
  AFTER INSERT OR UPDATE ON "slot_occupancy"
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION app.slot_occupancy_lane_check();
--> statement-breakpoint
-- Appointments occupy time in these statuses; no_show and cancelled free it (scheduling,
-- "Conflict detection and overbooking policy"). The mirror is written by definer triggers: the
-- runtime role can read the occupancy but never write it, so nothing but an appointment or a hold
-- can take time.
CREATE FUNCTION app.sync_appointment_occupancy()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  INSERT INTO public.slot_occupancy
    (tenant_id, professional_id, location_id, lane, during, active, appointment_id)
  VALUES (
    NEW.tenant_id, NEW.professional_id, NEW.location_id, NEW.lane,
    tstzrange(NEW.starts_at, NEW.ends_at + make_interval(mins => NEW.buffer_minutes), '[)'),
    NEW.status IN ('pending_approval', 'scheduled', 'confirmed', 'checked_in', 'in_progress', 'attended'),
    NEW.id
  )
  ON CONFLICT (appointment_id) WHERE appointment_id IS NOT NULL
  DO UPDATE SET
    professional_id = EXCLUDED.professional_id,
    location_id = EXCLUDED.location_id,
    lane = EXCLUDED.lane,
    during = EXCLUDED.during,
    active = EXCLUDED.active,
    updated_at = now();
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER appointment_sync_occupancy
  AFTER INSERT OR UPDATE OF status, starts_at, ends_at, buffer_minutes, lane, professional_id, location_id ON "appointment"
  FOR EACH ROW EXECUTE FUNCTION app.sync_appointment_occupancy();
--> statement-breakpoint
CREATE FUNCTION app.sync_hold_occupancy()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  INSERT INTO public.slot_occupancy
    (tenant_id, professional_id, location_id, lane, during, active, slot_hold_id)
  VALUES (
    NEW.tenant_id, NEW.professional_id, NEW.location_id, NEW.lane,
    tstzrange(NEW.starts_at, NEW.ends_at + make_interval(mins => NEW.buffer_minutes), '[)'),
    NEW.status = 'active',
    NEW.id
  )
  ON CONFLICT (slot_hold_id) WHERE slot_hold_id IS NOT NULL
  DO UPDATE SET
    professional_id = EXCLUDED.professional_id,
    location_id = EXCLUDED.location_id,
    lane = EXCLUDED.lane,
    during = EXCLUDED.during,
    active = EXCLUDED.active,
    updated_at = now();
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER slot_hold_sync_occupancy
  AFTER INSERT OR UPDATE OF status, starts_at, ends_at, buffer_minutes, lane, professional_id, location_id ON "slot_hold"
  FOR EACH ROW EXECUTE FUNCTION app.sync_hold_occupancy();
--> statement-breakpoint
-- Default privileges close new functions in schema app by default (migration 0019); only the
-- triggers, which run as the owner, call these.
REVOKE ALL ON FUNCTION app.sync_appointment_occupancy() FROM PUBLIC, app_rw;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.sync_hold_occupancy() FROM PUBLIC, app_rw;
--> statement-breakpoint
-- The occupancy is read-only to the application. Appointments and holds are never deleted, and the
-- history of an appointment can be added to but never rewritten.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "slot_occupancy" FROM app_rw;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "appointment" FROM app_rw;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "slot_hold" FROM app_rw;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "appointment_event" FROM app_rw;
