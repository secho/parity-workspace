import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { diffs, goldenTests, procedures, shadowRuns, specs } from '../db/schema.js';
import type { Config } from '../env.js';
import { executeRun, oracleRun, specRun, triageRun } from '../agent/runner.js';
import { recordBaseline, runSuite } from '../oracle/suite.js';
import { assembleDeletionPr, plural } from '../pr/deletion.js';
import { classifyRun } from '../shadow/classify.js';
import { runShadow } from '../shadow/run.js';
import { findingsFor } from '../replay/serve.js';

/**
 * The three campaigns, **as code rather than as rows**.
 *
 * A `campaigns` table would be a table with exactly three hardcoded rows in it, and every one of
 * those rows would have a function behind it anyway. What is genuinely data — which items a
 * particular run covered and how each of them ended — lives in `campaign_runs.items`, because
 * nothing else records it. That is the same test `blocker` passes in the other direction: derive
 * what can be derived, store what nothing else knows.
 *
 * Each definition answers four questions about a unit of work:
 *
 *   `items`      — what is there to do, read from the estate at start time
 *   `isComplete` — is this one already done, so the campaign can skip it
 *   `run`        — do it
 *   `finish`     — anything that belongs to the campaign as a whole rather than to an item
 *
 * `isComplete` is not an optimisation. It is what makes a campaign safe to re-run in rehearsal,
 * idempotent for the gate, and — the reason it exists — honest on stage: `Zmapovat estate` is
 * twenty-eight live model runs and roughly seven dollars, which is not a thing that happens
 * inside a two-minute beat. Started on an already-mapped estate the same button finishes in
 * seconds and says *14 přeskočeno*, which is true, rather than pretending to have done the work
 * again.
 */

/** pending | running | done | skipped | failed */
export type ItemStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface CampaignItem {
  /** Stable identity within the run. `procedure` or `procedure:step`. */
  key: string;
  /** Czech, engineering register — this is what the Kampaně screen shows. */
  label: string;
  procedure: string | null;
  step: string | null;
  status: ItemStatus;
  detail: string | null;
  costUsd: number | null;
  durationMs: number | null;
}

export interface CampaignDefinition {
  key: string;
  /** Czech. The button. */
  title: string;
  /** Czech, one line. What it does and what it costs. */
  description: string;
  /** Needs a procedure name — the migration campaign runs on one procedure at a time. */
  needsTarget: boolean;
  items: (db: Db, target: string | null) => Promise<Omit<CampaignItem, 'status' | 'detail' | 'costUsd' | 'durationMs'>[]>;
  isComplete: (db: Db, item: CampaignItem) => Promise<boolean>;
  run: (db: Db, config: Config, item: CampaignItem) => Promise<{ detail: string; costUsd: number }>;
}

const item = (key: string, label: string, procedure: string | null, step: string | null): Omit<CampaignItem, 'status' | 'detail' | 'costUsd' | 'durationMs'> => ({
  key,
  label,
  procedure,
  step,
});

const nameOf = (item: CampaignItem): string => {
  if (item.procedure === null) throw new Error(`campaign item ${item.key} has no procedure`);
  return item.procedure;
};

const has = async (db: Db, query: Promise<{ id: number }[]>): Promise<boolean> => (await query).length > 0;

// --- Zmapovat estate ----------------------------------------------------------------------

const mapEstate: CampaignDefinition = {
  key: 'map-estate',
  title: 'Zmapovat estate',
  description: 'Triage a specifikace pro každou proceduru. Dva běhy modelu na proceduru — co je hotové, přeskočí.',
  needsTarget: false,

  items: async (db) => {
    const rows = await db.select({ name: procedures.name }).from(procedures).orderBy(asc(procedures.name));
    return rows.map((row) => item(row.name, row.name, row.name, 'triage+spec'));
  },

  // Both halves, not either. A procedure with a classification and no specification is
  // half-mapped, and skipping it would leave the estate looking mapped with a hole in it.
  isComplete: async (db, entry) =>
    has(
      db,
      db
        .select({ id: procedures.id })
        .from(procedures)
        .innerJoin(specs, eq(specs.procedureId, procedures.id))
        .where(and(eq(procedures.name, nameOf(entry)), isNotNull(procedures.oracleClass))),
    ),

  run: async (db, config, entry) => {
    const name = nameOf(entry);
    let costUsd = 0;
    const triage = await executeRun(db, config, triageRun(name));
    costUsd += triage.result.costUsd ?? 0;
    const spec = await executeRun(db, config, specRun(name));
    costUsd += spec.result.costUsd ?? 0;

    const [row] = await db.select({ oracleClass: procedures.oracleClass }).from(procedures).where(eq(procedures.name, name));
    return { detail: `${row?.oracleClass ?? 'netriazováno'} · specifikace ${spec.result.isError ? 'selhala' : 'hotová'}`, costUsd };
  },
};

// --- Migrovat proceduru -------------------------------------------------------------------

/**
 * One procedure through the whole lane, live, in the room.
 *
 * What is NOT in it: `implement-service`. Writing the replacement is a fifteen-minute Opus run
 * and — the harder constraint — adopting what it wrote is a host-side step, because parity-api
 * deliberately has no write mount into the demo app (see `db/schema.ts`, `service_artifacts`).
 * A campaign item that cannot finish inside the API is not a campaign item.
 */
const migrateProcedure: CampaignDefinition = {
  key: 'migrate-procedure',
  title: 'Migrovat proceduru',
  description: 'Jedna procedura celou cestou: triage → specifikace → oracle → shadow run → roztřídění odchylek.',
  needsTarget: true,

  items: async (_db, target) => {
    const name = target ?? '';
    return [
      item(`${name}:triage`, 'Triage — klasifikace z kódu', name, 'triage'),
      item(`${name}:spec`, 'Specifikace v češtině', name, 'spec'),
      item(`${name}:oracle`, 'Golden testy a invarianty ze zachyceného provozu', name, 'oracle'),
      item(`${name}:shadow`, 'Shadow run nad obnovenou kopií', name, 'shadow'),
      item(`${name}:classify`, 'Roztřídit, co nevyřešila kanonikalizace', name, 'classify'),
    ];
  },

  isComplete: async (db, entry) => {
    const name = nameOf(entry);
    const [procedure] = await db.select().from(procedures).where(eq(procedures.name, name));
    if (procedure === undefined) return false;

    switch (entry.step) {
      case 'triage':
        return procedure.oracleClass !== null;
      case 'spec':
        return has(db, db.select({ id: specs.id }).from(specs).where(eq(specs.procedureId, procedure.id)));
      case 'oracle':
        return has(db, db.select({ id: goldenTests.id }).from(goldenTests).where(eq(goldenTests.procedureId, procedure.id)));
      case 'shadow':
        return has(
          db,
          db
            .select({ id: shadowRuns.id })
            .from(shadowRuns)
            .where(and(eq(shadowRuns.procedureId, procedure.id), eq(shadowRuns.kind, 'shadow'), eq(shadowRuns.status, 'succeeded'))),
        );
      case 'classify': {
        // Scoped to the newest run OF THIS PROCEDURE. Unscoped, "the latest run" is whichever
        // procedure was replayed most recently, and from M7 there is more than one.
        const latest = await latestShadowRun(db, procedure.id);
        if (latest === null) return false;
        return !(await has(
          db,
          db
            .select({ id: diffs.id })
            .from(diffs)
            .where(and(eq(diffs.shadowRunId, latest), isNull(diffs.verdict))),
        ));
      }
      default:
        return false;
    }
  },

  run: async (db, config, entry) => {
    const name = nameOf(entry);

    switch (entry.step) {
      case 'triage': {
        const handle = await executeRun(db, config, triageRun(name));
        const [row] = await db.select({ oracleClass: procedures.oracleClass }).from(procedures).where(eq(procedures.name, name));
        return { detail: row?.oracleClass ?? 'netriazováno', costUsd: handle.result.costUsd ?? 0 };
      }
      case 'spec': {
        const handle = await executeRun(db, config, specRun(name));
        const [row] = await db
          .select({ markdown: specs.markdown })
          .from(specs)
          .innerJoin(procedures, eq(procedures.id, specs.procedureId))
          .where(eq(procedures.name, name));
        return { detail: `${(row?.markdown ?? '').length} znaků specifikace`, costUsd: handle.result.costUsd ?? 0 };
      }
      case 'oracle': {
        const handle = await executeRun(db, config, oracleRun(name));
        // The model chooses the cases; recording what the procedure does with them is Parity's
        // job, and doing it here means an item that finished has a working oracle behind it
        // rather than a list of case names.
        const cases = await recordBaseline(db, config, name);
        const suite = cases === 0 ? null : await runSuite(db, config, name, 'verify');
        return {
          detail: suite === null ? 'žádné případy' : `${suite.goldenPassed}/${suite.goldenPassed + suite.goldenFailed} prošlo`,
          costUsd: handle.result.costUsd ?? 0,
        };
      }
      case 'shadow': {
        const result = await runShadow(db, config, { procedureName: name, implementation: 'generated' });
        return {
          detail:
            `${result.casesReplayed} volání · ${result.strataCovered}/${result.strataObserved} strat · ` +
            `${result.rawDiffs} hrubých, ${result.resolvedByCanonicaliser} vyřešila kanonikalizace`,
          costUsd: 0,
        };
      }
      case 'classify': {
        const latest = await latestShadowRun(db, (await procedureId(db, name)) ?? -1);
        if (latest === null) throw new Error(`no shadow run to classify for ${name}`);
        const [row] = await db.select().from(shadowRuns).where(eq(shadowRuns.id, latest));
        const findings = await findingsFor(db, latest);
        const classified = await classifyRun(db, config, {
          shadowRunId: latest,
          procedureName: name,
          casesReplayed: row.casesReplayed,
          strataCovered: row.strataCovered,
          strataObserved: row.strataObserved,
          rawDiffs: row.rawDiffs,
          resolvedByCanonicaliser: row.noiseDiffs,
          surviving: row.rawDiffs - row.noiseDiffs,
          findings,
          replayMs: row.replayMs ?? 0,
          durationMs: row.durationMs ?? 0,
          shadowDatabase: row.shadowDatabase,
          implementation: row.implementation,
          implementationId: row.implementationId,
        });
        return {
          detail: `${classified.findings.length} nálezů · ${classified.behaviourChange} změn chování k rozhodnutí`,
          costUsd: classified.costUsd,
        };
      }
      default:
        throw new Error(`unknown step ${entry.step ?? 'null'}`);
    }
  },
};

// --- Smazat mrtvé procedury ---------------------------------------------------------------

/**
 * The cheapest true thing this platform can do.
 *
 * No spec, no oracle, no shadow run and no model call: three procedures have not been invoked
 * once in ninety days of captured traffic, and the argument for deleting them is that number.
 * The PR is assembled at the end rather than per item, because it is one change.
 */
const deleteDead: CampaignDefinition = {
  key: 'delete-dead',
  title: 'Smazat mrtvé procedury',
  description: 'Procedury bez jediného volání za 90 dní. Žádný běh modelu — argumentem je ten počet.',
  needsTarget: false,

  items: async (db) => {
    const rows = await db
      .select({ name: procedures.name })
      .from(procedures)
      .where(eq(procedures.invocations90d, 0))
      .orderBy(asc(procedures.name));
    return [
      ...rows.map((row) => item(row.name, `${row.name} — 0 volání za 90 dní`, row.name, 'delete')),
      // The PR is one change over all of them, so it is one item rather than a hidden epilogue.
      // On the screen it reads as the last line of the campaign, which is what it is.
      item('__pr', 'Sestavit PR, který je odstraní', null, 'pr'),
    ];
  },

  // The PR item is never skipped. Assembling is idempotent — it keys on the artefact hash — and
  // it is the item a rehearsal most wants to see happen again.
  isComplete: async (db, entry) =>
    entry.step === 'pr'
      ? false
      : has(
          db,
          db
            .select({ id: procedures.id })
            .from(procedures)
            .where(and(eq(procedures.name, nameOf(entry)), eq(procedures.campaignStatus, 'deleted'))),
        ),

  run: async (db, config, entry) => {
    if (entry.step === 'pr') {
      const pr = await assembleDeletionPr(db, config);
      if (pr === null) return { detail: 'nebylo co sestavit', costUsd: 0 };
      const removals = (pr.files as { path: string; contents: string | null }[]).filter((f) => f.contents === null);
      return {
        detail: `${plural(removals.length, 'soubor', 'soubory', 'souborů')} ke smazání · větev ${pr.branch} · neotevřeno`,
        costUsd: 0,
      };
    }

    const name = nameOf(entry);
    const [row] = await db.select().from(procedures).where(eq(procedures.name, name));
    if (row === undefined) throw new Error(`no procedure named ${name}`);
    if (row.invocations90d > 0) {
      // Belt and braces against a stale item list: the campaign chose its items when it started,
      // and an ingest between then and now could have given one of them traffic.
      throw new Error(`${name} has ${row.invocations90d} invocations — it is not dead`);
    }
    await db.update(procedures).set({ campaignStatus: 'deleted' }).where(eq(procedures.id, row.id));
    return { detail: `${row.lineCount} řádků T-SQL k odstranění`, costUsd: 0 };
  },
};

export const CAMPAIGNS: CampaignDefinition[] = [mapEstate, migrateProcedure, deleteDead];

export const findCampaign = (key: string): CampaignDefinition | undefined => CAMPAIGNS.find((c) => c.key === key);

async function procedureId(db: Db, name: string): Promise<number | null> {
  const [row] = await db.select({ id: procedures.id }).from(procedures).where(eq(procedures.name, name));
  return row?.id ?? null;
}

/** The newest succeeded shadow run of ONE procedure. Never "the newest shadow run". */
async function latestShadowRun(db: Db, procedureIdValue: number): Promise<number | null> {
  const [row] = await db
    .select({ id: shadowRuns.id })
    .from(shadowRuns)
    .where(and(eq(shadowRuns.procedureId, procedureIdValue), eq(shadowRuns.kind, 'shadow'), eq(shadowRuns.status, 'succeeded')))
    .orderBy(sql`${shadowRuns.id} desc`)
    .limit(1);
  return row?.id ?? null;
}
