import sql from 'mssql';
import type { Config } from '../env.js';

/**
 * The shadow database: connections to it, and the reset that puts it back.
 *
 * `SPEC.md` §4 requires the replacement to run somewhere the production-equivalent database
 * is never touched. M4's rolled-back transaction was the tempting shortcut, since it exists
 * and `verify-m4` already proves it leaks nothing. It was rejected on measurement:
 * **Change Tracking cannot see a transaction that never commits**, so a rolled-back replay
 * has to fingerprint whole tables before and after, at 100–176 ms per case. On a separate
 * database the replay can COMMIT, which puts CT back in play at ~40 ms.
 *
 * It also makes the claim in the room stronger. "Production is untouched" stops being an
 * argument about transaction discipline and becomes an observation about the connection
 * string: nothing here ever opens `ParityShop`.
 *
 * Measured on the real 200 MB estate before any of this was written:
 *
 *   provision (`make shadow-db`)   0.8 s from nothing
 *   revert                         ~530 ms, repeatable
 *
 * Half a second killed the database-snapshot design this started as. Three reverts per
 * shadow run is ~1.6 s, and a plain RESTORE drops a whole mechanism — snapshot lifecycle,
 * its limitations, and a CREATE DATABASE grant — from the build.
 */

const poolFor = (config: Config, database: string, user: string, password: string): Promise<sql.ConnectionPool> =>
  new sql.ConnectionPool({
    server: config.mssql.server,
    port: config.mssql.port,
    database,
    user,
    password,
    options: { encrypt: true, trustServerCertificate: true, requestTimeout: 120_000 },
  }).connect();

/**
 * The replay connection. Same `parity_runner` principal the oracle harness uses — including
 * the DENY on `sp_SyncWarehouseDispatch`, which survived the restore as a database
 * permission and so guards the copy exactly as it guards the estate.
 */
export async function connectShadowRunner(config: Config): Promise<sql.ConnectionPool> {
  return poolFor(config, config.mssql.shadowDatabase, config.mssql.runnerUser, config.mssql.runnerPassword);
}

/** The reset connection. Opens `master`, because it is about to restore over its own database. */
export async function connectShadowOwner(config: Config): Promise<sql.ConnectionPool> {
  return poolFor(config, 'master', config.mssql.shadowOwnerUser, config.mssql.shadowOwnerPassword);
}

export interface ShadowReadiness {
  ready: boolean;
  reason: string | null;
  database: string;
  orderLines: number;
  changeTrackingTables: number;
}

/**
 * Whether a shadow run can be attempted at all, and if not, why — reported up front rather
 * than discovered three hundred cases into a replay. The same reasoning as `agentReadiness`.
 */
export async function shadowReadiness(config: Config): Promise<ShadowReadiness> {
  const absent: ShadowReadiness = {
    ready: false,
    reason: `${config.mssql.shadowDatabase} is not provisioned — run \`make shadow-db\` (after \`make traffic\`)`,
    database: config.mssql.shadowDatabase,
    orderLines: 0,
    changeTrackingTables: 0,
  };

  let pool: sql.ConnectionPool | null = null;
  try {
    pool = await connectShadowRunner(config);
    const row = (
      await pool.request().query(`
        SELECT (SELECT COUNT(*) FROM sys.change_tracking_tables) AS ctTables,
               (SELECT COUNT(*) FROM dbo.OrderLedger) AS orderLines,
               CHANGE_TRACKING_CURRENT_VERSION() AS version`)
    ).recordset[0] as { ctTables: number; orderLines: number; version: unknown };

    if (row.version === null) {
      return { ...absent, reason: 'change tracking is not on in the shadow database' };
    }
    if (row.ctTables === 0 || row.orderLines === 0) {
      return { ...absent, reason: 'the shadow database is empty — re-run `make shadow-db`' };
    }

    return {
      ready: true,
      reason: null,
      database: config.mssql.shadowDatabase,
      orderLines: row.orderLines,
      changeTrackingTables: row.ctTables,
    };
  } catch (err) {
    return { ...absent, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    await pool?.close();
  }
}

/**
 * Put the shadow database back to what `make shadow-db` left.
 *
 * `SINGLE_USER WITH ROLLBACK IMMEDIATE` first, for the reason M0 recorded the hard way:
 * RESTORE needs exclusive access, and without it the statement does not fail — it *waits*,
 * for as long as some pool holds an idle connection. Measured: a revert with one live
 * session took 6.5 s against 530 ms clean, and a session that never ends never returns.
 *
 * MULTI_USER is restored in a `finally` whatever happens. A gate — or a demo — must not be
 * able to leave the database it resets in a state where the next attempt cannot even
 * connect, which is exactly what an early version of this did.
 */
export async function revertShadow(config: Config): Promise<number> {
  const started = Date.now();
  const db = config.mssql.shadowDatabase;
  const owner = await connectShadowOwner(config);

  try {
    await owner.request().batch(`ALTER DATABASE [${db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;`);
    await owner.request().batch(`
      RESTORE DATABASE [${db}] FROM DISK = N'${config.mssql.shadowBaseBackup}'
      WITH REPLACE, RECOVERY;`);
    return Date.now() - started;
  } finally {
    // The restored copy comes back MULTI_USER because the baseline backup was taken that
    // way, so this is normally a no-op. It is here for the path where the RESTORE threw.
    try {
      await owner.request().batch(`ALTER DATABASE [${db}] SET MULTI_USER;`);
    } catch {
      // Already multi-user, or the database is gone; either way the RESTORE error is the
      // one worth propagating.
    }
    await owner.close();
  }
}
