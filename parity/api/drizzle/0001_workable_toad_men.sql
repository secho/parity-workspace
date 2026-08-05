CREATE TABLE "agent_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"skill" text NOT NULL,
	"task_class" text NOT NULL,
	"procedure_id" integer,
	"status" text DEFAULT 'running' NOT NULL,
	"model" text,
	"provider" text,
	"prompt" text NOT NULL,
	"output" text,
	"error" text,
	"num_turns" integer,
	"cost_usd" numeric(12, 6),
	"input_tokens" integer,
	"output_tokens" integer,
	"duration_ms" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "agent_runs_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
CREATE TABLE "agent_steps" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_run_id" integer NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"tool_name" text,
	"text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_agent_step_seq" UNIQUE("agent_run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "audit_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_run_id" integer NOT NULL,
	"seq" integer NOT NULL,
	"tool_name" text NOT NULL,
	"input_summary" text,
	"result_summary" text,
	"duration_ms" integer,
	"outcome" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_class" text NOT NULL,
	"tool_name" text NOT NULL,
	"tier" integer NOT NULL,
	"requires_human" boolean DEFAULT false NOT NULL,
	"note" text,
	CONSTRAINT "uq_policy_rule" UNIQUE("task_class","tool_name")
);
--> statement-breakpoint
CREATE TABLE "specs" (
	"id" serial PRIMARY KEY NOT NULL,
	"procedure_id" integer NOT NULL,
	"markdown" text NOT NULL,
	"model" text,
	"agent_run_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "specs_procedure_id_unique" UNIQUE("procedure_id")
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_procedure_id_procedures_id_fk" FOREIGN KEY ("procedure_id") REFERENCES "public"."procedures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_entries" ADD CONSTRAINT "audit_entries_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specs" ADD CONSTRAINT "specs_procedure_id_procedures_id_fk" FOREIGN KEY ("procedure_id") REFERENCES "public"."procedures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specs" ADD CONSTRAINT "specs_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_agent_runs_procedure" ON "agent_runs" USING btree ("procedure_id");--> statement-breakpoint
CREATE INDEX "ix_audit_run" ON "audit_entries" USING btree ("agent_run_id");