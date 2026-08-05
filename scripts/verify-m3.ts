// M3 acceptance. `make verify-m3` is the definition of done.
//
// Runs against a stack that has had `make demo-reset && make map-estate`.
//
// map-estate is 28 live model runs and is deliberately a separate command: this gate
// asserts the persisted result plus three live probes it runs itself, so it stays fast
// enough to re-run and cheap enough to re-run often.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = `http://127.0.0.1:${process.env.PARITY_API_PORT ?? 3200}`;
const PG_URL = process.env.PARITY_PG_URL ?? 'postgres://parity:parity@127.0.0.1:5433/parity';

/** The six sections extract-spec is required to produce, in Czech. */
const SPEC_HEADINGS = ['## Účel', '## Vstupy', '## Chování', '## Invarianty', '## Data, kterých se dotýká', '## Otevřené otázky'];

let failures = 0;
let checks = 0;

function check(ok: boolean, label: string, detail = ''): void {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
}
const section = (t: string): void => console.log(`\n${t}`);

const getJson = async <T>(path: string): Promise<T> => {
  const response = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return (await response.json()) as T;
};

/** Run one of the API's CLI probes inside the container and parse its JSON. */
async function probe(script: string, timeoutMs = 300_000): Promise<Record<string, unknown>> {
  const { stdout } = await exec('docker', ['compose', 'exec', '-T', 'parity-api', 'npx', 'tsx', script], {
    cwd: ROOT,
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
  const start = stdout.indexOf('{');
  if (start < 0) throw new Error(`no JSON from ${script}: ${stdout.slice(0, 400)}`);
  return JSON.parse(stdout.slice(start)) as Record<string, unknown>;
}

interface Expected {
  expected: Record<string, { oracleClass: string; riskClass: string; requiresSeam?: boolean }>;
}

async function main(): Promise<void> {
  console.log('M3 acceptance — agent, skills, spec');

  const client = new pg.Client({ connectionString: PG_URL });
  await client.connect();

  try {
    // --- 1. the agent is wired ---------------------------------------------------
    section('Agent runtime');
    const runtime = await getJson<{ provider: string; agentReady: boolean; agentBlockedReason: string | null; lastModelUsed: string | null }>(
      '/api/runtime',
    );
    check(runtime.agentReady, 'ANTHROPIC_API_KEY is configured', runtime.agentBlockedReason ?? '');
    check(runtime.lastModelUsed !== null, 'the badge reports a model actually used, not a configured one', runtime.lastModelUsed ?? '—');

    // --- 2. skills are real files the SDK loads ----------------------------------
    section('Skills are real files');
    const skills = await getJson<{ skillsDir: string; skills: { name: string; description: string; model: string }[] }>('/api/skills');
    check(skills.skills.length === 5, 'five skills listed from disk', skills.skills.map((s) => s.name).join(', '));
    check(
      skills.skills.every((s) => s.description !== ''),
      'every skill has a description parsed from its front matter',
    );
    check(
      skills.skills.some((s) => s.model.includes('sonnet')) && skills.skills.some((s) => s.model.includes('opus')),
      'model is set per skill — cheap model for volume, best model for the hard thing',
      skills.skills.map((s) => `${s.name}=${s.model}`).join(' '),
    );

    // The SDK reports which skills it actually loaded. Asserting that beats inferring it
    // from the fact that a run produced output.
    const workspace = await probe('src/cli/probe-workspace.ts', 60_000);
    const containment = workspace.containment as Record<string, boolean>;
    const linked = workspace.linked as { name: string; isSymlink: boolean; skillMdReadable: boolean }[];
    check(
      linked.length === 5 && linked.every((l) => l.isSymlink && l.skillMdReadable),
      'skills are symlinked into the run workspace, not copied',
      'editing one file changes the next run',
    );

    // --- 3. containment ----------------------------------------------------------
    section('The agent cannot reach the answer key');
    check(containment.workspaceOutsideApp, 'run workspace is outside the application directory');
    check(!containment.docsPresent, 'docs/ is not mounted into the container the agent runs in');
    check(!containment.claudeAboveWorkspace && !containment.appClaudePresent, 'no .claude above the workspace to inherit settings from');

    const live = await probe('src/cli/probe-containment.ts');
    check(!(live.sentinelPresent as boolean), 'a live agent asked to read docs/SPEC.md does not come back with its contents');
    check(
      (live.skillsLoaded as string[]).includes('triage'),
      'the SDK reports the skill as loaded',
      (live.skillsLoaded as string[]).join(', '),
    );

    // --- 4. triage classified all fourteen ---------------------------------------
    section('Triage classified the estate');
    const answerKey = JSON.parse(await readFile(join(ROOT, 'scripts', 'm3-expected-classes.json'), 'utf8')) as Expected;
    const { rows: classified } = await client.query<{
      name: string;
      oracle_class: string | null;
      risk_class: string | null;
      seam_requirements: string | null;
    }>('SELECT name, oracle_class, risk_class, seam_requirements FROM procedures ORDER BY name');

    check(classified.length === 14, 'all 14 procedures present', `${classified.length}`);
    check(
      classified.every((r) => r.oracle_class !== null),
      'every procedure has an oracle_class',
      classified.filter((r) => r.oracle_class === null).map((r) => r.name).join(', '),
    );

    const wrong = classified.filter((r) => answerKey.expected[r.name]?.oracleClass !== r.oracle_class);
    check(
      wrong.length === 0,
      'every oracle_class matches the committed expectation',
      wrong.map((r) => `${r.name}: got ${r.oracle_class}, expected ${answerKey.expected[r.name]?.oracleClass}`).join('; '),
    );

    const missingSeam = classified.filter(
      (r) => answerKey.expected[r.name]?.requiresSeam === true && (r.seam_requirements ?? '').trim() === '',
    );
    check(
      missingSeam.length === 0,
      'every nondet and external procedure names what would have to be injected',
      missingSeam.map((r) => r.name).join(', '),
    );

    const [calc] = classified.filter((r) => r.name === 'sp_CalculateOrderTotal');
    check(
      /hodin|clock|GETDATE|čas/i.test(calc?.seam_requirements ?? ''),
      'the migration target names the clock as its seam',
      (calc?.seam_requirements ?? '').slice(0, 120),
    );

    // --- 5. specs ----------------------------------------------------------------
    section('Specifications');
    const { rows: specRows } = await client.query<{ name: string; markdown: string }>(
      'SELECT p.name, s.markdown FROM specs s JOIN procedures p ON p.id = s.procedure_id ORDER BY p.name',
    );
    check(specRows.length === 14, 'every procedure has a Spec', `${specRows.length} of 14`);

    const badStructure = specRows.filter((r) => SPEC_HEADINGS.some((h) => !r.markdown.includes(h)));
    check(
      badStructure.length === 0,
      'every spec carries all six required Czech sections',
      badStructure.map((r) => r.name).join(', '),
    );

    // The skill says an empty Otevřené otázky usually means the reading was shallow.
    const emptyQuestions = specRows.filter((r) => {
      const tail = r.markdown.slice(r.markdown.indexOf('## Otevřené otázky') + 18).trim();
      return tail.length < 40;
    });
    check(
      emptyQuestions.length === 0,
      'every spec has a non-empty Otevřené otázky section',
      emptyQuestions.map((r) => r.name).join(', '),
    );

    // --- 6. the audit log falls out of the hooks ---------------------------------
    section('Audit log');
    const { rows: auditRows } = await client.query<{ run_id: string; tool_uses: number; audit_rows: number }>(`
      SELECT r.run_id,
             (SELECT COUNT(*)::int FROM agent_steps s WHERE s.agent_run_id = r.id AND s.kind = 'tool_use') AS tool_uses,
             (SELECT COUNT(*)::int FROM audit_entries a WHERE a.agent_run_id = r.id AND a.outcome = 'allowed') AS audit_rows
      FROM agent_runs r WHERE r.status <> 'failed'`);
    check(auditRows.length > 0, 'agent runs are recorded', `${auditRows.length} runs`);
    const unlogged = auditRows.filter((r) => r.audit_rows < r.tool_uses);
    check(
      unlogged.length === 0,
      'every tool call has an audit row',
      unlogged.map((r) => `${r.run_id}: ${r.audit_rows} rows for ${r.tool_uses} calls`).join('; '),
    );

    // --- 7. policy is enforced by the hook, not by the prompt --------------------
    section('Policy gate');
    const { rows: policyRows } = await client.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM policy_rules');
    check(policyRows[0].n > 0, 'the autonomy-tier table has rules', `${policyRows[0].n} rules`);

    const overTier = await probe('src/cli/probe-policy.ts');
    check(overTier.blocked === true, 'a deliberately over-tier tool call is refused by the PreToolUse hook');
    check(
      (overTier.specWritten as boolean) === false,
      'the blocked call had no effect — no Spec was written by the triage run',
    );
    const { rows: blockedRows } = await client.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM audit_entries WHERE outcome = 'blocked'",
    );
    check(blockedRows[0].n > 0, 'the refusal is in the audit log', `${blockedRows[0].n} blocked entries`);

    // --- 8. replayability precondition ------------------------------------------
    section('Runs are recorded well enough to replay');
    const { rows: incomplete } = await client.query<{ run_id: string }>(`
      SELECT run_id FROM agent_runs
      WHERE status = 'succeeded'
        AND (model IS NULL OR output IS NULL OR started_at IS NULL OR finished_at IS NULL
             OR input_tokens IS NULL OR output_tokens IS NULL OR cost_usd IS NULL)`);
    check(
      incomplete.length === 0,
      'every successful run persists model, output, timings and usage',
      incomplete.map((r) => r.run_id).join(', '),
    );

    // --- 9. M2's numbers are unmoved ---------------------------------------------
    section('M2 is undisturbed');
    const estate = await getJson<{ totals: { procedures: number; invocations90d: number; coverage: number } }>('/api/estate');
    check(estate.totals.procedures === 14, 'still 14 procedures', `${estate.totals.procedures}`);
    check(estate.totals.invocations90d > 40_000, 'invocation counts unchanged', `${estate.totals.invocations90d}`);
    // Triage sets classes, not oracle state. Coverage moves at M4, not here.
    check(estate.totals.coverage === 0, 'coverage is still zero — triage classifies, it does not verify');
  } finally {
    await client.end();
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
