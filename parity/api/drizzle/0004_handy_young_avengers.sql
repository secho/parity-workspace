CREATE TABLE "pull_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"procedure_id" integer NOT NULL,
	"status" text DEFAULT 'assembled' NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"base_branch" text NOT NULL,
	"branch" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"files" jsonb NOT NULL,
	"artifact_hash" text NOT NULL,
	"number" integer,
	"url" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_at" timestamp with time zone,
	CONSTRAINT "uq_pull_request_artifact" UNIQUE("procedure_id","artifact_hash")
);
--> statement-breakpoint
CREATE TABLE "service_artifacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"procedure_id" integer NOT NULL,
	"agent_run_id" integer,
	"path" text NOT NULL,
	"contents" text NOT NULL,
	"sha256" text NOT NULL,
	"run_hash" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_service_artifact_path" UNIQUE("procedure_id","attempt","path")
);
--> statement-breakpoint
ALTER TABLE "oracle_runs" ADD COLUMN "target" text DEFAULT 'procedure' NOT NULL;--> statement-breakpoint
ALTER TABLE "shadow_runs" ADD COLUMN "implementation_id" text DEFAULT 'reference' NOT NULL;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_procedure_id_procedures_id_fk" FOREIGN KEY ("procedure_id") REFERENCES "public"."procedures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_artifacts" ADD CONSTRAINT "service_artifacts_procedure_id_procedures_id_fk" FOREIGN KEY ("procedure_id") REFERENCES "public"."procedures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_artifacts" ADD CONSTRAINT "service_artifacts_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_pull_requests_proc" ON "pull_requests" USING btree ("procedure_id");--> statement-breakpoint
CREATE INDEX "ix_service_artifacts_proc" ON "service_artifacts" USING btree ("procedure_id");