# Demo choreography

~9 minutes, four beats. **The build is finished when this runs three times consecutively from `make demo-reset` with no intervention.**

Every number below is read from Postgres by `make verify-m7` §9 on every gate run. If one of them
moves, the gate goes red and this file is what has to change — the stale-doc failure has already
happened twice, so it is now checked rather than remembered.

---

## Live and recorded — per stretch, not per beat

`PARITY_MODE` is on the badge in the top right, in both directions: `LIVE` in grey, `REPLAY` in
amber. **Look at it before every beat.** Running a stretch in the wrong mode is the single most
likely way this demo breaks, and it used to be invisible in one of the two directions.

| Stretch | Mode | Why |
|---|---|---|
| Beat 1 — Estate | live | Reads Postgres. Nothing to spend. |
| Beat 2 — `Zmapovat estate` | live | Already-mapped items are **skipped**, so it costs nothing and finishes in seconds. |
| Beat 2 — `Smazat mrtvé procedury` | live | No model call at all. The argument is a column of zeros. |
| Beat 3 — spec, oracle | **replay** | ~5 minutes of real thinking per run. Say so out loud. |
| Beat 3 — shadow run | either | 16 s live if the shadow copy is up; replayed if the room is not worth the risk. |
| Beat 4 — the decision | live | It is a click and a row. |
| Beat 4 — `implement-service` | **replay** | Fifteen minutes of Opus. Never live in front of anyone. |
| Beat 4 — the green shadow run, the PR | live | 20 s and an assembly. |

> "Tohle je nahraný běh — stejný mechanismus, kterým platforma přehrává váš provoz. Vidíte
> původní kroky v původním rytmu, jen se u toho nic neplatí."

Replay serves from the recordings in the database, so **`make restore-golden` first** if the
database has been reset. Replay with no recording refuses loudly — it never emits an empty run.

---

## Beat 1 — Estate (60 s)

Open Parity on the Estate screen. Fourteen procedures, coverage near zero, everything `untouched`.

> "Tohle je výchozí stav. Nic není zanalyzované, nic není ověřitelné, a nikdo vám neřekne, do které z těch procedur je bezpečné sáhnout."

## Beat 2 — Triage and phase 0 (2 min)

Kampaně → `Zmapovat estate`. The agent reads all fourteen, classifies them, builds the coupling
graph; the blocker table fills in.

**Say the honest thing about the timing.** A full mapping is 28 model runs and about $7 — that is
not a two-minute beat and never will be. The campaign skips what is already done, so on a mapped
estate it completes in seconds and reports **14 přeskočeno**. On a genuinely fresh estate, start
it, watch three or four items fill in, and move on while it runs.

Three procedures show zero invocations over 90 days. Run `Smazat mrtvé procedury`. It marks them
`deleted` and assembles a PR that removes exactly those three files — three deletions, nothing
added. Show it.

> "První splátka dluhu za dvě minuty. Plně vratná, triviálně ověřitelná, nulové riziko. A žádné přepisování — jenom odstranění toho, co už nikdo nevolá."

Opening it is a click, and the tier table refuses `open_pr` to every agent — so the PR is
assembled by the machine and sent by a person. `make open-pr PROC=deletion --commit`.

## Beat 3 — One procedure, end to end (4 min)

Open `sp_CalculateOrderTotal`.

1. Agent extracts the spec. **Read one paragraph aloud** — it is in Czech and it is comprehensible. That is the point, not the technology.
2. Agent generates golden tests from captured traffic, plus invariants.
3. Shadow run against the **reference implementation**, `Shadow runy` tab: **400 zachycených volání
   replayed, 27 z 27 pozorovaných větví, 16 s.**
   Then the three numbers that carry the beat — **1 668 hrubých odchylek → 1 600 vyřešila
   kanonikalizace → 68 zbylo na model**.
   Four findings. Say the middle number out loud: the model never saw 96 % of them.

> "Zákazník celou dobu vidí jen výsledek staré procedury. Náhrada běží vedle nad obnovenou kopií databáze — shadow spojení se na produkci vůbec neotevře."

## Beat 4 — The decision (2 min)

Open the decision queue. Four items, and they are two different stories:

- **The legacy bug** — `TotalVat` and `TotalWithVat`. The 2022 VERNY20 branch computes VAT on
  `net − promo` where every other branch uses the full net. 32 of 400 cases. `TotalNet` is
  identical everywhere, which is exactly why nobody ever saw it.
- **The new one** — the same two columns, one hundredth of a heller apart on 2 orders. The
  reference implementation does its arithmetic in binary floating point and lands on a rounding
  boundary. Caught before it shipped — and the agent's service, told to match the database's
  decimal arithmetic, does not have it.

Show the side-by-side. Show the agent's reasoning. Click **Zachovat chování**.

> "Systém našel něco, co tady patnáct let nikdo neviděl. A všimněte si, že to sám potichu neopravil — zeptal se. Opraví se to zvlášť, jako vědomé rozhodnutí."

Now `implement-service` writes the replacement, and the decision is part of what it is given —
`preserve` means the old behaviour is the required behaviour, however wrong it looks. **This is a
recorded stretch**: fifteen minutes of Opus does not happen in front of an audience.

Shadow run again, against the agent's service this time: **400 volání, 27 z 27 strat, 20 s,
1 600 hrubých odchylek → 1 600 vyřešila kanonikalizace → 0 zbylo. 0 nálezů.** Same harness,
same case set, same database — only the implementation changed.

> "Referenční implementace tam zůstává schválně. Je to kontrola: kdyby diff engine přestal
> fungovat, byl by zelený i nad ní. Není."

The `PR` tab: spec, golden tests, the service and the recorded decision, with the shadow
numbers and `Kandidáti na opravu` in the body. Opening it is a click — the policy tier table
refuses `open_pr` to every agent, and the `Provoz` page shows that rule.

Back to Estate: coverage moved, the blocker table moved.

> "A tahle tabulka není report o roadmapě. Ona je ta roadmapa."

→ straight to the roadmap slide of the main deck.

---

## If someone asks "does it work on anything but that one procedure?"

This is the question the second procedure exists to answer, and it is worth two minutes.

Kampaně → `Migrovat proceduru` → `sp_GetCartSummary`. Triage, specification, oracle, shadow run
and classification, all of it API-side, five to eight minutes. Or show what it already produced:
**279 zachycených volání over 18 z 18 strat, 11 golden testů, 11/11 against the generated
service, zero differences.**

Then the sharper half of the answer. `sp_GetCartSummary` sits at **`shadow`, not `proven`**, and
the platform refuses to promote it — there is no hand-written reference implementation for it, so
nothing has ever been shown to diverge, and a green run against nothing is not proof of anything.

> "Ta procedura prošla celou linkou a platforma ji odmítá označit za ověřenou. To je ten rozdíl
> mezi měřením a razítkem."

Two more things to have ready rather than to volunteer:

- **It is `nondet`, not `pure_read`.** It writes nothing at all and still is not replayable
  as-is, because it branches on the clock. That is a better sentence than the classification.
- **Its promo branch has zero captured traffic.** All eleven golden cases are `promo=none`,
  six of eleven invariants are advisory, and one of them is named
  `promo_code_branch_unverified`. Never claim "N of N branches" — claim strata. "Ta větev v
  produkci za devadesát dní nikdy neběžela, a platforma to říká jménem" is the strong answer,
  and it only works if it is said first.

---

## Pre-flight checklist

- [ ] `make demo-reset` run within the last 10 minutes — or `make restore-golden` if a replayed beat is coming
- [ ] `make shadow-run PROC=sp_CalculateOrderTotal "" reference` — **the decision queue is empty without it.** A green generated run is the newest run, and the queue shows the newest run per procedure
- [ ] `PARITY_MODE` correct for the beat, checked on the badge, not remembered
- [ ] `make remount` if the branch has changed since the containers started
- [ ] GitHub PR page open in a second tab, logged in
- [ ] `make record-golden` / `make replay-check` green, and the snapshot committed
- [ ] Laptop on power, notifications off, browser zoom at a level readable from the back of the room

**Never quote a memorised number.** Invocation counts drift between the committed checksum, Postgres
and MS SQL as the gate tags its own calls; whatever the demo says must come off the screen on the day.
