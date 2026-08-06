-- A third login, and the one that owns the shadow database.
--
-- M5 replays captured invocations against both the old procedure and its replacement. That
-- has to happen somewhere that is not the estate, so it happens on `ParityShop_Shadow` — a
-- restored copy on the same server. Resetting that copy between passes is a RESTORE, and
-- RESTORE over an existing database needs sysadmin, dbcreator, or the database's own owner.
--
-- This login is the third of those and nothing else:
--
--   * it is made the owner of ParityShop_Shadow by `make shadow-db`, so it can restore it
--   * it gets no user in ParityShop at all, so the engine refuses it the estate outright —
--     not "it only reads", not "it never connects", but Msg 916. `verify-m5` asserts it.
--   * it gets no server role. It cannot create a database; `make shadow-db` runs as sa and
--     hands the finished copy over.
--
-- Note what this buys beyond tidiness. The principal that can wipe and rebuild a database is
-- the most dangerous one in the build, and it is the one principal with no route to
-- production whatsoever.

USE master;
GO

-- Server-scoped, so it survives `make seed` dropping the database and survives the shadow
-- copy being restored over. CHECK_POLICY is off because this is a local dev container.
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'parity_shadow')
    CREATE LOGIN parity_shadow WITH PASSWORD = N'Parity_Shadow_2026!', CHECK_POLICY = OFF;
GO
