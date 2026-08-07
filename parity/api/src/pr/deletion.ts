import { createHash } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { procedures, pullRequests, type PullRequest } from '../db/schema.js';
import type { Config } from '../env.js';
import { openRow } from './bundle.js';
import type { CommitFile } from './github.js';

/**
 * The deletion PR — the first instalment, and the only change in this whole platform that
 * needs no specification, no oracle and no shadow run.
 *
 * Three procedures have not been invoked once in ninety days of captured traffic. The argument
 * for removing them is that number and nothing else, which is why this PR carries no service,
 * no golden tests and no recorded decision: there is no behaviour to preserve, so there is
 * nothing to prove about it. It is fully reversible by a revert, trivially checkable by anyone
 * who can read the invocation column, and it is the cheapest true thing Parity can do.
 *
 * Mechanically it differs from a migration PR in exactly one way, and it is a small one: its
 * files carry `contents: null`, which `github.ts` turns into a tree entry with `sha: null` —
 * the Git Data API's way of saying a path is not in the new tree. One commit, three removals.
 *
 * It has a NULL `procedure_id`, because it belongs to three procedures rather than to one, and
 * that has a consequence worth stating: the row no longer cascades when `procedures` is
 * truncated. `resetState()` names `pull_requests` explicitly for that reason.
 */

/** Where the estate keeps its procedure source. Parity reads this path; it never reads the file. */
const PROCEDURE_SRC = 'parity-platform-demo-app/db/20-procs';

const cs = (n: number): string => n.toLocaleString('cs-CZ');

/**
 * Czech counts three ways: 1 takes the singular, 2–4 the nominative plural, 5 and up the
 * genitive. "3 souborů" is the mistake a non-native speaker makes and a Czech-speaking audience
 * reads instantly — and this text goes on the Kampaně screen and into a pull request they open.
 */
export const plural = (n: number, one: string, few: string, many: string): string =>
  `${cs(n)} ${n === 1 ? one : n >= 2 && n <= 4 ? few : many}`;

export async function assembleDeletionPr(db: Db, config: Config): Promise<PullRequest | null> {
  const dead = await db
    .select()
    .from(procedures)
    .where(and(eq(procedures.campaignStatus, 'deleted'), eq(procedures.invocations90d, 0)))
    .orderBy(asc(procedures.name));

  // Nothing marked, nothing to assemble. Not an error: the campaign marks them, and a PR for an
  // empty set would be a PR that says nothing.
  if (dead.length === 0) return null;

  const files: CommitFile[] = dead.map((procedure) => ({
    path: `${PROCEDURE_SRC}/${procedure.name}.sql`,
    contents: null,
  }));

  // Over the paths, so re-assembling the same deletion updates one row rather than
  // accumulating near-identical ones — the same rule as a migration PR's artefact hash, which
  // cannot be reused here because there is no artefact.
  const artifactHash = createHash('sha256').update(files.map((f) => f.path).join('\n')).digest('hex');

  const branch = 'parity/smazat-mrtve-procedury';
  const title = `Odstranit ${plural(dead.length, 'nevolanou proceduru', 'nevolané procedury', 'nevolaných procedur')}`;
  const body = renderBody(dead);

  // Keyed by hand rather than by ON CONFLICT. The unique index is `(procedure_id,
  // artifact_hash)`, and Postgres treats NULLs as distinct — so a deletion PR would never
  // collide with itself and every re-assembly would insert another row.
  const [existing] = await db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.kind, 'deletion'), eq(pullRequests.artifactHash, artifactHash)));

  if (existing !== undefined) {
    const [updated] = await db
      .update(pullRequests)
      .set({ title, body, files, branch, createdAt: new Date() })
      .where(eq(pullRequests.id, existing.id))
      .returning();
    return updated;
  }

  const [row] = await db
    .insert(pullRequests)
    .values({
      procedureId: null,
      kind: 'deletion',
      status: 'assembled',
      owner: config.github.owner,
      repo: config.github.repo,
      baseBranch: config.github.baseBranch,
      branch,
      title,
      body,
      files,
      artifactHash,
    })
    .returning();

  return row;
}

/**
 * The newest assembled deletion PR, for the one command that can open it.
 *
 * Found by kind rather than by procedure, because it has no procedure. Everything else about
 * opening it is unchanged — `openRow` is the same function a migration PR goes through, and the
 * tier table refuses `open_pr` to every task class either way.
 */
export async function commitDeletionPr(db: Db, config: Config): Promise<PullRequest | null> {
  const [row] = await db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.kind, 'deletion'))
    .orderBy(desc(pullRequests.id))
    .limit(1);
  if (row === undefined) return null;
  return openRow(db, config, row);
}

function renderBody(dead: (typeof procedures.$inferSelect)[]): string {
  const lines = dead.reduce((sum, p) => sum + p.lineCount, 0);

  return [
    `Odstraňuje ${plural(dead.length, 'proceduru', 'procedury', 'procedur')}, které za 90 dní zachyceného provozu nikdo nezavolal.`,
    '',
    '| Procedura | Řádků T-SQL | Volání za 90 dní | Třída oracle |',
    '| --- | ---: | ---: | --- |',
    ...dead.map((p) => `| \`${p.name}\` | ${cs(p.lineCount)} | **0** | ${p.oracleClass ?? '—'} |`),
    '',
    `Celkem ${plural(lines, 'řádek', 'řádky', 'řádků')} kódu, který nikdo nevolá.`,
    '',
    '## Proč tohle nepotřebuje shadow run',
    '',
    'Protože není co zachovat. Migrace nahrazuje chování a musí dokázat, že se nezměnilo —',
    'tady žádné chování v produkci není, takže není co měřit. Argument je ten nulový sloupec',
    'a nic jiného.',
    '',
    'Počty volání pocházejí z `parity_capture.Invocation`, ne z odhadu ani z `sys.dm_exec_procedure_stats`,',
    'který se resetuje s každým restartem instance. Zachytává se každé volání procedury přes monolit.',
    '',
    '## Rizika',
    '',
    '- **Plně vratné.** Revert tohohle PR vrátí zdrojáky přesně do původního stavu.',
    '- **Neruší nic v databázi.** PR mění repozitář, ne běžící instanci — `DROP PROCEDURE` je',
    '  samostatný krok, který patří až za merge a za jeden release bez incidentu.',
    '- **Zbylo by volání odjinud?** Capture pokrývá monolit. Volání z jobu, z SSIS balíku nebo',
    '  z ruky by v něm nebylo — proto se maže zdroják, ne procedura v databázi.',
    '',
    '---',
    '',
    'Sestavila Parity. Otevřít PR je vždycky na člověku — policy tabulka odmítá `open_pr` každé',
    'třídě úloh, takže tohle sestavil stroj a odeslat to musí někdo, kdo za to ručí.',
  ].join('\n');
}
