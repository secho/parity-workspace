USE ParityShop;
GO

-- sp_GetCartSummary
-- Autor: P.Kovar (2013), odvozeno z vypoctu v sp_CalculateOrderTotal - souhrn kosiku
-- pred vytvorenim objednavky (mezisoucet, slevy, DPH, doprava). Read-only, nic neuklada.
CREATE OR ALTER PROCEDURE dbo.sp_GetCartSummary
    @CartItems          NVARCHAR(MAX),
    @CustomerID         INT,
    @PromoCode          NVARCHAR(40)  = NULL,
    @ModifiedBy         NVARCHAR(60)  = N'system'   -- nepouzito, zbylo z kopie sp_CalculateOrderTotal
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @CountryCode NVARCHAR(2), @LoyaltyTier TINYINT, @NetSubtotal DECIMAL(18,4) = 0, @VatRate DECIMAL(9,6),
            @PromoDiscount DECIMAL(18,4) = 0, @LoyaltyDiscount DECIMAL(18,4) = 0, @LoyaltyPoints INT = 0,
            @StacksFlag BIT = 0, @ShippingCost DECIMAL(18,4) = 0, @ShippingVat DECIMAL(18,4) = 0,
            @TotalWithVat DECIMAL(18,4), @TotalNet DECIMAL(18,4), @TotalVat DECIMAL(18,4), @Now DATETIME2(3) = GETDATE();

    SELECT @CountryCode = CountryCode, @LoyaltyTier = LoyaltyTier FROM dbo.Customer WHERE CustomerID = @CustomerID;
    IF @CountryCode IS NULL SET @CountryCode = N'CZ';

    -- 1. rozparsuj retezec kosiku "productId:qty,productId:qty,..." - bez cursoru
    DECLARE @Cart NVARCHAR(MAX) = ISNULL(@CartItems, N'') + N',';
    DECLARE @Pos INT, @Chunk NVARCHAR(100), @ColonPos INT, @PID INT, @Qty INT;
    CREATE TABLE #CartLines
    (
        ProductID INT, CategoryID INT NULL, Quantity INT,
        UnitPriceNet DECIMAL(18,4), LineDiscountPct DECIMAL(5,2), LineNet DECIMAL(18,4)
    );

    WHILE LEN(@Cart) > 0
    BEGIN
        SET @Pos = CHARINDEX(N',', @Cart);
        IF @Pos = 0 BREAK;
        SET @Chunk = LTRIM(RTRIM(SUBSTRING(@Cart, 1, @Pos - 1)));
        SET @Cart  = SUBSTRING(@Cart, @Pos + 1, LEN(@Cart));
        IF LEN(@Chunk) > 0
        BEGIN
            SET @ColonPos = CHARINDEX(N':', @Chunk);
            IF @ColonPos > 0
            BEGIN
                SET @PID = TRY_CAST(SUBSTRING(@Chunk, 1, @ColonPos - 1) AS INT);
                SET @Qty = TRY_CAST(SUBSTRING(@Chunk, @ColonPos + 1, LEN(@Chunk)) AS INT);
                IF @PID IS NOT NULL AND @Qty IS NOT NULL AND @Qty > 0
                    INSERT INTO #CartLines (ProductID, Quantity, LineDiscountPct) VALUES (@PID, @Qty, 0);
            END
        END
    END

    -- 2. doplneni ceny a kategorie z katalogu, dopocet cisteho radku
    UPDATE l
    SET l.CategoryID   = c.CategoryID,
        l.UnitPriceNet = c.PriceNet,
        l.LineNet      = l.Quantity * c.PriceNet * (1 - l.LineDiscountPct / 100.0)
    FROM #CartLines l INNER JOIN dbo.Catalog c ON c.ProductID = l.ProductID;
    SELECT @NetSubtotal = SUM(LineNet) FROM #CartLines;
    IF @NetSubtotal IS NULL SET @NetSubtotal = 0;

    -- 3. DPH podle zeme zakaznika - cti z ciselniku, kaskada fallbacku pro jistotu
    SELECT @VatRate = Rate / 100.0 FROM dbo.VatRate WHERE CountryCode = @CountryCode AND RateCode = N'standard';
    IF @VatRate IS NULL
    BEGIN
        SELECT TOP 1 @VatRate = cat.VatRate / 100.0
        FROM #CartLines l INNER JOIN dbo.Category cat ON cat.CategoryID = l.CategoryID
        ORDER BY l.ProductID;
        IF @VatRate IS NULL
            SET @VatRate = 0.21;   -- ciselnik i kategorie chybi, tohle je jen pojistka
    END

    -- 4. promo kod
    DECLARE @PromoCodeID INT, @PromoPct DECIMAL(5,2), @PromoAmt DECIMAL(18,4),
            @PromoMin DECIMAL(18,4), @PromoCategory INT, @PromoCountry NVARCHAR(2),
            @PromoActive BIT, @PromoFrom DATETIME2(3), @PromoTo DATETIME2(3);
    IF @PromoCode IS NOT NULL
    BEGIN
        SELECT
            @PromoCodeID = PromoCodeID, @PromoPct = DiscountPct, @PromoAmt = DiscountAmount,
            @PromoMin = MinOrderValue, @PromoCategory = CategoryID, @PromoCountry = CountryCode,
            @StacksFlag = ISNULL(StacksWithLoyalty, 0), @PromoActive = IsActive,
            @PromoFrom = ValidFrom, @PromoTo = ValidTo
        FROM dbo.PromoCode WHERE Code = @PromoCode;

        IF @PromoCodeID IS NOT NULL
        BEGIN
            IF @PromoActive = 1 AND @Now >= @PromoFrom AND @Now <= @PromoTo
                AND (@PromoMin IS NULL OR @NetSubtotal >= @PromoMin)
                AND (@PromoCountry IS NULL OR @PromoCountry = @CountryCode)
            BEGIN
                IF @PromoPct IS NOT NULL
                    SET @PromoDiscount = @NetSubtotal * @PromoPct / 100.0;
                ELSE
                    SET @PromoDiscount = ISNULL(@PromoAmt, 0);
            END
        END
    END

    -- zakladni vypocet, historicky nejstarsi cast procedury
    SET @TotalWithVat = @NetSubtotal * (1 + @VatRate) - @PromoDiscount;
    /*
    -- stara verze pred zavedenim promo kodu (2013), necham pro historii
    SET @TotalWithVat = @NetSubtotal * (1 + @VatRate);
    SET @PromoDiscount = 0;
    */

    -- 5. vernostni sleva podle tieru - ctyri urovne zanoreni, rostlo postupne pres roky
    IF @LoyaltyTier IS NOT NULL
    BEGIN
        IF @LoyaltyTier >= 1
        BEGIN
            IF @NetSubtotal >= 500
            BEGIN
                IF @CountryCode = N'CZ'
                BEGIN
                    IF @LoyaltyTier >= 4
                        SET @LoyaltyDiscount = @NetSubtotal * 0.12;
                    ELSE IF @LoyaltyTier = 3
                        SET @LoyaltyDiscount = @NetSubtotal * 0.08;
                    ELSE IF @LoyaltyTier = 2
                        SET @LoyaltyDiscount = @NetSubtotal * 0.05;
                    ELSE
                        SET @LoyaltyDiscount = @NetSubtotal * 0.02;
                END
                ELSE
                BEGIN
                    -- SK zakaznici nemaji narok na vernostni slevu
                    SET @LoyaltyDiscount = @NetSubtotal * 0.03;
                END
            END
        END
    END

    -- 6. body za nakup - 1 bod za kazdych 100 Kc utracenych (z cisteho)
    SET @LoyaltyPoints = FLOOR(@NetSubtotal / 100.0);

    -- 7. doprava - nad 1500 Kc zdarma, jinak pausal
    IF @NetSubtotal >= 1500 SET @ShippingCost = 0; ELSE SET @ShippingCost = 99;
    SET @ShippingVat = ROUND(@ShippingCost * 0.21, 2);
    SET @TotalWithVat = @TotalWithVat - @LoyaltyDiscount + @ShippingCost + @ShippingVat;
    SET @TotalNet = @NetSubtotal - @PromoDiscount - @LoyaltyDiscount + @ShippingCost;
    SET @TotalVat = @TotalWithVat - @TotalNet;
    IF @TotalWithVat < 0 SET @TotalWithVat = 0;

    -- 8. radky kosiku
    SELECT l.ProductID, c.Sku, c.Name, l.Quantity, l.UnitPriceNet, l.LineNet
    FROM #CartLines l INNER JOIN dbo.Catalog c ON c.ProductID = l.ProductID
    ORDER BY l.ProductID;

    -- 9. souhrnny radek
    SELECT
        @NetSubtotal                       AS NetSubtotal,
        @TotalVat                          AS VatAmount,
        @ShippingCost                      AS ShippingCost,
        @PromoDiscount + @LoyaltyDiscount  AS DiscountAmount,
        @LoyaltyPoints                     AS LoyaltyPointsEarned,
        @TotalWithVat                      AS TotalWithVat;

    DROP TABLE #CartLines;
END
GO
