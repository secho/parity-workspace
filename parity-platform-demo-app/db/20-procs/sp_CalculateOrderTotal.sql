USE ParityShop;
GO

-- =============================================
-- sp_CalculateOrderTotal
-- Autor: P.Kovar (2013), postupne upravovano - naposledy 2022 pri kampani VERNY20.
-- Spocita souhrn objednavky (mezisoucet, slevy, DPH, dopravu, vernostni body)
-- a ulozi ho na VSECHNY radky OrderLedger prislusne objednavky (denormalizovane).
-- Mimochodem take "kotvi" aktualni cenu produktu do Catalog.LastQuotedPrice -
-- pouziva se v cenovem reportu, ktery bezi kazde rano.
-- =============================================
CREATE OR ALTER PROCEDURE dbo.sp_CalculateOrderTotal
    @OrderNumber            NVARCHAR(20),
    @PromoCode              NVARCHAR(40)  = NULL,
    @ModifiedBy             NVARCHAR(60)  = N'system',
    @RecalcShippingOnly     BIT           = 0   -- uz se nepouziva, ponecháno kvuli starym volanim z eshopu v1
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @OrderID            INT;
    DECLARE @CustomerID         INT;
    DECLARE @CountryCode        NVARCHAR(2);
    DECLARE @LoyaltyTier        TINYINT;
    DECLARE @NetSubtotal        DECIMAL(18,4) = 0;
    DECLARE @VatRate            DECIMAL(9,6);
    DECLARE @PromoDiscount      DECIMAL(18,4) = 0;
    DECLARE @LoyaltyDiscount    DECIMAL(18,4) = 0;
    DECLARE @LoyaltyPoints      INT           = 0;
    DECLARE @StacksFlag         BIT           = 0;
    DECLARE @ShippingCost       DECIMAL(18,4) = 0;
    DECLARE @ShippingVat        DECIMAL(18,4) = 0;
    DECLARE @TotalWithVat       DECIMAL(18,4);
    DECLARE @TotalNet           DECIMAL(18,4);
    DECLARE @TotalVat           DECIMAL(18,4);
    DECLARE @Now                DATETIME2(3)  = GETDATE();

    -- 1. najdi objednavku
    SELECT TOP 1
        @OrderID      = OrderID,
        @CustomerID   = CustomerID,
        @CountryCode  = CustomerCountryCode
    FROM dbo.OrderLedger
    WHERE OrderNumber = @OrderNumber;

    IF @OrderID IS NULL
    BEGIN
        RAISERROR(N'sp_CalculateOrderTotal: objednavka %s neexistuje', 16, 1, @OrderNumber);
        RETURN;
    END

    IF @CountryCode IS NULL
        SET @CountryCode = N'CZ';

    -- 2. nacti radky objednavky do docasne tabulky, dopocitej cistou castku na radek
    CREATE TABLE #Lines
    (
        OrderLineID     BIGINT,
        ProductID       INT,
        CategoryID      INT NULL,
        Quantity        INT,
        UnitPriceNet    DECIMAL(18,4),
        LineDiscountPct DECIMAL(5,2),
        LineNet         DECIMAL(18,4)
    );

    INSERT INTO #Lines (OrderLineID, ProductID, Quantity, UnitPriceNet, LineDiscountPct)
    SELECT OrderLineID, ProductID, Quantity, UnitPriceNet, ISNULL(LineDiscountPct, 0)
    FROM dbo.OrderLedger
    WHERE OrderNumber = @OrderNumber
      AND ProductID IS NOT NULL;

    UPDATE l
    SET l.CategoryID = c.CategoryID,
        l.LineNet    = l.Quantity * l.UnitPriceNet * (1 - l.LineDiscountPct / 100.0)
    FROM #Lines l
    INNER JOIN dbo.Catalog c ON c.ProductID = l.ProductID;

    SELECT @NetSubtotal = SUM(LineNet) FROM #Lines;
    IF @NetSubtotal IS NULL SET @NetSubtotal = 0;

    -- 3. DPH podle zeme zakaznika - cti z ciselniku, kaskada fallbacku pro jistotu
    SELECT @VatRate = Rate / 100.0
    FROM dbo.VatRate
    WHERE CountryCode = @CountryCode AND RateCode = N'standard';

    IF @VatRate IS NULL
    BEGIN
        SELECT TOP 1 @VatRate = cat.VatRate / 100.0
        FROM #Lines l
        INNER JOIN dbo.Category cat ON cat.CategoryID = l.CategoryID
        ORDER BY l.OrderLineID;

        IF @VatRate IS NULL
            SET @VatRate = 0.21;   -- ciselnik i kategorie chybi, tohle je jen pojistka
    END

    -- 4. vernostni tier - bereme aktualni z Customer, ne snapshot ulozeny na objednavce
    SELECT @LoyaltyTier = LoyaltyTier FROM dbo.Customer WHERE CustomerID = @CustomerID;

    -- 5. promo kod - pokud neni predan parametrem, pouzij ten, co uz na objednavce je
    IF @PromoCode IS NULL
    BEGIN
        SELECT TOP 1 @PromoCode = PromoCodeUsed FROM dbo.OrderLedger WHERE OrderNumber = @OrderNumber;
    END

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
        FROM dbo.PromoCode
        WHERE Code = @PromoCode;

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

    -- 6. vernostni sleva podle tieru - ctyri urovne zanoreni, rostlo postupne pres roky
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

    -- 7. body za nakup - 1 bod za kazdych 100 Kc utracenych (z cisteho)
    SET @LoyaltyPoints = FLOOR(@NetSubtotal / 100.0);

    -- 8. doprava - nad 1500 Kc zdarma, jinak pausal
    IF @NetSubtotal >= 1500
        SET @ShippingCost = 0;
    ELSE
        SET @ShippingCost = 99;

    -- DPH na dopravu se pocita samostatne od hlavni sazby
    SET @ShippingVat = ROUND(@ShippingCost * 0.21, 2);

    -- 9. kombinace promo kodu s vernostnim programem - doplneno pri kampani VERNY20
    IF @StacksFlag = 1 AND @LoyaltyDiscount > 0
    BEGIN
        SET @TotalWithVat = (@NetSubtotal - @PromoDiscount) * (1 + @VatRate);
    END

    SET @TotalWithVat = @TotalWithVat - @LoyaltyDiscount + @ShippingCost + @ShippingVat;

    SET @TotalNet = @NetSubtotal - @PromoDiscount - @LoyaltyDiscount + @ShippingCost;
    SET @TotalVat = @TotalWithVat - @TotalNet;

    -- pojistka proti zapornemu vysledku u male objednavky s vysokou slevou
    IF @TotalWithVat < 0 SET @TotalWithVat = 0;

    -- 10. zapis souhrnu na vsechny radky objednavky
    UPDATE dbo.OrderLedger
    SET
        TotalNet              = @TotalNet,
        TotalVat               = @TotalVat,
        TotalWithVat            = @TotalWithVat,
        ShippingCost            = @ShippingCost,
        DiscountAmount          = @PromoDiscount + @LoyaltyDiscount,
        PromoCodeUsed           = @PromoCode,
        PromoDiscountAmount     = @PromoDiscount,
        LoyaltyDiscountAmount   = @LoyaltyDiscount,
        LoyaltyPointsEarned     = @LoyaltyPoints,
        CalcCachedAt            = @Now,
        CalcVersion             = N'calc-2022-08',
        ModifiedAt              = @Now,
        ModifiedBy              = @ModifiedBy
    WHERE OrderNumber = @OrderNumber;

    -- 11. "kotva" aktualni ceny na katalog, pouziva reporting tym pro historii cen
    UPDATE c
    SET
        c.LastQuotedPrice = c.PriceNet,
        c.LastQuotedAt    = @Now,
        c.ModifiedAt      = @Now,
        c.ModifiedBy      = @ModifiedBy
    FROM dbo.Catalog c
    INNER JOIN #Lines l ON l.ProductID = c.ProductID;

    -- IF @PromoCodeID IS NOT NULL AND @PromoCategory IS NOT NULL
    -- BEGIN
    --     PRINT 'category-restricted promo used on order ' + @OrderNumber
    -- END
    -- docasny debug radek, mel byt odstranen po testovani slev (2016) - TODO

    DROP TABLE #Lines;
END
GO
