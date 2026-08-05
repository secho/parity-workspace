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
2. Agent generates golden tests from captured traffic, plus three invariants.
3. Agent implements `pricing-service`.
4. Shadow run: 2 000+ captured calls replayed. Diffs appear. The classifier sorts them. Human-facing count settles at three.

> "Zákazník celou dobu vidí jen výsledek staré procedury. Nová běží naprázdno vedle a její transakce se zahazuje. Produkce se nikdy nedotkne."

## Beat 4 — The decision (2 min)

Open the decision queue. Three items. One is the planted legacy bug: promo applied before VAT in one branch, after VAT in another.

Show the side-by-side. Show the agent's reasoning. Click **Zachovat chování**.

> "Systém našel něco, co tady patnáct let nikdo neviděl. A všimněte si, že to sám potichu neopravil — zeptal se. Opraví se to zvlášť, jako vědomé rozhodnutí."

Agent adjusts, shadow reruns green, PR opens with spec, tests, service and the recorded decision attached.

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
