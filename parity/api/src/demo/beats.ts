import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentRuns, decisions, diffs, goldenTests, procedures, pullRequests, serviceArtifacts, shadowRuns, specs } from '../db/schema.js';

/**
 * `docs/DEMO-SCRIPT.md`, as something a presenter can click.
 *
 * Every one of these already had a way to run it — a `make` target, a curl, a campaign button.
 * What did not exist was a single surface that runs them **in order** and says which have
 * happened, and the cost of that was a terminal on screen during a customer demo and a presenter
 * remembering which beat comes next.
 *
 * Two rules, both inherited rather than invented:
 *
 * **Nothing here does anything new.** Each beat posts to the endpoint that already existed, with
 * the body the `make` target already passed. This page is a remote control, not a second
 * implementation of the demo — if it drifted from the script, the script would be the one that
 * was wrong, and there would be no way to tell.
 *
 * **`done` is DERIVED**, on every read, from the same rows the screens read. Never stored, never
 * a checklist the presenter ticks. Same rule as `blocker` and the decision queue, and the same
 * reason: a stored "beat 2 is done" drifts from the estate and then lies at the worst moment.
 */

/** The procedure the whole choreography turns on. */
export const DEMO_TARGET = 'sp_CalculateOrderTotal';
/** The second one, for the question that always comes. */
export const DEMO_SECOND = 'sp_GetCartSummary';

export interface Beat {
  key: string;
  /** '1', '2a', … — what the script calls it. */
  beat: string;
  title: string;
  /** Czech, one line: what happens when this is clicked. */
  detail: string;
  /** Czech: what it should cost, measured. Said out loud on stage. */
  expect: string;
  /** The endpoint the button posts to. Null means a human does this one by hand. */
  path: string | null;
  body?: Record<string, unknown>;
  /** Where to look while it runs, or afterwards. */
  link: string | null;
  /** Derived on every read. */
  done: boolean;
  /** Czech, the live state — what the estate says about this beat right now. */
  note: string | null;
  /** Long enough that the UI should poll rather than wait on the response. */
  slow: boolean;
}

const count = async (db: Db, query: Promise<{ n: number }[]>): Promise<number> => (await query)[0]?.n ?? 0;
const n = sql<number>`count(*)::int`;

export async function beats(db: Db): Promise<Beat[]> {
  const [target] = await db.select().from(procedures).where(eq(procedures.name, DEMO_TARGET));
  const targetId = target?.id ?? -1;

  const analysed = await count(db, db.select({ n }).from(procedures).where(isNotNull(procedures.oracleClass)));
  const total = await count(db, db.select({ n }).from(procedures));
  const specced = await count(db, db.select({ n }).from(specs));
  const deleted = await count(db, db.select({ n }).from(procedures).where(eq(procedures.campaignStatus, 'deleted')));
  const dead = await count(db, db.select({ n }).from(procedures).where(eq(procedures.invocations90d, 0)));
  const deletionPr = (
    await db.select().from(pullRequests).where(eq(pullRequests.kind, 'deletion')).limit(1)
  )[0];

  const cases = await count(db, db.select({ n }).from(goldenTests).where(eq(goldenTests.procedureId, targetId)));
  const referenceRun = (
    await db
      .select()
      .from(shadowRuns)
      .where(
        and(eq(shadowRuns.procedureId, targetId), eq(shadowRuns.implementationId, 'reference'), eq(shadowRuns.status, 'succeeded')),
      )
      .orderBy(sql`${shadowRuns.id} desc`)
      .limit(1)
  )[0];
  const greenRun = (
    await db
      .select()
      .from(shadowRuns)
      .where(
        and(eq(shadowRuns.procedureId, targetId), eq(shadowRuns.implementationId, 'generated'), eq(shadowRuns.status, 'succeeded')),
      )
      .orderBy(sql`${shadowRuns.id} desc`)
      .limit(1)
  )[0];

  // Scoped to the reference run beat 3b just produced, which is also what the queue shows. A
  // signature names a SHAPE, so it recurs identically in every run that reproduces it, and
  // counting across every run of the procedure would report findings from a superseded run as
  // work — on a restored estate that reads as "four decisions waiting" beside a procedure that is
  // already `migrated`. `proven` is sticky, so the ladder and this panel are asking different
  // questions: has everything ever been decided, versus have I done this beat yet.
  const undecided =
    referenceRun === undefined
      ? 0
      : await count(
          db,
          db
            .select({ n: sql<number>`count(distinct ${diffs.signature})::int` })
            .from(diffs)
            .leftJoin(decisions, and(eq(decisions.shadowRunId, diffs.shadowRunId), eq(decisions.diffSignature, diffs.signature)))
            .where(and(eq(diffs.shadowRunId, referenceRun.id), eq(diffs.verdict, 'behaviour_change'), isNull(decisions.id))),
        );
  const decided = await count(db, db.select({ n }).from(decisions).where(eq(decisions.procedureId, targetId)));
  const artefacts = await count(db, db.select({ n }).from(serviceArtifacts).where(eq(serviceArtifacts.procedureId, targetId)));
  const runs = await count(db, db.select({ n }).from(agentRuns));

  const encoded = encodeURIComponent(DEMO_TARGET);

  return [
    {
      key: 'reset',
      beat: '1',
      title: 'Výchozí stav',
      detail: 'Smaže celou analýzu a znovu načte estate. Zůstane 14 procedur a nulové pokrytí.',
      expect: '0,4 s',
      path: '/api/_ops/reset',
      link: '/',
      done: analysed === 0 && total === 14,
      note: analysed === 0 ? `${total} procedur, nic zanalyzováno` : `${analysed} z ${total} procedur je zanalyzovaných`,
      slow: false,
    },
    {
      key: 'delete-dead',
      beat: '2a',
      title: 'Smazat mrtvé procedury',
      detail: 'Označí procedury s nulovým provozem a sestaví PR, který je odstraní. Žádný běh modelu.',
      expect: '15 ms',
      path: '/api/campaigns/delete-dead',
      link: '/kampane',
      done: deleted === dead && dead > 0 && deletionPr !== undefined,
      note: deleted === 0 ? `${dead} procedury bez volání čekají` : `${deleted} označeno · PR ${deletionPr === undefined ? 'nesestaven' : deletionPr.status === 'open' ? `otevřen #${deletionPr.number ?? '?'}` : 'sestaven'}`,
      slow: false,
    },
    {
      key: 'open-deletion-pr',
      beat: '2a',
      title: 'Otevřít ten PR na GitHubu',
      detail: 'Jediný nevratný úkon v celé platformě. Policy odmítá open_pr každé třídě úloh, takže tohle dělá člověk.',
      expect: '~2 s · idempotentní',
      path: '/api/pr/deletion',
      body: { commit: true },
      link: '/kampane',
      done: deletionPr?.status === 'open',
      note: deletionPr?.url ?? 'zatím neotevřen',
      slow: false,
    },
    {
      key: 'map-estate',
      beat: '2b',
      title: 'Zmapovat estate',
      detail: 'Triage a specifikace pro všech 14 procedur. V replay módu se přehrává nahrávka.',
      expect: 'replay 94 s · naživo hodina a ~$9',
      path: '/api/campaigns/map-estate',
      link: '/kampane',
      done: specced === total && total > 0,
      note: `${specced} z ${total} má specifikaci`,
      slow: true,
    },
    {
      key: 'oracle',
      beat: '3a',
      title: `Oracle pro ${DEMO_TARGET}`,
      detail: 'Model vybere případy ze zachyceného provozu a navrhne invarianty. Baseline se pak spustí doopravdy.',
      expect: 'replay 8 s',
      path: `/api/procedures/${encoded}/oracle`,
      link: `/procedura/${encoded}`,
      done: cases > 0,
      note: cases === 0 ? 'zatím žádné golden testy' : `${cases} golden testů`,
      slow: true,
    },
    {
      key: 'shadow-reference',
      beat: '3b',
      title: 'Shadow run proti referenční implementaci',
      detail: 'Kontrola, která diverguje. Tohle je ten běh, ze kterého vypadnou nálezy do fronty.',
      expect: 'replay 3 s · naživo 16 s',
      path: `/api/procedures/${encoded}/shadow/run`,
      body: { implementation: 'reference' },
      link: `/procedura/${encoded}`,
      done: referenceRun !== undefined,
      note:
        referenceRun === undefined
          ? 'zatím neproběhl'
          : `#${referenceRun.id} · ${referenceRun.rawDiffs} hrubých → ${referenceRun.noiseDiffs} vyřešila kanonikalizace → ${referenceRun.behaviourDiffs} nálezů`,
      slow: true,
    },
    {
      key: 'decide',
      beat: '4a',
      title: 'Rozhodnout VŠECHNY nálezy',
      detail:
        'Ručně, ve Frontě. Musí to být před zeleným během — fronta ukazuje nejnovější běh, takže po něm nálezy zmizí a `proven` už nejde získat.',
      expect: 'čtyři kliknutí',
      path: null,
      link: '/fronta',
      done: referenceRun !== undefined && undecided === 0 && decided > 0,
      note: undecided === 0 ? `${decided} rozhodnutí · nic nečeká` : `${undecided} nálezů čeká na rozhodnutí`,
      slow: false,
    },
    {
      key: 'implement-service',
      beat: '4b',
      title: 'Napsat náhradu',
      detail: 'Rozhodnutí je součástí zadání: `preserve` znamená, že staré chování je to požadované, i když je špatně.',
      expect: 'replay ~5 s · naživo 15 min a $3,93',
      path: `/api/procedures/${encoded}/service`,
      link: `/procedura/${encoded}`,
      done: artefacts > 0,
      note: artefacts === 0 ? 'služba zatím není' : `${artefacts} souborů služby`,
      slow: true,
    },
    {
      key: 'shadow-generated',
      beat: '4c',
      title: 'Shadow run proti vygenerované službě',
      detail: 'Stejný harness, stejné případy, stejná databáze — jiná jenom implementace.',
      expect: 'replay 3 s · naživo 20 s',
      path: `/api/procedures/${encoded}/shadow/run`,
      body: { implementation: 'generated' },
      link: `/procedura/${encoded}`,
      done: greenRun !== undefined && target?.oracleState === 'proven',
      note:
        greenRun === undefined
          ? 'zatím neproběhl'
          : `#${greenRun.id} · ${greenRun.behaviourDiffs} nálezů · ${target?.oracleState ?? '?'} / ${target?.campaignStatus ?? '?'}`,
      slow: true,
    },
    {
      key: 'estate',
      beat: '4d',
      title: 'Zpátky na Estate',
      detail: 'Pokrytí se pohnulo, blocker tabulka se pohnula. Tohle není report o roadmapě — tohle je ta roadmapa.',
      expect: '—',
      path: null,
      link: '/',
      done: target?.campaignStatus === 'migrated',
      note: `${DEMO_TARGET}: ${target?.oracleState ?? '—'} / ${target?.campaignStatus ?? '—'} · ${runs} běhů agenta celkem`,
      slow: false,
    },
  ];
}
