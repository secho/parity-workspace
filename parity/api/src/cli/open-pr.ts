// `make open-pr`. Assemble the pull request, and open it only when told to in so many words.
//
// Assembling is free and idempotent; opening is the one act in this platform that
// `make demo-reset` cannot take back, because a pull request on a public repository has been
// seen by whoever was watching. So the default is assemble-only, `verify-m6` never passes
// `--commit`, and the tier table refuses `open_pr` to every task class — which means whatever
// does pass `--commit` always has a person behind it.

import { openStore, waitForPostgres } from '../db/client.js';
import { applyMigrations } from '../db/migrate.js';
import { loadConfig, prReadiness } from '../env.js';
import { assemblePr, commitPr } from '../pr/bundle.js';

const config = loadConfig();
const procedureName = process.argv[2] ?? 'sp_CalculateOrderTotal';
const commit = process.argv.includes('--commit');

const store = openStore(config.pgUrl);
await waitForPostgres(store.pool);
await applyMigrations(store.db);

const assembled = await assemblePr(store.db, config, {
  procedureName,
  summaryCs:
    'Výpočet ceny objednávky se přesouvá ze stored procedury do samostatné služby. ' +
    'Chování zůstává identické — včetně toho, které je podle specifikace sporné.',
  fixCandidatesCs: '',
});

if (assembled === null) {
  console.error(`nothing to assemble for ${procedureName} — no complete generated service`);
  await store.pool.end();
  process.exit(1);
}

console.log(`assembled PR for ${procedureName}`);
console.log(`  ${assembled.owner}/${assembled.repo}  ${assembled.branch} → ${assembled.baseBranch}`);
console.log(`  ${(assembled.files as { path: string }[]).length} files:`);
for (const file of assembled.files as { path: string }[]) console.log(`    ${file.path}`);
console.log(`  artefact ${assembled.artifactHash.slice(0, 12)}, ${assembled.body.length} characters of body`);

const readiness = prReadiness(config);

if (!commit) {
  console.log(`\nnot opened — pass --commit to open it.`);
  // Said plainly rather than discovered at push time. An absent token is a normal state.
  if (!readiness.ready) console.log(`note: it could not be opened right now anyway — ${readiness.reason}`);
  await store.pool.end();
  process.exit(0);
}

if (!readiness.ready) {
  console.error(`\ncannot open: ${readiness.reason}`);
  await store.pool.end();
  process.exit(1);
}

const opened = await commitPr(store.db, config, procedureName);
if (opened?.status !== 'open') {
  console.error(`\nfailed to open: ${opened?.error ?? 'unknown error'}`);
  await store.pool.end();
  process.exit(1);
}

console.log(`\nopened ${opened.url}`);
await store.pool.end();
