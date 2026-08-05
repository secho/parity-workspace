-- Hlavni tabulky eshopu. Catalog vznikl 2011, OrderLedger 2012, od te doby se jen
-- pridavaly sloupce. Nekolikrat se resilo rozdeleni na vic tabulek, nikdy se to
-- nedotahlo -- viz zapis z porady 3/2017.

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
    PriceWithDiscount    DECIMAL(18,4)  NULL,
    DiscountPct          DECIMAL(5,2)   NULL,
    DiscountValidFrom    DATETIME2(3)   NULL,
    DiscountValidTo      DATETIME2(3)   NULL,
    PurchasePrice        DECIMAL(18,4)  NULL,
    RecommendedPrice     DECIMAL(18,4)  NULL,
    Currency             NVARCHAR(3)    NULL,
    LastQuotedPrice      DECIMAL(18,4)  NULL,
    LastQuotedAt         DATETIME2(3)   NULL,
    PriceImportBatch     NVARCHAR(40)   NULL,

    -- stock
    StockQty             INT            NULL,
    ReservedQty          INT            NULL,
    StockQtyWh1          INT            NULL,
    StockQtyWh2          INT            NULL,
    StockQtyWh3          INT            NULL,
    ReorderLevel         INT            NULL,
    LastStockSyncAt      DATETIME2(3)   NULL,
    StockStatusCode      TINYINT        NULL,

    -- flags
    IsActive             BIT            NULL,
    IsVisible            BIT            NULL,
    IsFeatured           BIT            NULL,
    IsClearance          BIT            NULL,
    AllowBackorder       BIT            NULL,

    -- merchandising
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
    ModifiedAt           DATETIME2(3)   NULL,
    ModifiedBy           NVARCHAR(60)   NULL,
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
    -- jeden radek = jedna polozka objednavky, hlavickove sloupce se opakuji na kazdem radku
    OrderLineID                 BIGINT IDENTITY(1,1) NOT NULL,
    OrderID                     INT            NOT NULL,
    OrderNumber                 NVARCHAR(20)   NOT NULL,
    LineNumber                  INT            NOT NULL,

    -- customer snapshot, frozen at order time
    CustomerID                  INT            NULL,
    CustomerEmailSnapshot       NVARCHAR(200)  NULL,
    CustomerNameSnapshot        NVARCHAR(200)  NULL,
    CustomerPhoneSnapshot       NVARCHAR(40)   NULL,
    CustomerLoyaltyTierSnapshot TINYINT        NULL,
    CustomerCountryCode         NVARCHAR(2)    NULL,  -- CZ / SK

    BillStreet                  NVARCHAR(200)  NULL,
    BillCity                    NVARCHAR(100)  NULL,
    BillZip                     NVARCHAR(10)   NULL,
    BillCountry                 NVARCHAR(2)    NULL,
    ShipStreet                  NVARCHAR(200)  NULL,
    ShipCity                    NVARCHAR(100)  NULL,
    ShipZip                     NVARCHAR(10)   NULL,
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
    TotalNet                    DECIMAL(18,4)  NULL,
    TotalVat                    DECIMAL(18,4)  NULL,
    TotalWithVat                DECIMAL(18,4)  NULL,
    ShippingCost                DECIMAL(18,4)  NULL,
    ShippingMethod              NVARCHAR(40)   NULL,
    ShippingVatRate             DECIMAL(5,2)   NULL,
    DiscountAmount              DECIMAL(18,4)  NULL,
    PromoCodeUsed               NVARCHAR(40)   NULL,
    PromoDiscountAmount         DECIMAL(18,4)  NULL,
    LoyaltyDiscountAmount       DECIMAL(18,4)  NULL,
    LoyaltyPointsEarned         INT            NULL,
    LoyaltyPointsSpent          INT            NULL,
    CalcCachedAt                DATETIME2(3)   NULL,
    CalcVersion                 NVARCHAR(20)   NULL,

    -- payment
    PaymentMethod               NVARCHAR(40)   NULL,
    PaymentStatus               NVARCHAR(30)   NULL,
    PaymentRef                  NVARCHAR(60)   NULL,
    PaidAt                      DATETIME2(3)   NULL,

    -- status history flattened. Kdyz dojdou sloupce, prida se Status7. Zatim staci 6.
    Status1                     NVARCHAR(30)   NULL,
    Status2                     NVARCHAR(30)   NULL,
    Status3                     NVARCHAR(30)   NULL,
    Status4                     NVARCHAR(30)   NULL,
    Status5                     NVARCHAR(30)   NULL,
    Status6                     NVARCHAR(30)   NULL,
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
