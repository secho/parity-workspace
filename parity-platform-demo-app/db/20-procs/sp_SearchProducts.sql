USE ParityShop;
GO

-- sp_SearchProducts
-- Fulltext-ish hledani + filtrovani + strankovani katalogu pro eshop.
-- Postaveno na dynamickem SQL (sp_executesql), protoze v roce 2013 to byl bezny zpusob
-- jak skladat volitelne filtry bez deseti vetvenych verzi te same query.
-- Autor: M.Dvorak 2013, filtr na kategorii pridan 2015, cenove rozmezi 2017.
CREATE OR ALTER PROCEDURE dbo.sp_SearchProducts
  @searchText     NVARCHAR(200) = NULL,
  @categoryId     INT           = NULL,
  @minPrice       DECIMAL(18,4) = NULL,
  @maxPrice       DECIMAL(18,4) = NULL,
  @inStockOnly    BIT           = 0,
  @sortMode       NVARCHAR(20)  = N'popularity',   -- popularity | price_asc | price_desc | newest | rating | name
  @pageNumber     INT           = 1,
  @pageSize       INT           = 20,
  @legacyChannel  NVARCHAR(20)  = NULL   -- nepouzito, puvodne pro rozliseni web/mobilni feed (2015), FE uz to neposila
AS
BEGIN
  SET NOCOUNT ON;

  IF @pageNumber IS NULL OR @pageNumber < 1
    SET @pageNumber = 1;

  IF @pageSize IS NULL OR @pageSize < 1
    SET @pageSize = 20;

  IF @pageSize > 100
    SET @pageSize = 100;   -- strop kvuli ochrane pred nekym kdo posle page-size=100000

  DECLARE @offset INT = (@pageNumber - 1) * @pageSize;
  DECLARE @searchPattern NVARCHAR(200) = NULL;

  IF @searchText IS NOT NULL AND LEN(LTRIM(RTRIM(@searchText))) > 0
    SET @searchPattern = N'%' + LTRIM(RTRIM(@searchText)) + N'%';

  DECLARE @where NVARCHAR(MAX);
  SET @where = N' WHERE c.IsActive = 1 AND c.IsVisible = 1 ';

  IF @searchPattern IS NOT NULL
    SET @where = @where + N' AND (c.Name LIKE @pSearch OR c.ShortDescription LIKE @pSearch OR c.Sku LIKE @pSearch) ';

  IF @categoryId IS NOT NULL
    SET @where = @where + N' AND c.CategoryID = @pCategoryId ';

  IF @minPrice IS NOT NULL
    SET @where = @where + N' AND c.PriceWithVat >= @pMinPrice ';

  IF @maxPrice IS NOT NULL
    SET @where = @where + N' AND c.PriceWithVat <= @pMaxPrice ';

  IF @inStockOnly = 1
    SET @where = @where + N' AND ISNULL(c.StockQty, 0) > 0 ';

  -- razeni - historicky nikdy nedostalo sekundarni klic, u popularity je to znat nejvic
  -- (Popularity ma jen malo distinct hodnot), ale opravovat to nikdo nechtel, mohlo by to
  -- zmenit poradi na existujicich strankach a marketing si stezoval na "skakajici" vysledky
  DECLARE @orderBy NVARCHAR(100);

  IF @sortMode = N'price_asc'
    SET @orderBy = N' ORDER BY c.PriceWithVat ASC';
  ELSE IF @sortMode = N'price_desc'
    SET @orderBy = N' ORDER BY c.PriceWithVat DESC';
  ELSE IF @sortMode = N'newest'
    SET @orderBy = N' ORDER BY c.CreatedAt DESC';
  ELSE IF @sortMode = N'rating'
    SET @orderBy = N' ORDER BY c.RatingAvg DESC';
  ELSE IF @sortMode = N'name'
    SET @orderBy = N' ORDER BY c.Name ASC';
  ELSE
    SET @orderBy = N' ORDER BY c.Popularity DESC';

  -- IF @sortMode = N'bestseller'
  --   SET @orderBy = N' ORDER BY c.SoldCount DESC'
  -- rezim "bestseller" byl v UI do 2019, pak ho marketing zrusil, kod tu zustal pro pripad navratu

  DECLARE @sql NVARCHAR(MAX);

  SET @sql = N'
SELECT
    c.ProductID, c.Sku, c.Name, c.ShortDescription, c.CategoryID, c.CategoryPathCache,
    c.Manufacturer, c.PriceNet, c.PriceWithVat, c.VatRate, c.PriceWithDiscount, c.DiscountPct,
    c.StockQty, c.StockStatusCode, c.IsFeatured, c.IsClearance,
    c.Popularity, c.RatingAvg, c.RatingCount, c.ImageUrl, c.SeoSlug
FROM dbo.Catalog c'
    + @where
    + @orderBy
    + N' OFFSET @pOffset ROWS FETCH NEXT @pFetch ROWS ONLY;';

  EXEC sp_executesql
    @sql,
    N'@pSearch NVARCHAR(200), @pCategoryId INT, @pMinPrice DECIMAL(18,4), @pMaxPrice DECIMAL(18,4), @pOffset INT, @pFetch INT',
    @pSearch = @searchPattern,
    @pCategoryId = @categoryId,
    @pMinPrice = @minPrice,
    @pMaxPrice = @maxPrice,
    @pOffset = @offset,
    @pFetch = @pageSize;

  -- druhy dotaz jen pro celkovy pocet vysledku, kvuli strankovani na FE (pocet stranek)
  DECLARE @countSql NVARCHAR(MAX);
  SET @countSql = N'SELECT COUNT(*) AS TotalMatches FROM dbo.Catalog c' + @where + N';';

  EXEC sp_executesql
    @countSql,
    N'@pSearch NVARCHAR(200), @pCategoryId INT, @pMinPrice DECIMAL(18,4), @pMaxPrice DECIMAL(18,4)',
    @pSearch = @searchPattern,
    @pCategoryId = @categoryId,
    @pMinPrice = @minPrice,
    @pMaxPrice = @maxPrice;

END
GO
