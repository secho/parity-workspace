-- Capture infrastructure. This is NOT part of the legacy estate — it is what Parity
-- turns on in order to observe it, and it is deliberately invisible to the procedures.
--
-- Two mechanisms, because neither is sufficient alone:
--
--   Change Tracking  answers "which rows changed, and which columns" — cheaply, and
--                    with a per-column bitmask. It never stores values.
--   Temporal tables  answer "what did the row look like before" via
--                    FOR SYSTEM_TIME AS OF. Change Tracking has no such notion.
--
-- Together they produce the {table, pk, column, before, after} write set SPEC §3 asks
-- for. The period columns are HIDDEN so that SELECT * is unaffected —
-- sp_MigrateCustomerAddresses and sp_ExportCatalogXml_OLD both use SELECT *, and a
-- visible period column would silently change their result sets.
--
-- Runs while the tables are still empty (reference data is loaded by 30-reference.sql),
-- so adding the period columns is instant.

USE ParityShop;
GO

ALTER DATABASE ParityShop
    SET CHANGE_TRACKING = ON (CHANGE_RETENTION = 7 DAYS, AUTO_CLEANUP = ON);
GO

CREATE SCHEMA History;
GO

-- Every tracked table gets the same treatment, so drive it from one list rather than
-- twelve near-identical blocks. Change Tracking requires a primary key; all twelve have
-- one, which verify-m0 already asserts indirectly by the estate working at all.
DECLARE @tables TABLE (Name SYSNAME);
INSERT INTO @tables (Name) VALUES
    ('Catalog'), ('OrderLedger'), ('Customer'), ('CustomerScore'),
    ('StockMovement'), ('StockReservation'), ('PromoCode'), ('PromoRedemption'),
    ('AuditTrail'), ('Category'), ('Warehouse'), ('VatRate');

DECLARE @name SYSNAME, @sql NVARCHAR(MAX);
DECLARE tbl CURSOR LOCAL FAST_FORWARD FOR SELECT Name FROM @tables;
OPEN tbl;
FETCH NEXT FROM tbl INTO @name;

WHILE @@FETCH_STATUS = 0
BEGIN
    -- Period columns + system versioning. DEFAULTs are required by ALTER TABLE ADD PERIOD.
    SET @sql = N'
        ALTER TABLE dbo.' + QUOTENAME(@name) + N' ADD
            SysStart DATETIME2(3) GENERATED ALWAYS AS ROW START HIDDEN NOT NULL
                CONSTRAINT ' + QUOTENAME('DF_' + @name + '_SysStart') + N' DEFAULT SYSUTCDATETIME(),
            SysEnd   DATETIME2(3) GENERATED ALWAYS AS ROW END   HIDDEN NOT NULL
                CONSTRAINT ' + QUOTENAME('DF_' + @name + '_SysEnd')   + N' DEFAULT CONVERT(DATETIME2(3), ''9999-12-31 23:59:59.999''),
            PERIOD FOR SYSTEM_TIME (SysStart, SysEnd);';
    EXEC sp_executesql @sql;

    SET @sql = N'ALTER TABLE dbo.' + QUOTENAME(@name)
             + N' SET (SYSTEM_VERSIONING = ON (HISTORY_TABLE = History.' + QUOTENAME(@name) + N'));';
    EXEC sp_executesql @sql;

    SET @sql = N'ALTER TABLE dbo.' + QUOTENAME(@name)
             + N' ENABLE CHANGE_TRACKING WITH (TRACK_COLUMNS_UPDATED = ON);';
    EXEC sp_executesql @sql;

    FETCH NEXT FROM tbl INTO @name;
END

CLOSE tbl;
DEALLOCATE tbl;
GO
