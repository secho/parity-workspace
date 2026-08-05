-- ParityShop database bootstrap. Runs against master.
-- Czech_CI_AS je collation zvolena pri zalozeni v roce 2011, meni se jen pres migraci.

IF DB_ID('ParityShop') IS NOT NULL
BEGIN
    ALTER DATABASE ParityShop SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
    DROP DATABASE ParityShop;
END
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
