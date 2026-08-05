-- A read-only login for Parity.
--
-- Parity's pitch is that it could be pointed at Alza's real estate tomorrow, and the first
-- question anyone sensible asks is what it is allowed to do to the database it analyses.
-- "It only reads" is a much weaker answer than "it cannot write". So the platform connects
-- as its own principal with db_datareader and nothing else — a demo that answers the
-- question with a permission grant instead of a promise.
--
-- VIEW DEFINITION is the part that is easy to miss: db_datareader can read every table in
-- the database and still gets NULL back from sys.sql_modules.definition, which is exactly
-- the column the whole ingest is built on. Without this grant Parity ingests fourteen
-- procedures with empty source and the failure looks like a parser bug.

USE master;
GO

-- The login is server-scoped and survives `make seed` dropping the database, so it is
-- created once and left alone. CHECK_POLICY is off because this is a local dev container.
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'parity_reader')
    CREATE LOGIN parity_reader WITH PASSWORD = N'Parity_Reader_2026!', CHECK_POLICY = OFF;
GO

USE ParityShop;
GO

CREATE USER parity_reader FOR LOGIN parity_reader;
ALTER ROLE db_datareader ADD MEMBER parity_reader;

-- Read the procedure bodies. Nothing else in the estate needs elevating.
GRANT VIEW DEFINITION TO parity_reader;
GO
