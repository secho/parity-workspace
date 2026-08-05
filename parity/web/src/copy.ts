/** All user-facing copy in one file. Czech, engineering register — `review`, `shadow run`,
 *  `oracle`, `seam` stay English inside Czech grammar, because that is how it is said. */

export const cs = {
  brand: 'Parity',
  brandSub: 'estate → spec → oracle → shadow',

  nav: {
    estate: 'Estate',
    campaigns: 'Kampaně',
    queue: 'Fronta',
    ops: 'Provoz',
  },

  estate: {
    title: 'Estate',
    subtitle: (n: number) => `${n} procedur v ostrém provozu`,
    metrics: {
      procedures: 'procedur celkem',
      live: 'volaných za 90 dní',
      dead: 'bez jediného volání',
      invocations: 'volání za 90 dní',
      coverage: 'pokrytí oraclem',
      coverageNote: 'vážené počtem volání',
      byCount: (pct: string) => `prostým počtem procedur: ${pct}`,
    },
    statusTitle: 'Stav portfolia',
    blockersTitle: 'Co brání postupu',
    blockersHint: 'Tohle není report o roadmapě. Tohle je ta roadmapa.',
    tableTitle: 'Procedury',
    columns: {
      name: 'Procedura',
      lines: 'Řádků',
      invocations: 'Volání 90 d',
      lastInvoked: 'Naposled',
      oracleClass: 'Třída oracle',
      oracleState: 'Stav oracle',
      status: 'Kampaň',
      blocker: 'Blocker',
    },
    filtered: (label: string) => `filtr: ${label}`,
    clearFilter: 'zrušit filtr',
  },

  procedure: {
    back: '← zpět na estate',
    tabs: {
      source: 'Zdroj',
      data: 'Data',
      coupling: 'Vazby',
    },
    facts: {
      lines: 'řádků T-SQL',
      invocations: 'volání za 90 dní',
      lastInvoked: 'naposled volána',
      oracleClass: 'třída oracle',
      oracleState: 'stav oracle',
      blocker: 'blocker',
      risk: 'riziko',
      owner: 'vlastník',
      dynamicSql: 'dynamické SQL',
    },
    calls: 'Volá',
    calledBy: 'Je volána z',
    readsTitle: 'Čte',
    writesTitle: 'Zapisuje',
    couplingTitle: 'Sdílené sloupce',
    couplingHint:
      'Procedury, které zapisují do stejných sloupců. Žádná z nich nevolá tu druhou — ve zdrojáku to nikde nestojí. ' +
      'Nahoře jsou sloupce, do kterých zapisuje nejmíň procedur: sloupec se dvěma zapisovateli je kolize, se šesti je to audit.',
    column: 'Sloupec',
    alsoWrites: 'Také zapisuje',
    writers: 'Zapisovatelů',
    owner: 'vlastník sloupce',
    inferred: 'odvozeno',
    inferredHint:
      'Parser musel rozšířit: dynamické SQL nebo nejednoznačný název sloupce. Nelze dokázat, které větve se za běhu poskládají.',
    noCoupling: 'Žádné sdílené sloupce — tahle procedura si zapisuje sama pro sebe.',
    notFound: 'Procedura nenalezena.',
  },

  common: {
    loading: 'načítám…',
    error: 'chyba',
    none: '—',
    absent: 'Zatím není. Přijde v pozdějším milníku.',
  },

  oracleClass: {
    pure_read: 'pure_read',
    det_write: 'det_write',
    nondet: 'nondet',
    external: 'external',
    none: 'none',
  } as Record<string, string>,

  oracleState: {
    none: 'žádný',
    golden: 'golden testy',
    invariants: 'invarianty',
    shadow: 'shadow run',
    proven: 'ověřeno',
  } as Record<string, string>,
};

export function formatDate(value: string | null): string {
  if (value === null) return cs.common.none;
  return new Date(value).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' });
}

export function formatInt(value: number): string {
  return value.toLocaleString('cs-CZ');
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1).replace('.', ',')} %`;
}
