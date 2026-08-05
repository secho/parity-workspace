-- Satellites. Narrower than the two core tables, but Customer and CustomerScore still
-- carry write overlap: sp_RecalculateCustomerScore and the deprecated
-- sp_RecomputeLoyaltyTier both write Customer.LoyaltyTier.

USE ParityShop;
GO

CREATE TABLE dbo.Category (
    CategoryID     INT           NOT NULL,
    Code           NVARCHAR(30)  NOT NULL,
    Name           NVARCHAR(120) NOT NULL,
    ParentID       INT           NULL,
    SortOrder      INT           NULL,
    IsActive       BIT           NULL,
    VatRate        DECIMAL(5,2)  NULL,
    CONSTRAINT PK_Category PRIMARY KEY (CategoryID)
);
GO

CREATE TABLE dbo.Warehouse (
    WarehouseID    INT           NOT NULL,
    Code           NVARCHAR(10)  NOT NULL,
    Name           NVARCHAR(120) NOT NULL,
    City           NVARCHAR(100) NULL,
    CountryCode    NVARCHAR(2)   NULL,
    DispatchEmail  NVARCHAR(200) NULL,   -- sp_SyncWarehouseDispatch mails this address
    IsActive       BIT           NULL,
    CONSTRAINT PK_Warehouse PRIMARY KEY (WarehouseID)
);
GO

CREATE TABLE dbo.Customer (
    CustomerID       INT IDENTITY(1,1) NOT NULL,
    Email            NVARCHAR(200) NOT NULL,
    FirstName        NVARCHAR(100) NULL,
    LastName         NVARCHAR(100) NULL,
    Phone            NVARCHAR(40)  NULL,
    Street           NVARCHAR(200) NULL,
    City             NVARCHAR(100) NULL,
    Zip              NVARCHAR(10)  NULL,
    CountryCode      NVARCHAR(2)   NULL,   -- CZ / SK
    CompanyName      NVARCHAR(150) NULL,
    VatId            NVARCHAR(20)  NULL,
    LoyaltyTier      TINYINT       NULL,   -- [W:2] sp_RecalculateCustomerScore, sp_RecomputeLoyaltyTier_deprecated
    LoyaltyPoints    INT           NULL,   -- [W:2]
    TotalSpent       DECIMAL(18,4) NULL,
    OrderCount       INT           NULL,
    RegisteredAt     DATETIME2(3)  NULL,
    LastOrderAt      DATETIME2(3)  NULL,
    IsActive         BIT           NULL,
    ModifiedAt       DATETIME2(3)  NULL,
    ModifiedBy       NVARCHAR(60)  NULL,
    -- puvodni adresni sloupce, migrace nedobehla (2014)
    OldAddressLine   NVARCHAR(300) NULL,
    CONSTRAINT PK_Customer PRIMARY KEY CLUSTERED (CustomerID)
);
GO

CREATE TABLE dbo.CustomerScore (
    CustomerID       INT           NOT NULL,
    Score            DECIMAL(10,4) NULL,
    RecencyPoints    DECIMAL(10,4) NULL,
    FrequencyPoints  DECIMAL(10,4) NULL,
    MonetaryPoints   DECIMAL(10,4) NULL,
    ReturnPenalty    DECIMAL(10,4) NULL,
    ManualAdjust     DECIMAL(10,4) NULL,
    CalculatedAt     DATETIME2(3)  NULL,
    CalcNote         NVARCHAR(200) NULL,
    CONSTRAINT PK_CustomerScore PRIMARY KEY (CustomerID)
);
GO

CREATE TABLE dbo.StockMovement (
    MovementID     BIGINT IDENTITY(1,1) NOT NULL,
    ProductID      INT           NOT NULL,
    WarehouseID    INT           NULL,
    MovementType   NVARCHAR(20)  NULL,   -- IN / OUT / RESERVE / RELEASE / CORRECTION
    Quantity       INT           NULL,
    QtyBefore      INT           NULL,
    QtyAfter       INT           NULL,
    OrderNumber    NVARCHAR(20)  NULL,
    Note           NVARCHAR(200) NULL,
    CreatedAt      DATETIME2(3)  NULL,
    CreatedBy      NVARCHAR(60)  NULL,
    CONSTRAINT PK_StockMovement PRIMARY KEY CLUSTERED (MovementID)
);
GO

CREATE TABLE dbo.PromoCode (
    PromoCodeID       INT IDENTITY(1,1) NOT NULL,
    Code              NVARCHAR(40)  NOT NULL,
    Description       NVARCHAR(200) NULL,
    DiscountPct       DECIMAL(5,2)  NULL,
    DiscountAmount    DECIMAL(18,4) NULL,
    MinOrderValue     DECIMAL(18,4) NULL,
    ValidFrom         DATETIME2(3)  NULL,
    ValidTo           DATETIME2(3)  NULL,
    MaxUses           INT           NULL,
    UsedCount         INT           NULL,
    MaxUsesPerCustomer INT          NULL,
    StacksWithLoyalty BIT           NULL,   -- the branch that carries the planted defect
    CategoryID        INT           NULL,
    CountryCode       NVARCHAR(2)   NULL,
    IsActive          BIT           NULL,
    CONSTRAINT PK_PromoCode PRIMARY KEY CLUSTERED (PromoCodeID)
);
GO

CREATE TABLE dbo.PromoRedemption (
    RedemptionID   BIGINT IDENTITY(1,1) NOT NULL,
    PromoCodeID    INT           NULL,
    Code           NVARCHAR(40)  NULL,
    CustomerID     INT           NULL,
    OrderNumber    NVARCHAR(20)  NULL,
    Amount         DECIMAL(18,4) NULL,
    RedeemedAt     DATETIME2(3)  NULL,
    CONSTRAINT PK_PromoRedemption PRIMARY KEY CLUSTERED (RedemptionID)
);
GO

CREATE TABLE dbo.AuditTrail (
    AuditID        BIGINT IDENTITY(1,1) NOT NULL,
    TableName      NVARCHAR(60)  NULL,
    RecordID       NVARCHAR(40)  NULL,
    Action         NVARCHAR(30)  NULL,
    ProcName       NVARCHAR(120) NULL,
    Detail         NVARCHAR(500) NULL,
    CreatedAt      DATETIME2(3)  NULL,
    CreatedBy      NVARCHAR(60)  NULL,
    CONSTRAINT PK_AuditTrail PRIMARY KEY CLUSTERED (AuditID)
);
GO

CREATE TABLE dbo.StockReservation (
    ReservationID  INT IDENTITY(1,1) NOT NULL,
    OrderNumber    NVARCHAR(20)  NULL,
    ProductID      INT           NULL,
    WarehouseID    INT           NULL,
    Quantity       INT           NULL,
    Status         NVARCHAR(20)  NULL,
    CreatedAt      DATETIME2(3)  NULL,
    ExpiresAt      DATETIME2(3)  NULL,
    CONSTRAINT PK_StockReservation PRIMARY KEY CLUSTERED (ReservationID)
);
GO

CREATE TABLE dbo.VatRate (
    CountryCode    NVARCHAR(2)   NOT NULL,
    RateCode       NVARCHAR(20)  NOT NULL,
    Rate           DECIMAL(5,2)  NOT NULL,
    ValidFrom      DATETIME2(3)  NULL,
    CONSTRAINT PK_VatRate PRIMARY KEY (CountryCode, RateCode)
);
GO
