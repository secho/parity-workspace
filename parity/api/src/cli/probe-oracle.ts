/**
 * The negative control.
 *
 * "Golden tests pass" is worth nothing on its own — a suite that compares a value to itself
 * passes too, and this build has shipped that assertion twice already. M1's replay check
 * compared one constant to another copy of the same constant and would have passed with the
 * VAT computation completely broken; M2's write-owner check was vacuously true whenever the
 * feature it tested had regressed. Both were found by asking what would make the test red.
 *
 * So: take a passing suite, corrupt one stored expectation by a single unit of currency, and
 * require the suite to go red. Then put it back and require it to go green again. `verify-m4`
 * refuses to accept a green suite without this.
 *
 * The corruption is applied to Parity's own record of what it expects, never to the estate.
 * Nothing here touches ParityShop beyond the rolled-back reads the suite already does.
 */
import { asc, eq } from 'drizzle-orm';
import { openStore, waitForPostgres } from '../db/client.js';
import { applyMigrations } from '../db/migrate.js';
import { goldenTests, procedures } from '../db/schema.js';
import { runSuite } from '../oracle/suite.js';
import { loadConfig } from '../env.js';

const config = loadConfig();
const store = openStore(config.pgUrl);
await waitForPostgres(store.pool);
await applyMigrations(store.db);

const target = process.argv[2] ?? 'sp_CalculateOrderTotal';

const [procedure] = await store.db.select().from(procedures).where(eq(procedures.name, target));
if (procedure === undefined) {
  console.log(JSON.stringify({ error: `no procedure named ${target}` }));
  await store.close();
  process.exit(1);
}

const [victim] = await store.db
  .select()
  .from(goldenTests)
  .where(eq(goldenTests.procedureId, procedure.id))
  .orderBy(asc(goldenTests.name))
  .limit(1);

if (victim === undefined) {
  console.log(JSON.stringify({ error: `${target} has no golden tests to probe` }));
  await store.close();
  process.exit(1);
}

const original = { writeSet: victim.expectedWriteSet, result: victim.expectedResult };

/**
 * Move exactly one number by one. Anything larger would not prove the comparison is tight.
 *
 * The write set first, because that is where the money is — and for a procedure with no
 * SELECT, as `sp_CalculateOrderTotal` has none, it is the only output there is. A pure read
 * has the opposite shape, so the result set is the fallback and the probe works on both.
 */
function corrupt(value: unknown): { mutated: unknown; changed: string | null } {
  const clone = structuredClone(value);
  let changed: string | null = null;

  const walk = (node: unknown, path: string): unknown => {
    if (changed !== null || node === null || typeof node !== 'object') return node;
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      if (changed !== null) break;
      const child = record[key];
      if (typeof child === 'number' && Number.isFinite(child)) {
        record[key] = child + 1;
        changed = `${path}${key}: ${child} -> ${child + 1}`;
        break;
      }
      walk(child, `${path}${key}.`);
    }
    return record;
  };

  walk(clone, '');
  return { mutated: clone, changed };
}

let { mutated, changed } = corrupt(original.writeSet);
let field: 'writeSet' | 'result' = 'writeSet';
if (changed === null) {
  ({ mutated, changed } = corrupt(original.result));
  field = 'result';
}

let detected = false;
let recovered = false;
let detail: string | null = null;

try {
  if (changed !== null) {
    await store.db
      .update(goldenTests)
      .set(field === 'writeSet' ? { expectedWriteSet: mutated } : { expectedResult: mutated })
      .where(eq(goldenTests.id, victim.id));
    const red = await runSuite(store.db, config, target, 'probe');
    detected = red.goldenFailed > 0;
    detail = red.goldenFailed > 0 ? `${red.goldenFailed} of ${red.goldenPassed + red.goldenFailed} failed` : null;
  }
} finally {
  // Always. A probe that damages the thing it measures is worse than no probe, and a throw
  // between the corruption and the restore would leave the estate showing a failing oracle
  // with no sign of why. Same discipline as verify-m2's finally.
  await store.db
    .update(goldenTests)
    .set({ expectedWriteSet: original.writeSet, expectedResult: original.result })
    .where(eq(goldenTests.id, victim.id))
    .catch(() => undefined);
}

const green = await runSuite(store.db, config, target, 'probe');
recovered = green.goldenFailed === 0 && green.goldenPassed > 0;

console.log(
  JSON.stringify(
    {
      procedure: target,
      case: victim.name,
      corruption: changed === null ? null : `${field}: ${changed}`,
      /** Did a one-unit change make the suite fail? If not, the suite asserts nothing. */
      detected,
      detail,
      /** And does it go green again once restored? If not, the probe damaged the estate. */
      recovered,
      passedAfterRestore: green.goldenPassed,
    },
    null,
    2,
  ),
);

await store.close();
