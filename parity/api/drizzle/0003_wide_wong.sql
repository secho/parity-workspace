CREATE TABLE "decisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"procedure_id" integer NOT NULL,
	"shadow_run_id" integer NOT NULL,
	"diff_signature" text NOT NULL,
	"action" text NOT NULL,
	"note" text,
	"decided_by" text DEFAULT 'human' NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_run_id" integer,
	CONSTRAINT "uq_decision_signature" UNIQUE("shadow_run_id","diff_signature")
);
--> statement-breakpoint
CREATE TABLE "diffs" (
	"id" serial PRIMARY KEY NOT NULL,
	"shadow_run_id" integer NOT NULL,
	"shadow_case_id" integer NOT NULL,
	"scope" text NOT NULL,
	"table_name" text,
	"column_name" text,
	"rows_affected" integer DEFAULT 1 NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"signature" text NOT NULL,
	"canonical_equal" boolean NOT NULL,
	"verdict" text,
	"verdict_source" text,
	"noise_reason" text,
	"explanation_cs" text,
	"agent_run_id" integer
);
--> statement-breakpoint
CREATE TABLE "shadow_cases" (
	"id" serial PRIMARY KEY NOT NULL,
	"shadow_run_id" integer NOT NULL,
	"seq" integer NOT NULL,
	"source_invocation_id" bigint NOT NULL,
	"branch_key" text,
	"stratum" text NOT NULL,
	"input_params" jsonb NOT NULL,
	"equal" boolean DEFAULT false NOT NULL,
	"old_fingerprint" text NOT NULL,
	"new_fingerprint" text NOT NULL,
	"old_outcome" jsonb,
	"new_outcome" jsonb,
	"old_normalisations" jsonb,
	"new_normalisations" jsonb,
	"old_error" text,
	"new_error" text,
	"old_ms" integer,
	"new_ms" integer,
	CONSTRAINT "uq_shadow_case_seq" UNIQUE("shadow_run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "shadow_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"procedure_id" integer NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"implementation" text NOT NULL,
	"kind" text DEFAULT 'shadow' NOT NULL,
	"shadow_database" text NOT NULL,
	"cases_planned" integer DEFAULT 0 NOT NULL,
	"cases_replayed" integer DEFAULT 0 NOT NULL,
	"strata_covered" integer DEFAULT 0 NOT NULL,
	"strata_observed" integer DEFAULT 0 NOT NULL,
	"raw_diffs" integer DEFAULT 0 NOT NULL,
	"noise_diffs" integer DEFAULT 0 NOT NULL,
	"behaviour_diffs" integer DEFAULT 0 NOT NULL,
	"replay_ms" integer,
	"duration_ms" integer,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_procedure_id_procedures_id_fk" FOREIGN KEY ("procedure_id") REFERENCES "public"."procedures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_shadow_run_id_shadow_runs_id_fk" FOREIGN KEY ("shadow_run_id") REFERENCES "public"."shadow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diffs" ADD CONSTRAINT "diffs_shadow_run_id_shadow_runs_id_fk" FOREIGN KEY ("shadow_run_id") REFERENCES "public"."shadow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diffs" ADD CONSTRAINT "diffs_shadow_case_id_shadow_cases_id_fk" FOREIGN KEY ("shadow_case_id") REFERENCES "public"."shadow_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diffs" ADD CONSTRAINT "diffs_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_cases" ADD CONSTRAINT "shadow_cases_shadow_run_id_shadow_runs_id_fk" FOREIGN KEY ("shadow_run_id") REFERENCES "public"."shadow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_runs" ADD CONSTRAINT "shadow_runs_procedure_id_procedures_id_fk" FOREIGN KEY ("procedure_id") REFERENCES "public"."procedures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_diffs_run" ON "diffs" USING btree ("shadow_run_id");--> statement-breakpoint
CREATE INDEX "ix_diffs_signature" ON "diffs" USING btree ("shadow_run_id","signature");--> statement-breakpoint
CREATE INDEX "ix_shadow_cases_run" ON "shadow_cases" USING btree ("shadow_run_id");--> statement-breakpoint
CREATE INDEX "ix_shadow_runs_proc" ON "shadow_runs" USING btree ("procedure_id");