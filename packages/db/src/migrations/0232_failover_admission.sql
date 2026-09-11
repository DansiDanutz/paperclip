CREATE TABLE "company_dispatch_epochs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"epoch" integer NOT NULL,
	"owner_instance_id" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"dispatch_count" integer DEFAULT 0 NOT NULL,
	"max_dispatches" integer NOT NULL,
	"admitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"renewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_dispatch_epochs_state_check" CHECK ("company_dispatch_epochs"."state" in ('active', 'invalidated', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "company_failover_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"policy" jsonb NOT NULL,
	"policy_revision" text NOT NULL,
	"enabled" text DEFAULT 'false' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_failover_policies_company_uq" UNIQUE("company_id"),
	CONSTRAINT "company_failover_policies_enabled_check" CHECK ("company_failover_policies"."enabled" in ('true', 'false'))
);
--> statement-breakpoint
ALTER TABLE "company_dispatch_epochs" ADD CONSTRAINT "company_dispatch_epochs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_failover_policies" ADD CONSTRAINT "company_failover_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_dispatch_epochs_company_active_uq" ON "company_dispatch_epochs" USING btree ("company_id") WHERE "company_dispatch_epochs"."state" = 'active';--> statement-breakpoint
CREATE INDEX "company_dispatch_epochs_company_state_idx" ON "company_dispatch_epochs" USING btree ("company_id","state");