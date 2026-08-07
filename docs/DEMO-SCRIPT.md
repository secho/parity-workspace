# Demo choreography

~9 minutes, four beats. **The build is finished when this runs three times consecutively from `make demo-reset` with no intervention.**

Every number below is read from Postgres by `make verify-m7` §9 on every gate run. If one of them
moves, the gate goes red and this file is what has to change — the stale-doc failure has already
happened twice, so it is now checked rather than remembered.

---

## How this runs: blank estate, everything replayed, nothing spent

The demo opens on an estate where nothing is analysed and then **fills it in live, for free**.
Both halves of that are real, and they are compatible because of one design decision worth being
able to state:

**The recordings live in a second database that `make demo-reset` cannot reach.** The recordings
*are* the analysis — reset truncates `agent_runs` and `agent_steps` with everything else — so
recordings kept in the live database could only ever re-show what was already on screen. Kept in
`parity_replay`, built from the committed snapshot by `make load-replay-source`, the demo can start
from nothing and replay every run into it.

A replayed run re-materialises **what it produced**, not just its transcript: the specification
lands at its full 15 368 characters, not the 2 000 the step stream carries. `verify-m7` §10 checks
that byte for byte, from a genuinely reset database.

Measured on this stack:

| Stretch | Mode | Measured |
|---|---|---|
| Beat 1 — Estate | live | `make demo-reset`, 0,4 s |
| Beat 2 — `Smazat mrtvé procedury` | live | 15 ms, no model call at all |
| Beat 2 — `Zmapovat estate` | **replay** | **94 s for all fourteen, $0,00** at `PARITY_REPLAY_SPEED=40` |
| Beat 3 — spec | **replay** | 38 s at speed 8; 9 s at speed 40 |
| Beat 3/4 — the whole lane as a campaign | **replay** | **15 s, $0,00** |
| Beat 3 — oracle (model replayed, baseline executed for real) | **replay** | 8 s, $0,00 |
| Beat 3 — reference shadow run | **replay** | 3 s, $0,00 |
| Beat 4 — the decision | live | a click and a row |
| **Beats 1–4 end to end, from `make demo-reset`** | **replay** | **~2,5 min of machine time, $0,00** |

`PARITY_MODE` is on the badge top right in both directions: `LIVE` in grey, `REPLAY` in amber.
**Look at it before every beat.** Running a stretch in the wrong mode is the single most likely way
this demo breaks — live, `Zmapovat estate` is five minutes and $0,65 *per procedure*, so the wrong
mode is an hour and $9 rather than 94 seconds.

> "Tohle je nahraný běh — stejný mechanismus, kterým platforma přehraje váš provoz. Původní kroky
> v původním rytmu, jen se u toho nic neplatí."

## Drive it from `/rezie`, not from a terminal

**<http://localhost:5190/rezie>** — one row per beat, in order, with a button, what it should cost,
and what the estate says about it right now. Every button posts to the endpoint the `make` target
already used; nothing there is a second implementation of this file.

It is in the sidebar, but **below the rule and deliberately quiet** — 10px, `--text-faint`, under
a divider. The four items above it are what the customer is meant to look at, and a fifth in the
same weight announces that what they are watching is choreographed before the first beat lands.
Findable when you look for it, unreadable from the fifth row. Keep it on a second screen anyway if
you can.

**The mode switch is at the top of that page.** `REŽIM live | replay`, and in replay a
`ZRYCHLENÍ ×1 | ×8 | ×40`. It takes effect immediately — no container restart — and everything
that decides reads the same value, so the badge in the corner cannot say `LIVE` while runs are
being replayed. It does **not** survive a restart: after one, `PARITY_MODE` wins again. If you want
replay to be the default, put `PARITY_MODE=replay` in `.env`.

Switching to replay checks the replay source first and refuses with the fix if it is missing, which
is the right moment to find that out rather than four beats later.

`hotovo` is derived from the database on every read, so it is a live "you are here" rather than a
checklist — reload mid-demo, or hand the laptop to someone else, and it still knows. It also
carries the warning that matters: if the stack is live, it says so, and says what beat 2b is about
to cost.

The two beats with no button are the two a person does: **4a**, the decisions in Fronta, and
**4d**, looking at the Estate screen.

---

## Beat 1 — Estate (60 s)

Open Parity on the Estate screen. Fourteen procedures, coverage near zero, everything `untouched`.

> "Tohle je výchozí stav. Nic není zanalyzované, nic není ověřitelné, a nikdo vám neřekne, do které z těch procedur je bezpečné sáhnout."

## Beat 2 — Triage and phase 0 (2 min)

**Start with the deletion campaign — no model call is involved at all.** Three procedures show
zero invocations over 90 days. Kampaně → `Smazat mrtvé procedury`, 15 ms. It marks them `deleted`
and assembles a PR that removes exactly those three files: three deletions, 180 lines, nothing
added. Watch the blocker table lose a whole row live — those three stop being work.

> "První splátka dluhu za dvě minuty. Plně vratná, triviálně ověřitelná, nulové riziko. A žádné přepisování — jenom odstranění toho, co už nikdo nevolá."

Then open it, and say why that is a separate act: the tier table refuses `open_pr` to every
agent, so the machine assembled it and a person sends it.

```
make open-pr PROC=deletion COMMIT=--commit
```

Idempotent — [PR #11](https://github.com/secho/parity-workspace/pull/11) is already open, so a
rehearsal returns that one rather than opening a second. Have it in a second tab.

**Then `Zmapovat estate`, and let it finish.** Fourteen procedures, triage and specification each,
filling in one after another — **94 seconds, and every one of the twenty-eight runs is replayed
from the recording, so it costs nothing.** The blocker table rebuilds itself as they land:
`netriazováno` empties, `chybí seam` and `chybí oracle` fill.

> "Tohle je nahrané. Naživo je jedna procedura pět minut přemýšlení a těch čtrnáct je hodina —
> tak se dívate na záznam, krok po kroku, v původním rytmu. Je to ten samý mechanismus, kterým
> platforma přehraje váš provoz proti nové implementaci."

Say the live number out loud, because it is the honest one and it is not embarrassing: **$7 and
an hour, once, for an estate nobody had ever documented.**

## Beat 3 — One procedure, end to end (4 min)

Open `sp_CalculateOrderTotal`. Beat 2 already gave it a triage and a specification; this beat adds
the oracle and the shadow run.

1. **The specification is already there** — open `Specifikace` and **read one paragraph aloud**. It
   is in Czech, it is 15 368 characters, and it is comprehensible. That is the point, not the
   technology. (Re-run it from the `Kroky agenta` tab if you want the steps to arrive on screen
   while you talk: 9 s at speed 40.)
2. `Oracle` tab → generate. The model chooses the cases and states the invariants; recording what
   the procedure does with them is Parity's job and **runs for real** — it executes the procedure
   inside a transaction that rolls back, which costs seconds and no money.
3. Shadow run against the **reference implementation**:
   ```
   make shadow-run PROC=sp_CalculateOrderTotal "" reference
   ```
   `Shadow runy` tab: **400 zachycených volání
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

Show the side-by-side. Show the agent's reasoning. Click **Zachovat chování** — and click it on
**all four**, not just the one you talked about. Two stories, two columns each.

**The order matters and there is no warning if you get it wrong.** The queue shows the newest run
per procedure, so the moment the green generated run lands, the reference run's findings stop
being work and disappear from the screen. `proven` requires every one of them to have been
decided, so a decision taken after the green run is a decision the ladder never sees: the
procedure stays at `shadow`, the blocker stays `čeká na rozhodnutí`, and beat 4's closing move —
the blocker clearing, `migrováno` appearing — does not happen. Rehearsed the wrong way round
once, which is how this paragraph exists.

> "Systém našel něco, co tady patnáct let nikdo neviděl. A všimněte si, že to sám potichu neopravil — zeptal se. Opraví se to zvlášť, jako vědomé rozhodnutí."

Now `implement-service` writes the replacement, and the decision is part of what it is given —
`preserve` means the old behaviour is the required behaviour, however wrong it looks. Live this is
fifteen minutes of Opus and $3,93; replayed it is seconds, and the service it produces is the same
artefact, byte for byte, that `/health` reports on the running container.

Shadow run again, against the agent's service this time:

```
make shadow-run PROC=sp_CalculateOrderTotal "" generated
```
 **400 volání, 27 z 27 strat, 20 s,
1 600 hrubých odchylek → 1 600 vyřešila kanonikalizace → 0 zbylo. 0 nálezů.** Same harness,
same case set, same database — only the implementation changed.

> "Referenční implementace tam zůstává schválně. Je to kontrola: kdyby diff engine přestal
> fungovat, byl by zelený i nad ní. Není."

The `PR` tab: spec, golden tests, the service and the recorded decision, with the shadow
numbers and `Kandidáti na opravu` in the body. Opening it is a click — the policy tier table
refuses `open_pr` to every agent, and the `Provoz` page shows that rule.

Back to Estate: **coverage 0 % → 5,21 %**, `migrováno` 1, and `sp_CalculateOrderTotal` has no
blocker at all. 5,21 % is that one procedure's real share of ninety days of traffic — the number
moves by what was actually migrated, not from nothing to nearly everything.

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
- [ ] **`make load-replay-source`** — builds `parity_replay` from the committed snapshot. Without
      it every replayed run refuses, loudly, and the demo has nothing to show. Re-run it after any
      `make record-golden`
- [ ] `make replay-check` — proves that snapshot restores, in a scratch database, before you depend
      on it in front of anyone
- [ ] Set **replay** on `/rezie` — the switch at the top, `×40`. Or start the stack that way, so a
      restart cannot surprise you: `PARITY_MODE=replay PARITY_REPLAY_SPEED=40 docker compose up -d parity-api`
- [ ] `make demo-reset` **last**, immediately before you start
- [ ] Check the badge says `REPLAY`, in amber. Do not take it on trust
- [ ] GitHub open in a second tab, logged in, on [PR #11](https://github.com/secho/parity-workspace/pull/11)
- [ ] Laptop on power, notifications off, browser zoom readable from the back of the room

**The gates are order-dependent, and two of them move the database.** Run them in this order:

```
make verify-m2 → make restore-golden → make verify-m6 → make verify-m7
```

`verify-m2` is written for the estate M2 had — nothing analysed — and it ends by running
`demo-reset`, so it goes first and cleans up after itself. `verify-m6` leaves two blocked probe
runs behind, which is what its policy controls are for. `verify-m7` resets and restores inside its
own last section and leaves the database exactly as it found it.

`make restore-golden` also re-runs `ingest`, so the restored estate carries **today's** invocation
counts rather than the snapshot's. Beat 1 reads that number off the screen, and every acceptance
run tags a few capture rows of its own.

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
| Mode switch (`/rezie`, no restart) | instant | — |
| Reference shadow run, replayed | 3 s | — |
| Beat 3 spec, replayed at speed 8 | 38 s | — |
| `Zmapovat estate` on a mapped estate | 266 ms, 14 skipped | — |

**Never quote a memorised number.** Invocation counts drift between the committed checksum, Postgres
and MS SQL as the gate tags its own calls; whatever the demo says must come off the screen on the day.
