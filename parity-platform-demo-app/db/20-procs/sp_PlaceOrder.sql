USE ParityShop;
GO

-- =============================================
-- sp_PlaceOrder
-- Hlavni vstupni bod pro vytvoreni objednavky z eshopu. Orchestruje vypocet (sp_CalculateOrderTotal),
-- rezervaci skladu (sp_ReserveStock) a promo kod (sp_ApplyPromoCode).
-- Autor: J.Prochazka 2015, TRY/CATCH pridal T.Vesely 2021 po incidentu s rozjetou platbou (viz PS-204),
-- adresni pole pridana 2022 kdyz pribyla samostatna dorucovaci adresa vedle fakturacni.
-- Radky objednavky se predavaji jako oddelovany retezec "ProductID:Qty|ProductID:Qty|...",
-- protoze puvodni eshop v1 nemel zadnou moznost poslat TVP a nikdy se to nepremigrovalo.
-- =============================================
CREATE OR ALTER PROCEDURE dbo.sp_PlaceOrder
	@CustomerID			INT,
	@LinesRaw			NVARCHAR(MAX),
	@PromoCode			NVARCHAR(40)	= NULL,
	@PaymentMethod		NVARCHAR(40)	= N'card',
	@ShipStreet			NVARCHAR(200)	= NULL,
	@ShipCity			NVARCHAR(100)	= NULL,
	@ShipZip			NVARCHAR(10)	= NULL,
	@ShipCountry		NVARCHAR(2)		= NULL,
	@BillStreet			NVARCHAR(200)	= NULL,
	@BillCity			NVARCHAR(100)	= NULL,
	@BillZip			NVARCHAR(10)	= NULL,
	@BillCountry		NVARCHAR(2)		= NULL,
	@WarehouseID		INT				= NULL,	-- uz se nepouziva, sklad resi sp_ReserveStock sam. Ponecháno kvuli starym volanim z eshopu v1 (2015).
	@CreatedBy			NVARCHAR(60)	= N'system'
AS
BEGIN
	SET NOCOUNT ON;

	DECLARE @Now			DATETIME2(3)	= SYSDATETIME();
	DECLARE @OrderID		INT;
	DECLARE @OrderNumber	NVARCHAR(20);
	DECLARE @Year			CHAR(4)			= CAST(YEAR(@Now) AS CHAR(4));
	DECLARE @NextSeq		INT;

	DECLARE @CustEmail			NVARCHAR(200);
	DECLARE @CustName			NVARCHAR(200);
	DECLARE @CustPhone			NVARCHAR(40);
	DECLARE @CustLoyaltyTier	TINYINT;
	DECLARE @CustCountry		NVARCHAR(2);
	DECLARE @CustStreet		NVARCHAR(200);
	DECLARE @CustCity			NVARCHAR(100);
	DECLARE @CustZip			NVARCHAR(10);

	DECLARE @PaymentStatus	NVARCHAR(30);
	DECLARE @PaymentRef		NVARCHAR(60)	= N'PR-' + CONVERT(NVARCHAR(36), NEWID());

	DECLARE @LineCount		INT;
	DECLARE @NewOrderLineID	BIGINT;

	DECLARE @TotalNet		DECIMAL(18,4);
	DECLARE @TotalVat		DECIMAL(18,4);
	DECLARE @TotalWithVat	DECIMAL(18,4);
	DECLARE @ShippingCost	DECIMAL(18,4);

	IF NOT EXISTS (SELECT 1 FROM dbo.Customer WHERE CustomerID = @CustomerID)
	BEGIN
		RAISERROR(N'sp_PlaceOrder: zakaznik %d neexistuje', 16, 1, @CustomerID);
		RETURN;
	END

	SELECT
		@CustEmail = Email,
		@CustName = LTRIM(RTRIM(ISNULL(FirstName, N'') + N' ' + ISNULL(LastName, N''))),
		@CustPhone = Phone,
		@CustLoyaltyTier = LoyaltyTier,
		@CustCountry = ISNULL(CountryCode, N'CZ'),
		@CustStreet = Street,
		@CustCity = City,
		@CustZip = Zip
	FROM dbo.Customer
	WHERE CustomerID = @CustomerID;

	-- dorucovaci a fakturacni adresa - pokud volajici neposle vlastni, padne se to na adresu z profilu
	IF @BillStreet IS NULL SET @BillStreet = @CustStreet;
	IF @BillCity IS NULL SET @BillCity = @CustCity;
	IF @BillZip IS NULL SET @BillZip = @CustZip;
	IF @BillCountry IS NULL SET @BillCountry = @CustCountry;
	IF @ShipStreet IS NULL SET @ShipStreet = @BillStreet;
	IF @ShipCity IS NULL SET @ShipCity = @BillCity;
	IF @ShipZip IS NULL SET @ShipZip = @BillZip;
	IF @ShipCountry IS NULL SET @ShipCountry = @BillCountry;

	IF @PaymentMethod = N'cod'
		SET @PaymentStatus = N'PENDING';
	ELSE IF @PaymentMethod = N'bank_transfer'
		SET @PaymentStatus = N'AWAITING_PAYMENT';
	ELSE
		SET @PaymentStatus = N'AUTHORIZED';

	-- rozparsovani radku objednavky. Format "ProductID:Qty" oddeleny "|", zdedeno z eshopu v1.
	DECLARE @sRemaining	NVARCHAR(MAX) = ISNULL(@LinesRaw, N'') + N'|';
	DECLARE @sChunk		NVARCHAR(200);
	DECLARE @iDelimPos	INT;
	DECLARE @iColonPos	INT;
	DECLARE @iProductId	INT;
	DECLARE @iQty		INT;

	CREATE TABLE #OrderLines
	(
		LineNumber	INT IDENTITY(1,1),
		ProductID	INT,
		Quantity	INT
	);

	WHILE LEN(@sRemaining) > 0
	BEGIN
		SET @iDelimPos = CHARINDEX(N'|', @sRemaining);
		IF @iDelimPos = 0
			BREAK;

		SET @sChunk = LTRIM(RTRIM(SUBSTRING(@sRemaining, 1, @iDelimPos - 1)));
		SET @sRemaining = SUBSTRING(@sRemaining, @iDelimPos + 1, LEN(@sRemaining));

		IF LEN(@sChunk) > 0
		BEGIN
			SET @iColonPos = CHARINDEX(N':', @sChunk);
			IF @iColonPos > 0
			BEGIN
				SET @iProductId = TRY_CAST(SUBSTRING(@sChunk, 1, @iColonPos - 1) AS INT);
				SET @iQty = TRY_CAST(SUBSTRING(@sChunk, @iColonPos + 1, LEN(@sChunk)) AS INT);

				IF @iProductId IS NOT NULL AND @iQty IS NOT NULL AND @iQty > 0
				BEGIN
					INSERT INTO #OrderLines (ProductID, Quantity) VALUES (@iProductId, @iQty);
				END
			END
		END
	END

	SELECT @LineCount = COUNT(*) FROM #OrderLines;

	IF @LineCount IS NULL OR @LineCount = 0
	BEGIN
		RAISERROR(N'sp_PlaceOrder: objednavka bez radku (@LinesRaw se nepodarilo rozparsovat)', 16, 1);
		RETURN;
	END

	IF @LineCount > 100
	BEGIN
		-- historicky limit, nikdo si nepamatuje presny duvod, ale je v produkci od 2016
		RAISERROR(N'sp_PlaceOrder: prilis mnoho radku (%d), limit je 100', 16, 1, @LineCount);
		RETURN;
	END

	BEGIN TRY

		-- cislovani objednavek - rok + poradove cislo v ramci roku (viz seed data, format 2026000001).
		-- POZNAMKA (2018): pri soubeznem vkladani muze dojit ke stejnemu cislu, nikdy se to
		-- v produkci nestalo natolik casto aby to nekdo resil, tak to zustalo takhle.
		SELECT @NextSeq = ISNULL(MAX(CAST(RIGHT(OrderNumber, 6) AS INT)), 0) + 1
		FROM dbo.OrderLedger
		WHERE LEFT(OrderNumber, 4) = @Year;

		SET @OrderNumber = @Year + RIGHT(N'000000' + CAST(@NextSeq AS VARCHAR(6)), 6);

		SELECT @OrderID = ISNULL(MAX(OrderID), 0) + 1 FROM dbo.OrderLedger;

		INSERT INTO dbo.OrderLedger
		(
			OrderID, OrderNumber, LineNumber, CustomerID,
			CustomerEmailSnapshot, CustomerNameSnapshot, CustomerPhoneSnapshot, CustomerLoyaltyTierSnapshot, CustomerCountryCode,
			BillStreet, BillCity, BillZip, BillCountry,
			ShipStreet, ShipCity, ShipZip, ShipCountry,
			ProductID, Sku, ProductNameSnapshot, Quantity,
			UnitPriceNet, UnitPriceWithVat, LineVatRate, LineNet, LineVat, LineTotal,
			PaymentMethod, PaymentStatus, PaymentRef,
			Status1, Status1At,
			WarehouseID,
			OrderedAt, CreatedAt, CreatedBy
		)
		SELECT
			@OrderID, @OrderNumber, ol.LineNumber, @CustomerID,
			@CustEmail, @CustName, @CustPhone, @CustLoyaltyTier, @CustCountry,
			@BillStreet, @BillCity, @BillZip, @BillCountry,
			@ShipStreet, @ShipCity, @ShipZip, @ShipCountry,
			ol.ProductID, cat.Sku, cat.Name, ol.Quantity,
			cat.PriceNet, cat.PriceWithVat, cat.VatRate,
			ROUND(ol.Quantity * cat.PriceNet, 2),
			ROUND(ol.Quantity * cat.PriceWithVat, 2) - ROUND(ol.Quantity * cat.PriceNet, 2),
			ROUND(ol.Quantity * cat.PriceWithVat, 2),
			@PaymentMethod, @PaymentStatus, @PaymentRef,
			N'NOVA', @Now,
			1,	-- vychozi sklad, presne rozdeleni mezi sklady resi az sp_ReserveStock nize
			@Now, @Now, @CreatedBy
		FROM #OrderLines ol
		INNER JOIN dbo.Catalog cat ON cat.ProductID = ol.ProductID;

		-- ID prvniho radku objednavky, pouziva se pri sestaveni potvrzovaciho emailu (mailer-service, PS-118)
		SET @NewOrderLineID = SCOPE_IDENTITY();

		IF @PromoCode IS NOT NULL AND LEN(@PromoCode) > 0
		BEGIN
			EXEC dbo.sp_ApplyPromoCode
				@p_OrderNumber = @OrderNumber,
				@p_Code = @PromoCode,
				@p_CustomerID = @CustomerID,
				@p_ModifiedBy = @CreatedBy;
		END

		EXEC dbo.sp_CalculateOrderTotal
			@OrderNumber = @OrderNumber,
			@PromoCode = @PromoCode,
			@ModifiedBy = @CreatedBy;

		EXEC dbo.sp_ReserveStock
			@orderNo = @OrderNumber,
			@modifiedBy = @CreatedBy;

		-- znovu nacist a zapsat soucty na objednavku - historicky duvod (2020, PS-204):
		-- transakce v sp_CalculateOrderTotal obcas spadla do rollbacku driv, nez se stihl
		-- zapsat cache radek, takze se soucet pro jistotu prepisuje jeste jednou tady
		SELECT TOP 1
			@TotalNet = TotalNet, @TotalVat = TotalVat,
			@TotalWithVat = TotalWithVat, @ShippingCost = ShippingCost
		FROM dbo.OrderLedger
		WHERE OrderNumber = @OrderNumber;

		UPDATE dbo.OrderLedger
		SET TotalNet = @TotalNet,
			TotalVat = @TotalVat,
			TotalWithVat = @TotalWithVat,
			ShippingCost = @ShippingCost,
			CalcCachedAt = @Now
		WHERE OrderNumber = @OrderNumber;

		-- sklad se prideluje az posledni vytvorenou rezervaci (viz komentar v sp_ReserveStock)
		UPDATE ol
		SET ol.WarehouseID = sr.WarehouseID
		FROM dbo.OrderLedger ol
		CROSS APPLY
		(
			SELECT TOP 1 WarehouseID
			FROM dbo.StockReservation sr2
			WHERE sr2.OrderNumber = ol.OrderNumber AND sr2.ProductID = ol.ProductID
			ORDER BY sr2.ReservationID DESC
		) sr
		WHERE ol.OrderNumber = @OrderNumber;

		-- merchandising pocitadlo prodejnosti + defenzivni prepis skladovych sloupcu
		UPDATE cat
		SET cat.SoldCount = ISNULL(cat.SoldCount, 0) + ol.Quantity,
			cat.StockQty = cat.StockQty,			-- no-op, ponechano z doby pred rozdelenim logiky do sp_ReserveStock (2016)
			cat.ReservedQty = cat.ReservedQty,		-- no-op
			cat.ModifiedAt = @Now,
			cat.ModifiedBy = @CreatedBy
		FROM dbo.Catalog cat
		INNER JOIN #OrderLines ol ON ol.ProductID = cat.ProductID;

		INSERT INTO dbo.AuditTrail (TableName, RecordID, Action, ProcName, Detail, CreatedAt, CreatedBy)
		VALUES (N'OrderLedger', @OrderNumber, N'CREATE', N'sp_PlaceOrder',
			N'objednavka vytvorena, radku: ' + CAST(@LineCount AS NVARCHAR(10)) + N', zakaznik ' + CAST(@CustomerID AS NVARCHAR(10)),
			@Now, @CreatedBy);

	END TRY
	BEGIN CATCH

		INSERT INTO dbo.AuditTrail (TableName, RecordID, Action, ProcName, Detail, CreatedAt, CreatedBy)
		VALUES (N'OrderLedger', ISNULL(@OrderNumber, N'?'), N'ERROR', N'sp_PlaceOrder', ERROR_MESSAGE(), @Now, @CreatedBy);

		-- pojistka z 2021 - v praxi se sem netrefi, protoze proc zadnou transakci explicitne nezaklada,
		-- ale ponecháno pro pripad, ze by volajici (monolit) obalil cely EXEC do vlastni transakce
		IF @@TRANCOUNT > 0
			ROLLBACK TRANSACTION;

		THROW;
	END CATCH

	DROP TABLE #OrderLines;

	SELECT
		@OrderID AS OrderID,
		@OrderNumber AS OrderNumber,
		@NewOrderLineID AS LastOrderLineID;

END
GO
