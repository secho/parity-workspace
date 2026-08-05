# Parity — the platform

Ingests an estate, runs one agent over it, produces specs and oracles, shadow-runs replacements, opens PRs.

Scope: `../docs/SPEC.md` §4. Screens and choreography: `../docs/DEMO-SCRIPT.md`.

## Non-negotiables

- **Parity never imports the demo app's code.** It reaches it only over the database connection, the capture log and the GitHub API. That separation is the whole argument — it must look like something that could be pointed at Alza's real estate tomorrow.
- **`blocker` is derived**, computed from `oracle_class` + `oracle_state` + `domain`. Never stored, never editable. A stored blocker drifts and then lies on the main screen.
- **Canonicalise before classifying.** Normalise ordering, timestamps, GUIDs and float tolerance in code. Only what survives goes to the model. Asking the agent to classify raw noise burns tokens and produces different verdicts between runs.
- **Nothing on screen is mocked.** Absent is fine. Simulated is not.

## Agent

`@anthropic-ai/claude-agent-sdk`, TypeScript, `ANTHROPIC_API_KEY`.

- Skills are real files in `skills/`, loaded via `settingSources: ['project']` and listed in the UI. "Update one file, every run picks it up" must be literally true and demonstrable live.
- **Policy is enforced by a `PreToolUse` hook**, not by prompt wording. A tool call exceeding the autonomy tier for its task class is refused and the item lands in the decision queue.
- **The audit log falls out of `PostToolUse` hooks.** Nothing instrumented by hand.
- Custom tools via `tool()` + `createSdkMcpServer()`, in-process: `query_capture`, `read_procedure`, `write_spec`, `write_test`, `run_shadow`, `open_pr`, `record_decision`. File editing, reading and bash come from the SDK built-ins.
- Model per skill: Sonnet-class for bulk work across the estate, Opus-class for `implement-service` and ambiguous `classify-diff`. Visible in the UI — it is the same routing argument the deck makes.
- Always set `maxTurns` and an explicit permission posture. Never `bypassPermissions`.

## Visual direction

An ops console that would sit comfortably next to a LiteLLM admin UI. Left sidebar, dense tables, monospace for identifiers, muted surfaces, small text chips for status. The intended reaction is "this is another part of the stack we already run", not "this is a product being sold to us". No gradients, no marketing hero, no illustrations.

Sidebar: `Estate · Kampaně · Fronta · Provoz`. Persistent top-right badge showing provider and model actually in use.

All UI copy in Czech.
