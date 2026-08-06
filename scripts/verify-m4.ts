// M4 acceptance. `make verify-m4` is the definition of done.
//
// Runs against a stack that has had `make demo-reset && make map-estate && make generate-oracles`.
//
// generate-oracles spends live model runs and is deliberately a separate command: this gate
// asserts the persisted result plus the suites it re-runs itself, so it stays cheap enough to
// re-run often. Note the ordering — `verify-m3` asserts coverage is still zero, which is true
// after map-estate and false after generate-oracles, so m3 runs before this, not after.

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

/** The oracle is built for every live procedure except the one that cannot be run at all. */
const NEVER_EXECUTE = 'sp_SyncWarehouseDispatch';
const DEAD = ['sp_ExportCatalogXml_OLD', 'sp_MigrateCustomerAddresses', 'sp_RecomputeLoyaltyTier_deprecated'];
const MIGRATION_TARGET = 'sp_CalculateOrderTotal';

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

const postJson = async <T>(path: string): Promise<T> => {
  const response = await fetch(`${API}${path}`, { method: 'POST', signal: AbortSignal.timeout(300_000) });
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

const connectMssql = (user: string, password: string): Promise<mssql.ConnectionPool> =>
  new mssql.ConnectionPool({
    server: process.env.MSSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MSSQL_PORT ?? 1433),
    database: 'ParityShop',
    user,
    password,
    options: { encrypt: true, trustServerCertificate: true, requestTimeout: 120_000 },
  }).connect();

/**
 * The M0 fingerprint over the watched columns, per-row checksums summed.
 * `CHECKSUM_AGG` is XOR-based and cancels pairwise, which is how a three-row write once went
 * completely undetected on a table where thousands of rows share a value.
 */
async function estateFingerprint(pool: mssql.ConnectionPool): Promise<string> {
  const query = await readFile(join(ROOT, 'scripts', 'seed-checksum.sql'), 'utf8');
  const result = await pool.request().query(query);

  // The committed fingerprint covers Catalog, OrderLedger and the customer tables — the ones
  // whose values move. It does not cover the tables the reserving and ordering procedures
  // INSERT into, and a leaked insert there is exactly the failure this check exists to catch,
  // so their row counts are appended rather than the shared query being widened (verify-m0
  // asserts that query against a committed value and must not be disturbed).
  const inserts = await pool.request().query(`
    SELECT (SELECT COUNT_BIG(*) FROM dbo.StockReservation) AS reservations,
           (SELECT COUNT_BIG(*) FROM dbo.StockMovement)    AS movements,
           (SELECT COUNT_BIG(*) FROM dbo.AuditTrail)       AS audit,
           (SELECT COUNT_BIG(*) FROM dbo.PromoRedemption)  AS redemptions`);

  return JSON.stringify({ ...result.recordset[0], ...inserts.recordset[0] });
}

interface EstateResponse {
  totals: { procedures: number; invocations90d: number; coverage: number; coverageByCount: number };
  procedures: { name: string; invocations90d: number; oracleState: string; oracleClass: string | null }[];
}

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: PG_URL });
  await client.connect();
  const sa = await connectMssql('sa', process.env.MSSQL_SA_PASSWORD ?? 'ParityShop_Dev_2026!');
  const runner = await connectMssql(
    process.env.PARITY_RUNNER_USER ?? 'parity_runner',
    process.env.PARITY_RUNNER_PASSWORD ?? 'Parity_Runner_2026!',
  );

  try {
    // --- 1. the previous milestone is undisturbed --------------------------------
    section('M3 is undisturbed');
    const estate = await getJson<EstateResponse>('/api/estate');
    check(estate.totals.procedures === 14, 'still 14 procedures', `${estate.totals.procedures}`);
    check(estate.totals.invocations90d > 40_000, 'invocation counts unchanged', `${estate.totals.invocations90d}`);
    check(
      estate.procedures.every((p) => p.oracleClass !== null),
      'every procedure still carries an oracle class from triage',
    );
    const { rows: specCount } = await client.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM specs');
    check(specCount[0].n === 14, 'all fourteen specifications survive', `${specCount[0].n}`);

    // --- 2. the execution credential is genuinely least-privilege -----------------
    section('The runner may execute, and nothing more');
    const perms = (
      await runner.request().query(`
        SELECT HAS_PERMS_BY_NAME('dbo.${MIGRATION_TARGET}', 'OBJECT', 'EXECUTE') AS canCalc,
               HAS_PERMS_BY_NAME('dbo.${NEVER_EXECUTE}', 'OBJECT', 'EXECUTE') AS canMail,
               IS_ROLEMEMBER('db_owner') AS owner, IS_ROLEMEMBER('db_ddladmin') AS ddl`)
    ).recordset[0] as Record<string, number>;
    check(perms.canCalc === 1, 'parity_runner may execute the migration target');
    check(
      perms.canMail === 0,
      'parity_runner is refused sp_SyncWarehouseDispatch — a sent email cannot be rolled back',
    );
    check(perms.owner === 0 && perms.ddl === 0, 'parity_runner holds no ownership or DDL role');

    let ddlRefused = false;
    try {
      await runner.request().query('CREATE TABLE dbo.zzz_verify_m4_probe(id int)');
      await runner.request().query('DROP TABLE dbo.zzz_verify_m4_probe').catch(() => undefined);
    } catch {
      ddlRefused = true;
    }
    check(ddlRefused, 'the engine refuses parity_runner any DDL against the estate');

    let readerRefused = false;
    const reader = await connectMssql(
      process.env.PARITY_READER_USER ?? 'parity_reader',
      process.env.PARITY_READER_PASSWORD ?? 'Parity_Reader_2026!',
    );
    try {
      await reader.request().query('UPDATE dbo.Catalog SET PriceNet = PriceNet WHERE 1 = 0');
    } catch {
      readerRefused = true;
    } finally {
      await reader.close();
    }
    check(readerRefused, "M2's guarantee is intact — the analysis login still cannot write");

    // --- 3. golden tests exist, and every one is traceable to real traffic --------
    section('Golden tests are drawn from captured traffic');
    const { rows: perProcedure } = await client.query<{ name: string; n: number; invocations: number }>(`
      SELECT p.name, COUNT(g.id)::int AS n, p.invocations_90d AS invocations
      FROM procedures p LEFT JOIN golden_tests g ON g.procedure_id = p.id
      GROUP BY p.name, p.invocations_90d ORDER BY p.name`);

    const withTests = perProcedure.filter((r) => r.n > 0);
    check(withTests.length >= 8, 'at least 8 procedures have golden tests', `${withTests.length} of 14`);
    note(withTests.map((r) => `${r.name}:${r.n}`).join('  '));

    check(
      perProcedure.filter((r) => DEAD.includes(r.name)).every((r) => r.n === 0),
      'the three dead procedures have none — there is no traffic to draw them from',
    );
    check(
      perProcedure.find((r) => r.name === NEVER_EXECUTE)?.n === 0,
      `${NEVER_EXECUTE} has none — it cannot be executed even once`,
    );

    const { rows: cases } = await client.query<{
      name: string;
      procedure: string;
      source_invocation_id: string;
      input_params: unknown;
    }>(`SELECT g.name, p.name AS procedure, g.source_invocation_id, g.input_params
        FROM golden_tests g JOIN procedures p ON p.id = g.procedure_id ORDER BY p.name, g.name`);

    const ids = cases.map((c) => Number(c.source_invocation_id));
    const captured = (
      await sa.request().query(`
        SELECT InvocationID, ProcName, InputParams, Sampled
        FROM parity_capture.Invocation
        WHERE InvocationID IN (${ids.length > 0 ? ids.join(',') : 'NULL'})`)
    ).recordset as { InvocationID: number; ProcName: string; InputParams: string; Sampled: boolean }[];
    const byId = new Map(captured.map((c) => [Number(c.InvocationID), c]));

    const unmatched = cases.filter((c) => {
      const source = byId.get(Number(c.source_invocation_id));
      return source === undefined || source.ProcName !== c.procedure || !source.Sampled;
    });
    check(
      unmatched.length === 0,
      'every case cites a sampled invocation of its own procedure',
      unmatched.map((u) => `${u.procedure}/${u.name}`).join(', '),
    );

    // The strong form: not merely that an invocation exists, but that the stored parameters
    // are the ones it really ran with. This is what makes "no invented inputs" checkable.
    //
    // Compared key-sorted, not as raw JSON. Postgres normalises `jsonb` key order, so the
    // stored copy comes back ordered differently from the capture's text — a plain
    // stringify comparison would report every case as drifted and be wrong every time.
    const drifted = cases.filter((c) => {
      const source = byId.get(Number(c.source_invocation_id));
      if (source === undefined) return true;
      return stableJson(JSON.parse(source.InputParams)) !== stableJson(c.input_params);
    });
    check(
      drifted.length === 0,
      'stored inputs byte-match the capture — nothing was invented',
      drifted.map((d) => `${d.procedure}/${d.name}`).join(', '),
    );

    // The skill's own instruction is "every distinct branch observed in the capture, at least
    // once", and its closing rule is that an oracle claiming more coverage than it has is
    // worse than no oracle. So the claim is checked rather than trusted: for every procedure
    // with a suite, the branches its cases cover are compared against the branches the estate
    // was actually observed taking.
    const observed = (
      await sa.request().query(`
        SELECT ProcName, COUNT(DISTINCT BranchKey) AS branches
        FROM parity_capture.Invocation
        WHERE Sampled = 1 AND BranchKey IS NOT NULL
          AND (CallerContext IS NULL OR CallerContext NOT LIKE 'verify:%')
        GROUP BY ProcName`)
    ).recordset as { ProcName: string; branches: number }[];
    const observedBy = new Map(observed.map((o) => [o.ProcName, o.branches]));

    const { rows: coveredBranches } = await client.query<{ name: string; branches: number }>(`
      SELECT p.name, COUNT(DISTINCT g.branch_key)::int AS branches
      FROM golden_tests g JOIN procedures p ON p.id = g.procedure_id
      WHERE g.branch_key IS NOT NULL GROUP BY p.name`);

    // Full coverage is asserted where the demo actually turns: the migration target is the
    // procedure that gets replaced, so a branch its oracle never saw is a branch M6 could
    // change without anything noticing.
    const targetCovered = coveredBranches.find((c) => c.name === MIGRATION_TARGET)?.branches ?? 0;
    const targetObserved = observedBy.get(MIGRATION_TARGET) ?? 0;
    check(
      targetCovered === targetObserved && targetObserved > 0,
      `${MIGRATION_TARGET} covers every branch it was observed taking`,
      `${targetCovered}/${targetObserved}`,
    );

    // Elsewhere it is reported rather than enforced, and reported is the point. The skill's
    // closing rule is that an oracle claiming more coverage than it has is worse than none, so
    // the shortfall is printed per procedure instead of being rounded away into a green tick.
    // `sp_ApplyPromoCode` alone has twenty observed branches; a suite covering eight of them is
    // a real oracle and an incomplete one, and the number says which.
    for (const row of coveredBranches.sort((a, b) => a.name.localeCompare(b.name))) {
      note(`${row.name}: ${row.branches}/${observedBy.get(row.name) ?? 0} observed branches covered`);
    }
    check(
      coveredBranches.every((c) => c.branches > 0 && c.branches <= (observedBy.get(c.name) ?? 0)),
      'no suite claims a branch its procedure was never observed taking',
    );

    // --- 4. the suites run, pass, repeat, and leave the estate alone -------------
    section('Golden tests execute against the current procedure');
    const before = await estateFingerprint(sa);

    const targets = withTests.map((r) => r.name);
    const first = new Map<string, { goldenPassed: number; goldenFailed: number }>();
    for (const name of targets) {
      const result = await postJson<{ goldenPassed: number; goldenFailed: number }>(
        `/api/procedures/${encodeURIComponent(name)}/oracle/run`,
      );
      first.set(name, result);
    }
    const green = targets.filter((n) => (first.get(n)?.goldenFailed ?? 1) === 0 && (first.get(n)?.goldenPassed ?? 0) > 0);
    check(green.length >= 8, 'golden tests pass for at least 8 procedures', `${green.length} of ${targets.length}`);
    for (const name of targets) {
      const r = first.get(name)!;
      if (r.goldenFailed > 0) note(`${name}: ${r.goldenFailed} failing`);
    }

    // Same suite, twice, same answer. Hard rule 5 applied to the oracle itself.
    let repeatable = true;
    for (const name of targets) {
      const again = await postJson<{ goldenPassed: number; goldenFailed: number }>(
        `/api/procedures/${encodeURIComponent(name)}/oracle/run`,
      );
      const previous = first.get(name)!;
      if (again.goldenPassed !== previous.goldenPassed || again.goldenFailed !== previous.goldenFailed) {
        repeatable = false;
        note(`${name} moved between runs`);
      }
    }
    check(repeatable, 'running every suite a second time gives identical results');

    const after = await estateFingerprint(sa);
    check(
      before === after,
      'the estate is byte-identical after every replay — the transactions really do roll back',
    );

    // --- 5. the negative control -------------------------------------------------
    section('The suite can fail');
    const sabotage = await probe('src/cli/probe-oracle.ts');
    check(
      sabotage.detected === true,
      'corrupting one stored expectation by one unit turns the suite red',
      String(sabotage.corruption ?? ''),
    );
    check(sabotage.recovered === true, 'and it goes green again once restored', `${String(sabotage.passedAfterRestore)} passing`);

    // --- 6. invariants, and what they found --------------------------------------
    section('Invariants');
    const oracle = await getJson<{
      invariants: {
        name: string;
        kind: string;
        evaluable: boolean;
        casesChecked: number;
        casesViolated: number;
        firstViolation: string | null;
        confirmed: boolean;
      }[];
    }>(`/api/procedures/${MIGRATION_TARGET}/oracle`);

    check(oracle.invariants.length >= 3, `${MIGRATION_TARGET} has at least three invariants`, `${oracle.invariants.length}`);
    const kinds = new Set(oracle.invariants.map((i) => i.kind));
    check(kinds.has('sum_identity'), 'one of them is a totals identity');
    check(kinds.has('non_negative'), 'one of them is a non-negativity rule');
    check(kinds.has('value_from_table'), 'one of them checks a rate against the reference table');
    check(
      oracle.invariants.every((i) => ['sum_identity', 'non_negative', 'value_from_table', 'advisory'].includes(i.kind)),
      'every invariant is either evaluated in code or filed as advisory',
    );
    check(
      oracle.invariants.filter((i) => i.evaluable).every((i) => i.casesChecked > 0),
      'every evaluable invariant actually ran against the golden cases',
    );

    // The planted defect. `docs/DECISIONS.md` records it: in the branch where a stacking
    // promo meets a loyalty discount, VAT is computed on net minus promo instead of on net.
    const rateRule = oracle.invariants.find((i) => i.kind === 'value_from_table');
    check(
      (rateRule?.casesViolated ?? 0) > 0,
      'the rate invariant is violated — the oracle found the promo/VAT defect',
      rateRule?.firstViolation ?? 'no violation reported',
    );
    // A defect is an exception: it lives in one branch. A rule broken everywhere is a rule
    // that does not describe the procedure, and this gate must tell the two apart — otherwise
    // a mis-stated invariant would satisfy the check above and read as a discovery.
    check(
      rateRule !== undefined && rateRule.confirmed && rateRule.casesViolated < rateRule.casesChecked,
      'and it is violated in a minority of cases — a finding, not a mis-stated rule',
      rateRule === undefined ? '' : `${rateRule.casesViolated} of ${rateRule.casesChecked} checks`,
    );
    const identity = oracle.invariants.find((i) => i.kind === 'sum_identity' && i.evaluable);
    check(
      (identity?.casesViolated ?? 0) === 0,
      'the totals identity still holds — which is why nobody found this by self-consistency',
    );

    // --- 7. coverage is real, and weighted ---------------------------------------
    section('Coverage');
    const moved = await getJson<EstateResponse>('/api/estate');
    check(moved.totals.coverage > 0, 'coverage has moved off zero', `${(moved.totals.coverage * 100).toFixed(2)} %`);

    const COVERED = new Set(['golden', 'invariants', 'shadow', 'proven']);
    const totalInvocations = moved.procedures.reduce((s, p) => s + p.invocations90d, 0);
    const coveredInvocations = moved.procedures
      .filter((p) => COVERED.has(p.oracleState))
      .reduce((s, p) => s + p.invocations90d, 0);
    const expected = coveredInvocations / totalInvocations;
    check(
      Math.abs(moved.totals.coverage - expected) < 1e-9,
      'coverage equals the invocation-weighted share computed independently here',
      `${(expected * 100).toFixed(2)} %`,
    );

    const countShare = moved.procedures.filter((p) => COVERED.has(p.oracleState)).length / moved.procedures.length;
    check(
      Math.abs(moved.totals.coverage - moved.totals.coverageByCount) > 1e-9,
      'coverage is weighted, not counted',
      `weighted ${(moved.totals.coverage * 100).toFixed(2)} % vs counted ${(countShare * 100).toFixed(2)} %`,
    );
    check(
      moved.procedures.filter((p) => DEAD.includes(p.name)).every((p) => p.invocations90d === 0),
      'the dead procedures contribute zero to both sides — deleting them will not move coverage',
    );

    // --- 8. nothing derived was stored, and reset will clear it -------------------
    section('The new state is derived where it should be, and disposable');
    const { rows: storedBlocker } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'blocker'`,
    );
    check(storedBlocker.length === 0, 'no table stores a blocker — it is still computed on every read');

    const { rows: cascades } = await client.query<{ table_name: string; delete_rule: string }>(`
      SELECT tc.table_name, rc.delete_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
      JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND kcu.column_name = 'procedure_id'
        AND tc.table_name IN ('golden_tests','invariants','oracle_runs')`);
    check(
      cascades.length === 3 && cascades.every((c) => c.delete_rule === 'CASCADE'),
      'the oracle tables cascade from procedures, so demo-reset clears them',
      cascades.map((c) => `${c.table_name}:${c.delete_rule}`).join(' '),
    );

    // --- 9. receipts --------------------------------------------------------------
    section('Runs are recorded');
    const { rows: oracleRunRows } = await client.query<{ n: number; incomplete: number }>(`
      SELECT COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE model IS NULL OR output IS NULL OR cost_usd IS NULL
                              OR input_tokens IS NULL OR output_tokens IS NULL)::int AS incomplete
      FROM agent_runs WHERE skill = 'generate-oracle' AND status = 'succeeded'`);
    check(oracleRunRows[0].n >= 8, 'a generate-oracle run is recorded per procedure', `${oracleRunRows[0].n} runs`);
    check(oracleRunRows[0].incomplete === 0, 'every successful run persists model, output, tokens and cost');

    const { rows: audited } = await client.query<{ tools: number; audited: number }>(`
      SELECT (SELECT COUNT(*)::int FROM agent_steps s
              JOIN agent_runs r ON r.id = s.agent_run_id
              WHERE r.skill = 'generate-oracle' AND s.kind = 'tool_use') AS tools,
             (SELECT COUNT(*)::int FROM audit_entries a
              JOIN agent_runs r ON r.id = a.agent_run_id
              WHERE r.skill = 'generate-oracle') AS audited`);
    check(
      audited[0].audited >= audited[0].tools && audited[0].tools > 0,
      'every tool call the oracle skill made has an audit row',
      `${audited[0].audited} rows for ${audited[0].tools} calls`,
    );

    const { rows: policyRows } = await client.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM policy_rules WHERE task_class = 'oracle'`,
    );
    check(policyRows[0].n > 0, 'the oracle task class is in the policy table', `${policyRows[0].n} rules`);
  } finally {
    await sa.close();
    await runner.close();
    await client.end();
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
