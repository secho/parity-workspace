/**
 * Column-level reads and writes, parsed out of T-SQL.
 *
 * Why a text parser and not the engine's own answer: `sys.dm_sql_referenced_entities`
 * looks like the perfect source of column-level truth and is not. It silently drops
 * every statement it cannot bind at analysis time, which includes every
 * `UPDATE ... FROM #temp` — and the gnarliest procedures in this estate are exactly
 * the ones that use temp tables. It under-reports Catalog's writers as 4 when the
 * T-SQL genuinely has 6 (docs/DECISIONS.md, M0). A text parser handles precisely the
 * case the DMV cannot.
 *
 * Two things keep this honest rather than plausible:
 *
 *   1. Table and column names come from INFORMATION_SCHEMA, never from the parse. The
 *      parser therefore cannot invent a table, and `#ReserveLines` / `FROM DATETIME2` /
 *      `FETCH NEXT FROM score_cursor` fall out without a special case.
 *   2. `verify-m2` grades the output against M1's captured write sets: every column the
 *      estate was *observed* to write must appear in the parse. A parser that looks
 *      right and is wrong fails the gate.
 *
 * Anything this cannot parse is reported in `unsupported`, and ingest refuses to run.
 * Under-reporting silently is the one failure mode that would poison everything
 * downstream, because a missing coupling edge looks exactly like an absent one.
 */

export interface CatalogTable {
  name: string;
  /** lower-cased column name -> real column name */
  columns: Map<string, string>;
}

/** lower-cased table name -> table */
export type SqlCatalog = Map<string, CatalogTable>;

export function buildCatalog(rows: { tableName: string; columnName: string }[]): SqlCatalog {
  const catalog: SqlCatalog = new Map();
  for (const row of rows) {
    const key = row.tableName.toLowerCase();
    const table = catalog.get(key) ?? { name: row.tableName, columns: new Map() };
    table.columns.set(row.columnName.toLowerCase(), row.columnName);
    catalog.set(key, table);
  }
  return catalog;
}

export interface ColumnAccess {
  table: string;
  column: string;
  /** The parser had to widen or guess: dynamic SQL, an ambiguous bare name, no column list. */
  inferred: boolean;
}

export interface ParseResult {
  reads: ColumnAccess[];
  writes: ColumnAccess[];
  tablesRead: string[];
  tablesWritten: string[];
  /** Procedures this one EXECs. sp_PlaceOrder orchestrates three others, and its
   *  captured write set therefore contains theirs — the graph is what makes that legible. */
  calls: string[];
  usesDynamicSql: boolean;
  /** Constructs this parser does not handle. Non-empty means ingest fails loudly. */
  unsupported: string[];
}

// --- lexical layer -----------------------------------------------------------------

interface Stripped {
  /** Source with comments and string bodies blanked out. Offsets are preserved. */
  code: string;
  /** The contents of every string literal, in order. */
  literals: string[];
}

/**
 * Blank out comments and string literals, replacing them with spaces so that every
 * offset in the result still lines up with the original. T-SQL block comments nest.
 */
export function stripNonCode(sql: string): Stripped {
  const out = sql.split('');
  const literals: string[] = [];
  let i = 0;

  while (i < sql.length) {
    const two = sql.slice(i, i + 2);

    if (two === '--') {
      while (i < sql.length && sql[i] !== '\n') out[i++] = ' ';
      continue;
    }

    if (two === '/*') {
      let depth = 0;
      do {
        if (sql.slice(i, i + 2) === '/*') {
          depth++;
          out[i] = ' ';
          out[i + 1] = ' ';
          i += 2;
        } else if (sql.slice(i, i + 2) === '*/') {
          depth--;
          out[i] = ' ';
          out[i + 1] = ' ';
          i += 2;
        } else {
          if (sql[i] !== '\n') out[i] = ' ';
          i++;
        }
      } while (i < sql.length && depth > 0);
      continue;
    }

    if (sql[i] === "'") {
      const start = i;
      out[i++] = ' ';
      let body = '';
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          body += "'";
          out[i] = ' ';
          out[i + 1] = ' ';
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          out[i++] = ' ';
          break;
        }
        body += sql[i];
        if (sql[i] !== '\n') out[i] = ' ';
        i++;
      }
      literals.push(body);
      void start;
      continue;
    }

    i++;
  }

  return { code: out.join(''), literals };
}

/** Parenthesis depth immediately before each character. */
function parenDepths(code: string): Int32Array {
  const depths = new Int32Array(code.length);
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    depths[i] = depth;
    if (code[i] === '(') depth++;
    else if (code[i] === ')') depth = Math.max(0, depth - 1);
  }
  return depths;
}

/** Keywords that can only begin a new statement — used to bound the one being read. */
const STATEMENT_HEADS =
  /\b(SELECT|INSERT|UPDATE|DELETE|MERGE|EXEC|EXECUTE|DECLARE|IF|WHILE|BEGIN|END|CREATE|ALTER|DROP|TRUNCATE|FETCH|OPEN|CLOSE|DEALLOCATE|RETURN|GOTO|PRINT|COMMIT|ROLLBACK|WAITFOR|SET|THROW|RAISERROR)\b/gi;

function nextAtDepthZero(code: string, depths: Int32Array, from: number, pattern: RegExp): number {
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  re.lastIndex = from;
  for (let m = re.exec(code); m !== null; m = re.exec(code)) {
    if (depths[m.index] === 0) return m.index;
  }
  return code.length;
}

/** Split on commas that sit at the top level of the given fragment. */
function splitTopLevel(fragment: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of fragment) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') parts.push(current);
  return parts;
}

const unbracket = (name: string): string => name.replace(/[[\]]/g, '');

/** `dbo.Catalog` and `Catalog` both resolve; `#ReserveLines` and `@tvp` do not. */
function resolveTable(raw: string, catalog: SqlCatalog): CatalogTable | null {
  const bare = unbracket(raw).split('.').pop() ?? '';
  return catalog.get(bare.toLowerCase()) ?? null;
}

// --- alias map ---------------------------------------------------------------------

interface AliasMap {
  /** alias or table name (lower-cased) -> table */
  entries: Map<string, CatalogTable>;
  /** aliases bound to more than one table across the procedure. */
  ambiguous: Set<string>;
}

const FROM_JOIN = /\b(?:FROM|JOIN|INTO|UPDATE)\s+(#?\[?[\w.[\]]+\]?)(?:\s+(?:AS\s+)?(?!ON\b|WHERE\b|SET\b|SELECT\b|VALUES\b|WITH\b|GROUP\b|ORDER\b|HAVING\b|INNER\b|LEFT\b|RIGHT\b|FULL\b|CROSS\b|OUTER\b|JOIN\b)(\[?\w+\]?))?/gi;

function aliasesIn(fragment: string, catalog: SqlCatalog): AliasMap {
  const entries = new Map<string, CatalogTable>();
  const ambiguous = new Set<string>();
  const re = new RegExp(FROM_JOIN.source, FROM_JOIN.flags);

  for (let m = re.exec(fragment); m !== null; m = re.exec(fragment)) {
    const table = resolveTable(m[1], catalog);
    if (table === null) continue;

    const bind = (key: string): void => {
      const lower = key.toLowerCase();
      const existing = entries.get(lower);
      if (existing !== undefined && existing.name !== table.name) ambiguous.add(lower);
      entries.set(lower, table);
    };

    bind(table.name);
    if (m[2] !== undefined) bind(unbracket(m[2]));
  }

  return { entries, ambiguous };
}

// --- extraction --------------------------------------------------------------------

interface Extraction {
  reads: ColumnAccess[];
  writes: ColumnAccess[];
  unsupported: string[];
}

/** Character ranges that name a write target and must not also count as a read. */
type Range = [number, number];

function extract(code: string, catalog: SqlCatalog, inferred: boolean): Extraction {
  const depths = parenDepths(code);
  const writes: ColumnAccess[] = [];
  const unsupported: string[] = [];
  const writeTargetRanges: Range[] = [];

  const addWrite = (table: CatalogTable, column: string, widened: boolean): void => {
    writes.push({ table: table.name, column, inferred: inferred || widened });
  };

  // MERGE would need its own handling of WHEN MATCHED / WHEN NOT MATCHED clauses. The
  // estate has none; if one appears, ingest must fail rather than under-report.
  const merge = /\bMERGE\s+(?:INTO\s+)?[\w.[\]]+/gi;
  for (let m = merge.exec(code); m !== null; m = merge.exec(code)) {
    if (depths[m.index] === 0) unsupported.push(`MERGE at offset ${m.index}`);
  }

  // --- UPDATE ---
  const update = /\bUPDATE\s+(?:TOP\s*\([^)]*\)\s*)?(#?\[?[\w.[\]]+\]?)/gi;
  for (let m = update.exec(code); m !== null; m = update.exec(code)) {
    if (depths[m.index] !== 0) continue;

    const setStart = nextAtDepthZero(code, depths, m.index + m[0].length, /\bSET\b/gi);
    if (setStart >= code.length) continue;
    const assignFrom = setStart + 3;
    const setEnd = nextAtDepthZero(code, depths, assignFrom, /\b(FROM|WHERE|OUTPUT|OPTION|FOR)\b|;/gi);
    const stmtEnd = nextAtDepthZero(code, depths, setEnd, STATEMENT_HEADS);

    // The FROM clause of *this* statement is what turns `UPDATE c` into `dbo.Catalog`.
    const aliases = aliasesIn(code.slice(m.index, stmtEnd), catalog);
    const target = catalog.get(unbracket(m[1]).split('.').pop()!.toLowerCase())
      ?? aliases.entries.get(unbracket(m[1]).toLowerCase())
      ?? null;
    // A temp table target is a real write, just not to the estate. Skipping it is correct.
    if (target === null) continue;

    for (const assignment of splitTopLevel(code.slice(assignFrom, setEnd))) {
      const eq = assignment.indexOf('=');
      if (eq < 0) continue;
      const lhs = assignment.slice(0, eq);
      const name = unbracket(lhs).trim().split('.').pop()?.trim() ?? '';
      const column = target.columns.get(name.toLowerCase());
      if (column === undefined) continue;
      addWrite(target, column, false);
      const offset = assignFrom + assignment.indexOf(lhs);
      writeTargetRanges.push([offset, offset + lhs.length]);
    }
  }

  // --- INSERT ---
  const insert = /\bINSERT\s+(?:TOP\s*\([^)]*\)\s*)?(?:INTO\s+)?(#?\[?[\w.[\]]+\]?)/gi;
  for (let m = insert.exec(code); m !== null; m = insert.exec(code)) {
    if (depths[m.index] !== 0) continue;
    const target = resolveTable(m[1], catalog);
    if (target === null) continue;

    let cursor = m.index + m[0].length;
    while (cursor < code.length && /\s/.test(code[cursor])) cursor++;

    if (code[cursor] === '(') {
      const open = cursor;
      let depth = 0;
      let close = open;
      for (let i = open; i < code.length; i++) {
        if (code[i] === '(') depth++;
        else if (code[i] === ')') {
          depth--;
          if (depth === 0) {
            close = i;
            break;
          }
        }
      }
      for (const raw of splitTopLevel(code.slice(open + 1, close))) {
        const column = target.columns.get(unbracket(raw).trim().toLowerCase());
        if (column !== undefined) addWrite(target, column, false);
      }
      writeTargetRanges.push([open, close + 1]);
    } else {
      // No column list: the statement writes every column of the table. Widening here
      // is honest; claiming a narrow write set we cannot prove would not be.
      for (const column of target.columns.values()) addWrite(target, column, true);
    }
  }

  // --- DELETE ---
  const del = /\bDELETE\s+(?:TOP\s*\([^)]*\)\s*)?(?:FROM\s+)?(#?\[?[\w.[\]]+\]?)/gi;
  for (let m = del.exec(code); m !== null; m = del.exec(code)) {
    if (depths[m.index] !== 0) continue;
    const target = resolveTable(m[1], catalog);
    if (target === null) continue;
    // A whole-row write. '*' rather than every column, so the coupling graph does not
    // claim a DELETE and an UPDATE fight over a specific column when they do not.
    addWrite(target, '*', false);
  }

  // --- reads ---
  // Procedure-level, not statement-level: SPEC's reads[] is a property of the procedure.
  const aliases = aliasesIn(code, catalog);
  const referenced = [...new Set(aliases.entries.values())];
  const reads: ColumnAccess[] = [];
  const inWriteTarget = (index: number): boolean =>
    writeTargetRanges.some(([from, to]) => index >= from && index < to);

  // Qualified references are exact.
  const qualified = /\b(\w+)\.(\w+)\b/g;
  for (let m = qualified.exec(code); m !== null; m = qualified.exec(code)) {
    if (inWriteTarget(m.index)) continue;
    const alias = m[1].toLowerCase();
    const table = aliases.entries.get(alias);
    if (table === undefined) continue;
    const column = table.columns.get(m[2].toLowerCase());
    if (column === undefined) continue;
    reads.push({ table: table.name, column, inferred: inferred || aliases.ambiguous.has(alias) });
  }

  // Bare column names, resolved against the tables this procedure actually references.
  // Ambiguous ones are attributed to every candidate and flagged rather than dropped.
  for (const table of referenced) {
    for (const [lower, column] of table.columns) {
      const owners = referenced.filter((t) => t.columns.has(lower));
      const bare = new RegExp(`(?<![@#\\w.\\[])${column}\\b`, 'gi');
      for (let m = bare.exec(code); m !== null; m = bare.exec(code)) {
        if (inWriteTarget(m.index)) continue;
        reads.push({ table: table.name, column, inferred: inferred || owners.length > 1 });
        break; // one read per column is enough; this is a set, not a count
      }
    }
  }

  return { reads, writes, unsupported };
}

// --- public entry point ------------------------------------------------------------

/** A string literal is treated as SQL only if it names a real table and reads like a query. */
function looksLikeSql(literal: string, catalog: SqlCatalog): boolean {
  if (!/\b(SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|ORDER\s+BY|JOIN)\b/i.test(literal)) return false;
  return [...catalog.values()].some((t) => new RegExp(`\\b${t.name}\\b`, 'i').test(literal));
}

/**
 * Procedures this body invokes. `sp_executesql` and anything else outside the estate is
 * filtered by the caller against the set of procedures actually ingested — this returns
 * every candidate name and lets the ingest decide what is real.
 */
function callsIn(code: string): string[] {
  const re = /\bEXEC(?:UTE)?\s+(?:@\w+\s*=\s*)?(?:\[?\w+\]?\.)?(\[?\w+\]?)/gi;
  const names = new Set<string>();
  for (let m = re.exec(code); m !== null; m = re.exec(code)) names.add(unbracket(m[1]));
  return [...names].sort();
}

export function parseProcedure(sourceSql: string, catalog: SqlCatalog): ParseResult {
  const { code, literals } = stripNonCode(sourceSql);
  const direct = extract(code, catalog, false);

  // sp_SearchProducts is built entirely from dynamic SQL, so the statements that touch
  // Catalog live inside string literals. Blanking those and reporting "reads nothing"
  // for ~36% of all traffic would be a lie on the main screen. The fragments are parsed
  // too, and everything found that way is flagged inferred — the parser cannot prove
  // which branches concatenate at runtime, and should not pretend otherwise.
  const sqlLiterals = literals.filter((l) => looksLikeSql(l, catalog));
  const usesDynamicSql = sqlLiterals.length > 0;
  const dynamic = usesDynamicSql ? extract(sqlLiterals.join('\n'), catalog, true) : null;

  const reads = dedupe([...direct.reads, ...(dynamic?.reads ?? [])]);
  const writes = dedupe([...direct.writes, ...(dynamic?.writes ?? [])]);

  return {
    reads,
    writes,
    tablesRead: [...new Set(reads.map((r) => r.table))].sort(),
    tablesWritten: [...new Set(writes.map((w) => w.table))].sort(),
    calls: callsIn(code),
    usesDynamicSql,
    unsupported: [...direct.unsupported, ...(dynamic?.unsupported ?? [])],
  };
}

/** One row per Table.Column. A column proven exactly anywhere is not inferred. */
function dedupe(accesses: ColumnAccess[]): ColumnAccess[] {
  const byKey = new Map<string, ColumnAccess>();
  for (const access of accesses) {
    const key = `${access.table}.${access.column}`;
    const existing = byKey.get(key);
    if (existing === undefined) byKey.set(key, { ...access });
    else if (!access.inferred) existing.inferred = false;
  }
  return [...byKey.values()].sort((a, b) =>
    a.table === b.table ? a.column.localeCompare(b.column) : a.table.localeCompare(b.table),
  );
}
