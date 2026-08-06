CREATE TABLE "golden_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"oracle_run_id" integer NOT NULL,
	"golden_test_id" integer NOT NULL,
	"status" text NOT NULL,
	"detail" text,
	"duration_ms" integer,
	CONSTRAINT "uq_golden_result" UNIQUE("oracle_run_id","golden_test_id")
);
--> statement-breakpoint
CREATE TABLE "golden_tests" (
	"id" serial PRIMARY KEY NOT NULL,
	"procedure_id" integer NOT NULL,
	"name" text NOT NULL,
	"branch_key" text,
	"source_invocation_id" bigint NOT NULL,
	"input_params" jsonb NOT NULL,
	"captured_context" jsonb,
	"baseline_context" jsonb,
	"expected_result" jsonb NOT NULL,
	"expected_write_set" jsonb NOT NULL,
	"normalisations" jsonb NOT NULL,
	"rationale" text,
	"agent_run_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_golden_test_name" UNIQUE("procedure_id","name")
);
--> statement-breakpoint
CREATE TABLE "invariant_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"oracle_run_id" integer NOT NULL,
	"invariant_id" integer NOT NULL,
	"cases_checked" integer DEFAULT 0 NOT NULL,
	"cases_violated" integer DEFAULT 0 NOT NULL,
	"first_violation" text,
	CONSTRAINT "uq_invariant_result" UNIQUE("oracle_run_id","invariant_id")
);
--> statement-breakpoint
CREATE TABLE "invariants" (
	"id" serial PRIMARY KEY NOT NULL,
	"procedure_id" integer NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"spec" jsonb NOT NULL,
	"rationale" text,
	"evaluable" boolean DEFAULT true NOT NULL,
	"agent_run_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_invariant_name" UNIQUE("procedure_id","name")
);
--> statement-breakpoint
CREATE TABLE "oracle_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"procedure_id" integer NOT NULL,
	"kind" text NOT NULL,
	"golden_passed" integer DEFAULT 0 NOT NULL,
	"golden_failed" integer DEFAULT 0 NOT NULL,
	"invariants_checked" integer DEFAULT 0 NOT NULL,
	"invariants_violated" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "golden_results" ADD CONSTRAINT "golden_results_oracle_run_id_oracle_runs_id_fk" FOREIGN KEY ("oracle_run_id") REFERENCES "public"."oracle_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "golden_results" ADD CONSTRAINT "golden_results_golden_test_id_golden_tests_id_fk" FOREIGN KEY ("golden_test_id") REFERENCES "public"."golden_tests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "golden_tests" ADD CONSTRAINT "golden_tests_procedure_id_procedures_id_fk" FOREIGN KEY ("procedure_id") REFERENCES "public"."procedures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "golden_tests" ADD CONSTRAINT "golden_tests_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invariant_results" ADD CONSTRAINT "invariant_results_oracle_run_id_oracle_runs_id_fk" FOREIGN KEY ("oracle_run_id") REFERENCES "public"."oracle_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invariant_results" ADD CONSTRAINT "invariant_results_invariant_id_invariants_id_fk" FOREIGN KEY ("invariant_id") REFERENCES "public"."invariants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invariants" ADD CONSTRAINT "invariants_procedure_id_procedures_id_fk" FOREIGN KEY ("procedure_id") REFERENCES "public"."procedures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invariants" ADD CONSTRAINT "invariants_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oracle_runs" ADD CONSTRAINT "oracle_runs_procedure_id_procedures_id_fk" FOREIGN KEY ("procedure_id") REFERENCES "public"."procedures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_golden_tests_proc" ON "golden_tests" USING btree ("procedure_id");--> statement-breakpoint
CREATE INDEX "ix_invariants_proc" ON "invariants" USING btree ("procedure_id");--> statement-breakpoint
CREATE INDEX "ix_oracle_runs_proc" ON "oracle_runs" USING btree ("procedure_id");