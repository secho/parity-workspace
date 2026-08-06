-- A second login for Parity, and the only one that may execute anything.
--
-- M4 has to run the current procedure to record what a golden test should expect. That is a
-- genuinely different act from analysing the estate, so it gets a genuinely different
-- principal rather than a widened one. `parity_reader` keeps db_datareader and nothing else,
-- and `verify-m2`'s assertion that the engine refuses its UPDATE stays true and stays the
-- answer to "what is this thing allowed to do to our database".
--
-- The runner may EXECUTE and may write, but every call it makes is wrapped in a transaction
-- that is always rolled back. That is a discipline in code; the two grants it does NOT get
-- are the part the engine enforces:
--
--   * no db_owner and no DDL — it cannot alter the estate it is verifying
--   * DENY EXECUTE on sp_SyncWarehouseDispatch — see below

USE master;
GO

-- Server-scoped, so it survives `make seed` dropping the database. CHECK_POLICY is off
-- because this is a local dev container.
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'parity_runner')
    CREATE LOGIN parity_runner WITH PASSWORD = N'Parity_Runner_2026!', CHECK_POLICY = OFF;
GO

USE ParityShop;
GO

CREATE USER parity_runner FOR LOGIN parity_runner;
ALTER ROLE db_datareader ADD MEMBER parity_runner;
ALTER ROLE db_datawriter ADD MEMBER parity_runner;

-- Executing the estate is the whole reason this principal exists.
GRANT EXECUTE ON SCHEMA::dbo TO parity_runner;
GO

-- sp_SyncWarehouseDispatch sends dispatch orders through Database Mail. A sent email cannot
-- be rolled back, so no amount of transaction discipline makes it safe to replay — which is
-- exactly why it is classified `external` and why it can never be shadowed. A DENY here means
-- "the verifier cannot send mail" is something the engine refuses rather than something the
-- selection logic remembers not to do. DENY beats the schema-level GRANT.
DENY EXECUTE ON OBJECT::dbo.sp_SyncWarehouseDispatch TO parity_runner;
GO
