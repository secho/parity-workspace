/**
 * `make generate-oracles` — build and verify the oracle for every procedure that has one to
 * build.
 *
 * Separate from `make verify-m4` for the same reason `map-estate` is separate from
 * `verify-m3`: this spends live model runs and should happen once, while the gate asserts
 * the persisted result and stays cheap enough to re-run.
 *
 * Three phases per procedure, and only the first involves the model:
 *   1. generate-oracle chooses cases from captured traffic and states invariants
 *   2. the baseline pass executes each case and records what the procedure does
 *   3. a verify pass executes them again and checks them against that record
 *
 * Phase 3 is not ceremony. It is the first moment anything proves the suite is repeatable,
 * and a case that cannot reproduce its own baseline is one whose procedure is not yet
 * pinnable — better to find that here than to ship a green number.
 */
import { asc } from 'drizzle-orm';
import { openStore, waitForPostgres } from '../db/client.js';
import { applyMigrations } from '../db/migrate.js';
import { seedPolicy } from '../agent/policy.js';
import { executeRun, oracleRun } from '../agent/runner.js';
import { procedures } from '../db/schema.js';
import { recordBaseline, runSuite } from '../oracle/suite.js';
import { agentReadiness, loadConfig } from '../env.js';
import { announceMode, loadMode } from '../replay/mode.js';

const config = loadConfig();

const readiness = agentReadiness();
if (!readiness.ready) {
  console.error(`cannot generate oracles: ${readiness.reason}`);
  console.error('Set a Console API key in .env as ANTHROPIC_API_KEY=sk-ant-… and re-run.');
  process.exit(1);
}

const store = openStore(config.pgUrl);
await waitForPostgres(store.pool);
await applyMigrations(store.db);
await loadMode(store.db);
announceMode(config);
await seedPolicy(store.db);

/**
 * `sp_SyncWarehouseDispatch` sends dispatch orders through Database Mail. A sent email
 * cannot be rolled back, so there is no safe way to execute it even once — which is the
 * whole reason it is classified `external`. The engine refuses it too: `parity_runner` is
 * DENYed EXECUTE on it. This list is belt and braces, and the gate asserts it has no cases.
 */
const NEVER_EXECUTE = new Set(['sp_SyncWarehouseDispatch']);

const rows = await store.db
  .select({ name: procedures.name, invocations: procedures.invocations90d })
  .from(procedures)
  .orderBy(asc(procedures.name));

const only = process.argv.slice(2);
const eligible = rows.filter((r) => r.invocations > 0 && !NEVER_EXECUTE.has(r.name));
const targets = only.length > 0 ? rows.filter((r) => only.includes(r.name)) : eligible;

console.log(`building oracles for ${targets.length} procedures`);
// Only explain exclusions on a full sweep. Naming a procedure on the command line is not a
// skip, and reporting it as one printed a reason that was simply untrue.
if (only.length === 0) {
  for (const row of rows.filter((r) => !eligible.includes(r))) {
    console.log(
      `  skipping ${row.name} — ${row.invocations === 0 ? 'no captured traffic to draw on' : 'external effect, cannot be executed safely'}`,
    );
  }
}
console.log();

const started = Date.now();
let cost = 0;
let failures = 0;

for (const [index, row] of targets.entries()) {
  process.stdout.write(`  [${index + 1}/${targets.length}] ${row.name} · generate … `);
  try {
    const handle = await executeRun(store.db, config, oracleRun(row.name));
    cost += handle.result.costUsd ?? 0;
    if (handle.result.isError) {
      failures += 1;
      console.log(`FAILED (${handle.result.numTurns} turns)`);
      continue;
    }

    const cases = await recordBaseline(store.db, config, row.name);
    if (cases === 0) {
      failures += 1;
      console.log('FAILED — the run produced no golden cases');
      continue;
    }

    const suite = await runSuite(store.db, config, row.name, 'verify');
    if (suite.goldenFailed > 0) failures += 1;
    console.log(
      `${suite.goldenFailed > 0 ? 'UNSTABLE' : 'ok'} — ${cases} cases, ` +
        `${suite.goldenPassed}/${suite.goldenPassed + suite.goldenFailed} pass, ` +
        `${suite.violations.length} finding${suite.violations.length === 1 ? '' : 's'} in ${suite.invariantsChecked} checks` +
        `${suite.unconfirmed.length > 0 ? `, ${suite.unconfirmed.length} unconfirmed` : ''} ` +
        `(${handle.result.numTurns} turns, ${handle.result.model ?? '?'})`,
    );
    for (const violation of suite.violations) console.log(`        ${violation}`);
    // Printed dimmer, but printed. A rule the procedure breaks nearly everywhere describes
    // something other than this procedure — it is a lead, not a finding, and not noise to hide.
    for (const rule of suite.unconfirmed) console.log(`        \x1b[2munconfirmed: ${rule}\x1b[0m`);
  } catch (err) {
    failures += 1;
    console.log(`ERROR ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log(
  `\nbuilt ${targets.length} oracles in ${((Date.now() - started) / 1000).toFixed(0)} s, ` +
    `$${cost.toFixed(2)}, ${failures} failure${failures === 1 ? '' : 's'}`,
);

await store.close();
if (failures > 0) process.exit(1);
