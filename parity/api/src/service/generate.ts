import { asc, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { decisions, goldenTests, invariants, procedures } from '../db/schema.js';
import type { Config } from '../env.js';
import { executeRun, implementServiceRun } from '../agent/runner.js';
import { allowedPathsFor, isComplete, latestArtifacts, nextAttempt, type ArtifactSet } from './artifacts.js';

/**
 * One attempt at writing the replacement.
 *
 * The brief is assembled here rather than in the skill file, because it is the part that
 * changes between attempts: the skill says what a good service looks like and never moves, and
 * this says what *this* procedure is and what the last attempt got wrong. `docs/DECISIONS.md`
 * records the same split for `classify-diff` — the closed vocabulary lives in the skill, the
 * evidence is assembled in code.
 *
 * The interface contract is stated verbatim. `index.ts` imports these two modules by name and
 * calls these three exports; a service that gets that wrong does not fail review, it fails
 * four hundred replay cases as a 503, and the diff engine reports it as four hundred
 * behavioural differences.
 */

/**
 * What the shell will import, per procedure, stated verbatim to the agent.
 *
 * These mirror the adapter table in the service's `index.ts`. Two statements of one truth, and
 * that is deliberate: this one is what the agent is asked for, that one is what the container
 * loads, and a disagreement between them surfaces at adoption rather than four hundred replay
 * cases into a shadow run.
 *
 * The shapes differ because the procedures do. `sp_CalculateOrderTotal` reads into variables and
 * updates `OrderLedger`, so its **write set is its output** and it returns no result set.
 * `sp_GetCartSummary` writes nothing and returns two: the cart lines, then a one-row summary.
 */
const INTERFACES: Record<string, string> = {
  sp_CalculateOrderTotal: [
    '```ts',
    '// pricing.ts',
    'export class OrderNotFound extends Error {}',
    'export interface PricingInput { orderNumber: string; promoCode: string | null; modifiedBy: string }',
    'export interface Pricing {',
    '  netSubtotal: number; vatRate: number; promoCode: string | null;',
    '  promoDiscount: number; loyaltyDiscount: number;',
    '  totalNet: number; totalVat: number; totalWithVat: number;',
    '  stackedWithLoyalty: boolean;',
    '}',
    'export async function price(pool: sql.ConnectionPool, input: PricingInput, now: Date): Promise<Pricing>',
    '',
    '// persist.ts',
    'export async function persist(pool: sql.ConnectionPool, input: PricingInput, pricing: Pricing, now: Date): Promise<void>',
    '```',
    '',
    'This procedure has no SELECT: it reads into variables and updates OrderLedger, so its write',
    'set IS its output and price/persist between them must reproduce every column it writes.',
  ].join('\n'),

  sp_GetCartSummary: [
    '```ts',
    '// summary.ts',
    'export async function summarise(',
    '  pool: sql.ConnectionPool,',
    '  params: Record<string, unknown>,',
    '  now: Date,',
    '): Promise<{ resultSets: unknown[][] }>',
    '```',
    '',
    'One module and one export. This procedure **writes nothing** — there is no persist step and',
    'there must not be one; anything your code writes to the database is a behavioural difference.',
    '',
    '`params` is the captured input object exactly as the estate recorded it, so read the',
    'parameter names off the procedure source rather than assuming them.',
    '',
    'It returns **two result sets, in this order**: the cart lines, then a one-row summary. Return',
    'them as `resultSets: [lines, [summary]]`, with each row an object whose keys match the column',
    'names the procedure SELECTs — the harness compares them column by column.',
  ].join('\n'),

  default: [
    '```ts',
    '// compute.ts',
    'export async function compute(',
    '  pool: sql.ConnectionPool,',
    '  params: Record<string, unknown>,',
    '  now: Date,',
    '): Promise<{ resultSets: unknown[][] }>',
    '```',
  ].join('\n'),
};

export interface GenerateInput {
  procedureName: string;
  /** What the previous attempt got wrong: failing golden cases, surviving shadow findings. */
  feedback: string | null;
}

export interface GenerateResult {
  runId: string;
  agentRunId: number;
  attempt: number;
  status: string;
  artifacts: ArtifactSet | null;
  complete: boolean;
  blocked: { toolName: string; reason: string }[];
  costUsd: number | null;
}

export async function generateService(db: Db, config: Config, input: GenerateInput): Promise<GenerateResult | null> {
  const [procedure] = await db.select().from(procedures).where(eq(procedures.name, input.procedureName));
  if (procedure === undefined) return null;

  const attempt = await nextAttempt(db, procedure.id);
  const brief = await assembleBrief(db, procedure.id, input);

  const handle = await executeRun(
    db,
    config,
    implementServiceRun(input.procedureName, brief),
    undefined,
    // Fixed for the whole run. Derived per call it would drift: the first file would open
    // attempt 3 and the second, seeing 3 stored, would open 4 — two half-attempts and nothing
    // complete enough to adopt.
    { serviceAttempt: attempt },
  );

  const artifacts = await latestArtifacts(db, procedure.id);
  return {
    runId: handle.runId,
    agentRunId: handle.agentRunId,
    attempt,
    status: handle.result.isError ? 'failed' : handle.blocked.length > 0 ? 'blocked' : 'succeeded',
    artifacts,
    complete: isComplete(input.procedureName, artifacts),
    blocked: handle.blocked,
    costUsd: handle.result.costUsd,
  };
}

async function assembleBrief(db: Db, procedureId: number, input: GenerateInput): Promise<string> {
  const cases = await db
    .select({ name: goldenTests.name, branchKey: goldenTests.branchKey, rationale: goldenTests.rationale })
    .from(goldenTests)
    .where(eq(goldenTests.procedureId, procedureId))
    .orderBy(asc(goldenTests.name));

  const rules = await db
    .select({ name: invariants.name, kind: invariants.kind, rationale: invariants.rationale })
    .from(invariants)
    .where(eq(invariants.procedureId, procedureId))
    .orderBy(asc(invariants.name));

  const decided = await db
    .select()
    .from(decisions)
    .where(eq(decisions.procedureId, procedureId))
    .orderBy(desc(decisions.decidedAt));

  return [
    `Use the implement-service skill to write the replacement for ${input.procedureName}.`,
    '',
    'Read its specification with read_spec and its source with read_procedure. The specification',
    'is the description of record — it was written from this source by an earlier run and it',
    'documents the behaviour faithfully, including the parts that look wrong.',
    '',
    '## The interface you are writing against',
    '',
    'The HTTP shell already exists and is not yours to write. It imports the modules below from',
    "your procedure's directory and calls the exports named here. Match these signatures exactly:",
    '',
    INTERFACES[input.procedureName] ?? INTERFACES.default,
    '',
    'Import `sql from "mssql"` and nothing else beyond the Node standard library. The container',
    'installs its dependencies at build time, so anything else will not resolve at runtime.',
    '',
    '`now` is passed in. Never call `new Date()`, `Date.now()` or `GETDATE()` yourself — the',
    'clock arrives through that parameter so the service can be replayed against a recorded one.',
    '',
    '## The cases your implementation will be measured on',
    '',
    'These are the golden cases. You are given their names and the branches they cover, and you',
    'are deliberately NOT given what they expect: an implementation fitted to the oracle is not',
    'measured by it. Reproduce the specified behaviour and the expectations follow.',
    '',
    ...cases.map((c) => `- \`${c.name}\` — branch \`${c.branchKey ?? 'n/a'}\`. ${c.rationale ?? ''}`),
    '',
    '## Invariants that must hold at runtime',
    '',
    ...rules.map((r) => `- **${r.name}** (${r.kind}) — ${r.rationale ?? ''}`),
    '',
    decided.length === 0
      ? ''
      : [
          '## Decisions already taken by a human',
          '',
          'These are binding. Each one is an answer to a difference a shadow run already found,',
          'given by a person who saw both sides. `preserve` means the old behaviour is the',
          'required behaviour, however wrong it looks.',
          '',
          ...decided.map((d) => `- \`${d.diffSignature}\` → **${d.action}**. ${d.note ?? ''}`),
          '',
        ].join('\n'),
    input.feedback === null
      ? ''
      : ['## What the previous attempt got wrong', '', input.feedback, ''].join('\n'),
    `Write ${allowedPathsFor(input.procedureName).join(' and ')} with write_service_file. Write the`,
    'complete file each time — it is stored verbatim and deployed verbatim, not merged with',
    'anything. No other path will be accepted.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}
