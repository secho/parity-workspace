USE ParityShop;
GO

-- sp_SyncWarehouseDispatch
-- Potvrzeni expedice objednavky - posle e-mail na sklad (profil DispatchProfile),
-- zapise dispatch referenci a tracking cislo na objednavku, odecte fyzicky sklad.
-- R.Havlik 2017, mail misto puvodniho HTTP volani na sklad prepsano 2023 (viz nize).
CREATE OR ALTER PROCEDURE dbo.sp_SyncWarehouseDispatch
	@orderNumber NVARCHAR(20),
	@warehouseIdOverride INT = NULL,
	@modifiedBy NVARCHAR(60) = N'system',
	@legacyForceResync BIT = 0		-- pokud je 1, ma se pred odeslanim mailu prepocitat dostupnost skladu (viz FE #4021) - v tele procedury se uz nepouziva
AS
BEGIN
	SET NOCOUNT ON

	DECLARE @now DATETIME2(3) = GETDATE()
	DECLARE @orderId INT
	DECLARE @warehouseId INT
	DECLARE @dispatchEmail NVARCHAR(200)
	DECLARE @slot INT = 0
	DECLARE @statusText NVARCHAR(30) = N'EXPEDOVANO'
	DECLARE @dispatchRef NVARCHAR(60)
	DECLARE @trackingNumber NVARCHAR(60)
	DECLARE @mailSubject NVARCHAR(200)
	DECLARE @mailBody NVARCHAR(MAX) = N''
	DECLARE @mailErrorNote NVARCHAR(500) = NULL
	DECLARE @lineCount INT = 0

	SELECT TOP 1
		@orderId = OrderID,
		@warehouseId = WarehouseID
	FROM dbo.OrderLedger
	WHERE OrderNumber = @orderNumber

	IF @orderId IS NULL
	BEGIN
		RAISERROR(N'sp_SyncWarehouseDispatch: objednavka %s neexistuje', 16, 1, @orderNumber)
		RETURN
	END

	IF @warehouseIdOverride IS NOT NULL
		SET @warehouseId = @warehouseIdOverride

	IF @warehouseId IS NULL
		SET @warehouseId = 1		-- pojistka, kdyz na objednavce chybi sklad - Praha je vychozi

	SELECT @dispatchEmail = DispatchEmail FROM dbo.Warehouse WHERE WarehouseID = @warehouseId

	IF @dispatchEmail IS NULL
		SET @dispatchEmail = N'sklad@parityshop.cz'		-- nemelo by nastat, ale radeji pojistka

	-- najdi prvni volny status slot, stejna logika jako v sp_ReserveStock
	SELECT TOP 1
		@slot = CASE
			WHEN Status1 IS NULL THEN 1
			WHEN Status2 IS NULL THEN 2
			WHEN Status3 IS NULL THEN 3
			WHEN Status4 IS NULL THEN 4
			WHEN Status5 IS NULL THEN 5
			WHEN Status6 IS NULL THEN 6
			ELSE 0
		END
	FROM dbo.OrderLedger
	WHERE OrderNumber = @orderNumber

	SET @dispatchRef = N'DISP-' + @orderNumber + N'-' + CONVERT(NVARCHAR(8), @now, 112)
	SET @trackingNumber = N'TRK' + CAST(@warehouseId AS NVARCHAR(4)) + N'-' + RIGHT(N'000000' + CAST(@orderId AS NVARCHAR(10)), 6)

	CREATE TABLE #DispatchLines
	(
		RowId INT IDENTITY(1,1) PRIMARY KEY,
		ProductID INT,
		Sku NVARCHAR(40),
		ProductName NVARCHAR(200),
		Quantity INT,
		Processed BIT NOT NULL DEFAULT 0
	)

	INSERT INTO #DispatchLines (ProductID, Sku, ProductName, Quantity)
	SELECT ProductID, Sku, ProductNameSnapshot, Quantity
	FROM dbo.OrderLedger
	WHERE OrderNumber = @orderNumber AND ProductID IS NOT NULL

	DECLARE @curRowId INT, @curProductId INT, @curSku NVARCHAR(40), @curName NVARCHAR(200), @curQty INT

	-- projedeme radky objednavky, sestavime telo mailu a rovnou odecteme fyzicky sklad
	WHILE EXISTS (SELECT 1 FROM #DispatchLines WHERE Processed = 0)
	BEGIN
		SELECT TOP 1 @curRowId = RowId, @curProductId = ProductID, @curSku = Sku, @curName = ProductName, @curQty = Quantity
		FROM #DispatchLines WHERE Processed = 0 ORDER BY RowId

		SET @mailBody = @mailBody + CAST(@curQty AS NVARCHAR(10)) + N'x ' + ISNULL(@curSku, N'?') + N' - ' + ISNULL(@curName, N'') + CHAR(13) + CHAR(10)
		SET @lineCount = @lineCount + 1

		UPDATE dbo.Catalog
		SET StockQty = ISNULL(StockQty, 0) - @curQty,
			LastStockSyncAt = @now,
			ModifiedAt = @now,
			ModifiedBy = @modifiedBy
		WHERE ProductID = @curProductId

		UPDATE #DispatchLines SET Processed = 1 WHERE RowId = @curRowId
	END

	SET @mailSubject = N'Expedice objednavky ' + @orderNumber + N' - sklad ' + CAST(@warehouseId AS NVARCHAR(4))
	SET @mailBody = N'Objednavka ' + @orderNumber + N' (' + CAST(@lineCount AS NVARCHAR(10)) + N' polozek) je pripravena k expedici.' + CHAR(13) + CHAR(10) + CHAR(13) + CHAR(10) + @mailBody
			+ CHAR(13) + CHAR(10) + N'Tracking: ' + @trackingNumber

	-- puvodne se tady volal externi HTTP endpoint skladoveho systemu pres sp_OACreate
	-- (WinHttp.WinHttpRequest), ale to na Linuxu nejde - prepsano na e-mail pres dbmail (2023)
	-- DECLARE @obj INT, @httpStatus INT
	-- EXEC sp_OACreate 'WinHttp.WinHttpRequest.5.1', @obj OUT
	-- EXEC sp_OAMethod @obj, 'Open', NULL, 'POST', 'https://wms.parityshop.internal/dispatch', 'false'
	-- EXEC sp_OAMethod @obj, 'Send', NULL, @mailBody
	-- EXEC sp_OADestroy @obj

	BEGIN TRY
		EXEC msdb.dbo.sp_send_dbmail
			@profile_name = N'DispatchProfile',
			@recipients = @dispatchEmail,
			@subject = @mailSubject,
			@body = @mailBody
	END TRY
	BEGIN CATCH
		-- mail se obcas nepovede (vypadek SMTP) - historicky se to jen zaloguje a jede se dal,
		-- expedice se kvuli tomu nezastavuje
		SET @mailErrorNote = N'mail se nepodarilo odeslat: ' + ERROR_MESSAGE()
	END CATCH

	IF @slot = 1
		UPDATE dbo.OrderLedger SET DispatchRef = @dispatchRef, DispatchedAt = @now, TrackingNumber = @trackingNumber, Status1 = @statusText, Status1At = @now, ModifiedAt = @now, ModifiedBy = @modifiedBy WHERE OrderNumber = @orderNumber
	ELSE IF @slot = 2
		UPDATE dbo.OrderLedger SET DispatchRef = @dispatchRef, DispatchedAt = @now, TrackingNumber = @trackingNumber, Status2 = @statusText, Status2At = @now, ModifiedAt = @now, ModifiedBy = @modifiedBy WHERE OrderNumber = @orderNumber
	ELSE IF @slot = 3
		UPDATE dbo.OrderLedger SET DispatchRef = @dispatchRef, DispatchedAt = @now, TrackingNumber = @trackingNumber, Status3 = @statusText, Status3At = @now, ModifiedAt = @now, ModifiedBy = @modifiedBy WHERE OrderNumber = @orderNumber
	ELSE IF @slot = 4
		UPDATE dbo.OrderLedger SET DispatchRef = @dispatchRef, DispatchedAt = @now, TrackingNumber = @trackingNumber, Status4 = @statusText, Status4At = @now, ModifiedAt = @now, ModifiedBy = @modifiedBy WHERE OrderNumber = @orderNumber
	ELSE IF @slot = 5
		UPDATE dbo.OrderLedger SET DispatchRef = @dispatchRef, DispatchedAt = @now, TrackingNumber = @trackingNumber, Status5 = @statusText, Status5At = @now, ModifiedAt = @now, ModifiedBy = @modifiedBy WHERE OrderNumber = @orderNumber
	ELSE IF @slot = 6
		UPDATE dbo.OrderLedger SET DispatchRef = @dispatchRef, DispatchedAt = @now, TrackingNumber = @trackingNumber, Status6 = @statusText, Status6At = @now, ModifiedAt = @now, ModifiedBy = @modifiedBy WHERE OrderNumber = @orderNumber
	ELSE
		UPDATE dbo.OrderLedger SET DispatchRef = @dispatchRef, DispatchedAt = @now, TrackingNumber = @trackingNumber, ModifiedAt = @now, ModifiedBy = @modifiedBy WHERE OrderNumber = @orderNumber

	INSERT INTO AuditTrail (TableName, RecordID, Action, ProcName, Detail, CreatedAt, CreatedBy)
	VALUES (N'OrderLedger', @orderNumber, N'DISPATCH', N'sp_SyncWarehouseDispatch',
		ISNULL(@mailErrorNote, N'mail odeslan, tracking ' + @trackingNumber), @now, @modifiedBy)

	DROP TABLE #DispatchLines
END
GO
