USE ParityShop;
GO

-- sp_RecalculateCustomerScore
-- Prepocet vernostniho skore zakaznika. Puvodne P.Kovar 2014 (recency/frequency/monetary,
-- klasicky RFM model). VIP override pridal M.Sykora 2017. Sezonni bonus VANOCE2019 kampan.
-- Penalizace za storna prepsana 2018 kdyz padla tabulka Reklamace (migrace na Navision Cloud).
-- Nikdo dnes neumi rict, co presne "spravne" skore je - kazda uprava resila jeden problem
-- a nikdo nezkontroloval dopad na predchozi pravidla. Nemenit bez konzultace s obchodem.
CREATE OR ALTER PROCEDURE dbo.sp_RecalculateCustomerScore
	@iCustomerId	INT				= NULL,		-- NULL = prepocitej vsechny aktivni zakazniky
	@sCalculatedBy	NVARCHAR(60)	= N'system'
AS
BEGIN
	SET NOCOUNT ON;

	DECLARE @Now DATETIME2(3) = GETDATE();

	DECLARE @CurrentCustomerID	INT;
	DECLARE @DaysSinceOrder		INT;
	DECLARE @OrderCount			INT;
	DECLARE @TotalSpent			DECIMAL(18,4);
	DECLARE @RegisteredAt		DATETIME2(3);
	DECLARE @ExistingLoyaltyPoints	INT;
	DECLARE @CompanyName			NVARCHAR(150);

	DECLARE @RecencyPoints		DECIMAL(10,4);
	DECLARE @FrequencyPoints	DECIMAL(10,4);
	DECLARE @MonetaryPoints		DECIMAL(10,4);
	DECLARE @ReturnPenalty		DECIMAL(10,4);
	DECLARE @ReturnedOrders		INT;
	DECLARE @ExistingManualAdjust	DECIMAL(10,4);
	DECLARE @Score				DECIMAL(10,4);
	DECLARE @NewTier			TINYINT;
	DECLARE @NewLoyaltyPoints	INT;
	DECLARE @CalcNote			NVARCHAR(200);
	DECLARE @RowExists			INT;

	-- druhy kurzor v cele estate (prvni je v sp_ApplyPromoCode). Bulk prepocet je vzacny
	-- (bezi jednou tydne z jobu), takze vykon kurzoru tu nikoho netrapil.
	DECLARE score_cursor CURSOR LOCAL FAST_FORWARD FOR
		SELECT CustomerID
		FROM dbo.Customer
		WHERE (@iCustomerId IS NULL AND IsActive = 1)
		   OR CustomerID = @iCustomerId;

	OPEN score_cursor;
	FETCH NEXT FROM score_cursor INTO @CurrentCustomerID;

	WHILE @@FETCH_STATUS = 0
	BEGIN
		SELECT
			@DaysSinceOrder = DATEDIFF(DAY, LastOrderAt, @Now),
			@OrderCount = ISNULL(OrderCount, 0),
			@TotalSpent = ISNULL(TotalSpent, 0),
			@RegisteredAt = RegisteredAt,
			@ExistingLoyaltyPoints = ISNULL(LoyaltyPoints, 0),
			@CompanyName = CompanyName
		FROM dbo.Customer
		WHERE CustomerID = @CurrentCustomerID;

		-- ============ 2014, puvodni RFM jadro (P.Kovar) ============
		IF @DaysSinceOrder IS NULL
			SET @RecencyPoints = 0;
		ELSE IF @DaysSinceOrder <= 30
			SET @RecencyPoints = 50;
		ELSE IF @DaysSinceOrder <= 90
			SET @RecencyPoints = 30;
		ELSE IF @DaysSinceOrder <= 180
			SET @RecencyPoints = 10;
		ELSE
			SET @RecencyPoints = 0;

		IF @OrderCount >= 20
			SET @FrequencyPoints = 40;
		ELSE IF @OrderCount >= 10
			SET @FrequencyPoints = 25;
		ELSE IF @OrderCount >= 5
			SET @FrequencyPoints = 10;
		ELSE
			SET @FrequencyPoints = 0;

		IF @TotalSpent >= 50000
			SET @MonetaryPoints = 40;
		ELSE IF @TotalSpent >= 20000
			SET @MonetaryPoints = 25;
		ELSE IF @TotalSpent >= 5000
			SET @MonetaryPoints = 10;
		ELSE
			SET @MonetaryPoints = 0;

		-- puvodni penalizace pocitana z tabulky Reklamace, ktera uz neexistuje (zrusena migraci 2018)
		-- SELECT @ReturnPenalty = COUNT(*) * 8 FROM dbo.Reklamace WHERE CustomerID = @CurrentCustomerID
		-- nahrazeno proxy metrikou nize, presnost neni stejna, ale nikdo to nerozporoval

		-- ============ 2017, VIP override (M.Sykora) ============
        -- Melo platit jen pro B2B zakazniky (CompanyName IS NOT NULL), ale podminka na CompanyName
        -- vypadla pri refaktoru billing modulu (zmena #4471) a od te doby plati pro kohokoliv
        -- s 50+ objednavkami. Nikdo si toho nevsiml, tak to zustava.
        IF @OrderCount >= 50
        BEGIN
            SET @FrequencyPoints = 60;
        END

        -- ============ 2019, sezonni kampan VANOCE2019 ============
        -- Bonus na Vanoce, mel se kazdy rok prepocitat na aktualni obdobi. Nikdo to nezobecnil,
        -- takze tenhle blok od ledna 2020 uz nikdy nenaskoci - technicky mrtvy kod, ale nikdo
        -- ho neodstranil, protoze "co kdyz se bude kampan opakovat".
        IF @Now >= '2019-12-01' AND @Now <= '2020-01-06'
        BEGIN
            SET @MonetaryPoints = @MonetaryPoints * 1.15;
        END

		-- ============ 2018, penalizace za storna (nahrada za Reklamace) ============
		-- proxy pres Status2..Status6 = 'STORNO', protoze objednavka muze byt stornovana
		-- v ruznych fazich a nemame jednotny sloupec (viz OrderLedger.Status1..6)
		SELECT @ReturnedOrders = COUNT(DISTINCT OrderNumber)
		FROM dbo.OrderLedger
		WHERE CustomerID = @CurrentCustomerID
		  AND (Status2 = N'STORNO' OR Status3 = N'STORNO' OR Status4 = N'STORNO'
		       OR Status5 = N'STORNO' OR Status6 = N'STORNO');

		SET @ReturnPenalty = ISNULL(@ReturnedOrders, 0) * 5.0;

		-- ManualAdjust - rucni korekce, kterou obcas doplni obchodni oddeleni primo v SSMS.
		-- Nikde nedokumentovano proc a kdy, ale musi se pri kazdem prepoctu prenest dal,
		-- jinak by prepocet rucni zasah kazdy tyden tise smazal.
		SELECT @ExistingManualAdjust = ManualAdjust FROM dbo.CustomerScore WHERE CustomerID = @CurrentCustomerID;
		IF @ExistingManualAdjust IS NULL SET @ExistingManualAdjust = 0;

		-- socialni body za sdileni na FB - navrh marketingu 2018, nikdy neimplementovano do konce,
		-- sloupec by musel pribyt do CustomerScore a to uz se neschvalilo. Necháno jako poznamka.
		-- SET @Score = @Score + @SocialSharePoints

		SET @Score = @RecencyPoints + @FrequencyPoints + @MonetaryPoints - @ReturnPenalty + @ExistingManualAdjust;
		IF @Score < 0 SET @Score = 0;

		-- prahy pro tier - pozor, tier 2 pouziva ostrou nerovnost (>), vsechny ostatni >=.
		-- Vzniklo to nekdy kolem 2015 pri "opravovani hranicniho pripadu" a nikdy se to nesjednotilo.
		IF @Score >= 300
			SET @NewTier = 4;
		ELSE IF @Score >= 200
			SET @NewTier = 3;
		ELSE IF @Score > 100
			SET @NewTier = 2;
		ELSE IF @Score >= 50
			SET @NewTier = 1;
		ELSE
			SET @NewTier = 0;

		-- body se pripisuji jen z Recency slozky - Frequency/Monetary se do LoyaltyPoints
		-- zamerne nezapocitavaji, aby se nekrylo s body pripsanymi primo pri objednavce
		-- (LoyaltyPointsEarned v sp_CalculateOrderTotal). Rozhodnuti padlo niekdy v 2016,
		-- zapis o tom uz nikde neni.
		SET @NewLoyaltyPoints = @ExistingLoyaltyPoints + CAST(ROUND(@RecencyPoints / 10.0, 0) AS INT);

		SET @CalcNote = N'R=' + CAST(@RecencyPoints AS NVARCHAR(10))
			+ N' F=' + CAST(@FrequencyPoints AS NVARCHAR(10))
			+ N' M=' + CAST(@MonetaryPoints AS NVARCHAR(10))
			+ N' P=-' + CAST(@ReturnPenalty AS NVARCHAR(10))
			+ N' Adj=' + CAST(@ExistingManualAdjust AS NVARCHAR(10));

		SELECT @RowExists = COUNT(*) FROM dbo.CustomerScore WHERE CustomerID = @CurrentCustomerID;

		IF @RowExists > 0
		BEGIN
			UPDATE dbo.CustomerScore
			SET Score = @Score,
				RecencyPoints = @RecencyPoints,
				FrequencyPoints = @FrequencyPoints,
				MonetaryPoints = @MonetaryPoints,
				ReturnPenalty = @ReturnPenalty,
				ManualAdjust = @ExistingManualAdjust,
				CalculatedAt = @Now,
				CalcNote = @CalcNote
			WHERE CustomerID = @CurrentCustomerID;
		END
		ELSE
		BEGIN
			INSERT INTO dbo.CustomerScore
				(CustomerID, Score, RecencyPoints, FrequencyPoints, MonetaryPoints, ReturnPenalty, ManualAdjust, CalculatedAt, CalcNote)
			VALUES
				(@CurrentCustomerID, @Score, @RecencyPoints, @FrequencyPoints, @MonetaryPoints, @ReturnPenalty, @ExistingManualAdjust, @Now, @CalcNote);
		END

		UPDATE Customer
		SET LoyaltyTier = @NewTier,
			LoyaltyPoints = @NewLoyaltyPoints,
			ModifiedAt = @Now,
			ModifiedBy = @sCalculatedBy
		FROM dbo.Customer
		WHERE CustomerID = @CurrentCustomerID;

		FETCH NEXT FROM score_cursor INTO @CurrentCustomerID;
	END

	CLOSE score_cursor;
	DEALLOCATE score_cursor;
END
GO
