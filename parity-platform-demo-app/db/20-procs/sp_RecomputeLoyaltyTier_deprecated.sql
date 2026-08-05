USE ParityShop;
GO

-- sp_RecomputeLoyaltyTier_deprecated
-- POZNAMKA: nahrazeno procedurou sp_RecalculateCustomerScore (2015), tahle uz by se
-- nemela pouzivat pro nic ziveho. Mela byt smazana - 2016-04-12 (J.Bartos) - a porad
-- tu je, protoze na ni visel jeden mesicni report z BI, ktery uz mezitim taky nikdo nespoustel.
-- Prahy pro tier jsou puvodni z roku 2013, NEODPOVIDAJI aktualnimu skorovani zakazniku.
CREATE OR ALTER PROCEDURE dbo.sp_RecomputeLoyaltyTier_deprecated
    @CustomerID INT = NULL,
    @ModifiedBy NVARCHAR(60) = N'system'
AS
BEGIN
    SET NOCOUNT ON;

    IF @CustomerID IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dbo.Customer WHERE CustomerID = @CustomerID)
    BEGIN
        RAISERROR(N'zakaznik %d neexistuje', 16, 1, @CustomerID);
        RETURN;
    END

    DECLARE @Now DATETIME2(3) = GETDATE();

    -- puvodni tierovani z roku 2013, prahy v Kc celkove utracene castky (TotalSpent)
    UPDATE dbo.Customer
    SET LoyaltyTier =
            CASE
                WHEN TotalSpent >= 150000 THEN 4
                WHEN TotalSpent >= 60000  THEN 3
                WHEN TotalSpent >= 25000  THEN 2
                WHEN TotalSpent >= 8000   THEN 1
                ELSE 0
            END,
        LoyaltyPoints = CAST(ISNULL(TotalSpent, 0) / 50 AS INT),  -- pozor, jiny pomer nez aktualni vypocet objednavky (ten pocita 1 bod / 100 Kc)
        ModifiedAt = @Now,
        ModifiedBy = @ModifiedBy
    WHERE (CustomerID = @CustomerID OR @CustomerID IS NULL)
      AND IsActive = 1;

    -- neaktivni zakaznici spadaji na tier 0 - historicke rozhodnuti obchodu, jinde nezdokumentovano
    UPDATE dbo.Customer
    SET LoyaltyTier = 0,
        ModifiedAt = @Now,
        ModifiedBy = @ModifiedBy
    WHERE (CustomerID = @CustomerID OR @CustomerID IS NULL)
      AND IsActive = 0
      AND LoyaltyTier <> 0;
END
GO
