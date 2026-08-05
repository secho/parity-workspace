-- Determinism fingerprint of the seeded estate. Hard rule 5: same seed, same numbers,
-- every run. `make seed-checksum` records this; `make verify-m0` asserts it still holds.
-- Read by both parity-platform-demo-app/seed/src/checksum.ts and scripts/verify-m0.ts,
-- so the two can never drift apart.
SET NOCOUNT ON;

SELECT
    CAST(CHECKSUM_AGG(CAST(PriceNet * 100 AS INT))   AS BIGINT) AS CatalogPrice,
    CAST(CHECKSUM_AGG(CAST(Popularity AS INT))       AS BIGINT) AS CatalogPopularity,
    CAST(CHECKSUM_AGG(CAST(StockQty AS INT))         AS BIGINT) AS CatalogStock,
    (SELECT CAST(CHECKSUM_AGG(CAST(TotalWithVat * 100 AS INT)) AS BIGINT) FROM dbo.OrderLedger) AS OrderTotals,
    (SELECT CAST(CHECKSUM_AGG(CAST(LineNet * 100 AS INT))      AS BIGINT) FROM dbo.OrderLedger) AS OrderLineNet,
    (SELECT CAST(CHECKSUM_AGG(CAST(Quantity AS INT))           AS BIGINT) FROM dbo.OrderLedger) AS OrderQty,
    (SELECT COUNT_BIG(*)                                                  FROM dbo.OrderLedger) AS OrderLineCount,
    (SELECT CAST(CHECKSUM_AGG(CAST(Score * 100 AS INT))        AS BIGINT) FROM dbo.CustomerScore) AS CustomerScores,
    (SELECT CAST(CHECKSUM_AGG(CAST(TotalSpent AS INT))         AS BIGINT) FROM dbo.Customer) AS CustomerSpend
FROM dbo.Catalog;
