/**
 * A coarse shape of what one captured call actually did — what it wrote if it writes, and
 * what it returned if it does not.
 *
 * Coarse on purpose. Exact values differ on every call and would make every invocation its own
 * stratum; the sign-and-shape pattern is what separates "a promo was applied and a loyalty
 * discount was not" from "both were", or "in stock" from "backordered" — distinctions the
 * input-derived branch key cannot see, because both procedures resolve them inside the body.
 *
 * This lived inside `agent/tools.ts` for M4 and moved here for M5, unchanged. The shadow run
 * has to stratify its replay set exactly the way the golden suite stratified its cases: a
 * second, nearly-identical copy of this heuristic would drift, and the first symptom would be
 * a shadow run that covers a branch the oracle does not, or the reverse. `DECISIONS.md`
 * records what a coarse-in-the-wrong-place stratification already cost this build once.
 */
export function outcomeSignature(writeSet: string | null, resultSet: string | null): string {
  const parts = new Set<string>();

  if (writeSet !== null && writeSet !== '') {
    try {
      const parsed = JSON.parse(writeSet) as Record<string, { columns?: { column: string; after: unknown }[] }[]>;
      for (const [table, images] of Object.entries(parsed)) {
        for (const image of images ?? []) {
          for (const change of image.columns ?? []) {
            const value = typeof change.after === 'string' ? Number(change.after) : change.after;
            if (typeof value !== 'number' || Number.isNaN(value)) continue;
            parts.add(`${table}.${change.column}:${value === 0 ? '0' : value > 0 ? '+' : '-'}`);
          }
        }
      }
    } catch {
      /* a malformed capture is not a reason to abandon stratification */
    }
  }

  // A read writes nothing, so a write-derived signature is empty for every call and the whole
  // procedure collapses into one stratum. `sp_GetProductAvailability` is the estate's hottest
  // procedure — 43% of all traffic, one observed branch key — and it drew exactly one candidate
  // case. Claiming a procedure is covered on the strength of a single replayed call is the
  // overclaiming the skill exists to forbid, so for reads the result set supplies the shape.
  if (parts.size === 0 && resultSet !== null && resultSet !== '') {
    try {
      const parsed = JSON.parse(resultSet) as unknown[][];
      parsed.forEach((rows, index) => {
        // Bucketed, not exact: row counts vary continuously and would make every call unique.
        const n = Array.isArray(rows) ? rows.length : 0;
        parts.add(`rs${index}:${n === 0 ? 'empty' : n === 1 ? 'one' : n < 10 ? 'few' : 'many'}`);
        const first = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
        for (const [column, value] of Object.entries(first ?? {})) {
          const numeric = typeof value === 'string' ? Number(value) : value;
          if (typeof numeric === 'number' && !Number.isNaN(numeric)) {
            parts.add(`rs${index}.${column}:${numeric === 0 ? '0' : numeric > 0 ? '+' : '-'}`);
          } else if (typeof value === 'boolean') {
            parts.add(`rs${index}.${column}:${value ? 'T' : 'F'}`);
          } else if (value === null) {
            parts.add(`rs${index}.${column}:null`);
          }
        }
      });
    } catch {
      /* same */
    }
  }

  return [...parts].sort().join(' ');
}

/** One stratum: the branch the inputs chose, and the shape of what came out. */
export const stratumOf = (branchKey: string | null, writeSet: string | null, resultSet: string | null): string =>
  `${branchKey ?? '-'}|${outcomeSignature(writeSet, resultSet)}`;
