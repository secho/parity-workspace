USE ParityShop;
GO

-- sp_GetProductDetail
-- Detail produktu pro produktovou kartu - nazev, popis, cena, kategorie, sklad.
-- L.Prochazkova, 2015
CREATE OR ALTER PROCEDURE dbo.sp_GetProductDetail
    @ProductID INT
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @Now DATETIME2(3) = GETDATE();

    IF NOT EXISTS (SELECT 1 FROM dbo.Catalog WHERE ProductID = @ProductID)
    BEGIN
        RAISERROR(N'sp_GetProductDetail: produkt %d neexistuje', 16, 1, @ProductID);
        RETURN;
    END

    -- efektivni cena: bezi-li aktivni slevova akce (DiscountValidFrom/To), bere se
    -- PriceWithDiscount, jinak normalni cena s DPH
    SELECT
        c.ProductID,
        c.Sku,
        c.Name,
        c.ShortDescription,
        c.LongDescription,
        c.CategoryID,
        cat.Name                   AS CategoryName,
        c.CategoryPathCache,
        c.SupplierName,
        c.Manufacturer,
        c.Ean,
        c.WarrantyMonths,
        c.WeightGrams,
        c.PriceNet,
        c.PriceWithVat,
        c.VatRate,
        c.PriceWithDiscount,
        c.DiscountPct,
        CASE
            WHEN c.DiscountValidFrom IS NOT NULL
                 AND c.DiscountValidTo IS NOT NULL
                 AND @Now BETWEEN c.DiscountValidFrom AND c.DiscountValidTo
                 AND c.PriceWithDiscount IS NOT NULL
            THEN c.PriceWithDiscount
            ELSE c.PriceWithVat
        END                         AS EffectivePrice,
        c.StockQtyWh1,
        c.StockQtyWh2,
        c.StockQtyWh3,
        ISNULL(c.StockQtyWh1, 0) + ISNULL(c.StockQtyWh2, 0) + ISNULL(c.StockQtyWh3, 0) AS StockQtyTotal,
        c.AllowBackorder,
        c.IsActive,
        c.IsVisible,
        c.RatingAvg,
        c.RatingCount,
        c.ImageUrl,
        c.SeoSlug
    FROM dbo.Catalog c
    LEFT JOIN dbo.Category cat ON cat.CategoryID = c.CategoryID
    WHERE c.ProductID = @ProductID;
END
GO
