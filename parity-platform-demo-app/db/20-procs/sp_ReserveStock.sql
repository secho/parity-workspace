USE ParityShop;
GO

-- sp_ReserveStock
-- Rezervace skladu pro objednavku, rozdeleni mezi sklady v prioritnim poradi 1 (Praha),
-- 2 (Brno), 3 (Bratislava). Puvodne J.Bartos 2016, backorder branch dopsan 2021.
CREATE OR ALTER PROCEDURE dbo.sp_ReserveStock
  @orderNo NVARCHAR(20),
  @modifiedBy NVARCHAR(60) = N'system',
  @reservationMinutes INT = 30
AS
BEGIN
  SET NOCOUNT ON;

  DECLARE @now DATETIME2(3) = GETDATE();
  DECLARE @orderExists INT = 0;
  DECLARE @reservationID INT;
  DECLARE @lastReservationID INT = NULL;
  DECLARE @statusText NVARCHAR(30) = N'REZERVOVANO';
  DECLARE @slot INT = 0;

  SELECT @orderExists = COUNT(*) FROM dbo.OrderLedger WHERE OrderNumber = @orderNo;
  IF @orderExists = 0
  BEGIN
    GOTO ErrorExit;
  END

  -- najdi prvni volny status slot (max 6, kdyz dojdou, prida se Status7 - viz schema)
  SELECT TOP 1
    @slot = CASE
      WHEN Status1 IS NULL THEN 1
      WHEN Status2 IS NULL THEN 2
      WHEN Status3 IS NULL THEN 3
      WHEN Status4 IS NULL THEN 4
      WHEN Status5 IS NULL THEN 5
      WHEN Status6 IS NULL THEN 6
      ELSE 0
    END
  FROM dbo.OrderLedger
  WHERE OrderNumber = @orderNo;

  CREATE TABLE #ReserveLines (
    RowId INT IDENTITY(1,1) PRIMARY KEY,
    ProductID INT,
    Quantity INT,
    Processed BIT NOT NULL DEFAULT 0
  );

  INSERT INTO #ReserveLines (ProductID, Quantity)
  SELECT ProductID, Quantity
  FROM dbo.OrderLedger
  WHERE OrderNumber = @orderNo AND ProductID IS NOT NULL;

  DECLARE @curRowId INT, @curProductID INT, @curQty INT;
  DECLARE @stockQty INT, @reservedQty INT, @wh1 INT, @wh2 INT, @wh3 INT, @allowBackorder BIT;
  DECLARE @qtyRemaining INT, @allocWh1 INT, @allocWh2 INT, @allocWh3 INT, @totalAlloc INT;

  WHILE EXISTS (SELECT 1 FROM #ReserveLines WHERE Processed = 0)
  BEGIN
    SELECT TOP 1 @curRowId = RowId, @curProductID = ProductID, @curQty = Quantity
    FROM #ReserveLines WHERE Processed = 0 ORDER BY RowId;

    SET @allocWh1 = 0; SET @allocWh2 = 0; SET @allocWh3 = 0; SET @totalAlloc = 0;
    SET @qtyRemaining = @curQty;

    SELECT
      @stockQty = StockQty, @reservedQty = ReservedQty,
      @wh1 = ISNULL(StockQtyWh1, 0), @wh2 = ISNULL(StockQtyWh2, 0), @wh3 = ISNULL(StockQtyWh3, 0),
      @allowBackorder = ISNULL(AllowBackorder, 0)
    FROM dbo.Catalog WHERE ProductID = @curProductID;

    -- puvodni verze pred rozsirenim na 3 sklady (do 2018), ponechano pro referenci
    -- UPDATE dbo.Catalog SET StockQty = StockQty - @curQty, ReservedQty = ReservedQty + @curQty
    -- WHERE ProductID = @curProductID

    -- prioritni sklad 1 (Praha) - ctyri urovne zanoreni, historicky rostlo postupne
    IF @qtyRemaining > 0
    BEGIN
      IF @wh1 > 0
      BEGIN
        IF @wh1 >= @qtyRemaining
        BEGIN
          IF @allowBackorder = 1 OR @wh1 > 0
          BEGIN
            SET @allocWh1 = @qtyRemaining;
          END
        END
        ELSE
        BEGIN
          SET @allocWh1 = @wh1;
        END
        SET @qtyRemaining = @qtyRemaining - @allocWh1;
        SET @totalAlloc = @totalAlloc + @allocWh1;
      END
    END

    -- sklad 2 (Brno)
    IF @qtyRemaining > 0 AND @wh2 > 0
    BEGIN
      IF @wh2 >= @qtyRemaining
        SET @allocWh2 = @qtyRemaining;
      ELSE
        SET @allocWh2 = @wh2;

      SET @qtyRemaining = @qtyRemaining - @allocWh2;
      SET @totalAlloc = @totalAlloc + @allocWh2;
    END

    -- sklad 3 (Bratislava)
    IF @qtyRemaining > 0 AND @wh3 > 0
    BEGIN
      IF @wh3 >= @qtyRemaining
        SET @allocWh3 = @qtyRemaining;
      ELSE
        SET @allocWh3 = @wh3;

      SET @qtyRemaining = @qtyRemaining - @allocWh3;
      SET @totalAlloc = @totalAlloc + @allocWh3;
    END

    -- backorder - pokud jeste neco zbyva a produkt to povoluje, jde do zaporu na sklad 1
    IF @qtyRemaining > 0
    BEGIN
      IF @allowBackorder = 1
      BEGIN
        SET @allocWh1 = @allocWh1 + @qtyRemaining;
        SET @totalAlloc = @totalAlloc + @qtyRemaining;
        SET @qtyRemaining = 0;
      END
    END

    IF @allocWh1 > 0
    BEGIN
      INSERT INTO dbo.StockReservation (OrderNumber, ProductID, WarehouseID, Quantity, Status, CreatedAt, ExpiresAt)
      VALUES (@orderNo, @curProductID, 1, @allocWh1, N'RESERVED', @now, DATEADD(MINUTE, @reservationMinutes, @now));
      SET @reservationID = SCOPE_IDENTITY();
      SET @lastReservationID = @reservationID;

      INSERT INTO dbo.StockMovement (ProductID, WarehouseID, MovementType, Quantity, QtyBefore, QtyAfter, OrderNumber, Note, CreatedAt, CreatedBy)
      VALUES (@curProductID, 1, N'RESERVE', @allocWh1, @wh1, @wh1 - @allocWh1, @orderNo, N'auto reserve', @now, @modifiedBy);
    END

    IF @allocWh2 > 0
    BEGIN
      INSERT INTO dbo.StockReservation (OrderNumber, ProductID, WarehouseID, Quantity, Status, CreatedAt, ExpiresAt)
      VALUES (@orderNo, @curProductID, 2, @allocWh2, N'RESERVED', @now, DATEADD(MINUTE, @reservationMinutes, @now));
      SET @lastReservationID = SCOPE_IDENTITY();

      INSERT INTO dbo.StockMovement (ProductID, WarehouseID, MovementType, Quantity, QtyBefore, QtyAfter, OrderNumber, Note, CreatedAt, CreatedBy)
      VALUES (@curProductID, 2, N'RESERVE', @allocWh2, @wh2, @wh2 - @allocWh2, @orderNo, N'auto reserve', @now, @modifiedBy);
    END

    IF @allocWh3 > 0
    BEGIN
      INSERT INTO dbo.StockReservation (OrderNumber, ProductID, WarehouseID, Quantity, Status, CreatedAt, ExpiresAt)
      VALUES (@orderNo, @curProductID, 3, @allocWh3, N'RESERVED', @now, DATEADD(MINUTE, @reservationMinutes, @now));
      SET @lastReservationID = SCOPE_IDENTITY();

      INSERT INTO dbo.StockMovement (ProductID, WarehouseID, MovementType, Quantity, QtyBefore, QtyAfter, OrderNumber, Note, CreatedAt, CreatedBy)
      VALUES (@curProductID, 3, N'RESERVE', @allocWh3, @wh3, @wh3 - @allocWh3, @orderNo, N'auto reserve', @now, @modifiedBy);
    END

    UPDATE dbo.Catalog
    SET StockQty = StockQty - @totalAlloc,
        ReservedQty = ISNULL(ReservedQty, 0) + @totalAlloc,
        LastStockSyncAt = @now,
        ModifiedAt = @now,
        ModifiedBy = @modifiedBy
    WHERE ProductID = @curProductID;

    INSERT INTO dbo.AuditTrail (TableName, RecordID, Action, ProcName, Detail, CreatedAt, CreatedBy)
    VALUES (N'Catalog', CAST(@curProductID AS NVARCHAR(40)), N'RESERVE', N'sp_ReserveStock',
            N'objednavka ' + @orderNo + N', mnozstvi ' + CAST(@totalAlloc AS NVARCHAR(10)), @now, @modifiedBy);

    UPDATE #ReserveLines SET Processed = 1 WHERE RowId = @curRowId;
  END

  -- ulozit ReservationID a status na vsechny radky objednavky (posledni vytvorena rezervace vyhrava)
  -- POZNAMKA: pri rozdeleni pres vice skladu se sem uklada jen posledni ReservationID,
  -- ostatni jsou dohledatelne pres StockReservation.OrderNumber - docasne reseni, opravit pozdeji (2016)
  IF @slot = 1
    UPDATE dbo.OrderLedger SET ReservationID = @lastReservationID, Status1 = @statusText, Status1At = @now, ModifiedAt = @now, ModifiedBy = @modifiedBy WHERE OrderNumber = @orderNo;
  ELSE IF @slot = 2
    UPDATE dbo.OrderLedger SET ReservationID = @lastReservationID, Status2 = @statusText, Status2At = @now, ModifiedAt = @now, ModifiedBy = @modifiedBy WHERE OrderNumber = @orderNo;
  ELSE IF @slot = 3
    UPDATE dbo.OrderLedger SET ReservationID = @lastReservationID, Status3 = @statusText, Status3At = @now, ModifiedAt = @now, ModifiedBy = @modifiedBy WHERE OrderNumber = @orderNo;
  ELSE IF @slot = 4
    UPDATE dbo.OrderLedger SET ReservationID = @lastReservationID, Status4 = @statusText, Status4At = @now, ModifiedAt = @now, ModifiedBy = @modifiedBy WHERE OrderNumber = @orderNo;
  ELSE IF @slot = 5
    UPDATE dbo.OrderLedger SET ReservationID = @lastReservationID, Status5 = @statusText, Status5At = @now, ModifiedAt = @now, ModifiedBy = @modifiedBy WHERE OrderNumber = @orderNo;
  ELSE IF @slot = 6
    UPDATE dbo.OrderLedger SET ReservationID = @lastReservationID, Status6 = @statusText, Status6At = @now, ModifiedAt = @now, ModifiedBy = @modifiedBy WHERE OrderNumber = @orderNo;
  ELSE
  BEGIN
    -- vsech 6 statusovych slotu obsazeno, tohle se historicky nemelo stat
    UPDATE dbo.OrderLedger SET ReservationID = @lastReservationID, ModifiedAt = @now, ModifiedBy = @modifiedBy WHERE OrderNumber = @orderNo;
  END

  DROP TABLE #ReserveLines;
  RETURN;

  ErrorExit:
  RAISERROR(N'sp_ReserveStock: objednavka %s neexistuje', 16, 1, @orderNo);
  RETURN;
END
GO
