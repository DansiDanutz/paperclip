CREATE TABLE "issue_interruptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"cancelled_run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"outcome" text,
	"continuation_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_interruptions_company_issue_run_uq" UNIQUE("company_id","issue_id","cancelled_run_id"),
	CONSTRAINT "issue_interruptions_kind_check" CHECK ("issue_interruptions"."kind" in ('board_interrupt', 'scheduled_retry_supersession')),
	CONSTRAINT "issue_interruptions_state_check" CHECK ("issue_interruptions"."state" in ('pending', 'completed')),
	CONSTRAINT "issue_interruptions_outcome_check" CHECK ("issue_interruptions"."outcome" is null or "issue_interruptions"."outcome" in ('continuation_queued', 'no_continuation_needed', 'blocked_escalation_required')),
	CONSTRAINT "issue_interruptions_pending_outcome_pairing_check" CHECK (("issue_interruptions"."state" = 'pending' and "issue_interruptions"."outcome" is null and "issue_interruptions"."continuation_run_id" is null)
        or ("issue_interruptions"."state" = 'completed' and "issue_interruptions"."outcome" is not null)),
	CONSTRAINT "issue_interruptions_continuation_pairing_check" CHECK (("issue_interruptions"."outcome" = 'continuation_queued') = ("issue_interruptions"."continuation_run_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "issue_interruptions" ADD CONSTRAINT "issue_interruptions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_interruptions" ADD CONSTRAINT "issue_interruptions_cancelled_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("cancelled_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_interruptions" ADD CONSTRAINT "issue_interruptions_continuation_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("continuation_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_interruptions" ADD CONSTRAINT "issue_interruptions_company_issue_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_interruptions_pending_created_idx" ON "issue_interruptions" USING btree ("created_at") WHERE "issue_interruptions"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "issue_interruptions_company_issue_idx" ON "issue_interruptions" USING btree ("company_id","issue_id");