import { stream } from './rng.js';
import { daysBefore } from './epoch.js';

export interface Customer {
  customerId: number;
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  /** Null for accounts the 2014 address migration never reached — see oldAddressLine. */
  street: string | null;
  city: string | null;
  zip: string | null;
  countryCode: 'CZ' | 'SK';
  companyName: string | null;
  vatId: string | null;
  loyaltyTier: number;
  loyaltyPoints: number;
  registeredAt: Date;
  /**
   * Free-text address left over from the pre-2014 schema. Only older accounts have it.
   * sp_MigrateCustomerAddresses exists to fold this into the structured columns; it ran
   * once, incompletely, and was never deleted. Without these rows that dead procedure
   * would have nothing to write, and the deletion campaign would have nothing to weigh.
   */
  oldAddressLine: string | null;
}

const FIRST_M = ['Jan', 'Petr', 'Martin', 'Tomáš', 'Jakub', 'Lukáš', 'Ondřej', 'David', 'Michal', 'Filip', 'Vojtěch', 'Adam', 'Marek', 'Radek', 'Štěpán'];
const FIRST_F = ['Jana', 'Petra', 'Lucie', 'Tereza', 'Eva', 'Kateřina', 'Marie', 'Veronika', 'Hana', 'Alena', 'Barbora', 'Klára', 'Michaela', 'Zuzana'];
const LAST_M = ['Novák', 'Svoboda', 'Novotný', 'Dvořák', 'Černý', 'Procházka', 'Kučera', 'Veselý', 'Horák', 'Němec', 'Marek', 'Pospíšil', 'Pokorný', 'Hájek', 'Král', 'Beneš', 'Fiala', 'Sedláček'];
const LAST_F = ['Nováková', 'Svobodová', 'Novotná', 'Dvořáková', 'Černá', 'Procházková', 'Kučerová', 'Veselá', 'Horáková', 'Němcová', 'Marková', 'Pospíšilová', 'Pokorná', 'Hájková', 'Králová'];

const CZ_CITIES = [
  ['Praha', '11000'], ['Brno', '60200'], ['Ostrava', '70200'], ['Plzeň', '30100'],
  ['Liberec', '46001'], ['Olomouc', '77900'], ['České Budějovice', '37001'],
  ['Hradec Králové', '50002'], ['Ústí nad Labem', '40001'], ['Pardubice', '53002'],
  ['Zlín', '76001'], ['Havířov', '73601'], ['Kladno', '27201'], ['Most', '43401'],
] as const;

const SK_CITIES = [
  ['Bratislava', '81101'], ['Košice', '04001'], ['Prešov', '08001'],
  ['Žilina', '01001'], ['Nitra', '94901'], ['Banská Bystrica', '97401'],
] as const;

const STREETS = [
  'Náměstí Míru', 'Dlouhá', 'Krátká', 'Zahradní', 'Nádražní', 'Školní', 'Polní',
  'Lipová', 'Havlíčkova', 'Masarykova', 'Purkyňova', 'Bezručova', 'Palackého',
  'Sokolská', 'Tyršova', 'Komenského', 'U Parku', 'Na Vyhlídce',
];

const COMPANIES = ['s.r.o.', 'a.s.', 'spol. s r.o.'];

function deaccent(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z]/g, '').toLowerCase();
}

export function buildCustomers(count = 500): Customer[] {
  const r = stream('customers');
  const customers: Customer[] = [];

  for (let id = 1; id <= count; id++) {
    // ~5% Slovak: these are the orders that hit the SK VAT branch in
    // sp_CalculateOrderTotal, and the reason that branch is genuinely rare.
    const isSlovak = r.chance(0.05);
    const female = r.chance(0.42);
    const firstName = female ? r.pick(FIRST_F) : r.pick(FIRST_M);
    const lastName = female ? r.pick(LAST_F) : r.pick(LAST_M);
    const [city, zip] = isSlovak ? r.pick(SK_CITIES) : r.pick(CZ_CITIES);
    const isCompany = r.chance(0.12);
    const street = `${r.pick(STREETS)} ${r.int(1, 240)}`;
    // A long tail of accounts the 2014 address migration never reached: their structured
    // address columns are still empty and the whole address sits in free text.
    // sp_MigrateCustomerAddresses exists to fix exactly these — it is dead, but the work
    // it would do is not, which is what makes deleting it a judgement rather than a chore.
    const unmigrated = r.chance(0.08);

    customers.push({
      oldAddressLine: unmigrated ? `${street}, ${city}, ${zip}` : null,
      customerId: id,
      email: `${deaccent(firstName)}.${deaccent(lastName)}${id}@${r.pick(['seznam.cz', 'gmail.com', 'email.cz', 'centrum.cz', 'volny.cz'])}`,
      firstName,
      lastName,
      phone: `+${isSlovak ? '421' : '420'} ${r.int(600, 799)} ${r.int(100, 999)} ${r.int(100, 999)}`,
      street: unmigrated ? null : street,
      city: unmigrated ? null : city,
      zip: unmigrated ? null : zip,
      countryCode: isSlovak ? 'SK' : 'CZ',
      companyName: isCompany ? `${lastName} ${r.pick(COMPANIES)}` : null,
      vatId: isCompany ? `${isSlovak ? 'SK' : 'CZ'}${r.int(10000000, 99999999)}` : null,
      // Tier is recomputed by sp_RecalculateCustomerScore; this is the starting state.
      loyaltyTier: r.zipf(5),
      loyaltyPoints: r.int(0, 4800),
      registeredAt: daysBefore(r.int(40, 1800)),
    });
  }

  return customers;
}
