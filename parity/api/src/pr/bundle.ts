import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { decisions, goldenTests, oracleRuns, procedures, pullRequests, shadowRuns, specs, type PullRequest } from '../db/schema.js';
import type { Config } from '../env.js';
import { isComplete, latestArtifacts } from '../service/artifacts.js';
import { openPullRequest, type CommitFile } from './github.js';

/**
 * What a migration PR carries, and how it reads.
 *
 * `docs/MILESTONES.md` names four attachments — spec, tests, service and the recorded
 * decision — and this assembles exactly those and nothing else. In particular it does NOT
 * carry the monolith's feature flag or the service's HTTP shell: those are platform code that
 * shipped with M6 and are already on `main` by the time anyone opens this. A PR that re-states
 * code already merged is a PR nobody reads to the end.
 *
 * Assembling and opening are separate acts. This function always assembles and persists;
 * whether anything is pushed is `commitPr`, and the tier table refuses `open_pr` to every task
 * class, so the thing that calls `commitPr` always has a person behind it. The gate therefore
 * asserts against stored text and never against the network, and a gate that runs on every
 * commit never opens a pull request.
 */

const MIGRATION_DOCS = 'docs/migrations';
const SERVICE_SRC = 'parity-platform-demo-app/pricing-service-generated/src';

/** One directory per procedure, so two migrations never write over each other's files. */
const serviceSrcFor = (procedureName: string): string => `${SERVICE_SRC}/${procedureName}`;

export interface AssembleInput {
  procedureName: string;
  summaryCs: string;
  fixCandidatesCs: string;
}

const cs = (n: number): string => n.toLocaleString('cs-CZ');

/**
 * Czech counts three ways: 1 takes the singular, 2–4 the nominative plural, 5 and up the
 * genitive. "4 odchylek" and "2 souborů" are the mistake a non-native speaker makes and a
 * Czech-speaking audience reads instantly — and this text goes into a pull request they open.
 */
const plural = (n: number, one: string, few: string, many: string): string =>
  `${cs(n)} ${n === 1 ? one : n >= 2 && n <= 4 ? few : many}`;

export async function assemblePr(db: Db, config: Config, input: AssembleInput): Promise<PullRequest | null> {
  const [procedure] = await db.select().from(procedures).where(eq(procedures.name, input.procedureName));
  if (procedure === undefined) return null;

  const artifacts = await latestArtifacts(db, procedure.id);
  if (!isComplete(procedure.name, artifacts)) return null;

  const [spec] = await db.select().from(specs).where(eq(specs.procedureId, procedure.id));
  const cases = await db.select().from(goldenTests).where(eq(goldenTests.procedureId, procedure.id));
  const decided = await db
    .select()
    .from(decisions)
    .where(eq(decisions.procedureId, procedure.id))
    .orderBy(desc(decisions.decidedAt));

  const [green] = await db
    .select()
    .from(shadowRuns)
    .where(
      and(
        eq(shadowRuns.procedureId, procedure.id),
        eq(shadowRuns.implementationId, 'generated'),
        eq(shadowRuns.status, 'succeeded'),
      ),
    )
    .orderBy(desc(shadowRuns.id))
    .limit(1);

  const [reference] = await db
    .select()
    .from(shadowRuns)
    .where(
      and(
        eq(shadowRuns.procedureId, procedure.id),
        eq(shadowRuns.implementationId, 'reference'),
        eq(shadowRuns.status, 'succeeded'),
      ),
    )
    .orderBy(desc(shadowRuns.id))
    .limit(1);

  // `kind = 'verify'` as well as `target = 'service'`. Both controls — the reference
  // implementation and the procedure-on-the-shadow-copy — are also recorded against a service
  // target, and the reference one is *supposed* to be red. Selecting on target alone picked
  // whichever ran last and put "16/17 prošlo" into a PR whose service passes 17 of 17.
  const [suite] = await db
    .select()
    .from(oracleRuns)
    .where(
      and(eq(oracleRuns.procedureId, procedure.id), eq(oracleRuns.target, 'service'), eq(oracleRuns.kind, 'verify')),
    )
    .orderBy(desc(oracleRuns.id))
    .limit(1);

  const files: CommitFile[] = [
    ...artifacts.files.map((f) => ({ path: `${serviceSrcFor(procedure.name)}/${f.path}`, contents: f.contents })),
    {
      path: `${MIGRATION_DOCS}/${procedure.name}/spec.md`,
      contents: spec?.markdown ?? `# ${procedure.name}\n\nSpecifikace zatím nebyla vygenerována.\n`,
    },
    { path: `${MIGRATION_DOCS}/${procedure.name}/golden-tests.md`, contents: renderCases(procedure.name, cases, suite) },
    { path: `${MIGRATION_DOCS}/${procedure.name}/decision.md`, contents: renderDecisions(procedure.name, decided, reference) },
  ];

  const branch = `parity/migrace-${procedure.name.toLowerCase()}`;
  const title = `${procedure.name} → pricing-service`;
  const body = renderBody({ procedure: procedure.name, input, artifacts, cases: cases.length, green, reference, suite, decided });

  const [row] = await db
    .insert(pullRequests)
    .values({
      procedureId: procedure.id,
      status: 'assembled',
      owner: config.github.owner,
      repo: config.github.repo,
      baseBranch: config.github.baseBranch,
      branch,
      title,
      body,
      files,
      artifactHash: artifacts.runHash,
    })
    .onConflictDoUpdate({
      // Keyed on the artefact hash, so re-assembling the same generated service updates one
      // row instead of accumulating near-identical ones. A NEW attempt is a new row, because
      // it is a different change and deserves its own record of what was proposed.
      target: [pullRequests.procedureId, pullRequests.artifactHash],
      set: { body, files, title, branch, createdAt: new Date() },
    })
    .returning();

  return row;
}

/**
 * Push the assembled PR.
 *
 * Separated from assembly because this is the one irreversible, outward-facing act in the
 * whole platform. Everything else Parity does can be undone by `make demo-reset`; a pull
 * request on a public repository has been seen by whoever was watching.
 */
export async function commitPr(db: Db, config: Config, procedureName: string): Promise<PullRequest | null> {
  const [procedure] = await db.select().from(procedures).where(eq(procedures.name, procedureName));
  if (procedure === undefined) return null;

  const [row] = await db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.procedureId, procedure.id))
    .orderBy(desc(pullRequests.id))
    .limit(1);
  if (row === undefined) return null;
  if (row.status === 'open' && row.url !== null) return row;

  try {
    const opened = await openPullRequest(
      { token: config.github.token, owner: row.owner, repo: row.repo },
      {
        baseBranch: row.baseBranch,
        branch: row.branch,
        title: row.title,
        body: row.body,
        files: row.files as CommitFile[],
        message: `${row.title}\n\nVygenerováno Parity. Rozhodnutí a shadow run jsou v popisu PR.`,
      },
    );

    const [updated] = await db
      .update(pullRequests)
      .set({ status: 'open', number: opened.number, url: opened.url, error: null, openedAt: new Date() })
      .where(eq(pullRequests.id, row.id))
      .returning();
    return updated;
  } catch (err) {
    const [failed] = await db
      .update(pullRequests)
      .set({ status: 'failed', error: err instanceof Error ? err.message : String(err) })
      .where(eq(pullRequests.id, row.id))
      .returning();
    return failed;
  }
}

// --- the prose ---------------------------------------------------------------------------

function renderCases(name: string, cases: typeof goldenTests.$inferSelect[], suite?: typeof oracleRuns.$inferSelect): string {
  const lines = [
    `# Golden testy — ${name}`,
    '',
    'Každý případ cituje `InvocationID` skutečného zachyceného volání. Vstupy se čtou zpátky',
    'z capture, ne z tohohle souboru — model si je nemohl vymyslet.',
    '',
    suite === undefined
      ? '_Sada zatím proti službě neběžela._'
      : `Proti vygenerované službě: **${suite.goldenPassed} prošlo, ${suite.goldenFailed} neprošlo**.`,
    '',
    '| Případ | Větev | InvocationID | Proč je v sadě |',
    '| --- | --- | --- | --- |',
    ...cases.map((c) => `| \`${c.name}\` | \`${c.branchKey ?? '—'}\` | ${c.sourceInvocationId} | ${c.rationale ?? '—'} |`),
    '',
  ];
  return lines.join('\n');
}

function renderDecisions(
  name: string,
  decided: typeof decisions.$inferSelect[],
  reference?: typeof shadowRuns.$inferSelect,
): string {
  const label = { preserve: 'Zachovat chování', accept: 'Přijmout změnu', escalate: 'Eskalovat' };
  return [
    `# Rozhodnutí — ${name}`,
    '',
    reference === undefined
      ? '_Referenční shadow run chybí._'
      : `Odchylky našel shadow run #${reference.id} nad referenční implementací: ` +
        `${cs(reference.casesReplayed)} přehraných volání, ${cs(reference.rawDiffs)} syrových rozdílů, ` +
        `${cs(reference.noiseDiffs)} vyřešila kanonikalizace v kódu, ${plural(reference.behaviourDiffs, 'nález došel', 'nálezy došly', 'nálezů došlo')} k člověku.`,
    '',
    decided.length === 0 ? '_Zatím nikdo nerozhodl._' : '',
    ...decided.map((d) =>
      [
        `## \`${d.diffSignature}\``,
        '',
        `**${label[d.action as keyof typeof label] ?? d.action}** — rozhodl ${d.decidedBy === 'human' ? 'člověk' : d.decidedBy}, ${d.decidedAt.toISOString().slice(0, 10)}.`,
        '',
        d.note ?? '',
        '',
      ].join('\n'),
    ),
  ].join('\n');
}

function renderBody(ctx: {
  procedure: string;
  input: AssembleInput;
  artifacts: { runHash: string; files: { path: string }[]; attempt: number };
  cases: number;
  green?: typeof shadowRuns.$inferSelect;
  reference?: typeof shadowRuns.$inferSelect;
  suite?: typeof oracleRuns.$inferSelect;
  decided: typeof decisions.$inferSelect[];
}): string {
  const { procedure, input, artifacts, green, reference, suite, decided } = ctx;

  return [
    `Nahrazuje \`${procedure}\` službou \`pricing-service\` (Node 22 + TypeScript + Fastify).`,
    '',
    input.summaryCs,
    '',
    '## Důkaz, že se chování nezměnilo',
    '',
    suite === undefined
      ? '- Golden testy proti službě zatím neběžely.'
      : `- **Golden testy:** ${suite.goldenPassed}/${suite.goldenPassed + suite.goldenFailed} prošlo proti vygenerované službě. Vstupy každého případu se čtou z capture, ne z testu.`,
    green === undefined
      ? '- Shadow run proti vygenerované službě zatím neproběhl.'
      : `- **Shadow run #${green.id}:** ${cs(green.casesReplayed)} přehraných volání přes ${green.strataCovered}/${green.strataObserved} pozorovaných strat, ` +
        `${cs(green.rawDiffs)} syrových rozdílů, ${cs(green.noiseDiffs)} vyřešila kanonikalizace v kódu, ` +
        `**${cs(green.behaviourDiffs)} změn chování**. Zápisové sety z Change Trackingu, ne z toho, co o sobě služba tvrdí.`,
    reference === undefined
      ? ''
      : `- **Kontrola:** tentýž harness nad referenční implementací (#${reference.id}) najde ${plural(reference.behaviourDiffs, 'odchylku', 'odchylky', 'odchylek')}. ` +
        'Stejné případy, stejná databáze, jiná implementace — takže zelený běh není zelený proto, že by diff engine přestal fungovat.',
    '',
    '## Rozhodnutí',
    '',
    decided.length === 0
      ? '_Žádné rozhodnutí není zaznamenané._'
      : decided
          .map(
            (d) =>
              `- \`${d.diffSignature}\` → **${d.action === 'preserve' ? 'Zachovat chování' : d.action === 'accept' ? 'Přijmout změnu' : 'Eskalovat'}** (${d.decidedBy === 'human' ? 'člověk' : d.decidedBy}). ${d.note ?? ''}`,
          )
          .join('\n'),
    '',
    '## Kandidáti na opravu',
    '',
    input.fixCandidatesCs.trim() === ''
      ? '_Žádní._'
      : `${input.fixCandidatesCs}\n\nReprodukováno záměrně. Oprava patří do samostatné změny, až bude parita prokázaná — ` +
        'oprava přibalená k migraci dělá shadow diff nečitelným a nikdo pak nepozná, jestli je nová implementace rozbitá, nebo lepší.',
    '',
    '---',
    '',
    `Vygenerovala Parity, pokus ${artifacts.attempt}, artefakt \`${artifacts.runHash.slice(0, 12)}\` ` +
      `(${plural(artifacts.files.length, 'soubor', 'soubory', 'souborů')}, ${plural(ctx.cases, 'golden test', 'golden testy', 'golden testů')}).`,
    'Soubory `index.ts` a `db.ts` psala platforma — jsou kontraktem shadow harnessu. Model psal pravidla a zápisy.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}
