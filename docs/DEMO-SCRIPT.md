# Demo choreography

~9 minutes, four beats. **The build is finished when this runs three times consecutively from `make demo-reset` with no intervention.**

Live for beats 1, 2 and 4. Beat 3's model-heavy stretch runs from a recorded run, stated openly: *"tohle je nahraný běh — stejný mechanismus, kterým platforma přehrává váš provoz."*

---

## Beat 1 — Estate (60 s)

Open Parity on the Estate screen. Fourteen procedures, coverage near zero, everything `untouched`.

> "Tohle je výchozí stav. Nic není zanalyzované, nic není ověřitelné, a nikdo vám neřekne, do které z těch procedur je bezpečné sáhnout."

## Beat 2 — Triage and phase 0 (2 min)

Run the `Zmapovat estate` campaign. The agent reads all fourteen, classifies them, builds the coupling graph. The blocker table fills in live.

Three procedures show zero invocations over 90 days. Run `Smazat mrtvé procedury`. A PR opens on GitHub — show it.

> "První splátka dluhu za dvě minuty. Plně vratná, triviálně ověřitelná, nulové riziko. A žádné přepisování — jenom odstranění toho, co už nikdo nevolá."

## Beat 3 — One procedure, end to end (4 min)

Open `sp_CalculateOrderTotal`.

1. Agent extracts the spec. **Read one paragraph aloud** — it is in Czech and it is comprehensible. That is the point, not the technology.
2. Agent generates golden tests from captured traffic, plus invariants.
3. Shadow run against the **reference implementation**, `Shadow runy` tab: **400 captured calls
   replayed, 27 of 27 observed branches, 16 s.**
   Then the three numbers that carry the beat — **1 668 hrubých odchylek → 1 600 vyřešila kanonikalizace → 68 zbylo na model**.
   Four findings. Say the middle number out loud: the model never saw 96 % of them.

> "Zákazník celou dobu vidí jen výsledek staré procedury. Náhrada běží vedle nad obnovenou kopií databáze — shadow spojení se na produkci vůbec neotevře."

## Beat 4 — The decision (2 min)

Open the decision queue. Four items, and they are two different stories:

- **The legacy bug** — `TotalVat` and `TotalWithVat`. The 2022 VERNY20 branch computes VAT on
  `net − promo` where every other branch uses the full net. 32 of 400 cases. `TotalNet` is
  identical everywhere, which is exactly why nobody ever saw it.
- **The new one** — the same two columns, one hundredth of a heller apart on 18 orders. The
  reference implementation does its arithmetic in binary floating point and lands on a rounding
  boundary. Caught before it shipped — and the agent's service, told to match the database's
  decimal arithmetic, does not have it.

Show the side-by-side. Show the agent's reasoning. Click **Zachovat chování**.

> "Systém našel něco, co tady patnáct let nikdo neviděl. A všimněte si, že to sám potichu neopravil — zeptal se. Opraví se to zvlášť, jako vědomé rozhodnutí."

Now `implement-service` writes the replacement, and the decision is part of what it is given —
`preserve` means the old behaviour is the required behaviour, however wrong it looks.

Shadow run again, against the agent's service this time: **400 cases, 27 of 27 strata, 20 s,
1 600 hrubých odchylek → 1 600 vyřešila kanonikalizace → 0 zbylo. Žádný nález.** Same harness,
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

## Pre-flight checklist

- [ ] `make demo-reset` run within the last 10 minutes
- [ ] `PARITY_MODE` set correctly for each beat
- [ ] GitHub PR page open in a second tab, logged in
- [ ] Recorded golden run present and verified
- [ ] Laptop on power, notifications off, browser zoom at a level readable from the back of the room
