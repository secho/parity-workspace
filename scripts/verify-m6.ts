// M6 acceptance. `make verify-m6` is the definition of done.
//
// Runs against a stack that has had the whole chain:
//   make demo-reset && make map-estate && make verify-m3
//   && make generate-oracles && make verify-m4
//   && make shadow-db && make shadow-run IMPL=reference && make verify-m5
//   && make implement-service && make adopt-service && make shadow-run IMPL=generated
//
// Gate order matters and keeps getting longer. The reference shadow run must come BEFORE the
// generated one: `latestRunIds` scopes the decision queue to the newest succeeded run per
// procedure, so a reference run afterwards re-fills the queue with findings already decided.
//
// Two things this gate deliberately does NOT do. It does not open a pull request — assembling
// is idempotent and free, opening is the one act in this platform that `make demo-reset`
// cannot take back. And it does not run `implement-service`: that is a live Opus run, and the
// gate asserts what it persisted, the same split as map-estate/verify-m3 and
// generate-oracles/verify-m4.

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
const SHOP = `http://127.0.0.1:${process.env.SHOP_API_PORT ?? 3100}`;
const PG_URL = process.env.PARITY_PG_URL ?? 'postgres://parity:parity@127.0.0.1:5433/parity';

const GENERATED = `http://127.0.0.1:${process.env.PRICING_SERVICE_GENERATED_PORT ?? 3301}`;
const LIVE = `http://127.0.0.1:${process.env.PRICING_SERVICE_LIVE_PORT ?? 3302}`;
const REFERENCE = `http://127.0.0.1:${process.env.PRICING_SERVICE_PORT ?? 3300}`;

const TARGET = 'sp_CalculateOrderTotal';
const ESTATE_DB = process.env.MSSQL_DATABASE ?? 'ParityShop';
const SHADOW_DB = process.env.MSSQL_SHADOW_DATABASE ?? 'ParityShop_Shadow';

/** A money column is never noise, and after migration it is never different either. */
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

const getJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return (await response.json()) as T;
};

async function probe(script: string, args: string[] = [], timeoutMs = 900_000): Promise<Record<string, unknown>> {
  const { stdout } = await exec('docker', ['compose', 'exec', '-T', 'parity-api', 'npx', 'tsx', script, ...args], {
    cwd: ROOT,
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
  const start = stdout.indexOf('{');
  if (start < 0) throw new Error(`no JSON from ${script}: ${stdout.slice(0, 400)}`);
  return JSON.parse(stdout.slice(start)) as Record<string, unknown>;
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

/** Reused verbatim from verify-m4 and verify-m5 — "production is untouched" is measured the same way every time. */
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

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: PG_URL });
  await client.connect();
  const sa = await connectMssql('sa', process.env.MSSQL_SA_PASSWORD ?? 'ParityShop_Dev_2026!');

  try {
    // --- 1 · M5 and the chain are undisturbed --------------------------------
    section('1 · M5 and the chain are undisturbed');

    const procs = await client.query(`SELECT name, oracle_class, oracle_state, campaign_status FROM procedures`);
    check(procs.rowCount === 14, 'fourteen procedures still ingested', `${procs.rowCount}`);

    const suites = await client.query(
      `SELECT COUNT(DISTINCT procedure_id)::int AS n FROM golden_tests`,
    );
    check(suites.rows[0].n >= 8, 'golden suites on at least 8 procedures', `${suites.rows[0].n}`);

    // Scoped to THIS procedure. Unscoped, "the latest reference run" becomes whichever
    // procedure was replayed most recently — and from M7 there is more than one.
    const referenceRun = await client.query(
      `SELECT * FROM shadow_runs WHERE implementation_id = 'reference' AND status = 'succeeded' AND kind = 'shadow'
         AND procedure_id = (SELECT id FROM procedures WHERE name = $1)
       ORDER BY id DESC LIMIT 1`,
      [TARGET],
    );
    check(referenceRun.rowCount === 1, 'the reference shadow run is still there', referenceRun.rows[0]?.implementation ?? '');
    check(
      referenceRun.rows[0]?.behaviour_diffs > 0,
      'it still carries its behavioural findings',
      `${referenceRun.rows[0]?.behaviour_diffs}`,
    );

    const blockerColumn = await client.query(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE column_name = 'blocker'`,
    );
    check(blockerColumn.rows[0].n === 0, 'blocker is still derived, never stored');

    // --- 2 · The service is the agent's ---------------------------------------
    section('2 · The service is the agent\'s, and what ran is what it wrote');

    // The run that produced the DEPLOYED service, reached through the artefact it wrote —
    // not merely the newest run carrying that skill name. `probe-pr` also runs
    // `implement-service`, and it is supposed to end `blocked`; picking by skill and recency
    // asserted "it succeeded" about the probe whose entire purpose is to be refused.
    const implRun = await client.query(
      `SELECT ar.* FROM agent_runs ar
       WHERE ar.id = (
         SELECT sa.agent_run_id FROM service_artifacts sa
         JOIN procedures p ON p.id = sa.procedure_id
         WHERE p.name = $1 AND sa.agent_run_id IS NOT NULL
         ORDER BY sa.attempt DESC LIMIT 1
       )`,
      [TARGET],
    );
    check((implRun.rowCount ?? 0) === 1, 'the run that wrote the deployed service is on record');
    check(implRun.rows[0]?.status === 'succeeded', 'it succeeded', implRun.rows[0]?.status ?? 'missing');
    check(
      (implRun.rows[0]?.model ?? '').includes('opus'),
      'it ran on an Opus-class model',
      implRun.rows[0]?.model ?? 'none',
    );

    const artefacts = await client.query(
      `SELECT sa.* FROM service_artifacts sa JOIN procedures p ON p.id = sa.procedure_id
       WHERE p.name = $1 ORDER BY sa.attempt DESC, sa.path`,
      [TARGET],
    );
    const topAttempt = artefacts.rows[0]?.attempt;
    const latest = artefacts.rows.filter((r) => r.attempt === topAttempt);
    check(latest.length === 2, 'the latest attempt has both files', latest.map((r) => r.path).join(', '));
    check(
      latest.every((r) => r.sha256?.length === 64 && r.run_hash?.length === 64),
      'every file carries a sha256 and a set hash',
    );

    // `artifacts` is a map at M7 — one container serves several procedures, so a single
    // `artifact` field could only ever have named one of them.
    const health = await getJson<{ status: string; artifacts: Record<string, string | null>; database: string }>(
      `${GENERATED}/health`,
    );
    check(health.status === 'ok', 'the generated service is serving', health.status);
    check(
      health.artifacts?.[TARGET] === latest[0]?.run_hash,
      'and it is serving exactly the artefact the agent wrote',
      `${health.artifacts?.[TARGET]?.slice(0, 12)} vs ${latest[0]?.run_hash?.slice(0, 12)}`,
    );
    note('this is the check that makes "what ran is what the agent wrote" a query, not a claim');
    check(health.database === SHADOW_DB, 'against the shadow copy, never the estate', health.database);

    const auditGaps = await client.query(
      `SELECT COUNT(*)::int AS n FROM agent_steps s
       WHERE s.agent_run_id = $1 AND s.kind = 'tool_use'
         AND NOT EXISTS (SELECT 1 FROM audit_entries a WHERE a.agent_run_id = s.agent_run_id AND a.tool_name = s.tool_name)`,
      [implRun.rows[0]?.id],
    );
    check(auditGaps.rows[0].n === 0, 'every tool call in that run has an audit row', `${auditGaps.rows[0].n} without`);

    const servicePolicy = await client.query(`SELECT tool_name, tier, requires_human FROM policy_rules WHERE task_class = 'service'`);
    check((servicePolicy.rowCount ?? 0) > 0, 'the service task class has a tier table', `${servicePolicy.rowCount} rules`);
    check(
      servicePolicy.rows.some((r) => r.tool_name.endsWith('open_pr') && r.tier === 3 && r.requires_human),
      'and open_pr is tier 3 in it',
    );

    // --- 3 · The generated service passes the golden suite --------------------
    section('3 · The generated service passes the golden suite');

    // First, the portability control. The expectations were recorded against ParityShop inside
    // a rolled-back transaction; the service runs against the restored copy and commits. If
    // they do not agree there, nothing else in this section means anything.
    const portability = await probe('src/cli/service-suite.ts', [TARGET, 'procedure_on_shadow']);
    check(
      portability.failed === 0 && (portability.passed as number) > 0,
      'the PROCEDURE reproduces every expectation on the shadow copy',
      `${portability.passed} passed, ${portability.failed} failed`,
    );
    note('the comparison base — without this the rest of the section is measuring two databases');

    const serviceSuite = await probe('src/cli/service-suite.ts', [TARGET, 'service']);
    const goldenCount = await client.query(
      `SELECT COUNT(*)::int AS n FROM golden_tests gt JOIN procedures p ON p.id = gt.procedure_id WHERE p.name = $1`,
      [TARGET],
    );
    check(
      (serviceSuite.passed as number) + (serviceSuite.failed as number) === goldenCount.rows[0].n,
      'the suite ran every golden case',
      `${serviceSuite.passed}+${serviceSuite.failed} of ${goldenCount.rows[0].n}`,
    );
    check(serviceSuite.failed === 0, 'and the generated service passes all of them', JSON.stringify(serviceSuite.failures));

    const traceable = await client.query(
      `SELECT COUNT(*)::int AS n FROM golden_tests gt JOIN procedures p ON p.id = gt.procedure_id
       WHERE p.name = $1 AND gt.source_invocation_id IS NOT NULL AND gt.baseline_context IS NOT NULL`,
      [TARGET],
    );
    check(
      traceable.rows[0].n === goldenCount.rows[0].n,
      'every case cites a real invocation and a recorded clock',
      `${traceable.rows[0].n}/${goldenCount.rows[0].n}`,
    );
    note('baseline_context is what the service is pinned to — declared at M4, written at M6');

    // The negative control. The reference implementation diverges, so the same suite must go
    // red against it. A suite that cannot fail is not evidence, and M1 and M2 each shipped an
    // assertion that compared a constant to itself before anyone asked what would make it red.
    const referenceSuite = await probe('src/cli/service-suite.ts', [TARGET, 'reference']);
    check(
      (referenceSuite.failed as number) > 0,
      'the same suite goes RED against the reference implementation',
      `${referenceSuite.passed} passed, ${referenceSuite.failed} failed`,
    );
    check(
      (referenceSuite.failed as number) < (referenceSuite.passed as number),
      'in a minority of cases — a finding, not a broken suite',
      `${referenceSuite.failed} of ${(referenceSuite.passed as number) + (referenceSuite.failed as number)}`,
    );

    const beforeSuite = await estateFingerprint(sa);
    const captureBefore = await sa
      .request()
      .query(`SELECT COUNT_BIG(*) AS n FROM parity_capture.Invocation WHERE ProcName = '${TARGET}'`);
    check(true, 'estate fingerprint taken before the flag exercise', `${captureBefore.recordset[0].n} capture rows`);

    // --- 4 · The shadow run against the generated service is green ------------
    section('4 · The shadow run against the generated service is green');

    const green = await client.query(
      `SELECT * FROM shadow_runs WHERE implementation_id = 'generated' AND kind = 'shadow'
         AND procedure_id = (SELECT id FROM procedures WHERE name = $1)
       ORDER BY id DESC LIMIT 1`,
      [TARGET],
    );
    check(green.rowCount === 1, 'a shadow run against the generated service exists');
    const g = green.rows[0] ?? {};
    check(g.status === 'succeeded', 'it succeeded', g.status);
    check((g.cases_replayed ?? 0) >= 100, 'it replayed a real number of cases', `${g.cases_replayed}`);
    check(g.strata_covered === g.strata_observed, 'covering every observed stratum', `${g.strata_covered}/${g.strata_observed}`);
    check((g.replay_ms ?? Infinity) < 60_000, 'in under a minute', `${((g.replay_ms ?? 0) / 1000).toFixed(1)}s`);
    // Not vacuous: the clock still moves between passes, so a run that found NOTHING raw would
    // mean the diff engine had stopped looking rather than that the service agreed.
    check((g.raw_diffs ?? 0) > 0, 'the diff engine was alive — raw differences were found', `${g.raw_diffs}`);
    check((g.behaviour_diffs ?? 0) === 0, 'and none of them survived as a behaviour change', `${g.behaviour_diffs}`);

    const survivingMoney = await client.query(
      `SELECT column_name, COUNT(*)::int AS n FROM diffs
       WHERE shadow_run_id = $1 AND canonical_equal = false AND column_name = ANY($2)
       GROUP BY column_name`,
      [g.id, MONEY],
    );
    check(survivingMoney.rowCount === 0, 'no money column differs at any magnitude', JSON.stringify(survivingMoney.rows));

    check(
      (g.implementation ?? '').includes(String(latest[0]?.run_hash ?? 'x').slice(0, 12)),
      'the run records which artefact it replayed',
      g.implementation ?? '',
    );

    // --- 5 · The reference implementation still diverges ----------------------
    section('5 · The reference implementation still diverges — the control');

    const r = referenceRun.rows[0] ?? {};
    check((r.behaviour_diffs ?? 0) > 0, 'the reference run found behavioural differences', `${r.behaviour_diffs}`);
    check(
      r.cases_replayed === g.cases_replayed,
      'same number of cases as the generated run — so the difference is attributable',
      `${r.cases_replayed} vs ${g.cases_replayed}`,
    );
    check(r.shadow_database === g.shadow_database, 'same database', r.shadow_database);

    const vatFinding = await client.query(
      `SELECT signature, COUNT(*)::int AS cases FROM diffs
       WHERE shadow_run_id = $1 AND verdict = 'behaviour_change' GROUP BY signature`,
      [r.id],
    );
    check(
      vatFinding.rows.some((row) => row.signature.includes('TotalVat') || row.signature.includes('TotalWithVat')),
      'including the promo/VAT defect',
      vatFinding.rows.map((row) => row.signature).join(' · '),
    );
    const totalNetDiverged = await client.query(
      `SELECT COUNT(*)::int AS n FROM diffs WHERE shadow_run_id = $1 AND column_name = 'TotalNet' AND canonical_equal = false`,
      [r.id],
    );
    check(totalNetDiverged.rows[0].n === 0, 'while TotalNet never diverges — which is why nobody found it in fifteen years');

    // Stronger than counting cases: the two runs replayed the SAME captured invocations, in
    // the same order. Selection is deterministic, so this should hold — and if it ever stops
    // holding, "the difference is the implementation" stops being true and every conclusion
    // drawn from comparing the two runs is drawn from comparing two different experiments.
    const caseSets = await client.query(
      `SELECT shadow_run_id, array_agg(source_invocation_id ORDER BY seq) AS ids
       FROM shadow_cases WHERE shadow_run_id = ANY($1) GROUP BY shadow_run_id`,
      [[r.id, g.id]],
    );
    const [setA, setB] = caseSets.rows.map((row) => JSON.stringify(row.ids));
    check(
      caseSets.rowCount === 2 && setA === setB,
      'both runs replayed the identical case set, in the same order',
      caseSets.rowCount === 2 ? '' : `${caseSets.rowCount} runs with cases`,
    );

    // --- 6 · The decision is real, and it is what made the run green ----------
    section('6 · The decision is real, and it is what earned `proven`');

    // Scoped to the procedure, not to one run. A decision is a record, not work: it outlives
    // the run that provoked it, and the procedure screen reads it that way for the same reason.
    // Which of the three actions was chosen is the presenter's call on stage, not something a
    // gate gets to require — what a gate can require is that a person chose, and chose first.
    const decision = await client.query(
      `SELECT d.*, sr.implementation_id FROM decisions d
       JOIN shadow_runs sr ON sr.id = d.shadow_run_id
       WHERE d.procedure_id = (SELECT id FROM procedures WHERE name = $1)
       ORDER BY d.decided_at ASC LIMIT 1`,
      [TARGET],
    );
    check((decision.rowCount ?? 0) === 1, 'a decision has been recorded on this procedure');
    check(
      ['preserve', 'accept', 'escalate'].includes(decision.rows[0]?.action),
      'with one of the three actions the queue offers',
      decision.rows[0]?.action ?? '',
    );
    check(decision.rows[0]?.decided_by === 'human', 'taken by a human', decision.rows[0]?.decided_by ?? '');
    check(decision.rows[0]?.agent_run_id === null, 'with no agent run behind it');
    check(
      decision.rows[0]?.implementation_id === 'reference',
      'against the reference run — the one that surfaced the difference',
      decision.rows[0]?.implementation_id ?? '',
    );
    check(
      new Date(decision.rows[0]?.decided_at).getTime() < new Date(g.started_at).getTime(),
      'and it was taken BEFORE the green run — the decision is what the service was built to honour',
    );

    // Distinct SIGNATURES on the run the queue actually asks about, not diff rows across every
    // run ever made. A finding is a signature — one item in the queue, decided once, covering
    // every case that carries it — so counting rows counts the same decision sixty-eight times,
    // and counting across superseded runs asks for decisions on work that has been superseded.
    // The same scoping mistake `classify_diff`, the decision undo and the queue itself each had
    // to be fixed for.
    const undecided = await client.query(
      `SELECT COUNT(DISTINCT df.signature)::int AS n FROM diffs df
       LEFT JOIN decisions d ON d.shadow_run_id = df.shadow_run_id AND d.diff_signature = df.signature
       WHERE df.shadow_run_id = $1 AND df.verdict = 'behaviour_change' AND d.id IS NULL`,
      [r.id],
    );
    check(undecided.rows[0].n === 0, 'every finding on that run has been decided', `${undecided.rows[0].n} open`);

    const prProbe = await probe('src/cli/probe-decision.ts');
    check(prProbe.attempted === true, 'a live agent still tries to record a decision');
    check(prProbe.decisionWritten === false, 'and is still refused, writing nothing');

    // --- 7 · The feature flag switches cleanly --------------------------------
    section('7 · The feature flag switches cleanly');

    const orderRow = await client.query(
      `SELECT gt.input_params->>'OrderNumber' AS n FROM golden_tests gt
       JOIN procedures p ON p.id = gt.procedure_id WHERE p.name = $1 LIMIT 1`,
      [TARGET],
    );
    const order = orderRow.rows[0]?.n as string;

    // The estate is about to be written to on purpose. Snapshot the rows, exercise both paths,
    // restore in a finally — the same discipline verify-m2 and verify-m5 use for their probes.
    //
    // Held in memory rather than in a #temp table: `sa` is a pool, so consecutive statements
    // land on whichever connection is free, and a session-scoped temp table written by one is
    // invisible to the next. The symptom is an `Invalid object name` in the `finally` — which
    // is the worst place for it, because that is the code that puts the estate back.
    const snapshot = (
      await sa.request().input('order', mssql.NVarChar(20), order).query(`
        SELECT OrderLineID, TotalNet, TotalVat, TotalWithVat, DiscountAmount, PromoCodeUsed,
               PromoDiscountAmount, LoyaltyDiscountAmount, LoyaltyPointsEarned, ShippingCost,
               CalcCachedAt, CalcVersion, ModifiedAt, ModifiedBy
        FROM dbo.OrderLedger WHERE OrderNumber = @order`)
    ).recordset;
    check(snapshot.length > 0, 'the rows about to be written are snapshotted first', `${snapshot.length} lines`);

    try {
      const call = async (flag: string | null): Promise<{ status: number; path?: string }> => {
        const response = await fetch(`${SHOP}/api/orders/${order}/total`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-parity-caller': 'verify:m6',
            ...(flag === null ? {} : { 'x-parity-pricing': flag }),
          },
          body: '{}',
          signal: AbortSignal.timeout(60_000),
        });
        const body = (await response.json()) as { path?: string };
        return { status: response.status, path: body.path };
      };

      // The capture buffers, so it must be flushed before it is counted — verify-m1 learned
      // the same thing. Counting by CallerContext rather than by ProcName because sampling
      // means an arbitrary call may or may not carry a result set, but every invocation the
      // gate makes is tagged and every tagged one is recorded.
      const flush = async (): Promise<void> => {
        await fetch(`${SHOP}/api/_capture/flush`, { method: 'POST', signal: AbortSignal.timeout(60_000) });
      };
      const tagged = async (): Promise<number> => {
        await flush();
        const row = await sa
          .request()
          .query(`SELECT COUNT_BIG(*) AS n FROM parity_capture.Invocation WHERE CallerContext = 'verify:m6'`);
        return Number(row.recordset[0].n);
      };

      const captureStart = await tagged();
      const off = await call(null);
      const captureAfterOff = await tagged();

      check(off.status === 200 && off.path === 'procedure', 'no header runs the procedure', off.path ?? `${off.status}`);
      check(
        captureAfterOff > captureStart,
        'and it lands in the capture, as a procedure call should',
        `${captureStart} -> ${captureAfterOff}`,
      );

      const on = await call('service');
      const captureAfterOn = await tagged();
      check(on.status === 200 && on.path === 'service', '`x-parity-pricing: service` runs the service', on.path ?? `${on.status}`);
      check(
        captureAfterOn === captureAfterOff,
        'and does NOT land in the capture — it was never a procedure call',
        `${captureAfterOff} -> ${captureAfterOn}`,
      );

      const garbage = await call('banana');
      check(garbage.path === 'procedure', 'an unrecognised value falls back to the old path', garbage.path ?? '');

      const liveHealth = await getJson<{ database: string; artifacts: Record<string, string | null> }>(`${LIVE}/health`);
      check(liveHealth.database === ESTATE_DB, 'the flagged target prices against the estate', liveHealth.database);
      check(liveHealth.artifacts?.[TARGET] === latest[0]?.run_hash, 'running the same artefact as the replay target');

      const flagged = await sa
        .request()
        .query(`SELECT InvocationID FROM parity_capture.Invocation WHERE CallerContext LIKE 'verify:%'`);
      const gateIds = flagged.recordset.map((row) => Number(row.InvocationID));
      check(gateIds.length > 0, 'the gate tags its own calls', `${gateIds.length} rows`);

      // The reason that tag exists. `shadow/cases.ts` filters `CallerContext NOT LIKE 'verify:%'`
      // so the harness never replays traffic the acceptance checks themselves generated —
      // otherwise every gate run would widen the population the next one draws from.
      const leaked = await client.query(
        `SELECT COUNT(*)::int AS n FROM shadow_cases WHERE source_invocation_id = ANY($1)`,
        [gateIds],
      );
      check(leaked.rows[0].n === 0, "and they are excluded from the harness's case selection", `${leaked.rows[0].n} leaked`);
    } finally {
      // Always. The estate the demo depends on being identical between rehearsals.
      for (const row of snapshot) {
        await sa
          .request()
          .input('id', mssql.Int, row.OrderLineID)
          .input('totalNet', mssql.Decimal(18, 4), row.TotalNet)
          .input('totalVat', mssql.Decimal(18, 4), row.TotalVat)
          .input('totalWithVat', mssql.Decimal(18, 4), row.TotalWithVat)
          .input('discount', mssql.Decimal(18, 4), row.DiscountAmount)
          .input('promoCode', mssql.NVarChar(40), row.PromoCodeUsed)
          .input('promoDiscount', mssql.Decimal(18, 4), row.PromoDiscountAmount)
          .input('loyaltyDiscount', mssql.Decimal(18, 4), row.LoyaltyDiscountAmount)
          .input('points', mssql.Int, row.LoyaltyPointsEarned)
          .input('shipping', mssql.Decimal(18, 4), row.ShippingCost)
          .input('cachedAt', mssql.DateTime2(3), row.CalcCachedAt)
          .input('version', mssql.NVarChar(20), row.CalcVersion)
          .input('modifiedAt', mssql.DateTime2(3), row.ModifiedAt)
          .input('modifiedBy', mssql.NVarChar(60), row.ModifiedBy)
          .query(`
            UPDATE dbo.OrderLedger
               SET TotalNet = @totalNet, TotalVat = @totalVat, TotalWithVat = @totalWithVat,
                   DiscountAmount = @discount, PromoCodeUsed = @promoCode,
                   PromoDiscountAmount = @promoDiscount, LoyaltyDiscountAmount = @loyaltyDiscount,
                   LoyaltyPointsEarned = @points, ShippingCost = @shipping,
                   CalcCachedAt = @cachedAt, CalcVersion = @version,
                   ModifiedAt = @modifiedAt, ModifiedBy = @modifiedBy
             WHERE OrderLineID = @id`);
      }
    }

    const afterFlag = await estateFingerprint(sa);
    check(afterFlag === beforeSuite, 'the estate fingerprint is back where it started', afterFlag === beforeSuite ? '' : 'MOVED');

    // --- 8 · A PR is produced, without opening one per gate run ---------------
    section('8 · A PR is produced, and only a person opens it');

    const assembled = await probe('src/cli/open-pr.ts', [TARGET]).catch(() => null);
    const prRows = await client.query(
      `SELECT pr.* FROM pull_requests pr JOIN procedures p ON p.id = pr.procedure_id WHERE p.name = $1 ORDER BY pr.id DESC`,
      [TARGET],
    );
    check((prRows.rowCount ?? 0) > 0, 'a pull request has been assembled', `${prRows.rowCount} rows`);
    const pr = prRows.rows[0] ?? {};
    check(pr.owner === (process.env.GITHUB_OWNER ?? 'secho'), 'against the configured owner', pr.owner);
    check(pr.repo === (process.env.GITHUB_REPO ?? 'parity-workspace'), 'and the configured repo', pr.repo);
    check(pr.base_branch === 'main', 'targeting main', pr.base_branch);

    const files = (pr.files ?? []) as { path: string }[];
    const paths = files.map((f) => f.path);
    check(paths.some((p) => p.endsWith('/pricing.ts')) && paths.some((p) => p.endsWith('/persist.ts')), 'carrying the service');
    check(paths.some((p) => p.endsWith('spec.md')), 'the specification');
    check(paths.some((p) => p.endsWith('golden-tests.md')), 'the golden tests');
    check(paths.some((p) => p.endsWith('decision.md')), 'and the recorded decision');
    check((pr.body ?? '').includes('Kandidáti na opravu'), 'the body names the fix candidates section');
    check(pr.artifact_hash === latest[0]?.run_hash, 'and it carries the artefact that was replayed');

    const prObserved = await probe('src/cli/probe-pr.ts', [TARGET]);
    check(prObserved.attempted === true, 'a live agent tries to open the PR itself');
    check(prObserved.blockedTools !== undefined && (prObserved.blockedTools as string[]).length > 0, 'and the hook refuses it');
    check(prObserved.openedByProbe === 0, 'and it opened nothing', `${prObserved.openedBefore} → ${prObserved.openedAfter} open`);

    // --- 9 · The estate moved, honestly ---------------------------------------
    section('9 · The estate moved, honestly');

    const target = procs.rows.find((p) => p.name === TARGET);
    check(target?.oracle_state === 'proven', 'oracle_state is `proven`', target?.oracle_state ?? '');
    check(target?.campaign_status === 'migrated', 'campaign_status is `migrated`', target?.campaign_status ?? '');

    const estate = await getJson<{ procedures: { name: string; blocker: { key: string } | null }[] }>(`${API}/api/procedures`);
    const shown = estate.procedures.find((p) => p.name === TARGET);
    check(shown?.blocker === null, 'and nothing blocks it any more', JSON.stringify(shown?.blocker));
    note('proven short-circuits ahead of the domain check — domain is null on every row in this estate');

    const others = estate.procedures.filter((p) => p.name !== TARGET);
    check(others.every((p) => p.blocker !== null || p.name === TARGET), 'every other procedure still reports its blocker');

    // --- 10 · Reset and determinism -------------------------------------------
    section('10 · Reset and determinism');

    await client.query('BEGIN');
    const artefactsBefore = await client.query(`SELECT COUNT(*)::int AS n FROM service_artifacts`);
    const prsBefore = await client.query(`SELECT COUNT(*)::int AS n FROM pull_requests`);
    await client.query(`DELETE FROM procedures`);
    const artefactsAfter = await client.query(`SELECT COUNT(*)::int AS n FROM service_artifacts`);
    const prsAfter = await client.query(`SELECT COUNT(*)::int AS n FROM pull_requests`);
    await client.query('ROLLBACK');

    check(artefactsBefore.rows[0].n > 0 && artefactsAfter.rows[0].n === 0, 'service_artifacts cascades from procedures');
    check(prsBefore.rows[0].n > 0 && prsAfter.rows[0].n === 0, 'pull_requests cascades too');
    const stillThere = await client.query(`SELECT COUNT(*)::int AS n FROM procedures`);
    check(stillThere.rows[0].n === 14, 'and the rollback held', `${stillThere.rows[0].n}`);
    note('so `make demo-reset` takes the generated service and the PR record with it');

    const suiteAgain = await probe('src/cli/service-suite.ts', [TARGET, 'service']);
    check(
      suiteAgain.passed === serviceSuite.passed && suiteAgain.failed === serviceSuite.failed,
      'two consecutive service-side suite runs agree',
      `${suiteAgain.passed}/${suiteAgain.failed} vs ${serviceSuite.passed}/${serviceSuite.failed}`,
    );

    const referenceHealth = await getJson<{ status: string }>(`${REFERENCE}/health`);
    check(referenceHealth.status === 'ok', 'the reference implementation is still standing', referenceHealth.status);
    note('it is permanent — it is the only implementation that diverges, and therefore the control');
  } finally {
    await sa.close();
    await client.end();
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
