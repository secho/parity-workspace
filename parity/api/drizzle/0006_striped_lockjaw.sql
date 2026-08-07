ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_replayed_from_agent_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "shadow_runs" DROP CONSTRAINT "shadow_runs_replayed_from_shadow_runs_id_fk";
