USE ParityShop;
GO

-- sp_LegacyPriceImport_v2
-- Ctvrtletni import cen od dodavatele (format "SKU:cena;SKU:cena;..."), pousti se
-- rucne z konzole obchodniho, ne z cronu. Puvodni sp_LegacyPriceImport cetla primo
-- XML z dodavatelskeho FTP - zrusena pri prechodu na novy format v roce 2019, volani
-- zustalo jen v jednom starem skriptu na sdilene ploche, viz komentar nize.
-- R.Prochazka 2015, prepis na oddelovac misto XML M.Sykora 2019 (proto "_v2").
CREATE OR ALTER PROCEDURE dbo.sp_LegacyPriceImport_v2
	@PriceData	NVARCHAR(MAX)	= NULL,
	@BatchID	NVARCHAR(40)	= NULL,
	@ModifiedBy	NVARCHAR(60)	= N'system'
AS
BEGIN
	SET NOCOUNT ON;

	DECLARE @Now DATETIME2(3) = GETDATE();
	DECLARE @Vat DECIMAL(5,2) = 21.00;	-- dodavatel dodava jen do CZ skladu, SK sazba se sem nikdy nedostala

	IF @BatchID IS NULL
		SET @BatchID = N'IMP-' + CONVERT(NVARCHAR(8), @Now, 112);

	IF @PriceData IS NULL OR LEN(@PriceData) = 0
	BEGIN
		-- bez dat jen prerazitkuj posledni davku novym cislem (pouziva se pri opravnem behu importu)
		UPDATE dbo.Catalog
		SET PriceImportBatch = @BatchID, ModifiedAt = @Now, ModifiedBy = @ModifiedBy
		WHERE PriceImportBatch = (SELECT TOP 1 PriceImportBatch FROM dbo.Catalog WHERE PriceImportBatch IS NOT NULL ORDER BY ModifiedAt DESC);
		RETURN;
	END

	-- COLLATE DATABASE_DEFAULT: tempdb jede na server collation, ParityShop na Czech_CI_AS,
	-- takze join na Catalog.Sku bez tohohle spadne na collation conflict. (2015)
	CREATE TABLE #Import (Sku NVARCHAR(40) COLLATE DATABASE_DEFAULT, NewPrice DECIMAL(18,4));

	DECLARE @rest NVARCHAR(MAX) = @PriceData + N';';
	DECLARE @pair NVARCHAR(200);
	DECLARE @sep INT;
	DECLARE @colon INT;

	-- rozparsuj "SKU:cena;SKU:cena;..." - stary format, tehdy se nikomu nechtelo resit JSON
	WHILE LEN(@rest) > 0
	BEGIN
		SET @sep = CHARINDEX(N';', @rest);
		IF @sep = 0 BREAK;

		SET @pair = LTRIM(RTRIM(SUBSTRING(@rest, 1, @sep - 1)));
		SET @rest = SUBSTRING(@rest, @sep + 1, LEN(@rest));

		IF LEN(@pair) > 0
		BEGIN
			SET @colon = CHARINDEX(N':', @pair);
			IF @colon > 0
				INSERT INTO #Import (Sku, NewPrice)
				VALUES (LTRIM(RTRIM(SUBSTRING(@pair, 1, @colon - 1))), TRY_CAST(SUBSTRING(@pair, @colon + 1, LEN(@pair)) AS DECIMAL(18,4)));
		END
	END

	DELETE FROM #Import WHERE NewPrice IS NULL OR NewPrice <= 0;

	-- EXEC dbo.sp_LegacyPriceImport @PriceXml = @PriceData, @ModifiedBy = @ModifiedBy   -- puvodni v1, nemazat, jeste je odkud kopirovat XSD

	UPDATE c
	SET
		c.PriceNet		= i.NewPrice,
		c.PriceWithVat		= ROUND(i.NewPrice * (1 + @Vat / 100.0), 2),
		c.PriceWithDiscount	= ROUND(i.NewPrice * (1 + @Vat / 100.0) * (1 - ISNULL(c.DiscountPct, 0) / 100.0), 2),
		c.DiscountPct		= ISNULL(c.DiscountPct, 0),
		c.LastQuotedPrice	= i.NewPrice,
		c.LastQuotedAt		= @Now,
		c.PriceImportBatch	= @BatchID,
		c.ModifiedAt		= @Now,
		c.ModifiedBy		= @ModifiedBy
	FROM dbo.Catalog c
	INNER JOIN #Import i ON i.Sku = c.Sku;

	IF @@ROWCOUNT = 0
		RAISERROR(N'import davky %s nenasel v katalogu zadne odpovidajici SKU', 10, 1, @BatchID);

	DROP TABLE #Import;
END
GO
