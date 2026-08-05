-- Ciselniky. Data jsou pevne, nemeni se generatorem.

USE ParityShop;
GO

INSERT INTO dbo.Category (CategoryID, Code, Name, ParentID, SortOrder, IsActive, VatRate) VALUES
    (1, 'components',  N'Komponenty',              NULL, 10, 1, 21.00),
    (2, 'peripherals', N'Periferie',               NULL, 20, 1, 21.00),
    (3, 'sbc',         N'Jednodeskové počítače',   NULL, 30, 1, 21.00),
    (4, 'retro',       N'Retro',                   NULL, 40, 1, 21.00),
    (5, 'merch',       N'Merch',                   NULL, 50, 1, 21.00),
    (6, 'networking',  N'Sítě',                    NULL, 60, 1, 21.00),
    (7, 'storage',     N'Úložiště',                NULL, 70, 1, 21.00),
    (8, 'power',       N'Napájení',                NULL, 80, 1, 21.00);
GO

INSERT INTO dbo.Warehouse (WarehouseID, Code, Name, City, CountryCode, DispatchEmail, IsActive) VALUES
    (1, 'PHA', N'Sklad Praha-Hostivař', N'Praha',   'CZ', 'sklad.praha@parityshop.cz',  1),
    (2, 'BRN', N'Sklad Brno-Slatina',   N'Brno',    'CZ', 'sklad.brno@parityshop.cz',   1),
    (3, 'BTS', N'Sklad Bratislava',     N'Bratislava', 'SK', 'sklad.ba@parityshop.sk',  1);
GO

INSERT INTO dbo.VatRate (CountryCode, RateCode, Rate, ValidFrom) VALUES
    ('CZ', 'standard',  21.00, '2024-01-01'),
    ('CZ', 'reduced',   15.00, '2024-01-01'),
    ('CZ', 'reduced2',  10.00, '2024-01-01'),
    ('SK', 'standard',  20.00, '2024-01-01'),
    ('SK', 'reduced',   10.00, '2024-01-01');
GO

-- Kampane se casto prekryvaji, marketing to tak chce. Ktery kod se pouzije kdyz plati
-- vic najednou nikde nestoji, resi se to az v procedure.
INSERT INTO dbo.PromoCode
    (Code, Description, DiscountPct, DiscountAmount, MinOrderValue, ValidFrom, ValidTo,
     MaxUses, UsedCount, MaxUsesPerCustomer, StacksWithLoyalty, CategoryID, CountryCode, IsActive)
VALUES
    (N'JARO10',     N'Jarní sleva 10 %',            10.00, NULL,    500.00, '2026-03-01', '2026-06-30', 5000, 0, 1, 0, NULL, NULL, 1),
    (N'LETO15',     N'Letní sleva 15 %',            15.00, NULL,   1000.00, '2026-06-01', '2026-09-30', 5000, 0, 1, 0, NULL, NULL, 1),
    (N'GEEK200',    N'200 Kč na cokoliv',            NULL, 200.00, 1500.00, '2026-01-01', '2026-12-31', 9999, 0, 2, 0, NULL, NULL, 1),
    (N'VERNY20',    N'Věrnostní 20 % pro tier 3+',  20.00, NULL,   2000.00, '2026-05-01', '2026-12-31', 2000, 0, 1, 1, NULL, NULL, 1),
    (N'RPI5',       N'Sleva na SBC',                12.00, NULL,    800.00, '2026-04-15', '2026-10-31', 1500, 0, 1, 1,    3, NULL, 1),
    (N'RETRO500',   N'500 Kč na retro',              NULL, 500.00, 3000.00, '2026-02-01', '2026-11-30',  600, 0, 1, 0,    4, NULL, 1),
    (N'SK10',       N'Sleva pro Slovensko',         10.00, NULL,    600.00, '2026-01-01', '2026-12-31', 3000, 0, 2, 1, NULL, 'SK', 1),
    (N'MERCHFREE',  N'Merch bez poštovného',         NULL,  99.00,  300.00, '2026-03-15', '2026-09-15', 4000, 0, 3, 0,    5, NULL, 1),
    (N'DOPRAVA0',   N'Doprava zdarma',               NULL,  89.00,  999.00, '2026-01-01', '2026-12-31', 9999, 0, 5, 0, NULL, NULL, 1),
    (N'VANOCE22',   N'Vánoční akce 2022',           25.00, NULL,   1000.00, '2022-11-15', '2022-12-31', 5000, 0, 1, 0, NULL, NULL, 0),
    (N'BLACKFRI',   N'Black Friday',                30.00, NULL,   2500.00, '2025-11-24', '2025-12-01', 8000, 0, 1, 0, NULL, NULL, 0),
    (N'TEST',       N'test kod, nemazat',            50.00, NULL,     0.00, '2019-01-01', '2030-01-01',   50, 0, 1, 1, NULL, NULL, 1);
GO
