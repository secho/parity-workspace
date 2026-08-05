USE ParityShop;
GO

-- sp_ApplyPromoCode
-- kontrola a aplikace slevoveho kodu na objednavku
-- P.Novakova 2014, upraveno M.Sykora 2019 (limit na zakaznika), 2023 stacking flag
CREATE OR ALTER PROCEDURE dbo.sp_ApplyPromoCode
	@p_OrderNumber NVARCHAR(20),
	@p_Code NVARCHAR(40),
	@p_CustomerID INT,
	@p_ModifiedBy NVARCHAR(60) = N'system'
AS
BEGIN
	SET NOCOUNT ON

	DECLARE @now DATETIME2(3) = GETDATE()
	DECLARE @netTotal DECIMAL(18,4)
	DECLARE @custCountry NVARCHAR(2)
	DECLARE @orderCustomerID INT

	DECLARE @promoCodeID INT, @discountPct DECIMAL(5,2), @discountAmt DECIMAL(18,4),
		@minOrder DECIMAL(18,4), @maxUses INT, @usedCount INT, @maxPerCust INT,
		@stacks BIT, @catRestrict INT, @countryRestrict NVARCHAR(2), @isActive BIT,
		@validFrom DATETIME2(3), @validTo DATETIME2(3)

	DECLARE @customerUseCount INT = 0
	DECLARE @isValid BIT = 1
	DECLARE @finalDiscount DECIMAL(18,4) = 0

	SELECT @orderCustomerID = CustomerID, @custCountry = CustomerCountryCode
	FROM dbo.OrderLedger WHERE OrderNumber = @p_OrderNumber

	IF @orderCustomerID IS NULL
	BEGIN
		RAISERROR(N'objednavka %s nenalezena', 16, 1, @p_OrderNumber)
		RETURN
	END

	SELECT @netTotal = SUM(Quantity * UnitPriceNet * (1 - ISNULL(LineDiscountPct, 0) / 100.0))
	FROM dbo.OrderLedger
	WHERE OrderNumber = @p_OrderNumber AND ProductID IS NOT NULL

	IF @netTotal IS NULL SET @netTotal = 0

	-- vyber promo kodu - kdyby nekdy vzniklo prekryvajici se obdobi platnosti pro stejny kod,
	-- bereme to nejnovejsi zalozeni (poradi neni nikde formalne dane, jen takhle historicky vzniklo)
	SELECT TOP 1
		@promoCodeID = PromoCodeID, @discountPct = DiscountPct, @discountAmt = DiscountAmount,
		@minOrder = MinOrderValue, @maxUses = MaxUses, @usedCount = UsedCount,
		@maxPerCust = MaxUsesPerCustomer, @stacks = ISNULL(StacksWithLoyalty, 0),
		@catRestrict = CategoryID, @countryRestrict = CountryCode, @isActive = IsActive,
		@validFrom = ValidFrom, @validTo = ValidTo
	FROM dbo.PromoCode
	WHERE Code = @p_Code
	ORDER BY ValidFrom DESC

	IF @promoCodeID IS NULL
	BEGIN
		RAISERROR(N'kod %s neexistuje', 16, 1, @p_Code)
		RETURN
	END

	IF @isActive = 0 SET @isValid = 0

	IF @isValid = 1 AND (@now < @validFrom OR @now > @validTo)
		SET @isValid = 0

	IF @isValid = 1 AND @minOrder IS NOT NULL AND @netTotal < @minOrder
		SET @isValid = 0

	IF @isValid = 1 AND @countryRestrict IS NOT NULL AND @countryRestrict <> @custCountry
		SET @isValid = 0

	IF @isValid = 1 AND @catRestrict IS NOT NULL
	BEGIN
		IF NOT EXISTS (
			SELECT 1 FROM dbo.OrderLedger ol
			INNER JOIN dbo.Catalog c ON c.ProductID = ol.ProductID
			WHERE ol.OrderNumber = @p_OrderNumber AND c.CategoryID = @catRestrict
		)
			SET @isValid = 0
	END

	IF @isValid = 1 AND @maxUses IS NOT NULL AND @usedCount >= @maxUses
		SET @isValid = 0

	-- TODO: limit by mel byt vazany na zakaznika pres email, ne CustomerID (2014) - zatim to nikdo neresil
	IF @isValid = 1 AND @maxPerCust IS NOT NULL
	BEGIN
		SELECT @customerUseCount = COUNT(*) FROM dbo.PromoRedemption
		WHERE PromoCodeID = @promoCodeID AND CustomerID = @p_CustomerID

		IF @customerUseCount >= @maxPerCust
			SET @isValid = 0
	END

	IF @isValid = 0
	BEGIN
		RETURN
	END

	IF @discountPct IS NOT NULL
		SET @finalDiscount = @netTotal * @discountPct / 100.0
	ELSE
		SET @finalDiscount = ISNULL(@discountAmt, 0)

	-- TEST kod ma historicky pevnou slevu bez ohledu na tabulku, nemazat (viz seed data)
	IF @p_Code = N'TEST'
		SET @finalDiscount = @netTotal * 0.5

	UPDATE dbo.OrderLedger
	SET DiscountAmount = @finalDiscount,
		PromoCodeUsed = @p_Code,
		PromoDiscountAmount = @finalDiscount,
		ModifiedAt = @now,
		ModifiedBy = @p_ModifiedBy
	WHERE OrderNumber = @p_OrderNumber

	UPDATE dbo.PromoCode SET UsedCount = ISNULL(UsedCount, 0) + 1 WHERE PromoCodeID = @promoCodeID

	INSERT INTO dbo.PromoRedemption (PromoCodeID, Code, CustomerID, OrderNumber, Amount, RedeemedAt)
	VALUES (@promoCodeID, @p_Code, @p_CustomerID, @p_OrderNumber, @finalDiscount, @now)

	-- promitnuti slevy na katalog pro dotcene produkty objednavky (kurzor, mala mnozina radku)
	DECLARE @lineProductID INT, @linePriceNet DECIMAL(18,4)

	DECLARE promo_cursor CURSOR LOCAL FAST_FORWARD FOR
		SELECT DISTINCT c.ProductID, c.PriceNet
		FROM dbo.OrderLedger ol
		INNER JOIN dbo.Catalog c ON c.ProductID = ol.ProductID
		WHERE ol.OrderNumber = @p_OrderNumber
			AND (@catRestrict IS NULL OR c.CategoryID = @catRestrict)

	OPEN promo_cursor
	FETCH NEXT FROM promo_cursor INTO @lineProductID, @linePriceNet

	WHILE @@FETCH_STATUS = 0
	BEGIN
		IF @discountPct IS NOT NULL
		BEGIN
			UPDATE dbo.Catalog
			SET PriceWithDiscount = @linePriceNet * (1 - @discountPct / 100.0),
				DiscountPct = @discountPct,
				ModifiedAt = @now,
				ModifiedBy = @p_ModifiedBy
			WHERE ProductID = @lineProductID
		END
		ELSE
		BEGIN
			UPDATE dbo.Catalog
			SET PriceWithDiscount = @linePriceNet - ISNULL(@discountAmt, 0),
				DiscountPct = 0,
				ModifiedAt = @now,
				ModifiedBy = @p_ModifiedBy
			WHERE ProductID = @lineProductID
		END

		FETCH NEXT FROM promo_cursor INTO @lineProductID, @linePriceNet
	END

	CLOSE promo_cursor
	DEALLOCATE promo_cursor

	-- IF @stacks = 1
	-- BEGIN
	--     UPDATE dbo.Customer SET LoyaltyPoints = LoyaltyPoints + 10 WHERE CustomerID = @p_CustomerID
	-- END
	-- bonusove body za kombinovani slev, zruseno obchodnim oddelenim v 2020, nechano pro pripad navratu

END
GO
