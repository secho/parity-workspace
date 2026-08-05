USE ParityShop;
GO

-- sp_GetProductAvailability
-- Dostupnost produktu po skladech pro kartu produktu a fulltext vyhledavani.
-- Nejvytizenejsi procedura v cele databazi - zamerne bez kontroly existence produktu,
-- to uz si hlida frontend (T.Novak, 2014).
CREATE OR ALTER PROCEDURE dbo.sp_GetProductAvailability
	@ProductId INT
AS
BEGIN
	SET NOCOUNT ON;

	DECLARE @AllowBackorder BIT;
	DECLARE @ReservedQty INT;

	SELECT
		@AllowBackorder = ISNULL(AllowBackorder, 0),
		@ReservedQty = ISNULL(ReservedQty, 0)
	FROM dbo.Catalog
	WHERE ProductID = @ProductId;

	-- puvodni verze pred rozdelenim skladu (do 2014), ponechano pro referenci
	-- SELECT ProductID, StockQty AS TotalStock, AllowBackorder FROM dbo.Catalog WHERE ProductID = @ProductId

	-- POZNAMKA: ReservedQty je soucet za cely produkt, nedeli se po skladech (rezervace
	-- po skladech existuje az od 2018, viz sp_ReserveStock) - stejne cislo je proto na
	-- vsech trech radcich nize, coz je nepresne, ale tak to bezi roky.
	SELECT
		1                       AS WarehouseID,
		N'PHA'                  AS WarehouseCode,
		N'Praha-Hostivar'       AS WarehouseName,
		ISNULL(StockQtyWh1, 0)  AS StockQty,
		@ReservedQty            AS ReservedQty,
		@AllowBackorder         AS AllowBackorder,
		CASE WHEN ISNULL(StockQtyWh1, 0) > 0 THEN 1 WHEN @AllowBackorder = 1 THEN 10 ELSE NULL END AS EstimatedDeliveryDays,
		CASE WHEN ISNULL(StockQtyWh1, 0) > 0 THEN 1 WHEN @AllowBackorder = 1 THEN 1 ELSE 0 END AS IsAvailable
	FROM dbo.Catalog
	WHERE ProductID = @ProductId

	UNION ALL

	SELECT
		2                       AS WarehouseID,
		N'BRN'                  AS WarehouseCode,
		N'Brno-Slatina'         AS WarehouseName,
		ISNULL(StockQtyWh2, 0)  AS StockQty,
		@ReservedQty            AS ReservedQty,
		@AllowBackorder         AS AllowBackorder,
		CASE WHEN ISNULL(StockQtyWh2, 0) > 0 THEN 2 WHEN @AllowBackorder = 1 THEN 12 ELSE NULL END AS EstimatedDeliveryDays,
		CASE WHEN ISNULL(StockQtyWh2, 0) > 0 THEN 1 WHEN @AllowBackorder = 1 THEN 1 ELSE 0 END AS IsAvailable
	FROM dbo.Catalog
	WHERE ProductID = @ProductId

	UNION ALL

	-- sklad 3 je Bratislava (SK) - historicky pricitame 2 dny navic kvuli hranici,
	-- pozustatek z doby pred vstupem do celni unie, nikdo to od te doby neupravil (2014)
	SELECT
		3                       AS WarehouseID,
		N'BTS'                  AS WarehouseCode,
		N'Bratislava'           AS WarehouseName,
		ISNULL(StockQtyWh3, 0)  AS StockQty,
		@ReservedQty            AS ReservedQty,
		@AllowBackorder         AS AllowBackorder,
		CASE WHEN ISNULL(StockQtyWh3, 0) > 0 THEN 3 WHEN @AllowBackorder = 1 THEN 16 ELSE NULL END AS EstimatedDeliveryDays,
		CASE WHEN ISNULL(StockQtyWh3, 0) > 0 THEN 1 WHEN @AllowBackorder = 1 THEN 1 ELSE 0 END AS IsAvailable
	FROM Catalog
	WHERE ProductID = @ProductId

	ORDER BY WarehouseID;
END
GO
