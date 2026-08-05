-- ParityShop database bootstrap. Runs against master.
-- Czech_CI_AS je collation zvolena pri zalozeni v roce 2011, meni se jen pres migraci.

-- Kill sessions first, then take the database offline, then drop.
--
-- SINGLE_USER alone is not enough: it frees the database but permits one connection,
-- and the running shop-api's pool reclaims that slot before DROP gets there. Worse, the
-- failed DROP leaves the database stuck in SINGLE_USER with the app holding the slot,
-- at which point even ALTER DATABASE is refused and the only way out is a manual KILL.
-- Killing the sessions first removes the holder; OFFLINE then refuses new connections
-- outright, so there is no window for the pool to reconnect into.
--
-- `make seed` runs constantly and M2's demo-reset depends on it, so this has to be
-- reliable with the whole stack up, not merely reliable on a quiet database.
DECLARE @attempt INT = 0;
WHILE DB_ID('ParityShop') IS NOT NULL AND @attempt < 10
BEGIN
    SET @attempt += 1;

    DECLARE @kill NVARCHAR(MAX) = N'';
    SELECT @kill += N'KILL ' + CAST(session_id AS NVARCHAR(10)) + N';'
    FROM sys.dm_exec_sessions
    WHERE database_id = DB_ID('ParityShop') AND session_id <> @@SPID;
    EXEC(@kill);

    BEGIN TRY
        ALTER DATABASE ParityShop SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
        DROP DATABASE ParityShop;
    END TRY
    BEGIN CATCH
        -- The app reconnected into the single permitted slot. Let it settle, then
        -- kill again. Do NOT leave the database stuck in SINGLE_USER on the way out.
        IF DB_ID('ParityShop') IS NOT NULL
            ALTER DATABASE ParityShop SET MULTI_USER;
        WAITFOR DELAY '00:00:01';
    END CATCH
END

IF DB_ID('ParityShop') IS NOT NULL
    RAISERROR(N'Could not drop ParityShop after 10 attempts -- something is holding it open.', 16, 1);
GO

CREATE DATABASE ParityShop COLLATE Czech_CI_AS;
GO

ALTER DATABASE ParityShop SET RECOVERY SIMPLE;
GO

-- Database Mail -- podklady k expedici chodi na sklady mailem. Drive to resil
-- sp_OACreate + WinHttp primo v procedure, po prechodu na Linux to prestalo fungovat
-- (xp_cmdshell ani OLE Automation tam nejsou) a prepsalo se to na sp_send_dbmail.
EXEC sp_configure 'show advanced options', 1;
RECONFIGURE;
GO
EXEC sp_configure 'Database Mail XPs', 1;
RECONFIGURE;
GO

IF EXISTS (SELECT 1 FROM msdb.dbo.sysmail_profile WHERE name = 'DispatchProfile')
BEGIN
    EXECUTE msdb.dbo.sysmail_delete_profileaccount_sp @profile_name = 'DispatchProfile', @account_name = 'WarehouseDispatch';
    EXECUTE msdb.dbo.sysmail_delete_profile_sp @profile_name = 'DispatchProfile';
END
IF EXISTS (SELECT 1 FROM msdb.dbo.sysmail_account WHERE name = 'WarehouseDispatch')
    EXECUTE msdb.dbo.sysmail_delete_account_sp @account_name = 'WarehouseDispatch';
GO

EXECUTE msdb.dbo.sysmail_add_account_sp
    @account_name    = 'WarehouseDispatch',
    @email_address   = 'eshop@parityshop.cz',
    @display_name    = 'ParityShop Expedice',
    @mailserver_name = 'mailpit',
    @port            = 1025;

EXECUTE msdb.dbo.sysmail_add_profile_sp
    @profile_name = 'DispatchProfile';

EXECUTE msdb.dbo.sysmail_add_profileaccount_sp
    @profile_name    = 'DispatchProfile',
    @account_name    = 'WarehouseDispatch',
    @sequence_number = 1;

EXECUTE msdb.dbo.sysmail_add_principalprofile_sp
    @profile_name = 'DispatchProfile',
    @principal_name = 'public',
    @is_default = 1;
GO
