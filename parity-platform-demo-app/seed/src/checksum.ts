// Records the determinism fingerprint of the currently seeded database.
// Run via `make seed-checksum`, and only when the seed legitimately changes —
// verify-m0 asserts the seeded data still hashes to the committed value.

import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const QUERY_PATH = join(ROOT, 'scripts', 'seed-checksum.sql');
const OUT_PATH = join(ROOT, 'scripts', 'seed-checksum.json');

export async function readChecksum(): Promise<Record<string, number>> {
  const query = await readFile(QUERY_PATH, 'utf8');
  const pool = await connect('ParityShop');
  try {
    const result = await pool.request().query(query);
    return result.recordset[0] as Record<string, number>;
  } finally {
    await pool.close();
  }
}

async function main(): Promise<void> {
  const row = await readChecksum();
  await writeFile(OUT_PATH, `${JSON.stringify(row, null, 2)}\n`, 'utf8');
  console.log(`wrote ${OUT_PATH}`);
  console.log(JSON.stringify(row, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
