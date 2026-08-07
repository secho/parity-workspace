// `make record-golden`, `make replay-check`, `make restore-golden` and `make load-replay-source`.
//
// The recorded golden run, as a snapshot of Parity's analysis rather than a hand-curated
// fixture. `docs/SPEC.md` §4 asks for "a recorded golden run in the repo so a fresh clone can
// demo immediately"; this is that, and it is also the mechanism replay mode restores from.
//
// Why a snapshot and not a per-run fixture: the artefacts cannot be reconstructed from the step
// stream. `runner.ts` truncates every tool input to 2 000 characters, so the `write_spec` step
// carries 2 000 characters of a specification that is 15 368 long. The steps are a visual
// transcript; the payload lives in `specs`, `golden_tests`, `diffs` and the rest. Measured, the
// whole analysis is ~20 MB — small enough that snapshotting all of it is simpler and more
// honest than deciding piecemeal what to keep.
//
// **This runs before anything destructive is built.** If the round-trip does not hold, nothing
// downstream should be trusted, and nothing has been lost.

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SNAPSHOT_TABLES } from './snapshot-tables.js';

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Gzipped: 41.9 MB of SQL becomes 3.1 MB, which is a reasonable thing to keep in a repository
// and an unreasonable thing not to compress. `psql` reads it back through `gunzip -c`.
const SNAPSHOT = join(ROOT, 'scripts', 'golden-run.sql.gz');
const COUNTS = join(ROOT, 'scripts', 'golden-run.counts.json');



const psql = (database: string, sql: string): Promise<{ stdout: string }> =>
  exec('docker', ['compose', 'exec', '-T', 'parity-postgres', 'psql', '-U', 'parity', '-d', database, '-tAc', sql], {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });

async function counts(database: string): Promise<Record<string, number>> {
  const query = SNAPSHOT_TABLES.map((t) => `select '${t}' t, count(*)::int n from ${t}`).join(' union all ');
  const { stdout } = await psql(database, query);
  return Object.fromEntries(
    stdout
      .trim()
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => {
        const [table, n] = line.split('|');
        return [table, Number(n)];
      }),
  );
}

async function record(): Promise<void> {
  const live = await counts('parity');
  const total = Object.values(live).reduce((a, b) => a + b, 0);
  if (total === 0) {
    console.error('refusing to record an empty snapshot — there is no analysis to capture');
    process.exit(1);
  }

  // --data-only, and pg_dump emits the tables in dependency order, so the restore satisfies
  // every foreign key without disabling anything. It also emits setval() for each sequence,
  // which matters because `resetState` does RESTART IDENTITY: without them the first row
  // inserted after a restore would collide with a restored id.
  const tables = SNAPSHOT_TABLES.map((t) => `--table public.${t}`).join(' ');
  await mkdir(dirname(SNAPSHOT), { recursive: true });
  await exec(
    'bash',
    [
      '-c',
      `docker compose exec -T parity-postgres pg_dump -U parity -d parity --data-only --no-owner --no-privileges ${tables} | gzip -9 > '${SNAPSHOT}'`,
    ],
    { cwd: ROOT, maxBuffer: 512 * 1024 * 1024 },
  );
  await writeFile(COUNTS, `${JSON.stringify(live, null, 2)}\n`, 'utf8');

  const { stdout: size } = await exec('bash', ['-c', `wc -c < '${SNAPSHOT}'`]);
  console.log(`recorded ${total.toLocaleString('en-GB')} rows across ${SNAPSHOT_TABLES.length} tables`);
  console.log(`  ${(Number(size.trim()) / 1024 / 1024).toFixed(1)} MB → scripts/golden-run.sql.gz`);
  for (const [table, n] of Object.entries(live).sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`  ${String(n).padStart(6)}  ${table}`);
  }
}

/**
 * Build one database from the committed snapshot: schema from the migrations, data from the dump.
 *
 * Shared by `check` and `source`, and that sharing is the point — the database `replay-check`
 * proves round-trips cleanly is built by exactly the same three commands as the one replay mode
 * later reads from. A source built a different way would be a different claim.
 */
async function build(database: string): Promise<void> {
  await psql('postgres', `DROP DATABASE IF EXISTS ${database}`);
  await psql('postgres', `CREATE DATABASE ${database} OWNER parity`);

  // Schema first, from the same migrations the API applies on boot, so the database carries the
  // real schema rather than one inferred from the dump. Drizzle's statements already end in `;`;
  // the breakpoint markers are comments to it, so they are simply removed.
  const migrations = join(ROOT, 'parity/api/drizzle');
  const feed = (input: string): Promise<unknown> =>
    exec('bash', [
      '-c',
      `${input} | docker compose exec -T parity-postgres psql -U parity -d ${database} -v ON_ERROR_STOP=1 -f - >/dev/null`,
    ], { cwd: ROOT, maxBuffer: 512 * 1024 * 1024 });

  await feed(`cat ${migrations}/*.sql | grep -v '^--> statement-breakpoint$'`);
  await feed(`gunzip -c '${SNAPSHOT}'`);
}

/**
 * Restore into a scratch database and compare, row for row.
 *
 * A scratch database on purpose: this must be provable without putting the live analysis at
 * risk, because the whole point of running it first is that nothing downstream is trusted yet.
 */
async function check(): Promise<void> {
  const recorded = JSON.parse(await readFile(COUNTS, 'utf8')) as Record<string, number>;
  const scratch = 'parity_replay_check';

  let failures = 0;
  try {
    await build(scratch);
    const restored = await counts(scratch);
    for (const table of SNAPSHOT_TABLES) {
      const ok = restored[table] === recorded[table];
      if (!ok) failures += 1;
      console.log(
        `  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${table.padEnd(20)} ${recorded[table]} → ${restored[table]}`,
      );
    }

    // Sequences too. A restore that gets the rows right and the sequences wrong looks perfect
    // until the next insert collides with a restored id.
    const { stdout } = await psql(
      scratch,
      `select last_value from pg_sequences where schemaname='public' and sequencename='procedures_id_seq'`,
    );
    const seq = Number(stdout.trim());
    const ok = seq >= recorded.procedures;
    if (!ok) failures += 1;
    console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  sequences restored${ok ? '' : ' — procedures_id_seq is behind'}`);
  } finally {
    await psql('postgres', `DROP DATABASE IF EXISTS ${scratch}`);
  }

  console.log(failures === 0 ? '\nsnapshot round-trips cleanly' : `\n${failures} mismatches`);
  if (failures > 0) process.exit(1);
}

/**
 * Put the recorded analysis back into the live database.
 *
 * Clears first, because a data-only restore into populated tables collides on every primary
 * key. That clearing is exactly what `resetState()` does, which is the point: reset and restore
 * are two halves of one mechanism rather than two features that happen to touch the same rows.
 *
 * This is what makes `make demo-reset` safe to run at any moment — beat 1 gets its blank slate,
 * and the ~$16 of analysis behind it is two seconds away.
 */
async function restore(): Promise<void> {
  const recorded = JSON.parse(await readFile(COUNTS, 'utf8')) as Record<string, number>;

  // TRUNCATE in one statement, so foreign keys never see a half-empty database. RESTART
  // IDENTITY because the dump carries its own setval() calls — without the restart the
  // sequences would be whatever the cleared rows left behind.
  await psql('parity', `TRUNCATE TABLE ${SNAPSHOT_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  await exec(
    'bash',
    [
      '-c',
      `gunzip -c '${SNAPSHOT}' | docker compose exec -T parity-postgres psql -U parity -d parity -v ON_ERROR_STOP=1 -f - >/dev/null`,
    ],
    { cwd: ROOT, maxBuffer: 512 * 1024 * 1024 },
  );

  const live = await counts('parity');
  let failures = 0;
  for (const table of SNAPSHOT_TABLES) {
    if (live[table] !== recorded[table]) {
      failures += 1;
      console.log(`  \x1b[31mFAIL\x1b[0m  ${table.padEnd(20)} ${recorded[table]} → ${live[table]}`);
    }
  }

  const total = Object.values(live).reduce((a, b) => a + b, 0);
  console.log(failures === 0 ? `restored ${total.toLocaleString('en-GB')} rows` : `\n${failures} tables did not restore`);
  if (failures > 0) process.exit(1);
}

/**
 * Build the REPLAY SOURCE — the database `PARITY_MODE=replay` reads recordings out of.
 *
 * The whole reason it is a separate database is that `make demo-reset` must not be able to touch
 * it. The recordings ARE the analysis: reset truncates `agent_runs` and `agent_steps`, so a
 * replay that read from the live database could only ever re-show something already on screen.
 * Beat 1 wants an empty estate and beats 2–4 want replay, and those two are only compatible if
 * the recordings live somewhere the reset does not reach.
 *
 * Built once, from the committed snapshot, by the same three commands `replay-check` uses. Rebuilt
 * only when the snapshot changes — `make record-golden && make load-replay-source`.
 */
async function source(): Promise<void> {
  const recorded = JSON.parse(await readFile(COUNTS, 'utf8')) as Record<string, number>;
  const database = process.env.PARITY_REPLAY_DATABASE ?? 'parity_replay';

  await build(database);
  const loaded = await counts(database);

  let failures = 0;
  for (const table of SNAPSHOT_TABLES) {
    if (loaded[table] !== recorded[table]) {
      failures += 1;
      console.log(`  \x1b[31mFAIL\x1b[0m  ${table.padEnd(20)} ${recorded[table]} → ${loaded[table]}`);
    }
  }

  const total = Object.values(loaded).reduce((a, b) => a + b, 0);
  console.log(
    failures === 0
      ? `replay source \`${database}\` loaded — ${total.toLocaleString('en-GB')} rows across ${SNAPSHOT_TABLES.length} tables`
      : `\n${failures} tables did not load`,
  );
  console.log('  `make demo-reset` cannot reach it. Rebuild it after `make record-golden`.');
  if (failures > 0) process.exit(1);
}

const command = process.argv[2];
if (command === 'record') await record();
else if (command === 'check') await check();
else if (command === 'restore') await restore();
else if (command === 'source') await source();
else {
  console.error('usage: golden.ts record|check|restore|source');
  process.exit(1);
}
