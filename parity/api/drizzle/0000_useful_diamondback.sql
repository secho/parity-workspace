CREATE TABLE "coupling_edges" (
	"id" serial PRIMARY KEY NOT NULL,
	"table_name" text NOT NULL,
	"column_name" text NOT NULL,
	"a_procedure_id" integer NOT NULL,
	"b_procedure_id" integer NOT NULL,
	CONSTRAINT "uq_coupling_edge" UNIQUE("table_name","column_name","a_procedure_id","b_procedure_id")
);
--> statement-breakpoint
CREATE TABLE "procedure_calls" (
	"id" serial PRIMARY KEY NOT NULL,
	"caller_id" integer NOT NULL,
	"callee_id" integer NOT NULL,
	CONSTRAINT "uq_procedure_call" UNIQUE("caller_id","callee_id")
);
--> statement-breakpoint
CREATE TABLE "procedure_columns" (
	"id" serial PRIMARY KEY NOT NULL,
	"procedure_id" integer NOT NULL,
	"table_name" text NOT NULL,
	"column_name" text NOT NULL,
	"access" text NOT NULL,
	"is_write_owner" boolean DEFAULT false NOT NULL,
	"inferred" boolean DEFAULT false NOT NULL,
	CONSTRAINT "uq_procedure_column" UNIQUE("procedure_id","table_name","column_name","access")
);
--> statement-breakpoint
CREATE TABLE "procedures" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"schema_name" text NOT NULL,
	"source_sql" text NOT NULL,
	"line_count" integer NOT NULL,
	"domain" text,
	"invocations_90d" integer DEFAULT 0 NOT NULL,
	"last_invoked_at" timestamp with time zone,
	"oracle_class" text,
	"oracle_state" text DEFAULT 'none' NOT NULL,
	"campaign_status" text DEFAULT 'untouched' NOT NULL,
	"owner_team" text,
	"risk_class" text,
	"seam_requirements" text,
	"uses_dynamic_sql" boolean DEFAULT false NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "procedures_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "coupling_edges" ADD CONSTRAINT "coupling_edges_a_procedure_id_procedures_id_fk" FOREIGN KEY ("a_procedure_id") REFERENCES "public"."procedures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupling_edges" ADD CONSTRAINT "coupling_edges_b_procedure_id_procedures_id_fk" FOREIGN KEY ("b_procedure_id") REFERENCES "public"."procedures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedure_calls" ADD CONSTRAINT "procedure_calls_caller_id_procedures_id_fk" FOREIGN KEY ("caller_id") REFERENCES "public"."procedures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedure_calls" ADD CONSTRAINT "procedure_calls_callee_id_procedures_id_fk" FOREIGN KEY ("callee_id") REFERENCES "public"."procedures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedure_columns" ADD CONSTRAINT "procedure_columns_procedure_id_procedures_id_fk" FOREIGN KEY ("procedure_id") REFERENCES "public"."procedures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_procedure_columns_target" ON "procedure_columns" USING btree ("table_name","column_name","access");--> statement-breakpoint
CREATE INDEX "ix_procedures_invocations" ON "procedures" USING btree ("invocations_90d");