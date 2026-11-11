-- UUIDv7: a 48-bit millisecond timestamp followed by random bits, so ids sort by creation time
-- and index well. PostgreSQL 17 has no built-in generator (18 does). The version bits are set on
-- a random v4 uuid after its first 6 bytes are replaced by the timestamp.
CREATE FUNCTION app.uuid_v7() RETURNS uuid
  LANGUAGE sql VOLATILE PARALLEL SAFE
  AS $$
    SELECT encode(
      set_bit(
        set_bit(
          overlay(
            uuid_send(gen_random_uuid())
            PLACING substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
            FROM 1 FOR 6
          ),
          52, 1
        ),
        53, 1
      ),
      'hex'
    )::uuid
  $$;
--> statement-breakpoint
CREATE TABLE "holiday_catalog" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"country" text NOT NULL,
	"date" date NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holiday_catalog_country_date_name_key" UNIQUE("country","date","name"),
	CONSTRAINT "holiday_catalog_kind_check" CHECK ("holiday_catalog"."kind" in ('national', 'bridge'))
);
--> statement-breakpoint
CREATE TABLE "payer" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"country" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payer_country_code_key" UNIQUE("country","code"),
	CONSTRAINT "payer_kind_check" CHECK ("payer"."kind" in ('obra_social', 'prepaga', 'private'))
);
--> statement-breakpoint
-- Platform catalogs are maintained by the platform operator as data. The runtime role reads them
-- and nothing else; writes go through the owner connection (seed loaders, operator console).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "holiday_catalog", "payer" FROM app_rw;
