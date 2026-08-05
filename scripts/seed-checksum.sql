-- Determinism fingerprint of the seeded estate. Hard rule 5: same seed, same numbers,
-- every run. `make seed-checksum` records this; `make verify-m0` asserts it still holds.
-- Read by both parity-platform-demo-app/seed/src/checksum.ts and scripts/verify-m0.ts,
-- so the two can never drift apart.
--
-- NOT CHECKSUM_AGG. That aggregate is XOR-based: repeated identical values cancel each
-- other pairwise, so a table of 16 000 rows sharing a value fingerprints to 0 and small
-- changes vanish entirely. Measured: updating three rows of OrderLedger.TotalWithVat left
-- CHECKSUM_AGG bit-identical while SUM moved. A summed per-row checksum has no such
-- blind spot.
SET NOCOUNT ON;

SELECT
    (SELECT SUM(CAST(ISNULL(CHECKSUM(PriceNet), 0) AS BIGINT))     FROM dbo.Catalog)       AS CatalogPrice,
    (SELECT SUM(CAST(ISNULL(CHECKSUM(Popularity), 0) AS BIGINT))   FROM dbo.Catalog)       AS CatalogPopularity,
    (SELECT SUM(CAST(ISNULL(CHECKSUM(StockQty), 0) AS BIGINT))     FROM dbo.Catalog)       AS CatalogStock,
    (SELECT SUM(CAST(ISNULL(CHECKSUM(Sku), 0) AS BIGINT))          FROM dbo.Catalog)       AS CatalogSku,
    (SELECT SUM(CAST(ISNULL(CHECKSUM(TotalWithVat), 0) AS BIGINT)) FROM dbo.OrderLedger)   AS OrderTotals,
    (SELECT SUM(CAST(ISNULL(CHECKSUM(LineNet), 0) AS BIGINT))      FROM dbo.OrderLedger)   AS OrderLineNet,
    (SELECT SUM(CAST(ISNULL(CHECKSUM(Quantity), 0) AS BIGINT))     FROM dbo.OrderLedger)   AS OrderQty,
    (SELECT COUNT_BIG(*)                                           FROM dbo.OrderLedger)   AS OrderLineCount,
    (SELECT SUM(CAST(ISNULL(CHECKSUM(Score), 0) AS BIGINT))        FROM dbo.CustomerScore) AS CustomerScores,
    (SELECT SUM(CAST(ISNULL(CHECKSUM(TotalSpent), 0) AS BIGINT))   FROM dbo.Customer)      AS CustomerSpend,
    (SELECT SUM(CAST(ISNULL(CHECKSUM(Email), 0) AS BIGINT))        FROM dbo.Customer)      AS CustomerEmail;
