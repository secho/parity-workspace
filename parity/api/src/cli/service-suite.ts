// `make service-suite`. Run the golden suite against a replacement.
//
// Three targets, and the second two are controls rather than measurements:
//
//   service             the agent's implementation. This is the one that must be green.
//   procedure_on_shadow the PROCEDURE, on the shadow copy, through the same path. A
//                       portability control: the expectations were recorded against
//                       ParityShop inside a rolled-back transaction, and this asks whether
//                       they still hold on the restored copy the service runs on. If this is
//                       red, nothing else in the section means anything, so `verify-m6` runs
//                       it first.
//   reference           M5's hand-written service, which is known to diverge. The negative
//                       control: the suite must go RED against it. A suite that cannot fail
//                       is not evidence, and M1 and M2 each shipped an assertion that
//                       compared a constant to itself before anyone asked what would make it
//                       red.
//
// Prints JSON so `verify-m6` asserts on the result rather than reimplementing the run.

import { openStore, waitForPostgres } from '../db/client.js';
import { applyMigrations } from '../db/migrate.js';
import { loadConfig } from '../env.js';
import { runServiceSuite, type SuiteTarget } from '../service/suite.js';

const config = loadConfig();
const procedureName = process.argv[2] ?? 'sp_CalculateOrderTotal';
const target = (process.argv[3] ?? 'service') as SuiteTarget;

if (!['service', 'reference', 'procedure_on_shadow'].includes(target)) {
  console.error(`unknown target ${target}`);
  process.exit(1);
}

const store = openStore(config.pgUrl);
await waitForPostgres(store.pool);
await applyMigrations(store.db);

const outcome = await runServiceSuite(store.db, config, procedureName, target);

console.log(
  JSON.stringify(
    {
      procedure: procedureName,
      target: outcome.target,
      oracleRunId: outcome.oracleRunId,
      passed: outcome.passed,
      failed: outcome.failed,
      durationMs: outcome.durationMs,
      failures: outcome.failures,
    },
    null,
    2,
  ),
);

await store.pool.end();
