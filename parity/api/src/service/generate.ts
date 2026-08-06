import { asc, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { decisions, goldenTests, invariants, procedures } from '../db/schema.js';
import type { Config } from '../env.js';
import { executeRun, implementServiceRun } from '../agent/runner.js';
import { isComplete, latestArtifacts, nextAttempt, type ArtifactSet } from './artifacts.js';

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
    complete: isComplete(artifacts),
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
    'The HTTP shell already exists and is not yours to write. It imports exactly two modules',
    'from the same directory and calls exactly three exports. Match these signatures:',
    '',
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
    'Write both files with write_service_file. Write the complete file each time — it is stored',
    'verbatim and deployed verbatim, not merged with anything.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}
