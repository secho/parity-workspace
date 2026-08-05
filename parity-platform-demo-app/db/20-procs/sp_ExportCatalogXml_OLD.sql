USE ParityShop;
GO

/* =====================================================================
   sp_ExportCatalogXml_OLD
   Autor: L. Dvorak
   Datum: 2013-09-02
   Ucel: generuje XML feed katalogu pro partnersky srovnavac cen Srovnejto.cz
   (smlouva podepsana 2013). Srovnejto.cz ukoncilo provoz nekdy v roce 2017,
   od te doby feed nikdo nestahuje. Ponechano - kdyby obchod nekdy sehnal
   noveho partnera se stejnym XML schematem, neni co predelavat.
   ===================================================================== */
CREATE OR ALTER PROCEDURE dbo.sp_ExportCatalogXml_OLD
    @IncludeInactive BIT = 0,
    @Debug BIT = 0   -- kdyz 1, vypise pred XML jeste kontrolni radkovy soucet (pridano pri ladeni 2013, nikdy neuklizeno)
AS
BEGIN
    SET NOCOUNT ON;

    -- mapovani naseho CategoryID na cislovani kategorii ocekavane feedem Srovnejto.cz -
    -- dohledano jen z jejich stareho PDF ciselniku, nikde jinde v systemu nezapsano
    DECLARE @PartnerCategoryFallback INT = 999;

    IF @Debug = 1
    BEGIN
        SELECT COUNT(*) AS PocetKExportu
        FROM dbo.Catalog
        WHERE IsActive = 1 AND (IsVisible = 1 OR @IncludeInactive = 1);
    END

    -- nazvy elementu odpovidaji puvodni specifikaci feedu (SHOPITEM schema Srovnejto.cz)
    SELECT
        c.ProductID         AS [SHOPITEM/ITEM_ID],
        c.Sku               AS [SHOPITEM/PRODUCT],
        c.Name              AS [SHOPITEM/PRODUCTNAME],
        c.ShortDescription  AS [SHOPITEM/DESCRIPTION],
        c.PriceWithVat      AS [SHOPITEM/PRICE_VAT],
        c.Manufacturer      AS [SHOPITEM/MANUFACTURER],
        c.Ean               AS [SHOPITEM/EAN],
        c.WarrantyMonths    AS [SHOPITEM/WARRANTY],
        c.WeightGrams       AS [SHOPITEM/WEIGHT],
        c.SupplierSku       AS [SHOPITEM/VENDOR_ID],
        c.CategoryPathCache AS [SHOPITEM/CATEGORYTEXT],
        CASE c.CategoryID
            WHEN 1 THEN 105   -- Komponenty
            WHEN 2 THEN 210   -- Periferie
            WHEN 3 THEN 340   -- SBC, partner to mel pod "Vyvojove desky"
            WHEN 4 THEN 780   -- Retro, partner nema presny ekvivalent, napasovano rucne (2013)
            WHEN 5 THEN 900   -- Merch
            ELSE @PartnerCategoryFallback
        END                 AS [SHOPITEM/CATEGORY_ID],
        c.ImageUrl          AS [SHOPITEM/IMGURL],
        CASE WHEN c.StockQty > 0 THEN N'skladem' ELSE N'nedostupne' END AS [SHOPITEM/DELIVERY_DATE]
    FROM dbo.Catalog c
    WHERE c.IsActive = 1
      AND (c.IsVisible = 1 OR @IncludeInactive = 1)
    ORDER BY c.ProductID
    FOR XML PATH(''), ROOT('SHOP');

    -- pokus o JSON variantu feedu pro jineho, tehdy potencialniho partnera - rozjednano
    -- 2016 a nikdy nedodelano, radeji nemazat, kdyby se k tomu nekdo vratil
    -- SELECT c.ProductID, c.Sku, c.Name, c.PriceWithVat
    -- FROM dbo.Catalog c
    -- WHERE c.IsActive = 1
    -- FOR JSON PATH, ROOT('items')

    -- puvodne se tady generoval i feed pro Zbozi.cz, presunuto do samostatne procedury
    -- v roce 2014 (sp_ExportZboziXml) - ta uz byla v mezicase smazana
END
GO
