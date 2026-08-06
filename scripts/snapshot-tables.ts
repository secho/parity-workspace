/**
 * What the recorded golden run covers.
 *
 * Exactly the tables `resetState()` empties — the seventeen it names plus the three it reaches
 * by CASCADE. Not a superset and not a subset: a table in the reset but not the snapshot is
 * state the demo cannot get back, and a table in the snapshot but not the reset is state that
 * survives a reset and would be restored on top of itself.
 *
 * `policy_rules` is deliberately absent from both. It is configuration, reasserted on every boot
 * by `seedPolicy`, and snapshotting it would make the tier table a thing that could drift from
 * the repository.
 *
 * In its own file so that `verify-m7` can import it without executing `golden.ts`, whose body is
 * a command-line dispatch. The gate cross-checks this list **empirically** — it truncates what
 * the reset truncates inside a transaction it rolls back, and requires the set of tables left
 * holding rows to be exactly `policy_rules` — so the two cannot drift apart in silence.
 */
export const SNAPSHOT_TABLES = [
  'procedures',
  'procedure_columns',
  'procedure_calls',
  'coupling_edges',
  'specs',
  'agent_runs',
  'agent_steps',
  'audit_entries',
  'golden_tests',
  'invariants',
  'oracle_runs',
  'golden_results',
  'invariant_results',
  'shadow_runs',
  'shadow_cases',
  'diffs',
  'decisions',
  'service_artifacts',
  'pull_requests',
  'campaign_runs',
] as const;
