# Demo choreography

~9 minutes, four beats. **The build is finished when this runs three times consecutively from `make demo-reset` with no intervention.**

Every number below is read from Postgres by `make verify-m7` §9 on every gate run. If one of them
moves, the gate goes red and this file is what has to change — the stale-doc failure has already
happened twice, so it is now checked rather than remembered.

---

## The one structural thing to understand before rehearsing

**Beat 1's blank slate and replay cannot both be true at the same moment**, and pretending
otherwise is how this demo falls over on stage.

`make demo-reset` gives beat 1 its empty estate — and it deletes the recordings, because the
recordings *are* the analysis. Replay serves from those recordings. So after a reset there is
nothing to replay, and a replay with no recording refuses loudly rather than emitting an empty
run. Meanwhile the whole estate live is 28 + 10 model runs, about **$16 and an hour**, which is
not nine minutes and never will be.

So the demo has an explicit restore in the middle of it, and **it is said out loud**. That is not
a workaround: `docs/SPEC.md` §4 asks for a recorded golden run in the repo so a fresh clone can
demo immediately, and this is that run being used for exactly what it is for.

| Stretch | Mode | Why |
|---|---|---|
| Beat 1 — Estate | live, on a reset estate | Reads Postgres. Nothing to spend. |
| Beat 2 — `Smazat mrtvé procedury` | **live, complete** | No model call at all. The argument is a column of zeros, and it finishes in front of you. |
| Beat 2 — `Zmapovat estate` | **live, partial** | 28 model runs. Start it, watch three or four land, move on. It is superseded by the restore and stops itself. |
| Beat 2½ — `make restore-golden` | — | 2 s. **Said out loud.** |
| Beat 3 — spec, oracle | **replay** | ~5 minutes of real thinking per run. |
| Beat 3 — shadow run | either | 16 s live if the shadow copy is up; replayed if the room is not worth the risk. |
| Beat 4 — the decision | live | It is a click and a row. |
| Beat 4 — `implement-service` | **replay** | Fifteen minutes of Opus. Never live in front of anyone. |
| Beat 4 — the green shadow run, the PR | live | 20 s and an assembly. |

`PARITY_MODE` is on the badge in the top right, in both directions: `LIVE` in grey, `REPLAY` in
amber. **Look at it before every beat.** Running a stretch in the wrong mode is the single most
likely way this demo breaks, and it used to be invisible in one of the two directions.

> "Tohle je nahraný běh — stejný mechanismus, kterým platforma přehrává váš provoz. Vidíte
> původní kroky v původním rytmu, jen se u toho nic neplatí."

---

## Beat 1 — Estate (60 s)

Open Parity on the Estate screen. Fourteen procedures, coverage near zero, everything `untouched`.

> "Tohle je výchozí stav. Nic není zanalyzované, nic není ověřitelné, a nikdo vám neřekne, do které z těch procedur je bezpečné sáhnout."

## Beat 2 — Triage and phase 0 (2 min)

**Start with the deletion campaign — it is the one that finishes.** Three procedures show zero
invocations over 90 days. Kampaně → `Smazat mrtvé procedury`. It marks them `deleted` and
assembles a PR that removes exactly those three files: three deletions, 180 lines, nothing added.
Watch the blocker table lose the `chybí oracle` row live — those three stop being work.

> "První splátka dluhu za dvě minuty. Plně vratná, triviálně ověřitelná, nulové riziko. A žádné přepisování — jenom odstranění toho, co už nikdo nevolá."

Then open it, and say why that is a separate act: the tier table refuses `open_pr` to every
agent, so the machine assembled it and a person sends it.

```
make open-pr PROC=deletion COMMIT=--commit
```

It is idempotent — [PR #11](https://github.com/secho/parity-workspace/pull/11) is already open, so
a rehearsal returns that one rather than opening a second. Have it in a second tab.

**Then `Zmapovat estate`, and say the honest thing about the timing.** Measured on this estate:
**one procedure is triage + spec, and it takes five minutes and about $0,65.** Fourteen of them
is over an hour and roughly $9. You will see the first item go `běží` and the other thirteen
sitting at `čeká` — **you will not see one complete**, so do not promise the room that they will.
That is the beat: it starts, it is visibly real, and it is visibly not something you wait for.

> "Jedna procedura je pět minut přemýšlení. Těch čtrnáct je hodina a nikdo tady nemá hodinu.
> Nechám to běžet a ukážu vám ten samý výsledek dokončený — platforma ho vyrobila včera."

## Beat 2½ — the recorded run (15 s, said out loud)

```
make restore-golden
```

Two seconds, 15 082 rows: the analysis of all fourteen procedures as the platform produced it,
committed to the repository. This is what makes beats 3 and 4 possible in a nine-minute slot, and
it is what `docs/SPEC.md` §4 asks for by name.

> "Tady přeskakuju dopředu. Tohle není simulace — je to nahraný běh téhle platformy nad tímhle
> estate, uložený v repozitáři. Za chvíli si ho přehrajeme krok po kroku."

The mapping campaign from beat 2 notices its run is gone and stops itself rather than carrying on
spending against an estate that has been replaced underneath it. Rehearsed: it leaves no residue —
`agent_runs` comes back to exactly the recorded count.

**Switch `PARITY_MODE` to `replay` now.** It is a container restart and takes two seconds:

```
PARITY_MODE=replay PARITY_REPLAY_SPEED=8 docker compose up -d parity-api
```

The badge turns amber, and it is the last time in the demo you have to think about it.

Then re-fill the decision queue, which beat 4 needs and which is **free and instant in replay
mode** — three seconds, no model call, the same four findings with the same Czech reasoning:

```
make shadow-run PROC=sp_CalculateOrderTotal "" reference
```

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

Run in this order. The first three are the ones that have actually gone wrong.

- [ ] `make remount` if the branch has changed since the containers started — a container serving
      a deleted inode reports HEALTHY and replays against whatever it had in memory
- [ ] `make replay-check` — proves the committed snapshot restores, in a scratch database, before
      you depend on it in front of anyone
- [ ] `make demo-reset` **last**, immediately before you start. Beat 1 is the only beat that needs
      it, and everything else in this list is undone by it
- [ ] `PARITY_MODE=live` for beats 1–2, `replay` from beat 2½. On the badge, not remembered
- [ ] GitHub open in a second tab, logged in, on [PR #11](https://github.com/secho/parity-workspace/pull/11)
- [ ] Laptop on power, notifications off, browser zoom readable from the back of the room

**Two gates are destructive — do not run them during setup.**
`make verify-m2` ends by running `demo-reset`, and `make verify-m6` leaves two blocked probe runs
behind. Both are fine; both want a `make restore-golden` afterwards. `make verify-m7` is the only
one that leaves the database exactly as it found it.

**The decision queue is empty until a reference run re-fills it.** It shows the newest run per
procedure, and after a restore the newest one is the green generated run with no findings. Beat 2½
already re-fills it; if you are jumping straight to beat 4, run it yourself:

```
make shadow-run PROC=sp_CalculateOrderTotal "" reference
```

In replay mode that is three seconds and free. Live it is 16 s plus four `classify-diff` runs.
Either way it makes `verify-m6` red on "every finding has been decided" until beat 4's click
happens — the gate being right, not broken.

## Measured on this stack, so you can budget

| Step | Time | Cost |
|---|---|---|
| `make demo-reset` | 0,4 s | — |
| `Smazat mrtvé procedury`, from cold | 15 ms | — |
| `make open-pr PROC=deletion COMMIT=--commit` | ~2 s | — |
| `Zmapovat estate`, per procedure | **5 min** | **$0,65** |
| `make restore-golden` | 2 s | — |
| Mode switch | 2 s | — |
| Reference shadow run, replayed | 3 s | — |
| Beat 3 spec, replayed at speed 8 | 38 s | — |
| `Zmapovat estate` on a mapped estate | 266 ms, 14 skipped | — |

**Never quote a memorised number.** Invocation counts drift between the committed checksum, Postgres
and MS SQL as the gate tags its own calls; whatever the demo says must come off the screen on the day.
