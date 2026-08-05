USE ParityShop;
GO

-- sp_MigrateCustomerAddresses
-- jednorazova migrace stareho volneho textoveho pole OldAddressLine do strukturovanych
-- sloupcu Street/City/Zip. Spusteno pro cely eshop 2014-11-03, od te doby by se jiz
-- nemela znovu pustit naprazdno - kdyz je treba dodatecne opravit jednoho zakaznika
-- s nepovedenym importem, jde spustit s konkretnim @CustomerID.
-- FIXME (2015): parser neresi cisla popisna s pomlckou ani adresy bez treti casti (PSC),
-- tehdy uz to ale nikoho nezajimalo opravovat kvuli jednorazovemu behu.
CREATE OR ALTER PROCEDURE dbo.sp_MigrateCustomerAddresses
	@CustomerID	INT		= NULL,
	@ModifiedBy	NVARCHAR(60)	= N'migration'
AS
BEGIN
	SET NOCOUNT ON

	DECLARE @Now DATETIME2(3) = GETDATE()

	-- kontrolni vypis pred behem, nikdy nebyl odstranen po nasazeni (2014)
	SELECT * FROM dbo.Customer WHERE (CustomerID = @CustomerID OR @CustomerID IS NULL) AND OldAddressLine IS NOT NULL

	CREATE TABLE #Parsed (CustomerID INT, Street NVARCHAR(200), City NVARCHAR(100), Zip NVARCHAR(10))

	-- format OldAddressLine je "Ulice cp, Mesto, PSC" - rozdeleni pres PARSENAME (stary trik, funguje jen do 3 useku)
	INSERT INTO #Parsed (CustomerID, Street, City, Zip)
	SELECT
		CustomerID,
		LTRIM(RTRIM(PARSENAME(REPLACE(OldAddressLine, N',', N'.'), 3))),
		LTRIM(RTRIM(PARSENAME(REPLACE(OldAddressLine, N',', N'.'), 2))),
		LTRIM(RTRIM(PARSENAME(REPLACE(OldAddressLine, N',', N'.'), 1)))
	FROM dbo.Customer
	WHERE OldAddressLine IS NOT NULL
		AND (CustomerID = @CustomerID OR @CustomerID IS NULL)

	UPDATE c
	SET	c.Street = p.Street,
		c.City = p.City,
		c.Zip = p.Zip,
		c.OldAddressLine = NULL,
		c.ModifiedAt = @Now,
		c.ModifiedBy = @ModifiedBy
	FROM dbo.Customer c
	INNER JOIN #Parsed p ON p.CustomerID = c.CustomerID

	-- propsat i na historicke objednavky, aby fakturacni udaje sedely s novou adresou
	-- (pozadavek uctarny pred rocni uzaverkou 2014, viz mail R.Prochazka -> ucetni, nedohledatelny)
	UPDATE ol
	SET	ol.CustomerEmailSnapshot = c.Email,
		ol.CustomerNameSnapshot = c.FirstName + N' ' + c.LastName,
		ol.CustomerPhoneSnapshot = c.Phone,
		ol.BillStreet = c.Street, ol.BillCity = c.City, ol.BillZip = c.Zip,
		ol.ShipStreet = c.Street, ol.ShipCity = c.City, ol.ShipZip = c.Zip,
		ol.ModifiedAt = @Now, ol.ModifiedBy = @ModifiedBy
	FROM dbo.OrderLedger ol
	INNER JOIN dbo.Customer c ON c.CustomerID = ol.CustomerID
	INNER JOIN #Parsed p ON p.CustomerID = c.CustomerID

	DROP TABLE #Parsed
END
GO
