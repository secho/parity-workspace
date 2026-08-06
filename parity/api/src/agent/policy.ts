import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { policyRules } from '../db/schema.js';

/**
 * Autonomy tiers, per task class.
 *
 * The point of putting this in a table rather than in a prompt is that a prompt is a
 * request and a table is a rule. The `PreToolUse` hook reads these rows and refuses a call
 * above the tier for the running task class — the model does not get a vote, and neither
 * does a cleverly-worded instruction that reached the agent through a procedure comment.
 *
 * Tier 1 proceeds. Tier 2 proceeds and is recorded prominently. Tier 3 stops and goes to
 * a human. `verify-m3` fires a deliberate over-tier call and asserts it is refused.
 */

export interface Tier {
  tier: number;
  requiresHuman: boolean;
  note: string | null;
}

export const DEFAULT_POLICY: { taskClass: string; toolName: string; tier: number; requiresHuman: boolean; note: string }[] = [
  // Triage reads and classifies. It writes one thing: the classification itself.
  { taskClass: 'triage', toolName: 'mcp__parity__read_procedure', tier: 1, requiresHuman: false, note: 'čtení zdroje procedury' },
  { taskClass: 'triage', toolName: 'mcp__parity__query_capture', tier: 1, requiresHuman: false, note: 'čtení zachyceného provozu' },
  { taskClass: 'triage', toolName: 'mcp__parity__write_triage', tier: 2, requiresHuman: false, note: 'zápis klasifikace' },
  // Writing a spec is not triage's job. Attempting it is the over-tier case the gate probes.
  { taskClass: 'triage', toolName: 'mcp__parity__write_spec', tier: 3, requiresHuman: true, note: 'mimo rozsah triage' },

  { taskClass: 'spec', toolName: 'mcp__parity__read_procedure', tier: 1, requiresHuman: false, note: 'čtení zdroje procedury' },
  { taskClass: 'spec', toolName: 'mcp__parity__query_capture', tier: 1, requiresHuman: false, note: 'čtení zachyceného provozu' },
  { taskClass: 'spec', toolName: 'mcp__parity__write_spec', tier: 2, requiresHuman: false, note: 'zápis specifikace' },
  { taskClass: 'spec', toolName: 'mcp__parity__write_triage', tier: 3, requiresHuman: true, note: 'mimo rozsah extract-spec' },

  // Building an oracle reads the source, the traffic and the candidate cases, and writes two
  // things: the chosen cases and the invariants. It may not reclassify the procedure and it
  // may not rewrite the spec — an oracle that could edit the specification it is being
  // measured against would be marking its own homework.
  { taskClass: 'oracle', toolName: 'mcp__parity__read_procedure', tier: 1, requiresHuman: false, note: 'čtení zdroje procedury' },
  { taskClass: 'oracle', toolName: 'mcp__parity__query_capture', tier: 1, requiresHuman: false, note: 'čtení zachyceného provozu' },
  { taskClass: 'oracle', toolName: 'mcp__parity__list_capture_cases', tier: 1, requiresHuman: false, note: 'kandidátní případy z provozu' },
  { taskClass: 'oracle', toolName: 'mcp__parity__write_golden_tests', tier: 2, requiresHuman: false, note: 'zápis golden testů' },
  { taskClass: 'oracle', toolName: 'mcp__parity__write_invariants', tier: 2, requiresHuman: false, note: 'zápis invariantů' },
  { taskClass: 'oracle', toolName: 'mcp__parity__write_triage', tier: 3, requiresHuman: true, note: 'mimo rozsah generate-oracle' },
  { taskClass: 'oracle', toolName: 'mcp__parity__write_spec', tier: 3, requiresHuman: true, note: 'mimo rozsah generate-oracle' },

  // Classifying a difference is a judgement about one finding and nothing more. It may read
  // the procedure to understand what it is looking at, and it may record the verdict.
  //
  // It may NOT record a decision. That rule is the decision queue: the one thing an agent
  // must never do is decide, on a person's behalf, that changed behaviour is acceptable — so
  // `record_decision` is tier 3 here, the hook refuses it, and the finding goes to a human.
  // The tool is fully implemented, which is what makes the refusal mean something.
  //
  // It may not run a shadow run either. A classifier that could re-run the experiment it is
  // being asked about could keep going until it liked the answer.
  { taskClass: 'diff', toolName: 'mcp__parity__read_procedure', tier: 1, requiresHuman: false, note: 'čtení zdroje procedury' },
  { taskClass: 'diff', toolName: 'mcp__parity__query_capture', tier: 1, requiresHuman: false, note: 'čtení zachyceného provozu' },
  { taskClass: 'diff', toolName: 'mcp__parity__classify_diff', tier: 2, requiresHuman: false, note: 'zápis verdiktu nad odchylkou' },
  { taskClass: 'diff', toolName: 'mcp__parity__run_shadow', tier: 3, requiresHuman: true, note: 'mimo rozsah classify-diff' },
  { taskClass: 'diff', toolName: 'mcp__parity__record_decision', tier: 3, requiresHuman: true, note: 'o změně chování rozhoduje člověk' },

  // Writing the replacement reads everything that describes the behaviour it must reproduce —
  // the source, the traffic, the spec, the invariants — and writes one thing: the service's
  // own source, through a tool that validates every path against a closed allowlist.
  //
  // It may NOT read the golden tests' recorded expectations. There is no tool that returns
  // them, and there is no rule here that could permit one: an implementation fitted to the
  // oracle is not measured by it. The agent gets the case *names* and the branches they
  // cover, which is a description of the job, not the answer to it.
  //
  // It may not re-run the shadow harness, for the same reason `classify-diff` may not — an
  // implementer that could re-run the experiment it is being judged by could keep going until
  // it liked the answer. Parity runs it, once per attempt, and feeds the result back.
  { taskClass: 'service', toolName: 'mcp__parity__read_procedure', tier: 1, requiresHuman: false, note: 'čtení zdroje procedury' },
  { taskClass: 'service', toolName: 'mcp__parity__query_capture', tier: 1, requiresHuman: false, note: 'čtení zachyceného provozu' },
  { taskClass: 'service', toolName: 'mcp__parity__read_spec', tier: 1, requiresHuman: false, note: 'čtení specifikace' },
  { taskClass: 'service', toolName: 'mcp__parity__write_service_file', tier: 2, requiresHuman: false, note: 'zápis zdroje služby' },
  { taskClass: 'service', toolName: 'mcp__parity__write_spec', tier: 3, requiresHuman: true, note: 'mimo rozsah implement-service' },
  { taskClass: 'service', toolName: 'mcp__parity__write_triage', tier: 3, requiresHuman: true, note: 'mimo rozsah implement-service' },
  { taskClass: 'service', toolName: 'mcp__parity__write_golden_tests', tier: 3, requiresHuman: true, note: 'implementace si nepíše vlastní testy' },
  { taskClass: 'service', toolName: 'mcp__parity__run_shadow', tier: 3, requiresHuman: true, note: 'shadow run spouští platforma, ne implementace' },
  { taskClass: 'service', toolName: 'mcp__parity__record_decision', tier: 3, requiresHuman: true, note: 'o změně chování rozhoduje člověk' },

  // Nothing opens a PR without a person. The tool is fully implemented at M6 — that is what
  // makes the refusal mean something, the same argument `record_decision` has carried since
  // M5 — and `probe-pr` provokes it live rather than reading the table back.
  { taskClass: 'triage', toolName: 'mcp__parity__open_pr', tier: 3, requiresHuman: true, note: 'PR vždy přes člověka' },
  { taskClass: 'spec', toolName: 'mcp__parity__open_pr', tier: 3, requiresHuman: true, note: 'PR vždy přes člověka' },
  { taskClass: 'oracle', toolName: 'mcp__parity__open_pr', tier: 3, requiresHuman: true, note: 'PR vždy přes člověka' },
  { taskClass: 'diff', toolName: 'mcp__parity__open_pr', tier: 3, requiresHuman: true, note: 'PR vždy přes člověka' },
  { taskClass: 'service', toolName: 'mcp__parity__open_pr', tier: 3, requiresHuman: true, note: 'PR vždy přes člověka' },
];

export async function seedPolicy(db: Db): Promise<void> {
  for (const rule of DEFAULT_POLICY) {
    await db
      .insert(policyRules)
      .values(rule)
      .onConflictDoUpdate({
        target: [policyRules.taskClass, policyRules.toolName],
        set: { tier: rule.tier, requiresHuman: rule.requiresHuman, note: rule.note },
      });
  }
}

export async function loadPolicy(db: Db, taskClass: string): Promise<Map<string, Tier>> {
  const rows = await db.select().from(policyRules).where(eq(policyRules.taskClass, taskClass));
  return new Map(rows.map((r) => [r.toolName, { tier: r.tier, requiresHuman: r.requiresHuman, note: r.note }]));
}

/**
 * The decision the hook enforces. A tool with no rule for this task class is refused
 * rather than allowed: an unlisted tool is one nobody thought about, and defaulting an
 * unconsidered capability to "yes" is how autonomy stops meaning anything.
 */
export function decide(policy: Map<string, Tier>, toolName: string): { allow: boolean; reason: string } {
  // The SDK's own file tools are already constrained by allowedTools and the workspace;
  // the tier table governs what Parity itself exposes.
  if (!toolName.startsWith('mcp__parity__')) return { allow: true, reason: 'built-in tool, scoped by workspace' };

  const rule = policy.get(toolName);
  if (rule === undefined) return { allow: false, reason: `žádné pravidlo pro ${toolName} v této třídě úloh` };
  if (rule.requiresHuman) return { allow: false, reason: `tier ${rule.tier} — rozhoduje člověk${rule.note ? `: ${rule.note}` : ''}` };
  return { allow: true, reason: `tier ${rule.tier}` };
}
