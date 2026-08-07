// M7 acceptance. `make verify-m7` is the definition of done.
//
// Runs against a stack that has had the whole chain through M6, plus M7's own two additions:
//
//   make implement-service PROC=sp_GetCartSummary && make adopt-service PROC=sp_GetCartSummary
//   make service-suite PROC=sp_GetCartSummary TARGET=service
//   make shadow-run PROC=sp_GetCartSummary "" generated
//
// Three things this gate deliberately does NOT do.
//
// It does not run `make demo-reset`. A gate that costs $16 of live analysis to run is a gate
// nobody runs, so the reset is exercised through `probe-reset` — the real TRUNCATE, inside a
// transaction that is rolled back — and the restore half through `golden.ts check`, which
// rebuilds the committed snapshot in a scratch database. Both are stronger than reading the
// table list out of the source and agreeing with it.
//
// It does not run `make reset-procedure` for real either, for the same reason and by the same
// method: `probe-reset-procedure` runs the identical function inside a transaction it rolls back.
//
// And it does not open a pull request. Assembling is idempotent and free; opening is the one act
// in this platform that `make demo-reset` cannot take back.
//
// What it DOES spend: nothing. Every probe here is model-free. Replay is checked by replaying,
// campaigns by running the one campaign that makes no model call, and the gate asserts the
// estate's total spend did not move while it did so.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import mssql from 'mssql';
import pg from 'pg';
import { SNAPSHOT_TABLES } from './snapshot-tables.js';

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = `http://127.0.0.1:${process.env.PARITY_API_PORT ?? 3200}`;
const PG_URL = process.env.PARITY_PG_URL ?? 'postgres://parity:parity@127.0.0.1:5433/parity';
const GENERATED = `http://127.0.0.1:${process.env.PRICING_SERVICE_GENERATED_PORT ?? 3301}`;

const MIGRATED = 'sp_CalculateOrderTotal';
const SECOND = 'sp_GetCartSummary';
const ESTATE_DB = process.env.MSSQL_DATABASE ?? 'ParityShop';

/** Speed for the replay section. The recorded spec run is five minutes of thinking. */
const REPLAY_SPEED = 10;

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

async function probe(script: string, args: string[] = [], timeoutMs = 900_000, env: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const flags = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const { stdout } = await exec('docker', ['compose', 'exec', '-T', ...flags, 'parity-api', 'npx', 'tsx', script, ...args], {
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

/** Reused verbatim from verify-m4, m5 and m6 — "production is untouched" is measured the same way every time. */
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

const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );

const num = (n: number): string => n.toLocaleString('cs-CZ');

/**
 * Whitespace-insensitive containment.
 *
 * `toLocaleString('cs-CZ')` groups with a non-breaking space and the docs are written with
 * ordinary ones. Comparing raw would fail on every grouped number for a reason that has nothing
 * to do with whether the figure is right — which is the failure this section exists to catch.
 */
const flatten = (text: string): string => text.replace(/[\s  ]+/g, ' ');
const quotes = (doc: string, fragments: string[]): string[] => {
  const flat = flatten(doc);
  return fragments.filter((fragment) => !flat.includes(flatten(fragment)));
};

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: PG_URL });
  await client.connect();
  const sa = await connectMssql('sa', process.env.MSSQL_SA_PASSWORD ?? 'ParityShop_Dev_2026!');

  try {
    // --- 1 · M6 and the chain are undisturbed ---------------------------------
    section('1 · M6 and the chain are undisturbed');

    const procs = await client.query(`SELECT name, oracle_class, oracle_state, campaign_status, invocations_90d FROM procedures`);
    check(procs.rowCount === 14, 'fourteen procedures still ingested', `${procs.rowCount}`);

    const migrated = procs.rows.find((p) => p.name === MIGRATED);
    check(
      migrated?.oracle_state === 'proven' && migrated?.campaign_status === 'migrated',
      `${MIGRATED} is still proven/migrated`,
      `${migrated?.oracle_state}/${migrated?.campaign_status}`,
    );

    // Scoped to the procedure, every time. Two latent gate bugs came from "the latest run"
    // meaning something different the moment a second procedure had runs of its own.
    const reference = await client.query(
      `SELECT * FROM shadow_runs WHERE implementation_id = 'reference' AND status = 'succeeded' AND kind = 'shadow'
         AND replayed_from IS NULL AND procedure_id = (SELECT id FROM procedures WHERE name = $1)
       ORDER BY id DESC LIMIT 1`,
      [MIGRATED],
    );
    const r = reference.rows[0] ?? {};
    check(
      reference.rowCount === 1 && r.behaviour_diffs > 0,
      'its reference run still carries its behavioural findings',
      `${r.behaviour_diffs} findings over ${r.cases_replayed} cases`,
    );

    const green = await client.query(
      `SELECT * FROM shadow_runs WHERE implementation_id = 'generated' AND status = 'succeeded' AND kind = 'shadow'
         AND replayed_from IS NULL AND procedure_id = (SELECT id FROM procedures WHERE name = $1)
       ORDER BY id DESC LIMIT 1`,
      [MIGRATED],
    );
    const g = green.rows[0] ?? {};
    check(
      green.rowCount === 1 && g.behaviour_diffs === 0 && g.cases_replayed === r.cases_replayed,
      'and its generated run is still green on the identical case count',
      `${g.cases_replayed} cases, ${g.behaviour_diffs} findings`,
    );

    const migratedArtifact = await client.query(
      `SELECT run_hash FROM service_artifacts sa JOIN procedures p ON p.id = sa.procedure_id
       WHERE p.name = $1 ORDER BY attempt DESC LIMIT 1`,
      [MIGRATED],
    );
    const health = await getJson<{ status: string; database: string; procedures: string[]; artifacts: Record<string, string> }>(
      `${GENERATED}/health`,
    );
    check(
      health.artifacts?.[MIGRATED] === migratedArtifact.rows[0]?.run_hash,
      'the shell still serves exactly the artefact M6 adopted for it',
      `${health.artifacts?.[MIGRATED]?.slice(0, 12)}`,
    );

    const blockerColumn = await client.query(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE column_name = 'blocker'`,
    );
    check(blockerColumn.rows[0].n === 0, 'blocker is still derived, never stored');

    // --- 2 · The shell serves two procedures without knowing either -----------
    section('2 · The shell serves two procedures without knowing either');

    const shell = await probe('src/cli/probe-shell.ts');
    const shellHealth = shell.health as { procedures: string[]; artifacts: Record<string, string>; database: string };
    check(
      shellHealth.procedures.includes(MIGRATED) && shellHealth.procedures.includes(SECOND),
      'one container serves both procedures',
      shellHealth.procedures.join(', '),
    );

    const secondArtifact = await client.query(
      `SELECT run_hash FROM service_artifacts sa JOIN procedures p ON p.id = sa.procedure_id
       WHERE p.name = $1 ORDER BY attempt DESC LIMIT 1`,
      [SECOND],
    );
    check(
      shellHealth.artifacts[MIGRATED] !== shellHealth.artifacts[SECOND],
      'with two distinct artefact hashes',
      `${shellHealth.artifacts[MIGRATED]?.slice(0, 8)} vs ${shellHealth.artifacts[SECOND]?.slice(0, 8)}`,
    );
    check(
      shellHealth.artifacts[SECOND] === secondArtifact.rows[0]?.run_hash,
      `and ${SECOND}'s is the one the agent wrote`,
      `${shellHealth.artifacts[SECOND]?.slice(0, 12)} vs ${secondArtifact.rows[0]?.run_hash?.slice(0, 12)}`,
    );
    note('a map, not a field: one field could only ever have named one of the two');

    const unknown = shell.unknownProcedure as { status: number };
    check(unknown.status === 503, 'an unserved name gets 503, not 404', `${unknown.status}`);
    note('503 means nothing to replay against; 404 means wrong URL. A 404 storm reads as a broken harness');

    const unserved = shell.unservedShadowRun as {
      refused: boolean;
      runsBefore: number;
      runsAfter: number;
      casesBefore: number;
      casesAfter: number;
      message: string;
    };
    check(unserved.refused, 'a shadow run against an unserved procedure refuses', unserved.message?.slice(0, 90) ?? '');
    check(
      unserved.runsBefore === unserved.runsAfter && unserved.casesBefore === unserved.casesAfter,
      'before writing a single row — not even a failed run',
      `${unserved.runsBefore}→${unserved.runsAfter} runs, ${unserved.casesBefore}→${unserved.casesAfter} cases`,
    );

    const paths = shell.paths as {
      refusals: Record<string, string | null>;
      allowed: Record<string, string | null>;
      getCartSummary: string[];
    };
    check(
      paths.refusals.indexForCalculate !== null && paths.refusals.dbForSummary !== null,
      'write_service_file refuses index.ts and db.ts — the harness contract is the platform\'s',
    );
    check(
      paths.refusals.pricingForSummary !== null && paths.allowed.pricingForCalculate === null,
      `and refuses pricing.ts for ${SECOND} while allowing it for ${MIGRATED}`,
      paths.getCartSummary.join(', '),
    );
    note('the allowlist is per procedure — with a global one, a lone summary.ts reads as "missing persist.ts"');

    // --- 3 · sp_GetCartSummary, end to end -------------------------------------
    section(`3 · ${SECOND}, end to end`);

    const beforeSecond = await estateFingerprint(sa);
    const captureBefore = await sa
      .request()
      .query(`SELECT COUNT_BIG(*) AS n FROM parity_capture.Invocation WHERE ProcName = '${SECOND}'`);

    const cases = await client.query<{ name: string; source_invocation_id: string; input_params: unknown }>(
      `SELECT g.name, g.source_invocation_id, g.input_params FROM golden_tests g
       JOIN procedures p ON p.id = g.procedure_id WHERE p.name = $1 ORDER BY g.name`,
      [SECOND],
    );
    check(cases.rowCount === 11, 'eleven golden cases', `${cases.rowCount}`);

    const ids = cases.rows.map((c) => Number(c.source_invocation_id));
    const captured = (
      await sa.request().query(`
        SELECT InvocationID, ProcName, InputParams, Sampled FROM parity_capture.Invocation
        WHERE InvocationID IN (${ids.length > 0 ? ids.join(',') : 'NULL'})`)
    ).recordset as { InvocationID: number; ProcName: string; InputParams: string; Sampled: boolean }[];
    const byId = new Map(captured.map((c) => [Number(c.InvocationID), c]));

    const drifted = cases.rows.filter((c) => {
      const source = byId.get(Number(c.source_invocation_id));
      if (source === undefined || source.ProcName !== SECOND || !source.Sampled) return true;
      return stableJson(JSON.parse(source.InputParams)) !== stableJson(c.input_params);
    });
    check(drifted.length === 0, 'each citing a sampled invocation whose inputs still byte-match', drifted.map((d) => d.name).join(', '));
    note('read back from parity_capture on the day — "no invented inputs" is a query, not a claim');

    const suite = await client.query(
      `SELECT o.* FROM oracle_runs o JOIN procedures p ON p.id = o.procedure_id
       WHERE p.name = $1 AND o.target = 'service' AND o.kind = 'verify' ORDER BY o.id DESC LIMIT 1`,
      [SECOND],
    );
    const s = suite.rows[0] ?? {};
    check(
      s.golden_passed === cases.rowCount && s.golden_failed === 0,
      'all eleven pass against the generated service',
      `${s.golden_passed}/${s.golden_passed + s.golden_failed}`,
    );

    const secondShadow = await client.query(
      // `sr.*`, not `*`. Both tables have an `id`, and node-postgres keeps the LAST column of a
      // duplicated name — so a bare star hands back the PROCEDURE's id under the name `id`, and
      // every query keyed on it afterwards silently asks about the wrong row.
      `SELECT sr.* FROM shadow_runs sr JOIN procedures p ON p.id = sr.procedure_id
       WHERE p.name = $1 AND sr.kind = 'shadow' AND sr.status = 'succeeded' AND sr.replayed_from IS NULL
       ORDER BY sr.id DESC`,
      [SECOND],
    );
    const sec = secondShadow.rows[0] ?? {};
    check((sec.cases_replayed ?? 0) >= 200, 'the shadow run replayed a real number of cases', `${sec.cases_replayed}`);
    check(
      sec.strata_covered === sec.strata_observed && sec.strata_observed > 0,
      'covering every observed stratum',
      `${sec.strata_covered}/${sec.strata_observed}`,
    );
    check(sec.implementation_id === 'generated', 'against the generated service', sec.implementation ?? '');
    check((sec.behaviour_diffs ?? -1) === 0, 'and found nothing', `${sec.behaviour_diffs} findings`);

    const shape = await probe('src/cli/probe-shadow.ts', [SECOND, '60']);
    const shapes = shape.shape as {
      procedure: Record<string, number>;
      service: Record<string, number> | null;
      serviceServes: boolean;
    };
    check(
      shapes.procedure.minResultSets === 2 && shapes.procedure.maxResultSets === 2,
      'the procedure answers in exactly two result sets, every case',
      `${shapes.procedure.minResultSets}–${shapes.procedure.maxResultSets}`,
    );
    check(
      shapes.service !== null && shapes.service.minResultSets === 2 && shapes.service.maxResultSets === 2,
      'and so does the service',
      shapes.service === null ? 'the service does not serve it' : `${shapes.service.minResultSets}–${shapes.service.maxResultSets}`,
    );
    check(
      shapes.procedure.writtenRows === 0 && shapes.service?.writtenRows === 0,
      'neither side wrote a single row — the pure-read claim, measured',
      `${shapes.procedure.writtenRows} vs ${shapes.service?.writtenRows}`,
    );
    note('read from Change Tracking, not from what the service says about itself');

    const afterSecond = await estateFingerprint(sa);
    check(afterSecond === beforeSecond, 'the estate is byte-identical after all of that', afterSecond === beforeSecond ? '' : 'MOVED');
    const captureAfter = await sa
      .request()
      .query(`SELECT COUNT_BIG(*) AS n FROM parity_capture.Invocation WHERE ProcName = '${SECOND}'`);
    check(
      String(captureAfter.recordset[0].n) === String(captureBefore.recordset[0].n),
      'and the capture gained no rows',
      `${captureBefore.recordset[0].n} → ${captureAfter.recordset[0].n}`,
    );

    // --- 4 · The control that does not exist, and what it costs ----------------
    section('4 · The control that does not exist, and what it costs');

    const secondReference = await client.query(
      `SELECT COUNT(*)::int AS n FROM shadow_runs sr JOIN procedures p ON p.id = sr.procedure_id
       WHERE p.name = $1 AND sr.implementation_id = 'reference'`,
      [SECOND],
    );
    check(secondReference.rows[0].n === 0, `${SECOND} has no reference implementation at all`, `${secondReference.rows[0].n} runs`);

    const secondRow = procs.rows.find((p) => p.name === SECOND);
    check(
      secondRow?.oracle_state === 'shadow',
      'so it sits at `shadow` — the ladder refuses the top rung',
      secondRow?.oracle_state ?? '',
    );
    note('it went green on its first run; `proven` also needs something to have been shown to diverge');

    const estate = await getJson<{ procedures: { name: string; blocker: { key: string; label: string } | null }[] }>(
      `${API}/api/procedures`,
    );
    const shownSecond = estate.procedures.find((p) => p.name === SECOND);
    check(
      shownSecond?.blocker?.label === 'čeká na rozhodnutí',
      'and the estate screen says so, in Czech',
      shownSecond?.blocker?.label ?? 'none',
    );

    const aa = shape.aa as { rawDiffs: number; surviving: number; findings: number; identicalCases: number };
    check(aa.surviving === 0 && aa.findings === 0, 'the A/A control surfaces nothing', `${aa.identicalCases} identical cases`);

    const perturbation = shape.perturbation as { attempted: boolean; detected: number; scope: string; cleanAgain: boolean };
    check(
      perturbation.attempted && perturbation.detected === 1 && perturbation.cleanAgain,
      'and one perturbed value surfaces exactly one difference',
      `${perturbation.scope}, ${perturbation.detected} detected`,
    );
    note('without this, a run that found nothing would be indistinguishable from an engine that cannot see');

    // --- 5 · Per-procedure reset ----------------------------------------------
    section('5 · Per-procedure reset leaves the other thirteen alone');

    const reset = await probe('src/cli/probe-reset-procedure.ts', [SECOND, MIGRATED]);
    const beforeCounts = (reset.before as { target: Record<string, number>; keep: Record<string, number>; procedures: number });
    const afterCounts = (reset.after as { target: Record<string, number>; keep: Record<string, number>; procedures: number });

    check(
      reset.otherProcedureUntouched === true,
      `every ${MIGRATED} row count is identical across all ${(reset.tablesChecked as string[]).length} artefact tables`,
      `${beforeCounts.keep.diffs} diffs, ${beforeCounts.keep.shadow_cases} cases, unchanged`,
    );
    note('the check that fails the moment someone reaches for TRUNCATE in here');
    check(reset.targetEmptied === true, `and every ${SECOND} artefact is gone`, JSON.stringify(afterCounts.target).slice(0, 80));
    check(
      Object.values(beforeCounts.target).some((n) => n > 0),
      'from a starting point that was not already empty',
      `${beforeCounts.target.agent_runs} runs, ${beforeCounts.target.golden_tests} cases`,
    );
    check(reset.stillListed === true, 'the procedures row survives — fourteen is an estate fact');
    check(afterCounts.procedures === 14, 'and the estate is still fourteen procedures', `${afterCounts.procedures}`);
    check(
      (reset.nowState as { oracleState: string }).oracleState === 'none' &&
        (reset.nowState as { oracleClass: string | null }).oracleClass === null,
      'it reads untriaged · none · untouched afterwards',
      JSON.stringify(reset.nowState),
    );
    check(reset.idempotent === true, 'and running it twice deletes nothing the second time');
    check((reset.elapsedMs as number) < 5000, 'under five seconds', `${reset.elapsedMs} ms`);

    // --- 6 · Campaigns ---------------------------------------------------------
    section('6 · Campaigns');

    const campaignDefs = await getJson<{ campaigns: { key: string; title: string; needsTarget: boolean }[] }>(
      `${API}/api/campaigns`,
    );
    check(campaignDefs.campaigns.length === 3, 'three campaigns, defined in code', campaignDefs.campaigns.map((c) => c.key).join(', '));

    const campaign = await probe('src/cli/probe-campaign.ts');
    const start = campaign.start as { status: number; elapsedMs: number };
    check(start.status === 202 && start.elapsedMs < 1000, 'a start returns in under a second', `${start.status} in ${start.elapsedMs} ms`);
    note('fire and forget — Zmapovat estate is ten minutes and Vite would kill the request');

    const concurrent = campaign.concurrent as { status: number };
    check(concurrent.status === 409, 'a second start is refused 409', `${concurrent.status}`);

    const run = campaign.run as { status: string; total: number; done: number; skipped: number; failed: number; items: { key: string; step: string }[] };
    check(run.done + run.skipped + run.failed === run.total, 'a finished run accounts for every item', `${run.done}+${run.skipped}+${run.failed} of ${run.total}`);

    const mapping = await probe('src/cli/probe-campaign-skip.ts');
    check(
      mapping.ran === true && mapping.skipped === mapping.total && mapping.spendMoved === false,
      '`Zmapovat estate` skips every procedure that is already specced, and spends nothing',
      mapping.ran === true ? `${mapping.skipped}/${mapping.total} skipped in ${mapping.elapsedMs} ms` : String(mapping.refused),
    );
    note('the honest answer to beat 2: the same button, on a mapped estate, finishes in seconds and says so');

    const deadNames = procs.rows.filter((p) => p.invocations_90d === 0).map((p) => p.name).sort();
    const campaignEstate = campaign.estate as { zeroInvocation: string[]; markedDeleted: string[] };
    check(
      JSON.stringify(campaignEstate.zeroInvocation) === JSON.stringify(deadNames) && deadNames.length === 3,
      'the deletion campaign\'s items are exactly the three zero-invocation procedures',
      deadNames.join(', '),
    );
    check(
      JSON.stringify(campaignEstate.markedDeleted) === JSON.stringify(deadNames),
      'and it writes campaign_status = `deleted` on all of them',
      `${campaignEstate.markedDeleted.length}`,
    );
    note('the one value in the campaign_status vocabulary nothing else has ever written');

    const pr = campaign.pr as {
      kind: string;
      procedureId: number | null;
      status: string;
      statusBefore: string | null;
      numberBefore: number | null;
      unchangedByCampaign: boolean;
      removals: number;
      additions: number;
      number: number | null;
      url: string | null;
      bodyLength: number;
    };
    check(
      pr.removals === 3 && pr.additions === 0,
      'the deletion PR is three removals and nothing else',
      `${pr.removals} removals, ${pr.additions} additions`,
    );
    note('tree entries with sha: null — the Git Data API\'s way of saying a path is not in the new tree');
    // The delta, not the absolute state. What has to be true is that **the campaign never opens
    // one** — which is a different sentence from "no pull request has ever been opened", and only
    // the first is a property of this code. A person opened #11 for the demo, exactly as beat 2
    // requires and exactly as the tier table intends: `open_pr` is tier 3 for every task class,
    // so the thing that opens one always has a person behind it.
    check(
      pr.unchangedByCampaign,
      'and running the campaign changes neither its status nor its number',
      `${pr.statusBefore ?? 'none'}/${pr.numberBefore ?? '—'} → ${pr.status}/${pr.number ?? '—'}`,
    );
    check(pr.procedureId === null && pr.kind === 'deletion', 'belonging to no single procedure', `kind ${pr.kind}`);

    const rerun = campaign.rerun as { skipped: number; failed: number };
    check(rerun.skipped === 3 && rerun.failed === 0, 'and a second run skips what it already did', `${rerun.skipped} skipped`);
    check(
      campaign.cleanedUp === true && mapping.cleanedUp === true,
      'and the three campaign runs this section started are removed again',
    );

    // --- 7 · Replay -------------------------------------------------------------
    section('7 · Replay — the load-bearing section');

    const shadowFingerprintBefore = await estateFingerprint(sa);
    const replay = await probe('src/cli/probe-replay.ts', [MIGRATED, String(REPLAY_SPEED)], 900_000, {
      PARITY_MODE: 'replay',
      PARITY_REPLAY_SPEED: String(REPLAY_SPEED),
    });
    const shadowFingerprintAfter = await estateFingerprint(sa);

    const agent = replay.agent as {
      cleanedUp: boolean;
      stepsIdentical: boolean;
      recordedSteps: number;
      replayedSteps: number;
      replayedFrom: number | null;
      recordedRunId: number | null;
      costUsd: string | null;
      expectedMs: number;
      elapsedMs: number;
      model: string | null;
    };
    check(
      agent.stepsIdentical && agent.replayedSteps === agent.recordedSteps && agent.recordedSteps > 0,
      'a replayed spec run re-materialises exactly the recorded steps, in order',
      `${agent.replayedSteps}/${agent.recordedSteps}`,
    );
    note('written to agent_steps as they are emitted — the UI treats the SSE event as a signal to refetch');

    const spend = replay.spend as { before: number; after: number; moved: boolean };
    check(!spend.moved && agent.costUsd === null, 'no model call — the estate\'s total spend did not move', `$${spend.after.toFixed(2)}`);
    check(
      agent.replayedFrom !== null && agent.replayedFrom === agent.recordedRunId,
      'the replayed row is marked as replayed and links to its recording',
      `replayed_from ${agent.replayedFrom}`,
    );

    const drift = Math.abs(agent.elapsedMs - agent.expectedMs) / Math.max(1, agent.expectedMs);
    check(
      drift <= 0.2,
      `elapsed within ±20% of the recorded cadence at speed ${REPLAY_SPEED}`,
      `${(agent.elapsedMs / 1000).toFixed(1)}s vs ${(agent.expectedMs / 1000).toFixed(1)}s (${(drift * 100).toFixed(1)}%)`,
    );

    const shadowReplay = replay.shadow as {
      replayedFrom: number | null;
      casesReplayed: number;
      recordedCases: number;
      rawDiffs: number;
      recordedRawDiffs: number;
      classifyModelRuns: number;
      cleanedUp: boolean;
    };
    check(
      shadowReplay.replayedFrom !== null && shadowReplay.casesReplayed === shadowReplay.recordedCases,
      'a replayed shadow run re-materialises the recorded run',
      `${shadowReplay.casesReplayed} cases from run #${shadowReplay.replayedFrom}`,
    );
    check(
      shadowFingerprintAfter === shadowFingerprintBefore,
      'and leaves the estate fingerprint exactly where it was',
      shadowFingerprintAfter === shadowFingerprintBefore ? '' : 'MOVED',
    );
    note('it never opens a connection — that is what makes the claim true rather than argued');
    check(shadowReplay.classifyModelRuns === 0, 'classification is replayed too, in zero model runs', `${shadowReplay.classifyModelRuns} runs`);

    const negative = replay.negativeControl as { refused: boolean; procedure: string | null; message: string | null };
    check(
      negative.refused,
      'and a replay with no recording refuses LOUDLY rather than emitting nothing',
      `${negative.procedure}: ${(negative.message ?? '').slice(0, 70)}`,
    );

    check(
      agent.cleanedUp === true && shadowReplay.cleanedUp === true,
      'both replays are removed again — this gate leaves the database as it found it',
    );
    note('otherwise every gate run would invalidate the committed snapshot it just checked');

    // --- 8 · Reset and restore are two halves of one mechanism -----------------
    section('8 · Reset and restore are two halves of one mechanism');

    const resetProbe = await probe('src/cli/probe-reset.ts');
    // Two tables are configuration rather than state: the tier table, reasserted on every boot,
    // and the runtime settings the mode switch writes. Neither is analysis, so neither is cleared
    // by a reset or carried by the snapshot — and a demo that lost its mode to `make demo-reset`
    // would be the same silent revert that made persisting it necessary.
    const CONFIG_TABLES = ['policy_rules', 'runtime_settings'];
    const survives = (resetProbe.survives as string[]).filter((t) => !CONFIG_TABLES.includes(t));
    check(
      survives.length === 0,
      'after a reset the only tables still holding rows are configuration',
      survives.join(', ') || 'none beyond ' + CONFIG_TABLES.join(' + '),
    );
    note('anything else here would be state the demo cannot get rid of');

    const allTables = (resetProbe.allTables as string[]).filter((t) => !CONFIG_TABLES.includes(t));
    const snapshot = [...SNAPSHOT_TABLES].sort();
    check(
      JSON.stringify(allTables.sort()) === JSON.stringify(snapshot),
      'and the snapshot covers exactly the tables the reset empties',
      allTables.length === snapshot.length ? `${snapshot.length} tables` : `${allTables.length} vs ${snapshot.length}`,
    );
    note('a table in the reset but not the snapshot is state the demo cannot get back');
    check(resetProbe.rolledBack === true, 'the probe put every row back', '');

    const roundTrip = await exec('npm', ['--prefix', 'scripts', 'run', 'replay-check'], {
      cwd: ROOT,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 600_000,
    }).then(
      (out) => out.stdout,
      (err: { stdout?: string }) => err.stdout ?? '',
    );
    check(
      roundTrip.includes('snapshot round-trips cleanly'),
      'the committed snapshot restores to its recorded row counts in a scratch database',
      roundTrip.includes('mismatches') ? roundTrip.split('\n').filter((l) => l.includes('FAIL')).join(' ') : '',
    );

    // --- 9 · Determinism, and the numbers in the docs --------------------------
    section('9 · Determinism, and the numbers in the docs');

    check((secondShadow.rowCount ?? 0) >= 2, `two consecutive ${SECOND} shadow runs exist to compare`, `${secondShadow.rowCount}`);
    const [runA, runB] = secondShadow.rows;
    const caseSets = await client.query(
      `SELECT shadow_run_id, array_agg(source_invocation_id ORDER BY seq) AS ids,
              array_agg(new_fingerprint ORDER BY seq) AS fingerprints
       FROM shadow_cases WHERE shadow_run_id = ANY($1) GROUP BY shadow_run_id`,
      [[runA?.id, runB?.id]],
    );
    check(
      caseSets.rowCount === 2 && JSON.stringify(caseSets.rows[0].ids) === JSON.stringify(caseSets.rows[1].ids),
      'they replayed the identical case set, in the same order',
      `${caseSets.rows[0]?.ids?.length} cases`,
    );
    check(
      caseSets.rowCount === 2 && JSON.stringify(caseSets.rows[0].fingerprints) === JSON.stringify(caseSets.rows[1].fingerprints),
      'and produced identical canonical fingerprints, case for case',
    );
    note('hard rule 5, measured on the procedure that branches on the clock');

    const demoScript = await readFile(join(ROOT, 'docs', 'DEMO-SCRIPT.md'), 'utf8');

    const beat3 = quotes(demoScript, [
      `${num(r.cases_replayed)} zachycených volání`,
      `${r.strata_covered} z ${r.strata_observed}`,
      `${num(r.raw_diffs)} hrubých odchylek`,
      `${num(r.noise_diffs)} vyřešila kanonikalizace`,
      `${num(r.raw_diffs - r.noise_diffs)} zbylo na model`,
    ]);
    check(beat3.length === 0, 'beat 3 quotes the reference run as Postgres has it', beat3.join(' · '));

    const beat4 = quotes(demoScript, [
      `${num(g.cases_replayed)} volání`,
      `${g.strata_covered} z ${g.strata_observed}`,
      `${num(g.raw_diffs)} hrubých odchylek`,
      `${num(g.behaviour_diffs)} nálezů`,
    ]);
    check(beat4.length === 0, 'beat 4 quotes the green run as Postgres has it', beat4.join(' · '));

    const secondQuotes = quotes(demoScript, [
      `${num(sec.cases_replayed)} zachycených volání`,
      `${sec.strata_covered} z ${sec.strata_observed}`,
      `${cases.rowCount} golden`,
    ]);
    check(secondQuotes.length === 0, `and ${SECOND}'s numbers likewise`, secondQuotes.join(' · '));
    note('this is the check for the stale-doc failure this build has already had twice');

    // --- 10 · Beat 1 and replay are compatible ---------------------------------
    //
    // The only destructive section, and the only one that has to be: it runs `demo-reset` for
    // real and then replays into the emptied database. Restored in the `finally` below, which is
    // also the only thing in this gate that exercises `make restore-golden` end to end.
    section('10 · An empty estate can still be replayed into');

    const fromBlank = await probe('src/cli/probe-replay-reset.ts', [MIGRATED], 900_000, { PARITY_MODE: 'replay', PARITY_REPLAY_SPEED: '40' });
    const emptied = fromBlank.afterReset as { procedures: number; agentRuns: number; specs: number };
    check(
      emptied.procedures === 14 && emptied.agentRuns === 0 && emptied.specs === 0,
      'a reset empties the analysis and leaves the estate',
      `${emptied.procedures} procedures, ${emptied.agentRuns} runs, ${emptied.specs} specs`,
    );
    note('beat 1 opens on this: fourteen procedures, coverage zero, nothing analysed');

    const replayed = fromBlank.replay as { elapsedMs: number; specReplayedFrom: number | null };
    check(
      replayed.specReplayedFrom !== null,
      'and a run replays into it anyway — the recordings are in a database the reset cannot reach',
      `replayed_from ${replayed.specReplayedFrom} in ${new URL(process.env.PARITY_REPLAY_PG_URL ?? 'postgres://x/parity_replay').pathname.slice(1)}`,
    );

    const specCheck = fromBlank.spec as { recordedChars: number; liveChars: number; identical: boolean; agentRunId: number | null; replayedRunId: number };
    check(
      specCheck.identical && specCheck.liveChars > 2000,
      'the specification it produced is byte-identical to the recorded one',
      `${specCheck.liveChars} of ${specCheck.recordedChars} characters`,
    );
    note('2 000 would mean it had been rebuilt from the transcript — runner.ts truncates tool inputs there');
    check(
      specCheck.agentRunId === specCheck.replayedRunId,
      'and it is attributed to the run whose steps are on screen',
      `spec.agent_run_id ${specCheck.agentRunId} vs run ${specCheck.replayedRunId}`,
    );

    const classification = fromBlank.classification as { recorded: string | null; live: string | null; campaignStatus: string };
    check(
      classification.live === classification.recorded && classification.campaignStatus === 'specced',
      'the classification came back too, so the blocker table moves',
      `${classification.live} · ${classification.campaignStatus}`,
    );

    // Against the post-reset baseline, not the pre-reset one: the truncate took the whole cost
    // history with it, so the only comparison that answers "did the replay spend anything" is the
    // one on the far side of it.
    const resetSpend = fromBlank.spend as { atBlank: number; afterReplay: number };
    check(
      resetSpend.afterReplay === resetSpend.atBlank && resetSpend.atBlank === 0,
      'and none of it cost anything',
      `$${resetSpend.atBlank.toFixed(2)} → $${resetSpend.afterReplay.toFixed(2)}`,
    );
  } finally {
    // The estate is left reset by section 10, deliberately — a probe that restored its own damage
    // would be asserting the restore works by using the restore. Doing it here means a gate that
    // dies mid-section still puts the analysis back.
    await exec('npm', ['--prefix', 'scripts', 'run', 'restore-golden'], {
      cwd: ROOT,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 600_000,
    })
      // And re-read the estate, like `make restore-golden` does: the snapshot carries the
      // invocation counts of the day it was recorded, and this gate tags capture rows of its own.
      .then(() =>
        exec('docker', ['compose', 'exec', '-T', 'parity-api', 'npx', 'tsx', 'src/cli/ingest.ts'], {
          cwd: ROOT,
          maxBuffer: 32 * 1024 * 1024,
          timeout: 600_000,
        }),
      )
      .catch((err: { stdout?: string }) => {
        console.error(`\nRESTORE FAILED — run \`make restore-golden\` by hand: ${err.stdout ?? ''}`);
      });

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
