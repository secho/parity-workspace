CREATE TABLE "campaign_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"campaign" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"target" text,
	"items" jsonb NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6),
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "pull_requests" ALTER COLUMN "procedure_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "replayed_from" integer;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "kind" text DEFAULT 'migration' NOT NULL;--> statement-breakpoint
ALTER TABLE "shadow_runs" ADD COLUMN "replayed_from" integer;--> statement-breakpoint
CREATE INDEX "ix_campaign_runs_campaign" ON "campaign_runs" USING btree ("campaign");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_replayed_from_agent_runs_id_fk" FOREIGN KEY ("replayed_from") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_runs" ADD CONSTRAINT "shadow_runs_replayed_from_shadow_runs_id_fk" FOREIGN KEY ("replayed_from") REFERENCES "public"."shadow_runs"("id") ON DELETE set null ON UPDATE no action;