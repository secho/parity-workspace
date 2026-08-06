import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { serviceArtifacts } from '../db/schema.js';

/**
 * The generated service's source, as rows rather than as files.
 *
 * Parity has no write mount into `parity-platform-demo-app` and does not get one at M6. The
 * reason is the policy layer, not tidiness: `decide()` waves through every tool whose name is
 * not prefixed `mcp__parity__` (../agent/policy.ts), and the SDK's built-in `Write` is exactly
 * that. A write mount would hand the agent a capability the tier table does not govern, does
 * not show on the Provoz page and cannot refuse — in the milestone whose entire claim is that
 * the platform gates what the agent does.
 *
 * There is a second, duller reason. `client.ts` disposes the run workspace in a `finally`, so
 * anything written with the SDK's file tools is gone the moment the run ends. Whatever the
 * agent produces has to be captured *during* the run either way.
 *
 * So: the agent calls `write_service_file`, the bytes land here, and `make adopt-service`
 * materialises them from the host. Three consequences worth having — the source is versioned
 * per attempt, `demo-reset` removes it by cascade like everything else, and `open_pr` reads
 * the same rows it deploys from, so the PR cannot drift from what was replayed.
 */

/**
 * What the agent may write, and nothing else.
 *
 * `index.ts` and `db.ts` are the harness contract, not business logic: `/replay/<proc>` taking
 * the captured parameters verbatim, `/health`, and the `/_admin/disconnect` handshake that
 * keeps a shadow revert at 530 ms instead of an unbounded wait on an idle pooled connection.
 * The shadow harness depends on all three, no spec describes any of them, and the failure mode
 * of getting the route shape wrong is four hundred replay cases returning 404 — which the diff
 * engine would faithfully report as four hundred behavioural differences.
 *
 * So the platform owns the shell and the agent writes the rules. That is a sentence to say out
 * loud rather than a limitation to hide: the agent wrote the pricing and the writes, the HTTP
 * shell is the migration harness's contract.
 */
export const ALLOWED_PATHS = ['pricing.ts', 'persist.ts'] as const;

/**
 * What each procedure's service is made of.
 *
 * Per procedure rather than one global list, because the shape of the answer differs:
 * `sp_CalculateOrderTotal` computes and then writes, so it has two modules;
 * `sp_GetCartSummary` writes nothing at all, so a `persist.ts` would be an empty file the
 * adoption check would then wait for forever. `isComplete` is the quiet failure here — with a
 * global list, adopting a lone `summary.ts` reads as "missing persist.ts", which is a true
 * sentence about the wrong thing.
 *
 * These names are also what `index.ts`'s adapter table imports, so the two must agree. They are
 * stated in both places on purpose: this one is enforced when the agent writes, that one when
 * the service loads, and a mismatch is caught at adoption rather than at replay.
 */
const PATHS: Record<string, readonly string[]> = {
  sp_CalculateOrderTotal: ['pricing.ts', 'persist.ts'],
  sp_GetCartSummary: ['summary.ts'],
};

export function allowedPathsFor(procedureName: string): readonly string[] {
  return PATHS[procedureName] ?? ALLOWED_PATHS;
}

export interface ArtifactFile {
  path: string;
  contents: string;
  sha256: string;
}

export interface ArtifactSet {
  attempt: number;
  files: ArtifactFile[];
  /** Over the whole set. What the deployed service echoes at `/health`. */
  runHash: string;
  agentRunId: number | null;
}

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * The hash of a whole attempt.
 *
 * Joined by NUL, in path order. M5 lost most of a day to a newline inside a template literal
 * quietly merging two key components into one, and the symptom was every finding being
 * classified as noise — a separator that cannot occur in the data is the fix that stuck.
 */
export function hashSet(files: { path: string; sha256: string }[]): string {
  const ordered = [...files].sort((a, b) => a.path.localeCompare(b.path));
  return sha256(ordered.map((f) => `${f.path}\0${f.sha256}`).join('\0\0'));
}

export function isAllowedPath(procedureName: string, path: string): boolean {
  return allowedPathsFor(procedureName).includes(path);
}

/** The attempt number a new run should write under: one past the highest already stored. */
export async function nextAttempt(db: Db, procedureId: number): Promise<number> {
  const [latest] = await db
    .select({ attempt: serviceArtifacts.attempt })
    .from(serviceArtifacts)
    .where(eq(serviceArtifacts.procedureId, procedureId))
    .orderBy(desc(serviceArtifacts.attempt))
    .limit(1);
  return (latest?.attempt ?? 0) + 1;
}

/**
 * Store one file and re-hash the attempt it belongs to.
 *
 * The set hash moves on every write because it is over the whole set, and a partially-written
 * attempt therefore carries a hash that matches nothing deployed. That is the correct
 * behaviour: `/health` reporting a hash no artefact set claims is how a half-adopted service
 * announces itself instead of being replayed against.
 */
export async function recordArtifact(
  db: Db,
  input: { procedureId: number; agentRunId: number | null; attempt: number; path: string; contents: string },
): Promise<{ sha256: string; runHash: string }> {
  const digest = sha256(input.contents);

  await db
    .insert(serviceArtifacts)
    .values({
      procedureId: input.procedureId,
      agentRunId: input.agentRunId,
      attempt: input.attempt,
      path: input.path,
      contents: input.contents,
      sha256: digest,
      // Rewritten below once the whole set is known. Never left as a placeholder.
      runHash: '',
    })
    .onConflictDoUpdate({
      target: [serviceArtifacts.procedureId, serviceArtifacts.attempt, serviceArtifacts.path],
      set: { contents: input.contents, sha256: digest, agentRunId: input.agentRunId, createdAt: new Date() },
    });

  const rows = await db
    .select({ path: serviceArtifacts.path, sha256: serviceArtifacts.sha256 })
    .from(serviceArtifacts)
    .where(and(eq(serviceArtifacts.procedureId, input.procedureId), eq(serviceArtifacts.attempt, input.attempt)));

  const runHash = hashSet(rows);
  await db
    .update(serviceArtifacts)
    .set({ runHash })
    .where(and(eq(serviceArtifacts.procedureId, input.procedureId), eq(serviceArtifacts.attempt, input.attempt)));

  return { sha256: digest, runHash };
}

/** The newest complete attempt, or null if the agent has not written one yet. */
export async function latestArtifacts(db: Db, procedureId: number): Promise<ArtifactSet | null> {
  const attempt = (await nextAttempt(db, procedureId)) - 1;
  if (attempt < 1) return null;

  const rows = await db
    .select()
    .from(serviceArtifacts)
    .where(and(eq(serviceArtifacts.procedureId, procedureId), eq(serviceArtifacts.attempt, attempt)));
  if (rows.length === 0) return null;

  const files = rows
    .map((r) => ({ path: r.path, contents: r.contents, sha256: r.sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path));

  return {
    attempt,
    files,
    runHash: hashSet(files),
    agentRunId: rows.find((r) => r.agentRunId !== null)?.agentRunId ?? null,
  };
}

/**
 * Whether an attempt is complete — every allowed path present.
 *
 * An incomplete set is not adopted. Half a service is worse than none: the container would
 * keep serving whichever file the last attempt left behind, and the shadow run would compare
 * the procedure against a chimera of two attempts with no way to tell from the recorded row.
 */
export function isComplete(procedureName: string, set: ArtifactSet | null): set is ArtifactSet {
  if (set === null) return false;
  const written = new Set(set.files.map((f) => f.path));
  return allowedPathsFor(procedureName).every((p) => written.has(p));
}
