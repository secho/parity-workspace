// Provision ParityShop_Shadow — the database M5's shadow harness replays against.
//
// `docs/SPEC.md` §4 requires the replacement to run against "a restored snapshot database"
// so the production-equivalent DB is never touched. This builds it, and it must run **after
// `make traffic`**: the replay draws its cases from captured invocations, and a large share
// of those name orders that traffic itself placed. A copy taken before traffic would be
// missing the rows the cases reference.
//
// Three things were measured before this was written, on the real 200 MB estate:
//
//   BACKUP ParityShop      391 ms
//   RESTORE as shadow      612 ms
//   revert (RESTORE)       ~530 ms, repeatable
//
// That killed the database-snapshot design this started as. A snapshot would revert faster in
// theory, but at half a second a plain RESTORE is already ~1.6 s across the three reverts a
// shadow run needs, and it drops an entire mechanism — snapshot lifecycle, its limitations,
// and a CREATE DATABASE grant — from the build. Boring wins.
//
// The one trap, found by hitting it: **RESTORE resets the database owner to whatever the
// backup recorded.** Restoring ParityShop's own backup therefore handed the shadow copy back
// to sa every time, and the next revert failed because parity_shadow was no longer its owner.
// So the revert baseline is backed up *from the shadow database after ownership is
// transferred*, not from ParityShop. Then every revert restores a file that already says
// parity_shadow, and ownership survives.

import sql from 'mssql';
import { connect } from './db.js';

const ESTATE = process.env.MSSQL_DATABASE ?? 'ParityShop';
const SHADOW = process.env.MSSQL_SHADOW_DATABASE ?? 'ParityShop_Shadow';
const SHADOW_OWNER = process.env.PARITY_SHADOW_USER ?? 'parity_shadow';
const BACKUP_DIR = process.env.MSSQL_BACKUP_DIR ?? '/var/opt/mssql/backup';
const DATA_DIR = process.env.MSSQL_DATA_DIR ?? '/var/opt/mssql/data';

/** The file every revert restores. Its name is part of Parity's config, not a local detail. */
export const BASE_BACKUP = `${BACKUP_DIR}/${SHADOW}_base.bak`;
const SEED_BACKUP = `${BACKUP_DIR}/${ESTATE}_for_shadow.bak`;

const ms = (started: number): string => `${Date.now() - started} ms`;

interface LogicalFile {
  LogicalName: string;
  Type: 'D' | 'L';
}

async function main(): Promise<void> {
  const overall = Date.now();
  const master = await connect('master');

  try {
    await master.request().batch(`EXEC master.dbo.xp_create_subdir N'${BACKUP_DIR}';`);

    let started = Date.now();
    await master.request().batch(`
      BACKUP DATABASE [${ESTATE}] TO DISK = N'${SEED_BACKUP}'
      WITH INIT, COPY_ONLY, COMPRESSION;`);
    console.log(`  backup ${ESTATE} (${ms(started)})`);

    // Logical names come from the backup rather than being assumed. The estate's are
    // predictable today; Parity has to stay pointable at an estate whose conventions it has
    // never seen, and this script is the demo-app half of that same promise.
    const files = (
      await master.request().batch(`RESTORE FILELISTONLY FROM DISK = N'${SEED_BACKUP}';`)
    ).recordset as unknown as LogicalFile[];

    let dataFiles = 0;
    let logFiles = 0;
    const move = files
      .map((f) => {
        const target =
          f.Type === 'L'
            ? `${DATA_DIR}/${SHADOW}_log${logFiles++ === 0 ? '' : logFiles}.ldf`
            : `${DATA_DIR}/${SHADOW}${dataFiles++ === 0 ? '' : dataFiles}.mdf`;
        return `MOVE N'${f.LogicalName}' TO N'${target}'`;
      })
      .join(', ');

    started = Date.now();
    await master.request().batch(`
      RESTORE DATABASE [${SHADOW}] FROM DISK = N'${SEED_BACKUP}'
      WITH ${move}, REPLACE, RECOVERY;`);
    console.log(`  restore as ${SHADOW} (${ms(started)})`);

    // The shadow database's owner is the only principal that can restore it, and this is
    // where it stops being sa's.
    await master.request().batch(`ALTER AUTHORIZATION ON DATABASE::[${SHADOW}] TO [${SHADOW_OWNER}];`);

    // Reading a write set out of Change Tracking needs VIEW CHANGE TRACKING, which
    // db_datareader does not imply. Granted here and **only here**: the runner replays on
    // the copy, so that is the only place it needs to see what changed. `41-parity-runner.sql`
    // deliberately does not grant it, which keeps the runner's reach into the estate itself
    // at exactly what M4 needed — execute, and read.
    const shadow = await connect(SHADOW);
    try {
      await shadow.request().batch(`GRANT VIEW CHANGE TRACKING ON SCHEMA::dbo TO [parity_runner];`);
    } finally {
      await shadow.close();
    }

    await assertCopyIsUsable(master);

    started = Date.now();
    await master.request().batch(`
      BACKUP DATABASE [${SHADOW}] TO DISK = N'${BASE_BACKUP}'
      WITH INIT, COPY_ONLY, COMPRESSION;`);
    console.log(`  revert baseline → ${BASE_BACKUP} (${ms(started)})`);

    console.log(`shadow database ready in ${((Date.now() - overall) / 1000).toFixed(1)}s`);
  } finally {
    await master.close();
  }
}

/**
 * A restored copy that is missing Change Tracking, or the procedures, or the runner's DENY,
 * would fail much later and much less clearly — as an empty write set, or as a shadow run
 * that quietly sent Database Mail. Assert it here, where the message can name the cause.
 */
async function assertCopyIsUsable(master: sql.ConnectionPool): Promise<void> {
  const row = (
    await master.request().batch(`
      SELECT
        (SELECT COUNT(*) FROM sys.change_tracking_databases WHERE database_id = DB_ID('${SHADOW}')) AS ctDatabase,
        (SELECT COUNT(*) FROM [${SHADOW}].sys.change_tracking_tables) AS ctTables,
        (SELECT COUNT(*) FROM [${ESTATE}].sys.change_tracking_tables) AS ctTablesEstate,
        (SELECT COUNT(*) FROM [${SHADOW}].sys.procedures WHERE name LIKE 'sp[_]%') AS procs,
        (SELECT COUNT(*) FROM [${SHADOW}].sys.database_principals dp
           JOIN sys.server_principals sp ON sp.sid = dp.sid
          WHERE dp.name IN ('parity_reader','parity_runner')) AS mappedLogins,
        (SELECT COUNT(*) FROM [${SHADOW}].sys.database_permissions
          WHERE state_desc = 'DENY' AND permission_name = 'EXECUTE') AS denies,
        (SELECT COUNT(*) FROM [${SHADOW}].sys.database_permissions p
           JOIN [${SHADOW}].sys.database_principals dp ON dp.principal_id = p.grantee_principal_id
          WHERE p.permission_name = 'VIEW CHANGE TRACKING' AND p.state_desc = 'GRANT'
            AND dp.name = 'parity_runner') AS ctGrant,
        SUSER_SNAME((SELECT owner_sid FROM sys.databases WHERE name = '${SHADOW}')) AS owner,
        (SELECT COUNT(*) FROM [${SHADOW}].dbo.OrderLedger) AS orderLines,
        (SELECT COUNT(*) FROM [${ESTATE}].dbo.OrderLedger) AS orderLinesEstate;`)
  ).recordset[0] as Record<string, number | string>;

  const problems: string[] = [];
  if (row.ctDatabase !== 1) problems.push('change tracking is not on');
  if (row.ctTables !== row.ctTablesEstate)
    problems.push(`change tracking covers ${row.ctTables} tables, the estate has ${row.ctTablesEstate}`);
  if (row.procs !== 14) problems.push(`${row.procs} procedures, expected 14`);
  if (row.mappedLogins !== 2) problems.push(`${row.mappedLogins} of 2 parity logins mapped`);
  if (row.denies < 1) problems.push('the runner DENY on sp_SyncWarehouseDispatch did not survive');
  if (row.ctGrant < 1) problems.push('the runner cannot read change tracking on the copy');
  if (row.owner !== SHADOW_OWNER) problems.push(`owner is ${String(row.owner)}, expected ${SHADOW_OWNER}`);
  if (row.orderLines !== row.orderLinesEstate)
    problems.push(`${row.orderLines} order lines against the estate's ${row.orderLinesEstate}`);

  if (problems.length > 0) throw new Error(`shadow copy is not usable: ${problems.join('; ')}`);

  console.log(
    `  verified: CT on ${row.ctTables} tables, 14 procedures, ${row.orderLines} order lines, owner ${SHADOW_OWNER}`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
