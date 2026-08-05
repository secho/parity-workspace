-- The two wide tables. This shape is the thing being demonstrated, not an accident.
--
-- Catalog is written by SIX procedures that mostly do not call each other.
-- OrderLedger is written by FIVE. The column overlap between unrelated procedures is
-- what makes M2's data-coupling graph a discovery rather than a decoration; if it were
-- faked the whole estate story collapses. Overlapping columns are marked [W:n] with the
-- number of distinct procedures that write them.

USE ParityShop;
GO

CREATE TABLE dbo.Catalog (
    ProductID            INT IDENTITY(1,1) NOT NULL,
    Sku                  NVARCHAR(40)   NOT NULL,
    Name                 NVARCHAR(200)  NOT NULL,
    ShortDescription     NVARCHAR(500)  NULL,
    LongDescription      NVARCHAR(MAX)  NULL,
    CategoryID           INT            NULL,
    CategoryPathCache    NVARCHAR(300)  NULL,   -- denormalised, nobody refreshes it
    SupplierID           INT            NULL,
    SupplierSku          NVARCHAR(60)   NULL,
    SupplierName         NVARCHAR(150)  NULL,   -- denormalised
    Manufacturer         NVARCHAR(120)  NULL,
    Ean                  NVARCHAR(20)   NULL,
    WarrantyMonths       INT            NULL,
    WeightGrams          INT            NULL,

    -- pricing
    PriceNet             DECIMAL(18,4)  NOT NULL,
    PriceWithVat         DECIMAL(18,4)  NULL,
    VatRate              DECIMAL(5,2)   NULL,
    PriceWithDiscount    DECIMAL(18,4)  NULL,   -- [W:2] sp_LegacyPriceImport_v2, sp_ApplyPromoCode
    DiscountPct          DECIMAL(5,2)   NULL,   -- [W:2] sp_LegacyPriceImport_v2, sp_ApplyPromoCode
    DiscountValidFrom    DATETIME2(3)   NULL,
    DiscountValidTo      DATETIME2(3)   NULL,
    PurchasePrice        DECIMAL(18,4)  NULL,
    RecommendedPrice     DECIMAL(18,4)  NULL,
    Currency             NVARCHAR(3)    NULL,
    LastQuotedPrice      DECIMAL(18,4)  NULL,   -- [W:2] sp_CalculateOrderTotal, sp_LegacyPriceImport_v2
    LastQuotedAt         DATETIME2(3)   NULL,   -- [W:2] sp_CalculateOrderTotal, sp_LegacyPriceImport_v2
    PriceImportBatch     NVARCHAR(40)   NULL,

    -- stock
    StockQty             INT            NULL,   -- [W:3] sp_ReserveStock, sp_PlaceOrder, sp_SyncWarehouseDispatch
    ReservedQty          INT            NULL,   -- [W:2] sp_ReserveStock, sp_PlaceOrder
    StockQtyWh1          INT            NULL,
    StockQtyWh2          INT            NULL,
    StockQtyWh3          INT            NULL,
    ReorderLevel         INT            NULL,
    LastStockSyncAt      DATETIME2(3)   NULL,   -- [W:2] sp_SyncWarehouseDispatch, sp_ReserveStock
    StockStatusCode      TINYINT        NULL,

    -- flags
    IsActive             BIT            NULL,
    IsVisible            BIT            NULL,
    IsFeatured           BIT            NULL,
    IsClearance          BIT            NULL,
    AllowBackorder       BIT            NULL,

    -- merchandising. Popularity has huge tie groups on purpose: sp_SearchProducts sorts
    -- by it with no unique tiebreaker, so paged replays legitimately differ.
    Popularity           INT            NULL,
    RatingAvg            DECIMAL(3,2)   NULL,
    RatingCount          INT            NULL,
    SoldCount            INT            NULL,
    ViewCount            INT            NULL,

    -- seo
    SeoTitle             NVARCHAR(200)  NULL,
    SeoDescription       NVARCHAR(400)  NULL,
    SeoSlug              NVARCHAR(200)  NULL,
    SeoKeywords          NVARCHAR(400)  NULL,
    ImageUrl             NVARCHAR(300)  NULL,
    ImageCount           INT            NULL,

    -- audit
    CreatedAt            DATETIME2(3)   NULL,
    CreatedBy            NVARCHAR(60)   NULL,
    ModifiedAt           DATETIME2(3)   NULL,   -- [W:6] every procedure that writes Catalog
    ModifiedBy           NVARCHAR(60)   NULL,   -- [W:6] every procedure that writes Catalog
    RowVersionTag        NVARCHAR(40)   NULL,

    -- migrace z Navision 2013, sloupce uz nikdo necte. Smazat az po vyrazeni starych reportu.
    LegacyProductCode    NVARCHAR(30)   NULL,
    LegacyCategoryCode   NVARCHAR(30)   NULL,
    LegacyFlagA          BIT            NULL,
    LegacyImportNote     NVARCHAR(200)  NULL,

    CONSTRAINT PK_Catalog PRIMARY KEY CLUSTERED (ProductID)
);
GO

CREATE TABLE dbo.OrderLedger (
    -- One row per order LINE. Order-level columns are repeated on every line, which is
    -- why sp_CalculateOrderTotal has to update N rows to cache one total.
    OrderLineID                 BIGINT IDENTITY(1,1) NOT NULL,
    OrderID                     INT            NOT NULL,
    OrderNumber                 NVARCHAR(20)   NOT NULL,
    LineNumber                  INT            NOT NULL,

    -- customer snapshot, frozen at order time
    CustomerID                  INT            NULL,
    CustomerEmailSnapshot       NVARCHAR(200)  NULL,  -- [W:2] sp_PlaceOrder, sp_MigrateCustomerAddresses
    CustomerNameSnapshot        NVARCHAR(200)  NULL,  -- [W:2] sp_PlaceOrder, sp_MigrateCustomerAddresses
    CustomerPhoneSnapshot       NVARCHAR(40)   NULL,  -- [W:2] sp_PlaceOrder, sp_MigrateCustomerAddresses
    CustomerLoyaltyTierSnapshot TINYINT        NULL,
    CustomerCountryCode         NVARCHAR(2)    NULL,  -- CZ / SK, drives the VAT branch

    BillStreet                  NVARCHAR(200)  NULL,  -- [W:2] sp_PlaceOrder, sp_MigrateCustomerAddresses
    BillCity                    NVARCHAR(100)  NULL,  -- [W:2]
    BillZip                     NVARCHAR(10)   NULL,  -- [W:2]
    BillCountry                 NVARCHAR(2)    NULL,
    ShipStreet                  NVARCHAR(200)  NULL,  -- [W:2] sp_PlaceOrder, sp_MigrateCustomerAddresses
    ShipCity                    NVARCHAR(100)  NULL,  -- [W:2]
    ShipZip                     NVARCHAR(10)   NULL,  -- [W:2]
    ShipCountry                 NVARCHAR(2)    NULL,
    ShipCompany                 NVARCHAR(150)  NULL,

    -- line
    ProductID                   INT            NULL,
    Sku                         NVARCHAR(40)   NULL,
    ProductNameSnapshot         NVARCHAR(200)  NULL,
    Quantity                    INT            NULL,
    UnitPriceNet                DECIMAL(18,4)  NULL,
    UnitPriceWithVat            DECIMAL(18,4)  NULL,
    LineVatRate                 DECIMAL(5,2)   NULL,
    LineDiscountPct             DECIMAL(5,2)   NULL,
    LineNet                     DECIMAL(18,4)  NULL,
    LineVat                     DECIMAL(18,4)  NULL,
    LineTotal                   DECIMAL(18,4)  NULL,

    -- order totals, cached onto every line
    TotalNet                    DECIMAL(18,4)  NULL,  -- [W:2] sp_CalculateOrderTotal, sp_PlaceOrder
    TotalVat                    DECIMAL(18,4)  NULL,  -- [W:2]
    TotalWithVat                DECIMAL(18,4)  NULL,  -- [W:2]
    ShippingCost                DECIMAL(18,4)  NULL,  -- [W:2]
    ShippingMethod              NVARCHAR(40)   NULL,
    ShippingVatRate             DECIMAL(5,2)   NULL,
    DiscountAmount              DECIMAL(18,4)  NULL,  -- [W:2] sp_ApplyPromoCode, sp_CalculateOrderTotal
    PromoCodeUsed               NVARCHAR(40)   NULL,  -- [W:2] sp_ApplyPromoCode, sp_CalculateOrderTotal
    PromoDiscountAmount         DECIMAL(18,4)  NULL,  -- [W:2]
    LoyaltyDiscountAmount       DECIMAL(18,4)  NULL,
    LoyaltyPointsEarned         INT            NULL,
    LoyaltyPointsSpent          INT            NULL,
    CalcCachedAt                DATETIME2(3)   NULL,  -- [W:2] sp_CalculateOrderTotal, sp_PlaceOrder
    CalcVersion                 NVARCHAR(20)   NULL,

    -- payment
    PaymentMethod               NVARCHAR(40)   NULL,
    PaymentStatus               NVARCHAR(30)   NULL,
    PaymentRef                  NVARCHAR(60)   NULL,
    PaidAt                      DATETIME2(3)   NULL,

    -- status history flattened. Kdyz dojdou sloupce, prida se Status7. Zatim staci 6.
    Status1                     NVARCHAR(30)   NULL,  -- [W:3] sp_PlaceOrder, sp_ReserveStock, sp_SyncWarehouseDispatch
    Status2                     NVARCHAR(30)   NULL,  -- [W:3]
    Status3                     NVARCHAR(30)   NULL,  -- [W:3]
    Status4                     NVARCHAR(30)   NULL,  -- [W:3]
    Status5                     NVARCHAR(30)   NULL,  -- [W:3]
    Status6                     NVARCHAR(30)   NULL,  -- [W:3]
    Status1At                   DATETIME2(3)   NULL,
    Status2At                   DATETIME2(3)   NULL,
    Status3At                   DATETIME2(3)   NULL,
    Status4At                   DATETIME2(3)   NULL,
    Status5At                   DATETIME2(3)   NULL,
    Status6At                   DATETIME2(3)   NULL,

    -- fulfilment
    WarehouseID                 INT            NULL,
    ReservationID               INT            NULL,
    DispatchRef                 NVARCHAR(60)   NULL,
    DispatchedAt                DATETIME2(3)   NULL,
    TrackingNumber              NVARCHAR(60)   NULL,

    -- audit
    OrderedAt                   DATETIME2(3)   NULL,
    CreatedAt                   DATETIME2(3)   NULL,
    CreatedBy                   NVARCHAR(60)   NULL,
    ModifiedAt                  DATETIME2(3)   NULL,
    ModifiedBy                  NVARCHAR(60)   NULL,
    Note                        NVARCHAR(500)  NULL,
    LegacyOrderRef              NVARCHAR(30)   NULL,

    CONSTRAINT PK_OrderLedger PRIMARY KEY CLUSTERED (OrderLineID)
);
GO
