-- Indexes, deliberately incomplete. Somebody added what was needed for a specific
-- slow page and nobody ever revisited it. In particular there is no covering index for
-- sp_SearchProducts' sort, and no index on OrderLedger.CustomerID.

USE ParityShop;
GO

CREATE UNIQUE INDEX UX_Catalog_Sku      ON dbo.Catalog (Sku);
CREATE INDEX        IX_Catalog_Category ON dbo.Catalog (CategoryID);
CREATE INDEX        IX_Catalog_Active   ON dbo.Catalog (IsActive, IsVisible);
GO

CREATE INDEX IX_OrderLedger_OrderNumber ON dbo.OrderLedger (OrderNumber);
CREATE INDEX IX_OrderLedger_OrderedAt   ON dbo.OrderLedger (OrderedAt);
GO

CREATE UNIQUE INDEX UX_Customer_Email   ON dbo.Customer (Email);
GO

CREATE INDEX IX_StockMovement_Product   ON dbo.StockMovement (ProductID);
CREATE UNIQUE INDEX UX_PromoCode_Code   ON dbo.PromoCode (Code);
GO
