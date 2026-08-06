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
    shadowTab: 'Shadow runy',
    decisionsTab: 'Rozhodnutí',
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

  runtime: {
    directTooltip: 'Přímo na Anthropic API. Nastavením PARITY_LLM_BASE_URL se provoz přesměruje na gateway.',
    noRunYet: 'zatím žádný běh',
    notConfigured: 'chybí API klíč',
    // Vždycky viditelné, obojí. Puštět beat naživo v replay módu (nebo naopak) je nejpravděpodobnější
    // způsob, jak si demo rozbít — a dokud se ukazoval jenom replay, nešlo to poznat dřív než podle
    // toho, že běh trval podezřele přesně stejně jako minule.
    modeLive: 'live',
    modeReplay: 'replay',
    modeReplayTooltip: 'Běhy se přehrávají z nahrávky. Nic se nevolá na modelu a nic se neplatí.',
    modeLiveTooltip: 'Ostrý provoz — každý běh jde na model a stojí peníze.',
  },

  ops: {
    title: 'Provoz',
    skillsTitle: 'Skill registry',
    skillsHint:
      'Skutečné soubory na disku, které agent načítá. Úprava jednoho souboru se projeví v dalším běhu — bez rebuildu, bez deploye.',
    skillColumns: { name: 'Skill', description: 'Co dělá', model: 'Model', from: 'Od' },
    policyTitle: 'Policy — tiery autonomie',
    policyHint:
      'Tuhle tabulku čte PreToolUse hook a odmítne volání nad rámec tieru pro danou třídu úloh. Pravidla vynucuje platforma, ne prompt.',
    policyColumns: { taskClass: 'Třída úlohy', tool: 'Nástroj', tier: 'Tier', human: 'Rozhoduje člověk', note: 'Poznámka' },
    auditTitle: 'Audit log',
    auditHint:
      'Vzniká z PostToolUse hooku — nic se neinstrumentuje ručně, takže na nic nejde zapomenout. Tokeny a cena jsou na běhu, ne na volání: SDK je hlásí jednou za běh.',
    auditColumns: { when: 'Kdy', run: 'Běh', tool: 'Nástroj', outcome: 'Výsledek', duration: 'Trvání', detail: 'Detail' },
    auditEmpty: 'Zatím žádné volání nástroje. Audit log se naplní prvním během agenta.',
    // Čtyři výsledky, ne dva. `denied` a `failed` se dřív vykreslovaly jako zelené „povoleno“ —
    // tedy přesně naopak, než co se stalo. Dvě odmítnutí mají různý důvod a musí být rozeznatelná:
    // `blocked` odmítl PreToolUse hook podle policy tabulky, `denied` odmítlo SDK, protože nástroj
    // nebyl v allowedTools pro tenhle běh. `failed` je jediný z těch čtyř, kde volání proběhlo.
    outcomes: {
      allowed: { label: 'povoleno', tone: 'good' },
      blocked: { label: 'zablokováno policy', tone: 'bad' },
      denied: { label: 'nepovolený nástroj', tone: 'bad' },
      failed: { label: 'selhalo', tone: 'warn' },
    } as Record<string, { label: string; tone: string }>,
    agentBlocked: (code: string | null): string => {
      switch (code) {
        case 'placeholder_key':
          return 'Agent neběží: ANTHROPIC_API_KEY je jen zástupná hodnota z .env.example. Doplň klíč z Console do .env.';
        case 'missing_workspace':
          return 'Agent neběží: chybí ANTHROPIC_AWS_WORKSPACE_ID. Bez workspace ID nemá Claude Platform on AWS kam request směrovat.';
        case 'missing_region':
          return 'Agent neběží: chybí AWS_REGION. Claude Platform on AWS nemá výchozí region.';
        default:
          return 'Agent neběží: v .env chybí API klíč.';
      }
    },
  },

  campaigns: {
    title: 'Kampaně',
    subtitle: 'Hromadná práce nad estate. Jedna kampaň naráz.',
    start: 'Spustit',
    running: 'běží…',
    needsTarget: 'Vyber proceduru',
    lastRun: 'Poslední běh',
    history: 'Historie',
    empty: 'Zatím neproběhla žádná kampaň.',
    progress: (done: number, total: number) => `${done}/${total} hotovo`,
    // Přeskočené se počítají zvlášť, a to je ten podstatný rozdíl: kampaň, která nic neudělala,
    // protože všechno už bylo hotové, není totéž co kampaň, která odvedla práci.
    skipped: (n: number) => `${n} přeskočeno`,
    failed: (n: number) => `${n} selhalo`,
    cost: 'cena',
    duration: 'trvání',
    concurrent: 'Jiná kampaň už běží.',
    agentBlocked: 'Kampaně, které volají model, nejde spustit — chybí API klíč.',
    columns: { item: 'Položka', status: 'Stav', detail: 'Výsledek', duration: 'Trvání' },
    historyColumns: { campaign: 'Kampaň', status: 'Stav', items: 'Položek', cost: 'Cena' },
    itemStatus: {
      pending: 'čeká',
      running: 'běží',
      done: 'hotovo',
      skipped: 'přeskočeno',
      failed: 'selhalo',
    } as Record<string, string>,
    runStatus: {
      running: 'běží',
      succeeded: 'dokončeno',
      failed: 'selhalo',
    } as Record<string, string>,
  },

  spec: {
    title: 'Specifikace',
    empty: 'Specifikace zatím není. Vzniká skillem extract-spec.',
    generatedAt: (when: string) => `vygenerováno ${when}`,
  },

  oracle: {
    title: 'Oracle',
    empty: 'Oracle zatím není. Vzniká skillem generate-oracle.',
    goldenTitle: 'Golden testy',
    invariantsTitle: 'Invarianty',
    // The distinction the whole tab exists to make: a case is a recorded call, an invariant
    // is a rule. One says "it still does what it did", the other says "what it does is right".
    goldenHint: 'Každý případ je skutečné zachycené volání. Vstupy se neberou od modelu, ale z capture.',
    invariantsHint: 'Pravidla se vyhodnocují v kódu nad tím, co golden testy zapsaly.',
    branch: 'Větev',
    covers: 'Pokrývá',
    source: 'Volání',
    normalised: 'Normalizováno',
    checks: 'kontrol',
    violations: 'porušení',
    advisory: 'neověřováno',
    advisoryHint: 'Pravidlo, které nejde vyhodnotit v kódu. Je zapsané, ale nepočítá se jako ověřené.',
    notEvaluated: 'nevyhodnoceno',
    notEvaluatedHint:
      'Pravidlo se vyhodnocuje nad tím, co procedura zapsala. Tahle nic nezapisuje, takže není co kontrolovat — pravidlo tu je, ale zatím nic netvrdí.',
    unconfirmed: 'nepotvrzeno',
    unconfirmedHint:
      'Pravidlo neplatí skoro nikde — to znamená, že popisuje něco jiného než tuhle proceduru, ne že je procedura rozbitá. Zůstává tu jako stopa, ale nepočítá se mezi nálezy.',
    pass: 'prošel',
    fail: 'neprošel',
    notRun: 'nespuštěno',
    passRate: (passed: number, total: number) => `${passed}/${total} prošlo`,
    // A violated invariant is a finding about the estate, not a broken oracle. The copy has
    // to say that plainly or the screen reads as "our tooling is failing".
    violationHint: 'Procedura porušuje pravidlo, které sama deklaruje. To není chyba oracle — to je nález.',
  },

  decisions: {
    title: 'Rozhodnutí',
    empty: 'Zatím nikdo nerozhodl.',
    signature: 'odchylka',
    action: 'rozhodnutí',
    by: 'rozhodl',
    run: 'implementace',
    note: 'poznámka',
    human: 'člověk',
    actions: {
      preserve: 'Zachovat chování',
      accept: 'Přijmout změnu',
      escalate: 'Eskalovat',
    },
  },

  pr: {
    title: 'PR',
    empty: 'PR zatím není sestavený.',
    assembledChip: 'sestaven',
    status: 'stav',
    branch: 'branch',
    repo: 'repo',
    artifact: 'artefakt',
    files: 'Soubory',
    body: 'Popis',
    // Sestavit PR a otevřít ho jsou dva různé úkony. Otevření je jediná věc, kterou
    // `make demo-reset` nevrátí zpátky, a policy ho nikdy nepustí přes agenta.
    notOpened: 'Sestaveno, neotevřeno — otevření PR je vždycky na člověku.',
    blocked: 'Otevřít zatím nejde:',
    statuses: {
      assembled: 'sestaven',
      open: 'otevřen',
      failed: 'selhalo',
    },
  },

  shadow: {
    title: 'Shadow runy',
    empty: 'Zatím žádný shadow run. Spouští se příkazem make shadow-run.',
    // The sentence the whole beat turns on. Say what actually happens, not what sounds safe.
    hint:
      'Zachycená volání se přehrají dvakrát nad obnovenou kopií databáze: jednou původní procedurou, jednou náhradou. ' +
      'Produkční databáze zůstane nedotčená — shadow spojení se na ni vůbec neotevře.',
    replayed: 'přehraných volání',
    strata: 'pokrytých větví',
    replayTime: 'čas přehrání',
    perCase: 'na volání',
    against: 'proti',
    database: 'databáze',
    raw: 'hrubých odchylek',
    resolvedInCode: 'vyřešeno kanonikalizací',
    reachedModel: 'zbylo na model',
    // This is the §8 claim made checkable on screen rather than asserted in a doc.
    resolvedHint:
      'Vyřešeno v kódu, ještě než cokoliv vidí model: stabilní řazení, normalizace hodin, GUID, identity a zaokrouhlení. ' +
      'Model tyhle odchylky nikdy neviděl — u žádné z nich není běh agenta.',
    breakdownTitle: 'Kam odchylky doputovaly',
    findingsTitle: 'Nálezy',
    columns: {
      signature: 'Odchylka',
      cases: 'Případů',
      rows: 'Řádků',
      verdict: 'Verdikt',
      source: 'Rozhodl',
      reason: 'Důvod',
    },
    sourceCanonicaliser: 'kanonikalizace',
    sourceModel: 'classify-diff',
    noise: 'šum',
    behaviourChange: 'změna chování',
    unclassified: 'nezařazeno',
  },

  queue: {
    title: 'Fronta rozhodnutí',
    // Deliberately not "dnes": a wall-clock window gives a different number at every
    // rehearsal, and the sentence is about how much the machine absorbed, not about the date.
    counter: (raw: string, human: number) => `${raw} odchylek v posledním běhu · ${human} doputovalo k člověku`,
    resolvedInCode: (n: string) => `${n} z nich vyřešila kanonikalizace v kódu — model je nikdy neviděl`,
    empty: 'Fronta je prázdná. Žádná změna chování nečeká na rozhodnutí.',
    emptyNoRun: 'Zatím neproběhl žádný shadow run, takže není co rozhodovat.',
    openTitle: 'Čeká na rozhodnutí',
    decidedTitle: 'Rozhodnuto',
    old: 'Původní procedura',
    new: 'Náhrada',
    reasoning: 'Zdůvodnění agenta',
    affected: (cases: number, rows: number) => `${cases} případů · ${rows} zapsaných řádků`,
    sample: 'Ukázkové volání',
    unassigned: 'bez vlastníka',
    actions: {
      preserve: 'Zachovat chování',
      accept: 'Přijmout změnu',
      escalate: 'Eskalovat',
    },
    decided: {
      preserve: 'zachovat chování',
      accept: 'přijmout změnu',
      escalate: 'eskalováno',
    } as Record<string, string>,
    undo: 'vrátit',
    // What "preserve" means here, said plainly, because it is the point of beat 4.
    preserveHint:
      'Zachovat chování znamená, že náhrada bude dělat totéž co původní procedura — včetně chyby. Opraví se zvlášť, jako vědomé rozhodnutí.',
  },

  steps: {
    title: 'Kroky agenta',
    empty: 'Zatím žádný běh agenta nad touhle procedurou.',
    turns: 'tahů',
    cost: 'cena',
    tokens: 'tokeny',
    blocked: 'zablokováno policy',
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
