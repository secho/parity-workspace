import { canonicalise, fingerprint, stableKey, type CanonicalOutcome } from '../oracle/canonicalise.js';
import type { RowImage } from '../oracle/execute.js';
import type { ReplayOutcome } from './replay.js';

/**
 * What differs between the old procedure and the new implementation, and which of those
 * differences a model is allowed to see.
 *
 * `SPEC.md` §8 is unambiguous: *"Normalise ordering, timestamps, GUIDs and float tolerance in
 * code first; only send what survives to the model. Asking the agent to classify raw noise
 * wastes tokens and produces inconsistent verdicts between demo runs."* This file is where
 * that rule is executed, and — more importantly — where it becomes **auditable**.
 *
 * Every raw difference is recorded, including the ones canonicalisation resolves. That is
 * deliberate. A pipeline that silently dropped them would leave nothing on screen to show
 * that the mechanical layer did any work, and "the model never saw these" would be an
 * assertion about code nobody can check. Instead each resolved difference is stored with the
 * normalisation that resolved it and no `agentRunId`, and `verify-m5` reads that back.
 *
 * Aggregation is per **case, table and column**, not per row. One order writes its summary
 * onto every line it has, so a single wrong total shows up on three or forty rows; counting
 * those separately would inflate every number in the demo by the average order size and tell
 * nobody anything.
 */

/** Below this, a numeric difference is smaller than the smallest coin the estate prices in. */
const SUB_CENT = 0.01;

export type DiffScope = 'write_set' | 'result_set' | 'error';

export interface FieldDiff {
  scope: DiffScope;
  tableName: string | null;
  columnName: string | null;
  /** Rows of this table in this case that carried the difference. */
  rowsAffected: number;
  oldValue: unknown;
  newValue: unknown;
  /**
   * Groups equivalent differences into one finding, across every case that shows it. One
   * model call per signature, and one queue item per signature.
   */
  signature: string;
  canonicalEqual: boolean;
  /** Which normalisation resolved it, when one did. Null for anything that survived. */
  noiseReason: string | null;
}

export interface CaseDiff {
  equal: boolean;
  oldCanonical: CanonicalOutcome;
  newCanonical: CanonicalOutcome;
  oldFingerprint: string;
  newFingerprint: string;
  diffs: FieldDiff[];
}

export interface DiffOptions {
  identityColumns: Map<string, Set<string>>;
}

const isNumeric = (value: unknown): value is number =>
  typeof value === 'number' || (typeof value === 'string' && value !== '' && !Number.isNaN(Number(value)));

/**
 * The magnitude class of a numeric change, and the reason it belongs in the signature.
 *
 * A finding is a thing a human decides once. Grouping a hundredth-of-a-heller rounding
 * difference together with a 1 647 Kč VAT difference — both on `OrderLedger.TotalWithVat`,
 * both real — would force one verdict to cover both, and whichever answer came back would be
 * wrong about the other. This is a structural property of the difference, not a judgement
 * about it: the model still decides what each class *means*.
 */
function magnitude(oldValue: unknown, newValue: unknown): string {
  if (!isNumeric(oldValue) || !isNumeric(newValue)) return 'value';
  const delta = Math.abs(Number(oldValue) - Number(newValue));
  return delta < SUB_CENT ? 'sub_cent' : 'material';
}

/**
 * Which normalisation resolved a difference, read off the canonical value itself.
 *
 * The canonicaliser reports which normalisations fired anywhere in an outcome, not which one
 * fired on a given field, and threading that through would mean changing the file `SPEC.md`
 * calls the one place normalisation happens. The tokens it writes are unambiguous, so the
 * reason is recovered from them instead.
 */
function noiseReasonFor(scope: DiffScope, canonicalValue: unknown, oldValue: unknown, newValue: unknown): string {
  const token = typeof canonicalValue === 'string' ? canonicalValue : '';
  if (token === '<clock>' || /^<clock[+-]\d+s>$/.test(token)) return 'clock';
  if (token.includes('<new:')) return 'identity';
  if (token.includes('<guid:')) return 'guid';
  if (isNumeric(oldValue) && isNumeric(newValue) && Number(oldValue) !== Number(newValue)) return 'float';
  // Only result-set rows are sorted, so ordering cannot resolve a write-set value. Falling
  // back to it there would put a plausible label on something nobody understands, which is
  // how a wrong reason survives review. `verify-m5` fails the build on `unexplained`.
  if (scope === 'result_set') return 'ordering';
  return 'unexplained';
}

const rowsByKey = (images: RowImage[]): Map<string, RowImage> =>
  new Map(images.map((image) => [stableKey(image.pk), image]));

interface WriteSetDifference {
  table: string;
  /** Null means the two sides wrote different *rows*, not different values in a row. */
  column: string | null;
  kind: 'missing_in_new' | 'extra_in_new' | 'value';
  rows: number;
  oldValue: unknown;
  newValue: unknown;
}

/**
 * Compare two write sets per table and column. Used twice per case — once on the raw pair and
 * once on the canonical pair — which is what lets "canonicalisation resolved this" be derived
 * rather than tracked.
 */
function compareWriteSets(
  oldWriteSet: Record<string, RowImage[]>,
  newWriteSet: Record<string, RowImage[]>,
): WriteSetDifference[] {
  const differences: WriteSetDifference[] = [];
  const tables = [...new Set([...Object.keys(oldWriteSet), ...Object.keys(newWriteSet)])].sort();

  for (const table of tables) {
    const oldRows = rowsByKey(oldWriteSet[table] ?? []);
    const newRows = rowsByKey(newWriteSet[table] ?? []);

    const onlyOld = [...oldRows.keys()].filter((key) => !newRows.has(key));
    const onlyNew = [...newRows.keys()].filter((key) => !oldRows.has(key));
    if (onlyOld.length > 0 || onlyNew.length > 0) {
      differences.push({
        table,
        column: null,
        kind: onlyOld.length > 0 ? 'missing_in_new' : 'extra_in_new',
        rows: onlyOld.length + onlyNew.length,
        oldValue: { rowsWritten: oldRows.size, onlyHere: onlyOld.slice(0, 3) },
        newValue: { rowsWritten: newRows.size, onlyHere: onlyNew.slice(0, 3) },
      });
    }

    const perColumn = new Map<string, { rows: number; oldValue: unknown; newValue: unknown }>();
    for (const [key, oldRow] of oldRows) {
      const newRow = newRows.get(key);
      if (newRow === undefined) continue;

      const oldValues: Record<string, unknown> = oldRow.op === newRow.op ? (oldRow.row ?? {}) : { __op: oldRow.op };
      const newValues: Record<string, unknown> = oldRow.op === newRow.op ? (newRow.row ?? {}) : { __op: newRow.op };

      for (const column of new Set([...Object.keys(oldValues), ...Object.keys(newValues)])) {
        if (stableKey(oldValues[column]) === stableKey(newValues[column])) continue;
        const entry = perColumn.get(column) ?? {
          rows: 0,
          oldValue: oldValues[column] ?? null,
          newValue: newValues[column] ?? null,
        };
        perColumn.set(column, { ...entry, rows: entry.rows + 1 });
      }
    }

    for (const [column, entry] of [...perColumn.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      differences.push({ table, column, kind: 'value', rows: entry.rows, oldValue: entry.oldValue, newValue: entry.newValue });
    }
  }

  return differences;
}

/**
 * The identity of one (table, column) difference, used to line the raw walk up against the
 * canonical one.
 *
 * A function rather than a template literal repeated at each site. The engine once had three
 * copies of `` `${table} ${column ?? ''}` `` and an edit put a newline inside one of them, so
 * the producer emitted `OrderLedger\nTotalVat` and the consumer looked up `OrderLedger TotalVat`.
 * Nothing matched, every surviving difference was reclassified as noise, and the shadow run
 * reported a clean board — it typechecked, it ran, and it was silently wrong in the one
 * direction this build cannot tolerate. One definition cannot disagree with itself.
 */
const columnKey = (table: string, column: string | null): string => `${table}\u0000${column ?? ''}`;

/** A canonical value for one column, to read the normalisation token off. */
const canonicalValueOf = (images: RowImage[], column: string): unknown =>
  images.map((image) => image.row?.[column]).find((value) => value !== undefined) ?? null;

/**
 * Compare one replayed case.
 *
 * Each side is canonicalised against **its own** clock window, which is the only correct
 * reading: a timestamp is normalised when it provably came from the clock of the run that
 * produced it, and the two runs happened at different moments by construction.
 */
export function diffCase(oldOutcome: ReplayOutcome, newOutcome: ReplayOutcome, options: DiffOptions): CaseDiff {
  const oldCanonical = canonicalise(oldOutcome, {
    clockWindow: oldOutcome.clockWindow,
    identityColumns: options.identityColumns,
  });
  const newCanonical = canonicalise(newOutcome, {
    clockWindow: newOutcome.clockWindow,
    identityColumns: options.identityColumns,
  });

  const diffs: FieldDiff[] = [];

  // --- errors ---------------------------------------------------------------
  // An error on one side and not the other is the largest difference there is, and it is
  // never noise: one implementation refused work the other did.
  if ((oldOutcome.error ?? null) !== (newOutcome.error ?? null)) {
    diffs.push({
      scope: 'error',
      tableName: null,
      columnName: null,
      rowsAffected: 1,
      oldValue: oldOutcome.error,
      newValue: newOutcome.error,
      signature: `error:${oldOutcome.error === null ? 'new_only' : newOutcome.error === null ? 'old_only' : 'both'}`,
      canonicalEqual: false,
      noiseReason: null,
    });
  }

  // --- write sets -----------------------------------------------------------
  //
  // Two independent walks rather than one. The obvious form — walk the raw rows and look up
  // each one's canonical twin — cannot be made correct: the canonicaliser normalises primary
  // keys too, so a freshly inserted row's raw key does not appear in the canonical write set
  // at all, and the lookup silently misses exactly the rows an inserting procedure produces.
  //
  // So: walk raw to find what differs and by how much, walk canonical to find what still
  // differs afterwards, and a column present in the first and absent from the second is one
  // canonicalisation resolved. Aggregating per column makes the two walks comparable without
  // ever having to pair individual rows across them.
  const rawDifferences = compareWriteSets(oldOutcome.writeSet, newOutcome.writeSet);
  const survivingDifferences = compareWriteSets(oldCanonical.writeSet, newCanonical.writeSet);
  const surviving = new Set(survivingDifferences.map((d) => columnKey(d.table, d.column)));

  // Rows still differing after normalisation, per column. Reporting the raw count on a
  // surviving column would include the rows canonicalisation resolved, so a finding could
  // claim more rows than it actually covers.
  const survivingRows = new Map(survivingDifferences.map((d) => [columnKey(d.table, d.column), d.rows]));

  for (const difference of rawDifferences) {
    const key = columnKey(difference.table, difference.column);
    const canonicalEqual = !surviving.has(key);
    const rows = canonicalEqual ? difference.rows : (survivingRows.get(key) ?? difference.rows);

    if (difference.column === null) {
      // A row one side wrote and the other did not — reported once for the table rather than
      // once per row. "The service never touched Catalog" is a single finding.
      diffs.push({
        scope: 'write_set',
        tableName: difference.table,
        columnName: null,
        rowsAffected: rows,
        oldValue: difference.oldValue,
        newValue: difference.newValue,
        signature: `write_set:${difference.table}:rows:${difference.kind}`,
        canonicalEqual,
        noiseReason: null,
      });
      continue;
    }

    diffs.push({
      scope: 'write_set',
      tableName: difference.table,
      columnName: difference.column,
      rowsAffected: rows,
      oldValue: difference.oldValue,
      newValue: difference.newValue,
      signature: `write_set:${difference.table}.${difference.column}:${magnitude(difference.oldValue, difference.newValue)}`,
      canonicalEqual,
      noiseReason: canonicalEqual
        ? noiseReasonFor(
            'write_set',
            canonicalValueOf(oldCanonical.writeSet[difference.table] ?? [], difference.column),
            difference.oldValue,
            difference.newValue,
          )
        : null,
    });
  }

  // A difference canonicalisation *introduced*.
  //
  // Normalisation is not per value — the GUID and identity maps assign ordinals in order of
  // first encounter, per side. Two sides that wrote the same two new identifiers in the
  // opposite order are raw-equal on every row and canonically different on both. Driving the
  // loop from the raw walk alone would drop that on the floor: no diff row, nothing on screen,
  // and a shadow run that reported clean.
  //
  // Nothing in `sp_CalculateOrderTotal` can reach this — it inserts no rows and writes no
  // GUIDs — but `sp_PlaceOrder` writes `PaymentRef = 'PR-' + NEWID()` and is M6's problem.
  // A silently dropped difference is the one failure mode this build cannot afford.
  const rawKeys = new Set(rawDifferences.map((d) => columnKey(d.table, d.column)));
  for (const difference of survivingDifferences) {
    if (rawKeys.has(columnKey(difference.table, difference.column))) continue;
    diffs.push({
      scope: 'write_set',
      tableName: difference.table,
      columnName: difference.column,
      rowsAffected: difference.rows,
      oldValue: difference.oldValue,
      newValue: difference.newValue,
      signature:
        difference.column === null
          ? `write_set:${difference.table}:rows:normalised_${difference.kind}`
          : `write_set:${difference.table}.${difference.column}:normalised`,
      canonicalEqual: false,
      noiseReason: null,
    });
  }

  // --- result sets ----------------------------------------------------------
  // Compared canonical, because the canonicaliser has already sorted them: this estate is
  // deliberately full of ORDER BY branches with no secondary key, so raw sequence equality
  // would report a difference on every call of `sp_SearchProducts` and mean nothing.
  const recordsets = Math.max(oldCanonical.resultSets.length, newCanonical.resultSets.length);
  for (let index = 0; index < recordsets; index++) {
    const oldRows = oldCanonical.resultSets[index] ?? [];
    const newRows = newCanonical.resultSets[index] ?? [];
    if (stableKey(oldRows) === stableKey(newRows)) continue;

    diffs.push({
      scope: 'result_set',
      tableName: null,
      columnName: `rs${index}`,
      rowsAffected: Math.max(oldRows.length, newRows.length),
      oldValue: oldRows.slice(0, 3),
      newValue: newRows.slice(0, 3),
      signature: `result_set:rs${index}:${oldRows.length === newRows.length ? 'values' : 'row_count'}`,
      canonicalEqual: false,
      noiseReason: null,
    });
  }

  const oldFingerprint = fingerprint(oldCanonical);
  const newFingerprint = fingerprint(newCanonical);

  return {
    equal: oldFingerprint === newFingerprint && (oldOutcome.error ?? null) === (newOutcome.error ?? null),
    oldCanonical,
    newCanonical,
    oldFingerprint,
    newFingerprint,
    diffs,
  };
}

export interface Finding {
  signature: string;
  scope: DiffScope;
  tableName: string | null;
  columnName: string | null;
  /** Cases showing this difference — the number that says whether it is an exception. */
  cases: number;
  rowsAffected: number;
  /** One case, for the side-by-side. The lowest sequence, so it is stable between runs. */
  sample: { seq: number; sourceInvocationId: number; oldValue: unknown; newValue: unknown };
}

/**
 * Group what survived canonicalisation into findings — one per signature, ordered so that
 * the same run always produces the same queue.
 */
export function findings(
  perCase: { seq: number; sourceInvocationId: number; diff: CaseDiff }[],
): Finding[] {
  const grouped = new Map<string, Finding>();

  for (const entry of perCase) {
    for (const diff of entry.diff.diffs) {
      if (diff.canonicalEqual) continue;
      const existing = grouped.get(diff.signature);
      if (existing === undefined) {
        grouped.set(diff.signature, {
          signature: diff.signature,
          scope: diff.scope,
          tableName: diff.tableName,
          columnName: diff.columnName,
          cases: 1,
          rowsAffected: diff.rowsAffected,
          sample: {
            seq: entry.seq,
            sourceInvocationId: entry.sourceInvocationId,
            oldValue: diff.oldValue,
            newValue: diff.newValue,
          },
        });
        continue;
      }
      existing.cases++;
      existing.rowsAffected += diff.rowsAffected;
    }
  }

  return [...grouped.values()].sort((a, b) => b.cases - a.cases || a.signature.localeCompare(b.signature));
}
