CREATE TABLE "action_token" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"session_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "action_token_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "action_token_uses_check" CHECK ("action_token"."uses" between 0 and "action_token"."max_uses"),
	CONSTRAINT "action_token_max_uses_check" CHECK ("action_token"."max_uses" >= 1),
	CONSTRAINT "action_token_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "action_token_token_hash_key" ON "action_token" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "action_token_subject_idx" ON "action_token" USING btree ("tenant_id","kind","subject_id");
--> statement-breakpoint
ALTER TABLE "action_token" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "action_token" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "action_token" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
