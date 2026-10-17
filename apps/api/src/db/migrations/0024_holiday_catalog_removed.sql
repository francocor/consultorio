ALTER TABLE "holiday_catalog" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
-- The platform operator maintains the holiday catalog as data (country-rules-ar, "Holiday
-- catalog"): it may add a holiday and end one that was added by mistake, and nothing else. The
-- organizations read it; they never write it.
GRANT SELECT, INSERT ON "holiday_catalog" TO app_operator;
--> statement-breakpoint
GRANT UPDATE ("kind", "removed_at") ON "holiday_catalog" TO app_operator;
