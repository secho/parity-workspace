// M5 acceptance. `make verify-m5` is the definition of done.
//
// Runs against a stack that has had:
//   make demo-reset && make map-estate && make verify-m3 && make generate-oracles
//   && make verify-m4 && make shadow-db && make shadow-run
//
// `shadow-run` spends live model runs — one per finding — and is deliberately a separate
// command, like map-estate and generate-oracles before it. This gate asserts the persisted
// result plus the probes it runs itself, so it stays cheap enough to re-run.
//
// Gate order matters and keeps getting longer: verify-m3 asserts coverage is still zero,
// which stops being true once oracles exist; verify-m4 asserts oracle_state is golden or
// invariants, which stops being true once a shadow run promotes it to `shadow`.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import mssql from 'mssql';
import pg from 'pg';

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = `http://127.0.0.1:${process.env.PARITY_API_PORT ?? 3200}`;
const PG_URL = process.env.PARITY_PG_URL ?? 'postgres://parity:parity@127.0.0.1:5433/parity';

const MIGRATION_TARGET = 'sp_CalculateOrderTotal';
const ESTATE_DB = process.env.MSSQL_DATABASE ?? 'ParityShop';
const SHADOW_DB = process.env.MSSQL_SHADOW_DATABASE ?? 'ParityShop_Shadow';
const NEVER_EXECUTE = 'sp_SyncWarehouseDispatch';

/** The vocabulary the canonicaliser fires. Anything else in that column is a bug. */
const CANONICAL_REASONS = ['clock', 'identity', 'float', 'guid', 'ordering'];
/** The closed list `skills/classify-diff/SKILL.md` gives the model. */
const SKILL_REASONS = ['time', 'identifier', 'ordering', 'float_precision', 'unstable_collection'];
/** A money column is never noise — the skill says so, and this is where that is enforced. */
const MONEY = ['TotalNet', 'TotalVat', 'TotalWithVat', 'DiscountAmount', 'PromoDiscountAmount', 'LoyaltyDiscountAmount'];

let failures = 0;
let checks = 0;

function check(ok: boolean, label: string, detail = ''): void {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
}
const section = (t: string): void => console.log(`\n${t}`);
const note = (t: string): void => console.log(`        \x1b[2m${t}\x1b[0m`);

const getJson = async <T>(path: string): Promise<T> => {
  const response = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return (await response.json()) as T;
};

const send = async <T>(path: string, method: 'POST' | 'DELETE', body?: unknown): Promise<T> => {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return (await response.json()) as T;
};

async function probe(script: string, args: string[] = [], timeoutMs = 600_000): Promise<Record<string, unknown>> {
  const { stdout } = await exec('docker', ['compose', 'exec', '-T', 'parity-api', 'npx', 'tsx', script, ...args], {
    cwd: ROOT,
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
  const start = stdout.indexOf('{');
  if (start < 0) throw new Error(`no JSON from ${script}: ${stdout.slice(0, 400)}`);
  return JSON.parse(stdout.slice(start)) as Record<string, unknown>;
}

/** Key-sorted JSON, so two copies of the same object compare equal whatever ordered them. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(record[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const connectMssql = (user: string, password: string, database = ESTATE_DB): Promise<mssql.ConnectionPool> =>
  new mssql.ConnectionPool({
    server: process.env.MSSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MSSQL_PORT ?? 1433),
    database,
    user,
    password,
    options: { encrypt: true, trustServerCertificate: true, requestTimeout: 120_000 },
  }).connect();

/**
 * M0's fingerprint over the watched columns, per-row checksums summed, plus the row counts of
 * the tables the writing procedures INSERT into. Reused verbatim from `verify-m4`, because
 * "production is untouched" has to be measured the same way every milestone measures it.
 */
async function estateFingerprint(pool: mssql.ConnectionPool): Promise<string> {
  const query = await readFile(join(ROOT, 'scripts', 'seed-checksum.sql'), 'utf8');
  const result = await pool.request().query(query);
  const inserts = await pool.request().query(`
    SELECT (SELECT COUNT_BIG(*) FROM dbo.StockReservation) AS reservations,
           (SELECT COUNT_BIG(*) FROM dbo.StockMovement)    AS movements,
           (SELECT COUNT_BIG(*) FROM dbo.AuditTrail)       AS audit,
           (SELECT COUNT_BIG(*) FROM dbo.PromoRedemption)  AS redemptions`);
  return JSON.stringify({ ...result.recordset[0], ...inserts.recordset[0] });
}

interface QueueItem {
  signature: string;
  procedure: string;
  shadowRunId: number;
  cases: number;
  rowsAffected: number;
  explanationCs: string | null;
  columnName: string | null;
  decision: { action: string } | null;
}

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: PG_URL });
  await client.connect();
  const sa = await connectMssql('sa', process.env.MSSQL_SA_PASSWORD ?? 'ParityShop_Dev_2026!');

  try {
    // --- 1 ------------------------------------------------------------------
    section('M4 is undisturbed');

    const procedures = (
      await client.query<{ name: string; oracle_state: string; campaign_status: string; invocations_90d: number }>(
        'SELECT name, oracle_state, campaign_status, invocations_90d FROM procedures ORDER BY name',
      )
    ).rows;
    check(procedures.length === 14, 'fourteen procedures still ingested', `${procedures.length}`);

    const golden = (
      await client.query<{ n: string }>(
        'SELECT COUNT(DISTINCT procedure_id) AS n FROM golden_tests',
      )
    ).rows[0];
    check(Number(golden.n) >= 8, 'golden suites survive on at least 8 procedures', `${golden.n}`);

    const target = procedures.find((p) => p.name === MIGRATION_TARGET);
    check(target !== undefined, 'the migration target is in the estate');

    // --- 2 ------------------------------------------------------------------
    section('The shadow database is a separate, real copy');

    const copy = (
      await sa.request().query(`
        SELECT (SELECT COUNT(*) FROM sys.databases WHERE name = '${SHADOW_DB}') AS exists_,
               (SELECT COUNT(*) FROM sys.change_tracking_databases WHERE database_id = DB_ID('${SHADOW_DB}')) AS ct,
               (SELECT COUNT(*) FROM [${SHADOW_DB}].sys.change_tracking_tables) AS ctTables,
               (SELECT COUNT(*) FROM [${ESTATE_DB}].sys.change_tracking_tables) AS ctTablesEstate,
               (SELECT COUNT(*) FROM [${SHADOW_DB}].dbo.OrderLedger) AS lines,
               (SELECT COUNT(*) FROM [${ESTATE_DB}].dbo.OrderLedger) AS linesEstate,
               (SELECT COUNT(*) FROM [${SHADOW_DB}].dbo.Catalog) AS products,
               (SELECT COUNT(*) FROM [${ESTATE_DB}].dbo.Catalog) AS productsEstate,
               (SELECT COUNT(*) FROM [${SHADOW_DB}].sys.procedures WHERE name LIKE 'sp[_]%') AS procs,
               SUSER_SNAME((SELECT owner_sid FROM sys.databases WHERE name = '${SHADOW_DB}')) AS owner`)
    ).recordset[0] as Record<string, number | string>;

    check(copy.exists_ === 1, `${SHADOW_DB} exists`);
    check(SHADOW_DB !== ESTATE_DB, 'the shadow database is not the estate', `${SHADOW_DB} ≠ ${ESTATE_DB}`);
    check(
      copy.lines === copy.linesEstate && copy.products === copy.productsEstate,
      'it is a real copy, not an empty schema',
      `${copy.lines} order lines, ${copy.products} products`,
    );
    check(copy.procs === 14, 'all fourteen procedures came with it', `${copy.procs}`);
    check(copy.ct === 1 && copy.ctTables === copy.ctTablesEstate, 'change tracking survived the restore', `${copy.ctTables} tables`);
    check(copy.owner === 'parity_shadow', 'the shadow database is owned by parity_shadow', String(copy.owner));

    // The principal that can wipe and rebuild a database is the most dangerous one in the
    // build, and it is the one with no route to production at all.
    let shadowReachedEstate = false;
    try {
      const asShadow = await connectMssql(
        process.env.PARITY_SHADOW_USER ?? 'parity_shadow',
        process.env.PARITY_SHADOW_PASSWORD ?? 'Parity_Shadow_2026!',
        'master',
      );
      try {
        await asShadow.request().query(`SELECT TOP 1 ProductID FROM [${ESTATE_DB}].dbo.Catalog`);
        shadowReachedEstate = true;
      } catch {
        shadowReachedEstate = false;
      } finally {
        await asShadow.close();
      }
    } catch {
      shadowReachedEstate = false;
    }
    check(!shadowReachedEstate, 'the engine refuses parity_shadow the estate outright');

    // M2's guarantee, still true: the analysis credential cannot write.
    let readerWrote = false;
    const reader = await connectMssql(
      process.env.PARITY_READER_USER ?? 'parity_reader',
      process.env.PARITY_READER_PASSWORD ?? 'Parity_Reader_2026!',
    );
    try {
      await reader.request().query('UPDATE dbo.Catalog SET ModifiedBy = N\'verify-m5\' WHERE ProductID = 1');
      readerWrote = true;
    } catch {
      readerWrote = false;
    } finally {
      await reader.close();
    }
    check(!readerWrote, 'M2 is intact — the analysis login still cannot write to the estate');

    // The DENY is a database permission, so it came with the copy. That is worth asserting
    // rather than assuming: it is the reason a shadow run cannot send Database Mail.
    const deny = (
      await sa.request().query(`
        SELECT COUNT(*) AS n FROM [${SHADOW_DB}].sys.database_permissions p
        JOIN [${SHADOW_DB}].sys.database_principals dp ON dp.principal_id = p.grantee_principal_id
        WHERE p.state_desc = 'DENY' AND p.permission_name = 'EXECUTE'
          AND dp.name = 'parity_runner' AND OBJECT_NAME(p.major_id, DB_ID('${SHADOW_DB}')) = '${NEVER_EXECUTE}'`)
    ).recordset[0].n as number;
    check(deny === 1, `the runner is DENYed ${NEVER_EXECUTE} on the copy too`);

    // --- 3 ------------------------------------------------------------------
    section('Production is provably untouched');

    const before = await estateFingerprint(sa);
    const captureBefore = (await sa.request().query('SELECT COUNT_BIG(*) AS n FROM parity_capture.Invocation'))
      .recordset[0].n as string;

    const probeResult = await probe('src/cli/probe-shadow.ts');

    const after = await estateFingerprint(sa);
    const captureAfter = (await sa.request().query('SELECT COUNT_BIG(*) AS n FROM parity_capture.Invocation'))
      .recordset[0].n as string;

    check(before === after, 'the estate is byte-identical after a full replay');
    check(
      String(captureBefore) === String(captureAfter),
      'the replay wrote no capture rows — it never went through the monolith',
      `${captureBefore}`,
    );

    const runDatabases = (
      await client.query<{ shadow_database: string; n: string }>(
        'SELECT shadow_database, COUNT(*) AS n FROM shadow_runs GROUP BY shadow_database',
      )
    ).rows;
    check(
      runDatabases.length > 0 && runDatabases.every((r) => r.shadow_database === SHADOW_DB),
      'every recorded shadow run names the shadow database, never the estate',
      runDatabases.map((r) => `${r.shadow_database}×${r.n}`).join(' '),
    );

    // --- 4 ------------------------------------------------------------------
    section('A full shadow run completes');

    const run = (
      await client.query<{
        id: number;
        status: string;
        cases_replayed: number;
        strata_covered: number;
        strata_observed: number;
        raw_diffs: number;
        noise_diffs: number;
        behaviour_diffs: number;
        replay_ms: number;
        implementation: string;
      }>(
        `SELECT s.* FROM shadow_runs s JOIN procedures p ON p.id = s.procedure_id
         WHERE p.name = $1 AND s.kind = 'shadow' ORDER BY s.id DESC LIMIT 1`,
        [MIGRATION_TARGET],
      )
    ).rows[0];

    check(run !== undefined && run.status === 'succeeded', 'a shadow run of the migration target succeeded');
    if (run === undefined) throw new Error('no shadow run to assert against — run `make shadow-run`');

    check(run.cases_replayed >= 100, 'a few hundred captured calls were replayed', `${run.cases_replayed}`);
    check(
      run.strata_covered === run.strata_observed,
      'every observed branch is covered, not just the hot ones',
      `${run.strata_covered}/${run.strata_observed}`,
    );
    check(run.replay_ms < 60_000, 'the replay finishes inside 60 s', `${(run.replay_ms / 1000).toFixed(1)}s`);
    note(
      `${run.cases_replayed} cases in ${(run.replay_ms / 1000).toFixed(1)}s = ` +
        `${(run.replay_ms / run.cases_replayed).toFixed(1)} ms/case, both passes`,
    );

    // Every case must trace to a real sampled invocation whose recorded inputs the gate
    // re-reads. The same assertion M4 makes about golden cases, for the same reason: without
    // it, "replayed from production traffic" is a claim rather than a property.
    const cases = (
      await client.query<{ source_invocation_id: string; input_params: Record<string, unknown>; stratum: string }>(
        'SELECT source_invocation_id, input_params, stratum FROM shadow_cases WHERE shadow_run_id = $1 ORDER BY seq',
        [run.id],
      )
    ).rows;

    const ids = cases.map((c) => c.source_invocation_id).join(',');
    const captured = (
      await sa.request().query(`
        SELECT InvocationID, ProcName, Sampled, InputParams
        FROM parity_capture.Invocation WHERE InvocationID IN (${ids})`)
    ).recordset as { InvocationID: number; ProcName: string; Sampled: boolean; InputParams: string }[];

    const byId = new Map(captured.map((row) => [String(row.InvocationID), row]));
    const wrongProc = cases.filter((c) => byId.get(c.source_invocation_id)?.ProcName !== MIGRATION_TARGET);
    const unsampled = cases.filter((c) => byId.get(c.source_invocation_id)?.Sampled !== true);
    const invented = cases.filter((c) => {
      const source = byId.get(c.source_invocation_id);
      if (source === undefined) return true;
      // Both sides fully, key-sorted. An earlier form passed the recorded key list to
      // JSON.stringify as a filter, which compares only the keys the capture happens to have —
      // so a parameter the harness invented would have been invisible to the check meant to
      // catch exactly that.
      return stableJson(JSON.parse(source.InputParams)) !== stableJson(c.input_params);
    });

    check(wrongProc.length === 0, 'every case cites a real invocation of this procedure', `${cases.length} cases`);
    check(unsampled.length === 0, 'every cited invocation was actually sampled');
    check(invented.length === 0, 'stored inputs byte-match the capture — nothing was invented', `${invented.length} mismatches`);

    check(probeResult.selectionStable === true, 'the replay set is identical when selected twice (hard rule 5)');

    // --- 5 ------------------------------------------------------------------
    section('Canonicalisation happens in code, before the model sees anything');

    const verdicts = (
      await client.query<{ verdict: string | null; verdict_source: string | null; noise_reason: string | null; n: string; with_agent: string }>(
        `SELECT verdict, verdict_source, noise_reason, COUNT(*) AS n,
                COUNT(*) FILTER (WHERE agent_run_id IS NOT NULL) AS with_agent
         FROM diffs WHERE shadow_run_id = $1
         GROUP BY verdict, verdict_source, noise_reason`,
        [run.id],
      )
    ).rows;

    const total = verdicts.reduce((n, v) => n + Number(v.n), 0);
    const byCanonicaliser = verdicts.filter((v) => v.verdict_source === 'canonicaliser');
    const canonicalCount = byCanonicaliser.reduce((n, v) => n + Number(v.n), 0);
    const modelCount = verdicts.filter((v) => v.verdict_source === 'classify-diff').reduce((n, v) => n + Number(v.n), 0);

    check(total > 0, 'the run produced raw differences to resolve', `${total}`);
    check(canonicalCount > modelCount, 'the majority are resolved mechanically, not by the model', `${canonicalCount} vs ${modelCount}`);
    note(`${((canonicalCount / total) * 100).toFixed(1)}% resolved in code — the model saw ${modelCount} of ${total}`);

    // `unexplained` is what the engine emits when it resolved a difference and cannot say
    // which normalisation did it. Guessing a plausible label there would be worse than
    // failing, so it fails.
    check(
      byCanonicaliser.every((v) => v.verdict === 'noise' && v.noise_reason !== null && CANONICAL_REASONS.includes(v.noise_reason)),
      'every mechanically-resolved difference names the normalisation that resolved it',
      byCanonicaliser.map((v) => `${v.noise_reason}×${v.n}`).join(' '),
    );
    // The receipt. Without it "the model never saw them" is a claim about code nobody reads.
    check(
      byCanonicaliser.every((v) => Number(v.with_agent) === 0),
      'no mechanically-resolved difference carries an agent run — the model never saw one',
    );

    // Counted from the diffs of *this* run, not from every classify-diff run ever recorded.
    // The global form drifted with unrelated history — a second shadow run and each
    // `probe-decision` both add classify-diff runs — so the check passed or failed on
    // something it was not measuring. Scoped, it says exactly what it claims: this run asked
    // one question per finding.
    const classifyRuns = (
      await client.query<{ n: string }>(
        `SELECT COUNT(DISTINCT agent_run_id) AS n FROM diffs
         WHERE shadow_run_id = $1 AND verdict_source = 'classify-diff'`,
        [run.id],
      )
    ).rows[0];
    const signatures = (
      await client.query<{ n: string }>(
        'SELECT COUNT(DISTINCT signature) AS n FROM diffs WHERE shadow_run_id = $1 AND canonical_equal = false',
        [run.id],
      )
    ).rows[0];
    check(
      Number(classifyRuns.n) === Number(signatures.n),
      'one model run per finding, not one per difference',
      `${classifyRuns.n} runs, ${signatures.n} findings, ${modelCount} differences`,
    );

    const unclassified = (
      await client.query<{ n: string }>(
        'SELECT COUNT(*) AS n FROM diffs WHERE shadow_run_id = $1 AND verdict IS NULL',
        [run.id],
      )
    ).rows[0];
    check(Number(unclassified.n) === 0, 'nothing was left unclassified', `${unclassified.n}`);

    // --- 6 ------------------------------------------------------------------
    section('classify-diff labels rather than guesses');

    const modelVerdicts = (
      await client.query<{ verdict: string; noise_reason: string | null; explanation_cs: string | null; n: string }>(
        `SELECT verdict, noise_reason, explanation_cs, COUNT(*) AS n FROM diffs
         WHERE shadow_run_id = $1 AND verdict_source = 'classify-diff'
         GROUP BY verdict, noise_reason, explanation_cs`,
        [run.id],
      )
    ).rows;

    check(
      modelVerdicts.every((v) => v.verdict === 'noise' || v.verdict === 'behaviour_change'),
      'every model verdict is one of the two allowed values',
    );

    // Stated over the whole population rather than over the noise verdicts alone.
    //
    // "Every noise verdict carries a reason from the closed list" is the obvious phrasing and
    // it is the wrong one: this run produced no noise verdicts at all, so it would pass
    // vacuously and go on passing if the vocabulary were dropped entirely. M1's replay check,
    // M2's write-owner check and M4's rate check were all this exact shape, and each of them
    // passed while the thing it named was broken. The contract holds in both directions —
    // a reason exactly when the verdict is noise — and that is testable on every row.
    const contractHolds = modelVerdicts.every((v) =>
      v.verdict === 'noise'
        ? v.noise_reason !== null && SKILL_REASONS.includes(v.noise_reason)
        : v.noise_reason === null && (v.explanation_cs ?? '').trim().length > 40,
    );
    const noiseVerdicts = modelVerdicts.filter((v) => v.verdict === 'noise').length;
    check(
      contractHolds && modelVerdicts.length > 0,
      'every model verdict is a reason from the closed list or a Czech explanation, never both',
      `${modelCount} differences across ${modelVerdicts.length} verdicts`,
    );
    note(
      noiseVerdicts === 0
        ? 'the model returned no noise verdicts this run — canonicalisation had already taken all of it, ' +
            "so the skill's noise vocabulary went unexercised here"
        : `${noiseVerdicts} noise verdicts from the model`,
    );

    const policy = (
      await client.query<{ n: string }>("SELECT COUNT(*) AS n FROM policy_rules WHERE task_class = 'diff'")
    ).rows[0];
    check(Number(policy.n) > 0, 'the diff task class is in the policy table', `${policy.n} rules`);

    // Deciding on a person's behalf is the one thing an agent must never do, and it is proved
    // by provoking it rather than by reading the rule back.
    //
    // An earlier version of this check queried `policy_rules` for the row and asserted
    // `requires_human`. `seedPolicy` writes that row unconditionally on every boot, so the
    // check passed on the strength of its own fixture: it would have gone on passing if
    // `decide()` regressed or if the tool were quietly added to a skill's allowedTools. The
    // same shape as the four vacuous assertions this build has already paid for.
    //
    // `probe-decision` grants `record_decision` at the SDK layer on purpose, so what refuses
    // it can only be Parity's tier table. Costs one live model run, like M3's probe-policy.
    const decisionProbe = await probe('src/cli/probe-decision.ts');
    check(
      decisionProbe.attempted === true,
      'the agent really tried to record a decision and the hook refused it',
      String((decisionProbe.blockedTools as string[])?.join(' ') ?? ''),
    );
    check(
      decisionProbe.decisionWritten === false,
      'and the refused call wrote nothing — a gate that blocks and still lets the row through is worse than none',
      `${decisionProbe.decisionsBefore} → ${decisionProbe.decisionsAfter}`,
    );
    note(`refusal reason: ${(decisionProbe.reasons as string[])?.[0] ?? '—'}`);

    // M3 and M4 both lost audit rows here, one layer apart. Every tool call, whatever its
    // outcome, produces exactly one row.
    const audit = (
      await client.query<{ tools: string; rows: string }>(
        `SELECT
           (SELECT COUNT(*) FROM agent_steps s JOIN agent_runs r ON r.id = s.agent_run_id
             WHERE r.skill = 'classify-diff' AND s.kind = 'tool_use') AS tools,
           (SELECT COUNT(*) FROM audit_entries a JOIN agent_runs r ON r.id = a.agent_run_id
             WHERE r.skill = 'classify-diff') AS rows`,
      )
    ).rows[0];
    check(
      Number(audit.rows) >= Number(audit.tools) && Number(audit.tools) > 0,
      'every classify-diff tool call has an audit row',
      `${audit.tools} calls, ${audit.rows} rows`,
    );

    // --- 7 ------------------------------------------------------------------
    section('The planted promo/VAT defect surfaces as behaviour_change');

    const vatFindings = (
      await client.query<{ signature: string; column_name: string; cases: string; explanation_cs: string | null }>(
        `SELECT signature, column_name, COUNT(DISTINCT shadow_case_id) AS cases, MIN(explanation_cs) AS explanation_cs
         FROM diffs WHERE shadow_run_id = $1 AND verdict = 'behaviour_change'
           AND column_name IN ('TotalVat', 'TotalWithVat')
         GROUP BY signature, column_name`,
        [run.id],
      )
    ).rows;

    check(vatFindings.length > 0, 'the VAT columns diverge and are called a behaviour change', `${vatFindings.length} findings`);

    const vatCases = Math.max(0, ...vatFindings.map((f) => Number(f.cases)));
    check(
      vatCases > 0 && vatCases < run.cases_replayed / 2,
      'it is confined to a minority of replayed cases — an exception, not a broken implementation',
      `${vatCases} of ${run.cases_replayed}`,
    );

    // The half that explains fifteen years. TotalVat is defined as TotalWithVat − TotalNet,
    // so the procedure's own identity holds on every branch and no self-consistency check
    // could ever have caught this. TotalNet agreeing everywhere is that fact, measured.
    const netFindings = (
      await client.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM diffs
         WHERE shadow_run_id = $1 AND verdict = 'behaviour_change' AND column_name = 'TotalNet'`,
        [run.id],
      )
    ).rows[0];
    check(Number(netFindings.n) === 0, 'TotalNet never diverges — which is why nobody saw this for fifteen years');

    const moneyAsNoise = (
      await client.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM diffs
         WHERE shadow_run_id = $1 AND verdict = 'noise' AND verdict_source = 'classify-diff'
           AND column_name = ANY($2)`,
        [run.id, MONEY],
      )
    ).rows[0];
    check(Number(moneyAsNoise.n) === 0, 'no monetary difference was ever classified as noise');

    // --- 8 ------------------------------------------------------------------
    section('The queue is real and the estate moved');

    const queue = await getJson<{ open: QueueItem[]; decided: QueueItem[] }>('/api/queue');
    // Open *or* decided. An earlier form required an open item and crashed once a human had
    // worked the queue — which is the normal state after a demo, not an exceptional one. A
    // gate that only runs before anyone has used the thing it gates is not much of a gate.
    check(
      queue.open.length + queue.decided.length > 0,
      'the queue holds the latest run\'s findings',
      `${queue.open.length} open, ${queue.decided.length} decided`,
    );

    // The queue is work, not an archive.
    //
    // A signature names the *shape* of a difference, so it recurs identically in every run
    // that reproduces it. Unscoped, the queue listed each finding once per shadow run and a
    // human re-running the harness had to decide everything twice — found in use, on a stack
    // with three runs and four findings that asked for eight decisions.
    const everyItem = [...queue.open, ...queue.decided];
    const queued = everyItem.map((item) => `${item.procedure} ${item.signature}`);
    check(
      new Set(queued).size === queued.length,
      'no finding appears twice — the queue is scoped to the latest run, not every run',
      `${queued.length} items, ${new Set(queued).size} distinct`,
    );

    const latestRuns = new Set(
      (
        await client.query<{ id: number }>(
          `SELECT DISTINCT ON (procedure_id) id FROM shadow_runs
           WHERE kind = 'shadow' AND status = 'succeeded' ORDER BY procedure_id, id DESC`,
        )
      ).rows.map((r) => r.id),
    );
    const totalRuns = (
      await client.query<{ n: string }>("SELECT COUNT(*) AS n FROM shadow_runs WHERE kind = 'shadow'")
    ).rows[0];
    check(
      everyItem.every((item) => latestRuns.has(item.shadowRunId)),
      'and every item it does show belongs to its procedure\'s newest run',
      `${totalRuns.n} runs recorded, ${latestRuns.size} of them current`,
    );
    check(
      everyItem.every((item) => item.explanationCs !== null && item.cases > 0),
      'every queue item carries its Czech reasoning and how many cases it covers',
    );

    const summary = await getJson<{ rawDiffs: number; resolvedInCode: number; reachedHuman: number }>('/api/queue/summary');
    check(
      summary.rawDiffs === run.raw_diffs && summary.resolvedInCode === run.noise_diffs,
      'the header counter is the run\'s own numbers',
      `${summary.rawDiffs} raw, ${summary.resolvedInCode} in code, ${summary.reachedHuman} to a human`,
    );

    // Deciding is what the screen is for, so the gate presses the button — and it works from
    // whatever state a human left the queue in, deciding an already-decided item if that is
    // all there is. Whatever was there before is put back in a `finally`, decision and all:
    // verify-m2 learned that a gate must not be able to damage the thing it measures, and
    // silently clearing someone's recorded decision is damage.
    const item = queue.open[0] ?? queue.decided[0];
    const priorAction = item.decision?.action ?? null;
    const path = `/api/queue/${encodeURIComponent(item.signature)}/decision`;
    try {
      await send(path, 'POST', { action: 'preserve', shadowRunId: item.shadowRunId });
      const afterDecision = await getJson<{ open: QueueItem[]; decided: QueueItem[] }>('/api/queue');
      check(
        !afterDecision.open.some((o) => o.signature === item.signature) &&
          afterDecision.decided.some((d) => d.signature === item.signature && d.decision?.action === 'preserve'),
        '`Zachovat chování` records the decision and the item leaves the open queue',
      );
    } finally {
      if (priorAction === null) await send(path, 'DELETE');
      else await send(path, 'POST', { action: priorAction, shadowRunId: item.shadowRunId });
    }
    const restored = await getJson<{ open: QueueItem[]; decided: QueueItem[] }>('/api/queue');
    check(
      restored.open.length === queue.open.length &&
        restored.decided.find((d) => d.signature === item.signature)?.decision?.action === (priorAction ?? undefined),
      'the gate put the queue back exactly as it found it',
      priorAction === null ? 'was undecided' : `was ${priorAction}`,
    );

    const estate = await getJson<{ procedures: { name: string; oracleState: string; blocker: { key: string } | null }[] }>(
      '/api/estate',
    );
    const row = estate.procedures.find((p) => p.name === MIGRATION_TARGET);
    check(row?.oracleState === 'shadow', 'the migration target reads oracle_state = shadow', row?.oracleState ?? '—');
    check(
      row?.blocker?.key === 'awaiting_decision',
      'and its blocker moved to `čeká na rozhodnutí`',
      row?.blocker?.key ?? '—',
    );

    const storedBlocker = (
      await client.query<{ n: string }>(
        "SELECT COUNT(*) AS n FROM information_schema.columns WHERE column_name = 'blocker'",
      )
    ).rows[0];
    check(Number(storedBlocker.n) === 0, 'no table stores a blocker — still derived');

    // --- 9 ------------------------------------------------------------------
    section('The harness can fail');

    const aa = probeResult.aa as Record<string, number>;
    const perturbation = probeResult.perturbation as Record<string, unknown>;

    check(Number(aa.rawDiffs) > 0, 'the A/A control does produce raw differences to resolve', `${aa.rawDiffs}`);
    check(Number(aa.surviving) === 0, 'replaying the procedure against itself surfaces nothing', `${aa.surviving} survived`);
    check(Number(aa.findings) === 0, 'and produces no findings');
    check(
      Number(aa.identicalCases) === Number(probeResult.cases),
      'every A/A case is canonically identical — repeat runs reproduce exactly',
      `${aa.identicalCases}/${probeResult.cases}`,
    );

    // The migration target has no result set, so the other half of the diff engine would go
    // untested by everything above. Driven directly by the probe instead.
    const resultSetProbe = probeResult.resultSetProbe as Record<string, unknown>;
    check(Number(resultSetProbe.differingRows) > 0, 'a differing result-set row is reported as a difference');
    check(resultSetProbe.identicalIsQuiet === true, 'an identical result set is not');
    check(
      resultSetProbe.reorderedIsQuiet === true,
      'and the same rows in a different order are not — the canonicaliser sorts before comparing',
    );

    check(perturbation.attempted === true, 'the perturbation probe found a money column to corrupt');
    check(
      Number(perturbation.detected) === 1,
      'adding one unit to a single value surfaces exactly one difference',
      `${perturbation.table}.${perturbation.column} ${perturbation.before} → ${perturbation.after}`,
    );
    check(
      Array.isArray(perturbation.signatures) && (perturbation.signatures as string[])[0]?.endsWith(':material'),
      'and it is material, not sub-cent noise',
      String((perturbation.signatures as string[])[0]),
    );
    check(perturbation.cleanAgain === true, 'the uncorrupted pair is still clean');

    // --- 10 -----------------------------------------------------------------
    section('The new state is disposable');

    const cascades = (
      await client.query<{ table_name: string }>(
        `SELECT DISTINCT tc.table_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
         WHERE tc.constraint_type = 'FOREIGN KEY' AND rc.delete_rule = 'CASCADE'
           AND tc.table_name IN ('shadow_runs', 'shadow_cases', 'diffs', 'decisions')`,
      )
    ).rows.map((r) => r.table_name);
    check(
      ['shadow_runs', 'shadow_cases', 'diffs', 'decisions'].every((t) => cascades.includes(t)),
      'the four shadow tables cascade, so demo-reset cannot leave them behind',
      cascades.sort().join(' '),
    );

    // Asserted structurally rather than by running `make demo-reset`, which is what an
    // earlier version of this gate did.
    //
    // `verify-m4` already made this decision one milestone ago and for the same reason: a
    // reset destroys a sweep's worth of live model output, and a gate that costs twelve
    // dollars of inference to re-run stops being re-run. It is worse here than there —
    // demo-reset truncates `procedures`, so this would take M3's estate sweep and M4's oracle
    // sweep down with M5's shadow run. `verify-m2` owns the timing and pristine-state
    // assertions for demo-reset; what M5 has to add is only that the four new tables are
    // reachable by it, and the cascade is that property.
    // Behavioural rather than declarative: clear `procedures` inside a transaction, count what
    // is left, and roll back. Reading the truncate list out of the source would assert the
    // same property against the spelling of a variable name instead of against the database.
    await client.query('BEGIN');
    let orphans = { runs: '0', cases: '0', diffs: '0', decisions: '0' };
    try {
      await client.query('DELETE FROM procedures');
      orphans = (
        await client.query<typeof orphans>(
          `SELECT (SELECT COUNT(*) FROM shadow_runs) AS runs, (SELECT COUNT(*) FROM shadow_cases) AS cases,
                  (SELECT COUNT(*) FROM diffs) AS diffs, (SELECT COUNT(*) FROM decisions) AS decisions`,
        )
      ).rows[0];
    } finally {
      await client.query('ROLLBACK');
    }
    check(
      Object.values(orphans).every((n) => Number(n) === 0),
      'clearing procedures takes every shadow row with it — nothing can outlive a reset',
      `${orphans.runs}/${orphans.cases}/${orphans.diffs}/${orphans.decisions} left`,
    );

    const stillThere = (await client.query<{ n: string }>('SELECT COUNT(*) AS n FROM shadow_runs')).rows[0];
    check(Number(stillThere.n) > 0, 'and the probe rolled back — the run this gate asserted is still there', `${stillThere.n} runs`);
    note('demo-reset is not run here: it would take M3\'s and M4\'s live sweeps down with M5\'s run.');
  } finally {
    await client.end();
    await sa.close();
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
