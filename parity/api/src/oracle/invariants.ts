import type sql from 'mssql';
import { z } from 'zod';
import type { RowImage } from './execute.js';

/**
 * Invariants: rules that must hold after any run, checked in code over the write set.
 *
 * A **closed vocabulary**, deliberately. The agent proposes which columns and which
 * reference table, not how the check runs, and certainly not SQL that Parity would then
 * execute against the estate. Two reasons, and the second is the one that matters: a rule
 * expressed as free text is a comment, and a comment presented as verification is exactly
 * what this build exists not to ship.
 *
 * Anything the agent cannot express in this vocabulary is stored as `advisory` — recorded,
 * shown, and never counted as passing.
 *
 * The vocabulary is linear because that is what money is. A term list `[{column, factor}]`
 * expresses "the VAT charged on goods" as `TotalVat − 0.21·ShippingCost` without needing a
 * bespoke rule per estate, and expresses the taxed base as `TotalNet + DiscountAmount −
 * ShippingCost`. Isolating the base is not optional: a naive `TotalVat / TotalNet` is not a
 * rate on any order that carries a discount, so it would fire everywhere and mean nothing.
 */

const term = z.object({
  column: z.string().min(1),
  factor: z.number().default(1),
});

export type Term = z.infer<typeof term>;

export const invariantSpec = z.discriminatedUnion('kind', [
  /** A declared total really is the sum of its declared parts. */
  z.object({
    kind: z.literal('sum_identity'),
    table: z.string().min(1),
    target: z.string().min(1),
    components: z.array(term).min(1),
    tolerance: z.number().min(0).default(0.01),
  }),

  /** Money that must never go below zero, whatever the discounts do. */
  z.object({
    kind: z.literal('non_negative'),
    table: z.string().min(1),
    columns: z.array(z.string().min(1)).min(1),
  }),

  /**
   * A derived ratio must appear in a reference table. This is the shape that catches a rate
   * applied to the wrong base — the arithmetic still adds up, and only the rate table knows.
   */
  z.object({
    kind: z.literal('value_from_table'),
    table: z.string().min(1),
    numerator: z.array(term).min(1),
    denominator: z.array(term).min(1),
    referenceTable: z.string().min(1),
    referenceColumn: z.string().min(1),
    /**
     * Multiplies the reference value before comparison: `numerator / denominator` is compared
     * against `referenceColumn * referenceScale`.
     *
     * Stated as a multiplier because the alternative reading cost a run. A `Rate` column
     * holding `21` to mean 21%, compared against a ratio of `0.21`, needs **0.01** — not 100.
     * Getting it backwards makes the rule fail on every row, which is indistinguishable from a
     * procedure that is broken everywhere, so `write_invariants` reports the values it will
     * actually compare against and the caller can see the mistake immediately.
     */
    referenceScale: z.number().default(1),
    tolerance: z.number().min(0).default(0.0005),
  }),

  /** Real, but not expressible above. Recorded and reported, never counted as verified. */
  z.object({
    kind: z.literal('advisory'),
    note: z.string().min(1),
  }),
]);

export type InvariantSpec = z.infer<typeof invariantSpec>;

/**
 * An invariant violated by more than half of what it checked is not a finding about the
 * estate — it is a rule that does not describe this procedure.
 *
 * A real defect is an exception by construction: it lives in one branch, so it shows up in a
 * minority of cases. The planted promo/VAT defect violates 2 of 21 checks. A mis-stated rule
 * behaves the opposite way — `sp_ApplyPromoCode` drew one that failed 16 of 17, because it
 * compared a stored percentage against a ratio.
 *
 * Such a rule is **not deleted and not hidden**. It is reported as unconfirmed, with its
 * counts, and excluded from the violation headline. Deleting it would lose a reviewer's lead;
 * counting it would bury the one violation that matters under noise. The verdict is derived
 * on every read rather than stored, for the same reason `blocker` is: a stored judgement
 * drifts from the numbers it was drawn from and then misreports them with a straight face.
 */
export const UNCONFIRMED_RATIO = 0.5;

export function isConfirmedRule(evaluable: boolean, checked: number, violated: number): boolean {
  if (!evaluable || checked === 0) return false;
  return violated <= checked * UNCONFIRMED_RATIO;
}

export interface InvariantOutcome {
  checked: number;
  violated: number;
  /** The first case that broke it, and by how much. This is what a reviewer reads. */
  firstViolation: string | null;
}

const numeric = (value: unknown): number | null => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value);
  return null;
};

/** Σ factorᵢ·columnᵢ, or null if any column is missing or non-numeric on this row. */
function combination(row: Record<string, unknown>, terms: Term[]): number | null {
  let total = 0;
  for (const t of terms) {
    const value = numeric(row[t.column]);
    if (value === null) return null;
    total += value * t.factor;
  }
  return total;
}

/** Reference values, read once per evaluation rather than once per row. */
export async function loadReferenceValues(
  pool: sql.ConnectionPool,
  specs: InvariantSpec[],
): Promise<Map<string, number[]>> {
  const wanted = new Map<string, { table: string; column: string }>();
  for (const spec of specs) {
    if (spec.kind !== 'value_from_table') continue;
    wanted.set(`${spec.referenceTable}.${spec.referenceColumn}`, {
      table: spec.referenceTable,
      column: spec.referenceColumn,
    });
  }

  const values = new Map<string, number[]>();
  for (const [key, { table, column }] of wanted) {
    // Identifiers come from a validated spec and are checked against the estate catalog
    // before an invariant is ever stored, so they cannot be arbitrary text by this point.
    const result = await pool.request().query(`SELECT DISTINCT [${column}] AS v FROM dbo.[${table}]`);
    values.set(
      key,
      (result.recordset as { v: unknown }[]).map((r) => numeric(r.v)).filter((v): v is number => v !== null),
    );
  }
  return values;
}

/**
 * Evaluate one invariant across every row a golden case wrote.
 *
 * `caseLabel` is threaded through so a violation names the case that produced it — the
 * whole value of a failing invariant is knowing which call to look at.
 */
export function evaluate(
  spec: InvariantSpec,
  writeSet: Record<string, RowImage[]>,
  referenceValues: Map<string, number[]>,
  caseLabel: string,
): InvariantOutcome {
  if (spec.kind === 'advisory') return { checked: 0, violated: 0, firstViolation: null };

  const rows = (writeSet[spec.table] ?? []).filter((image) => image.row !== null);
  let checked = 0;
  let violated = 0;
  let firstViolation: string | null = null;

  const fail = (detail: string): void => {
    violated += 1;
    firstViolation ??= `${caseLabel}: ${detail}`;
  };

  for (const image of rows) {
    const row = image.row as Record<string, unknown>;

    if (spec.kind === 'sum_identity') {
      const target = numeric(row[spec.target]);
      const sum = combination(row, spec.components);
      if (target === null || sum === null) continue;
      checked += 1;
      if (Math.abs(target - sum) > spec.tolerance) {
        fail(`${spec.target}=${target} but components sum to ${sum.toFixed(4)}`);
      }
      continue;
    }

    if (spec.kind === 'non_negative') {
      for (const column of spec.columns) {
        const value = numeric(row[column]);
        if (value === null) continue;
        checked += 1;
        if (value < 0) fail(`${column}=${value}`);
      }
      continue;
    }

    const numerator = combination(row, spec.numerator);
    const denominator = combination(row, spec.denominator);
    if (numerator === null || denominator === null) continue;
    // A zero base is not a violation, it is an order with nothing to tax.
    if (Math.abs(denominator) < 1e-9) continue;

    checked += 1;
    const ratio = numerator / denominator;
    const allowed = referenceValues.get(`${spec.referenceTable}.${spec.referenceColumn}`) ?? [];
    const matched = allowed.some((v) => Math.abs(ratio - v * spec.referenceScale) <= spec.tolerance);
    if (!matched) {
      const options = allowed.map((v) => (v * spec.referenceScale).toFixed(4)).join(', ');
      fail(`derived rate ${ratio.toFixed(6)} is not in ${spec.referenceTable}.${spec.referenceColumn} (${options})`);
    }
  }

  return { checked, violated, firstViolation };
}

/**
 * Does this spec only name things that really exist?
 *
 * The agent chooses the columns, so a typo or a hallucinated column would otherwise become
 * an invariant that silently checks nothing — `combination` returns null for a missing
 * column and the row is skipped, so it would sit on the screen at zero violations looking
 * exactly like a rule that holds.
 */
export function unknownIdentifiers(spec: InvariantSpec, catalog: Map<string, Set<string>>): string[] {
  if (spec.kind === 'advisory') return [];

  const missing: string[] = [];
  const check = (table: string, columns: string[]): void => {
    const known = catalog.get(table);
    if (known === undefined) {
      missing.push(`table ${table}`);
      return;
    }
    for (const column of columns) if (!known.has(column)) missing.push(`${table}.${column}`);
  };

  if (spec.kind === 'sum_identity') {
    check(spec.table, [spec.target, ...spec.components.map((t) => t.column)]);
  } else if (spec.kind === 'non_negative') {
    check(spec.table, spec.columns);
  } else {
    check(spec.table, [...spec.numerator, ...spec.denominator].map((t) => t.column));
    check(spec.referenceTable, [spec.referenceColumn]);
  }
  return missing;
}
