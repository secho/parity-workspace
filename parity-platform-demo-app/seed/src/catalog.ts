import { stream } from './rng.js';
import { daysBefore } from './epoch.js';

export interface Product {
  productId: number;
  sku: string;
  name: string;
  shortDescription: string;
  categoryId: number;
  supplierId: number;
  supplierSku: string;
  supplierName: string;
  manufacturer: string;
  ean: string;
  warrantyMonths: number;
  weightGrams: number;
  priceNet: number;
  priceWithVat: number;
  vatRate: number;
  purchasePrice: number;
  recommendedPrice: number;
  stockQty: number;
  stockQtyWh1: number;
  stockQtyWh2: number;
  stockQtyWh3: number;
  reorderLevel: number;
  popularity: number;
  ratingAvg: number;
  ratingCount: number;
  soldCount: number;
  viewCount: number;
  isActive: boolean;
  isVisible: boolean;
  isFeatured: boolean;
  isClearance: boolean;
  allowBackorder: boolean;
  seoSlug: string;
  createdAt: Date;
}

interface CategorySpec {
  categoryId: number;
  count: number;
  manufacturers: readonly string[];
  models: readonly string[];
  variants: readonly string[];
  priceRange: readonly [number, number];
  weightRange: readonly [number, number];
  warranty: number;
}

const CATEGORIES: readonly CategorySpec[] = [
  {
    categoryId: 1,
    count: 60,
    manufacturers: ['AMD', 'Intel', 'ASUS', 'MSI', 'Gigabyte', 'Kingston', 'Corsair', 'be quiet!'],
    models: ['Ryzen 7', 'Ryzen 5', 'Core i5', 'Core i7', 'B650 TUF', 'Z790 PRO', 'Fury Beast', 'Vengeance', 'Radeon RX 7600', 'GeForce RTX 4060'],
    variants: ['16GB', '32GB', 'DDR5-6000', 'WIFI', 'OC Edition', '8-Core', 'Rev. 2.0', ''],
    priceRange: [890, 24990],
    weightRange: [40, 2400],
    warranty: 24,
  },
  {
    categoryId: 2,
    count: 50,
    manufacturers: ['Logitech', 'Keychron', 'Ducky', 'Razer', 'SteelSeries', 'Genius', 'Trust'],
    models: ['MX Master 3S', 'K8 Pro', 'One 3', 'DeathAdder V3', 'Arctis Nova', 'G502 HERO', 'Apex Pro'],
    variants: ['CZ layout', 'Brown switch', 'Red switch', 'Wireless', 'TKL', 'RGB', ''],
    priceRange: [290, 7490],
    weightRange: [60, 1500],
    warranty: 24,
  },
  {
    categoryId: 3,
    count: 40,
    manufacturers: ['Raspberry Pi', 'Arduino', 'Espressif', 'Orange Pi', 'BeagleBoard', 'Radxa'],
    models: ['Pi 5', 'Pi 4 Model B', 'Pi Zero 2 W', 'Uno R4', 'Mega 2560', 'ESP32-S3', 'Zero 3', 'Rock 5B'],
    variants: ['2GB', '4GB', '8GB', '16GB', 'WiFi', 'startovací sada', ''],
    priceRange: [190, 4290],
    weightRange: [10, 400],
    warranty: 24,
  },
  {
    categoryId: 4,
    count: 30,
    manufacturers: ['Commodore', 'Sinclair', 'Atari', 'Nintendo', 'TheC64', 'Analogue'],
    models: ['C64 Mini', 'ZX Spectrum Next', 'Atari 2600+', 'NES Classic', 'Amiga 500 case', 'Pocket'],
    variants: ['repro', 'bazar A', 'bazar B', 'nová edice', 'sběratelská', ''],
    priceRange: [390, 12900],
    weightRange: [200, 3500],
    warranty: 12,
  },
  {
    categoryId: 5,
    count: 35,
    manufacturers: ['ParityShop', 'GeekWear', 'Devmerch'],
    models: ['Tričko', 'Mikina', 'Hrnek', 'Samolepky', 'Ponožky', 'Čepice', 'Podložka'],
    variants: ['S', 'M', 'L', 'XL', 'XXL', 'sada 10 ks', 'černá', 'bílá'],
    priceRange: [99, 1290],
    weightRange: [20, 700],
    warranty: 24,
  },
  {
    categoryId: 6,
    count: 30,
    manufacturers: ['MikroTik', 'Ubiquiti', 'TP-Link', 'Zyxel', 'Netgear'],
    models: ['hAP ax3', 'CRS310', 'UniFi 6 Lite', 'Archer AX55', 'GS308', 'RB5009'],
    variants: ['8-port', '16-port', 'PoE', 'outdoor', 'rack 1U', ''],
    priceRange: [490, 14900],
    weightRange: [150, 4000],
    warranty: 24,
  },
  {
    categoryId: 7,
    count: 35,
    manufacturers: ['Samsung', 'WD', 'Seagate', 'Crucial', 'Synology', 'Kingston'],
    models: ['990 PRO', 'Red Plus', 'IronWolf', 'MX500', 'DS224+', 'NV2', 'Blue SN580'],
    variants: ['500GB', '1TB', '2TB', '4TB', '8TB', 'M.2 NVMe', '2.5"'],
    priceRange: [690, 18900],
    weightRange: [8, 900],
    warranty: 36,
  },
  {
    categoryId: 8,
    count: 20,
    manufacturers: ['be quiet!', 'Seasonic', 'Corsair', 'APC', 'Eaton', 'Anker'],
    models: ['Pure Power 12', 'Focus GX', 'RM750x', 'Back-UPS 650', 'Ellipse ECO', 'PowerPort III'],
    variants: ['550W', '650W', '750W', '850W', '65W GaN', '100W', ''],
    priceRange: [390, 9900],
    weightRange: [90, 6000],
    warranty: 60,
  },
];

const SUPPLIERS = [
  { id: 1, name: 'AT Computers a.s.' },
  { id: 2, name: 'eD system a.s.' },
  { id: 3, name: 'SWS a.s.' },
  { id: 4, name: 'Techdata CZ' },
  { id: 5, name: 'Přímý dovoz' },
] as const;

function slugify(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function buildCatalog(): Product[] {
  const r = stream('catalog');
  const products: Product[] = [];
  let id = 0;

  for (const cat of CATEGORIES) {
    for (let i = 0; i < cat.count; i++) {
      id++;
      const manufacturer = r.pick(cat.manufacturers);
      const model = r.pick(cat.models);
      const variant = r.pick(cat.variants);
      const name = [manufacturer, model, variant].filter(Boolean).join(' ');

      const priceNet = r.float(cat.priceRange[0], cat.priceRange[1], 2);
      const vatRate = 21;
      const supplier = r.pick(SUPPLIERS);

      // Popularity deliberately takes only 11 distinct values across 300 products, so
      // sp_SearchProducts' ORDER BY Popularity DESC has tie groups of ~27 rows and no
      // tiebreaker. Paged replays then legitimately differ — that is the noise the
      // classifier has to learn to dismiss.
      const popularity = r.int(0, 10) * 10;

      const wh1 = r.int(0, 40);
      const wh2 = r.int(0, 25);
      const wh3 = r.int(0, 15);

      products.push({
        productId: id,
        sku: `PS-${String(cat.categoryId)}${String(id).padStart(4, '0')}`,
        name,
        shortDescription: `${name} — skladem v ParityShopu.`,
        categoryId: cat.categoryId,
        supplierId: supplier.id,
        supplierSku: `${supplier.id}-${r.int(100000, 999999)}`,
        supplierName: supplier.name,
        manufacturer,
        ean: `859${String(r.int(1000000000, 9999999999)).slice(0, 10)}`,
        warrantyMonths: cat.warranty,
        weightGrams: r.int(cat.weightRange[0], cat.weightRange[1]),
        priceNet,
        priceWithVat: Math.round(priceNet * (1 + vatRate / 100) * 100) / 100,
        vatRate,
        purchasePrice: Math.round(priceNet * r.float(0.55, 0.82, 4) * 100) / 100,
        recommendedPrice: Math.round(priceNet * r.float(1.02, 1.25, 4) * 100) / 100,
        stockQty: wh1 + wh2 + wh3,
        stockQtyWh1: wh1,
        stockQtyWh2: wh2,
        stockQtyWh3: wh3,
        reorderLevel: r.int(2, 12),
        popularity,
        ratingAvg: r.float(3.1, 5.0, 2),
        ratingCount: r.int(0, 420),
        soldCount: r.int(0, 900),
        viewCount: r.int(10, 26000),
        isActive: true,
        isVisible: r.chance(0.96),
        isFeatured: r.chance(0.08),
        isClearance: r.chance(0.06),
        allowBackorder: r.chance(0.25),
        seoSlug: `${slugify(name)}-${id}`,
        createdAt: daysBefore(r.int(30, 1500)),
      });
    }
  }

  return products;
}
