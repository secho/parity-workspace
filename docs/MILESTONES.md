# Milestones

One milestone per Claude Code session. `/clear` between them. A milestone is done when its verify command exits 0 and the work is committed on `milestone/mN` with a PR into `main`.

Update the checkboxes as you go. This file is the handoff between sessions.

---

## M0 — ParityShop stands up
- [x] `docker compose up --build` brings MS SQL Server 2022, monolith (Node 22 + TS + Fastify) and frontend up
- [x] Schema per SPEC §3: `Catalog` (60 cols), `OrderLedger` (72 cols), satellites
- [x] All 14 stored procedures created, **column write-overlap between unrelated procedures is real** — asserted by execution, 16 columns written by 2+ procedures
- [x] Seed: 300 products, 8 categories, 3 warehouses, 500 customers, 5 000 orders (16 194 lines)
- [x] Shop is clickable: list, detail, cart

`make verify-m0` — asserts containers healthy, all 14 procedures exist, row counts match seed expectations, `GET /api/products` returns 200 with data.

## M1 — Capture and traffic
- [x] Change Tracking enabled; every procedure call records inputs, result set, **write set**, duration — CT detects, temporal history supplies the before-image
- [x] Sampling policy: full for first 200 calls per proc, then 1-in-50, always on uncovered branches — per-procedure rates, `sp_CalculateOrderTotal` full to 3 000 for M5
- [x] Capture records the **ambient values a procedure read**, not just its input parameters. At minimum the clock. Several procedures read `GETDATE()` into a variable and then branch on it — `sp_CalculateOrderTotal` line 123 tests promo validity against wall-clock time. **Measured: 11 of 14 read the clock, 4 branch on it.**
- [x] Replay can **pin the recorded clock**. `verify-m1` asserts that replaying a captured `sp_CalculateOrderTotal` invocation with a pinned clock reproduces the captured result exactly.
- [x] Traffic generator produces 90 days of history in one run, power-law distributed — 40 087 calls in 184 s, availability + search at ~72%
- [x] Rare branches present: leap day, negative stock, Slovak VAT, stacked promo, 40-line order
- [x] The 3 dead procedures have exactly zero invocations

`make verify-m1` — asserts capture rows exist for all live procs, write sets non-empty for `sp_ReserveStock` across 4 tables, dead procs at zero, distribution is power-law, and a pinned-clock replay of `sp_CalculateOrderTotal` reproduces the captured result exactly.

## M2 — Estate ingestion
- [x] Parity app shell: sidebar, Postgres schema, Drizzle migrations
- [x] Ingest procedures from MS SQL: name, source, line count, invocation counts — 14 procedures, 45 287 invocations
- [x] Column-level `reads[]` / `writes[]` parsed from T-SQL; data-coupling graph built — 562 column accesses, 121 edges, 51 columns written by 2+ procedures
- [x] The parse is **graded against M1's captured write sets**: every column the estate was observed to write must appear in it. Text parsing recovers the `UPDATE … FROM #temp` statements `sys.dm_sql_referenced_entities` silently drops.
- [x] `sp_SearchProducts` is entirely dynamic SQL; its reads are parsed out of the string literals and flagged `inferred` rather than reported as nothing
- [x] `blocker` is a **derived property**, never stored — asserted twice: no such column exists, and the value moves when `oracle_state` moves
- [x] Parity connects as `parity_reader` (`db_datareader` + `VIEW DEFINITION`), so "it cannot write to the estate" is a permission the gate asserts, not a promise
- [x] Estate screen live: totals, invocation-weighted coverage, status bar, blocker breakdown, sortable table
- [x] `make demo-reset` in 1.4 s, back to 14 procedures / coverage 0 / everything `untouched`

`make verify-m2` — 35 checks. Asserts Parity's login can read the estate and its procedure source but is refused a write, 14 procedures ingested with matching line counts, per-procedure invocation counts equal a live `COUNT(*)`, every observed write is covered by the parse, the coupling graph contains the two designed collisions, every written column has exactly one owner, coverage is weighted not counted, ingest is deterministic across two runs, and `demo-reset` returns the estate to its pre-demo state under 120 s.

## M3 — Agent, skills, spec
- [x] Agent SDK wired, `settingSources: ['project']` — routed through **Claude Platform on AWS** (`CLAUDE_CODE_USE_ANTHROPIC_AWS`, eu-central-1); model IDs unchanged
- [x] `parity/skills/<name>/SKILL.md` loaded as real files, symlinked per run, listed in the UI
- [x] Audit log from `PostToolUse` **and `PostToolUseFailure`** hooks; policy gate on `PreToolUse` — 195 tool calls, 195 rows
- [x] `triage` classifies all 14 correctly — and corrected the answer key on six of them, including a clock branch the M1 survey missed (`sp_GetProductDetail:45`)
- [x] `extract-spec` produces a readable Czech spec over all 14, each with the six required sections and a non-empty `Otevřené otázky`
- [x] Procedure detail screen: source, spec, agent steps streaming via SSE; `Provoz` page with skills, policy tiers and audit log
- [x] Agent runs with cwd in `/tmp/parity-agent/<runId>`, outside the application directory
- [x] `docs/` is not mounted into the agent's container at all; a live agent asked for it by five paths comes back empty
- [x] `make map-estate` — 28 live runs, 0 failures, $7.12

`make verify-m3` — **29 checks**. Asserts every procedure has an `oracle_class` matching the committed expectation and a `Spec`, every tool call has an audit row whatever its outcome, a deliberately over-tier call is refused by the hook and writes nothing, the agent cannot reach `docs/SPEC.md`, every run persists enough to replay, and M2's numbers are unmoved.

**Open:** nine of fourteen procedures are `nondet`, so `chybí seam` carries 25 646 of 45 297 invocations. Accurate but a weak roadmap — see the open entry in `docs/DECISIONS.md` on splitting the blocker by seam kind.

## M4 — Oracle
- [x] `generate-oracle` produces golden tests from captured invocations — **90 cases over 10
      procedures**, each citing an `InvocationID` whose inputs the gate re-reads and compares
      byte for byte, so the agent cannot supply parameters of its own
- [x] Invariants proposed for `sp_CalculateOrderTotal` (total identity, non-negative, VAT rate
      table) — 9 of them, in a closed vocabulary and **evaluated in code**, 41 checks
- [x] Golden tests execute against the current procedure and pass — **10 of 10 suites green**,
      identical across two consecutive runs, inside a transaction that always rolls back under
      a `parity_runner` login with EXECUTE, no DDL, and a DENY on `sp_SyncWarehouseDispatch`
- [x] Coverage number on Estate is real and **invocation-weighted** — 99,89% weighted against
      71,43% counted. The math already existed and was correct; M4 is what makes `oracle_state`
      move
- [x] The oracle finds the planted promo/VAT defect: a derived rate of **0,168** against a rate
      table of {0,10 · 0,15 · 0,20 · 0,21}, in 2 of 41 checks — a minority, so a finding rather
      than a mis-stated rule — while the totals identity stays clean, which is why fifteen
      years of self-consistency checks never saw it

`make generate-oracles`: 10 procedures, 2 012 s, $4,85. The three dead procedures and
`sp_SyncWarehouseDispatch` are skipped and the gate asserts they have no cases.

**Coverage reads 99,89% only after a full sweep.** Beat 1 opens after `demo-reset` at zero and
beat 3 builds one procedure's oracle live, so the number the room sees moves by
`sp_CalculateOrderTotal`'s real share of traffic, not from nothing to nearly everything.

**Branch coverage is enforced on the migration target and reported elsewhere** — 5/5 for
`sp_CalculateOrderTotal`, 11/11 for `sp_PlaceOrder`, 6/20 for `sp_ApplyPromoCode`. An
incomplete suite is shown as a number rather than failed or rounded up.

`make generate-oracles` — one live model run per procedure with traffic to draw on, then a
baseline pass and a verify pass. Separate from the gate, like `map-estate`.

`make verify-m4` — **40 checks**. Asserts golden tests exist and pass for at least 8 procedures, that every
case traces to a real sampled invocation with byte-identical inputs, that the estate is
byte-identical after every replay, that a one-unit corruption turns the suite red, that the
rate invariant is violated in a *minority* of cases (a finding, not a mis-stated rule), and
that coverage math is weighted not counted.

**Gate order matters:** `demo-reset → map-estate → verify-m3 → generate-oracles → verify-m4`.
`verify-m3` asserts coverage is still zero, which stops being true once oracles exist.

## M5 — Shadow harness  ⚠ the hard one
- [x] `ParityShop_Shadow` — a restored copy on the same server, built by `make shadow-db` in
      0.8 s and reverted between passes in **530 ms**. The replay **commits** there rather than
      rolling back, which is what puts Change Tracking back in play; "production is untouched"
      is then an observation about the connection string, not an argument about transactions
- [x] Result-set and write-set diffing, per case, table and column — write sets from Change
      Tracking, cross-checked against M4's independent fingerprint mechanism on the same
      invocation and agreeing to the cent
- [x] Canonicalisation **in code before the model sees anything** — `oracle/canonicalise.ts`
      imported unchanged from M4. Measured: **1 668 raw differences, 1 600 resolved
      mechanically (95,9%), 68 surviving**. Every resolved difference is stored with the
      normalisation that resolved it and **no agent run**, so "the model never saw these" is a
      query rather than a claim
- [x] `classify-diff` labels `noise` (with a reason from a closed list) vs `behaviour_change`
      (with a Czech explanation) — **one model run per finding, not per difference**: 4 runs
      for 68 differences
- [x] Decision queue screen with side-by-side, the agent's reasoning and three actions;
      `oracle_state` moves to `shadow` and the blocker to `čeká na rozhodnutí`. The procedure
      screen's shadow tab ships the per-run numbers and findings but **no chart over time** —
      one run is not a series, and absent beats simulated
- [x] **400 replayed calls covering 27 of 27 observed strata, both passes, in 16,2 s** —
      40,5 ms per case

`make shadow-db` after `make traffic`, then `make shadow-run`: 400 cases, 18 s, 4 findings.

**The 2 000-call target is superseded** — see `docs/DECISIONS.md`. Two thousand calls drawn by
volume are the same handful of branches repeated; 400 drawn by stratum cover every behaviour
the estate was observed taking, and the honest figure is the one reported.

**The planted promo/VAT defect surfaces as `behaviour_change` in 32 of 400 cases** — a
minority, so a finding rather than a broken implementation — while `TotalNet` never diverges,
which is precisely why fifteen years of self-consistency checks never saw it. A second,
unplanted finding came out of the same run: the hand-written service uses binary floating
point, and 18 of 400 orders land exactly on a rounding boundary where SQL Server's decimal
arithmetic rounds the other way.

`make verify-m5` — **63 checks**. Asserts the shadow database is a real copy and that the
principal owning it is refused the estate outright, that the estate is byte-identical after a
full replay and gained no capture rows, that every replayed case traces to a real sampled
invocation with byte-identical inputs, that the majority of differences are resolved in code
and none of those carries an agent run, that there is one model run per finding, that the
promo/VAT defect surfaces as `behaviour_change` in a minority of cases while `TotalNet` does
not, that no monetary difference is ever called noise, and that the queue's three buttons
record a decision, and that the queue shows only the newest run's findings rather than
every run's. Two probes supply the controls: `probe-shadow` replays the procedure
against itself and surfaces **nothing**, while adding one unit to a single value surfaces
exactly one difference; `probe-decision` puts a live agent up against the tier table and
asserts the hook refuses it and nothing is written.

**Gate order, again:** `demo-reset → map-estate → verify-m3 → generate-oracles → verify-m4 →
shadow-db → shadow-run → verify-m5`. `verify-m4` asserts `oracle_state` is `golden` or
`invariants`, which stops being true once a shadow run promotes it to `shadow`. `verify-m5`
deliberately does **not** run `demo-reset` — it would take M3's and M4's live sweeps down with
M5's run.

## M6 — Service and PR
- [x] `implement-service` generates `pricing-service` (Node + TS + Fastify) — **two attempts,
      $2.23 + $1.70**. Attempt 1 failed all 17 golden cases on one T-SQL error: it bound
      `@totalNet`/`@totalVat`/`@totalWithVat` and then `DECLARE`d `@TotalNet`/`@TotalVat`/
      `@TotalWithVat` in the same batch, and T-SQL identifiers are case-insensitive. Given that
      cause, attempt 2 passes **17/17**
- [x] Monolith calls it behind a feature flag; both paths runnable — `x-parity-pricing: service`
      per request, defaulting to the procedure. The flagged path is **not** written to the
      capture: a call that never reached a procedure is not a procedure invocation
- [x] Shadow run against the new service goes green after the human decision — **400 cases,
      27/27 strata, 20 s. 1 600 raw differences, all 1 600 resolved in code, 0 surviving,
      0 findings** — against the reference implementation's 1 668 raw / 68 surviving / 4 findings
      on the identical case set
- [x] `open_pr` opens a real PR on GitHub with spec, tests, service and the recorded decision
      attached — **exercised for real once**, [PR #9](https://github.com/secho/parity-workspace/pull/9):
      one commit, five files, over the Git Data API from a container with no checkout of the
      repository. Assembling and opening are separate acts, and opening needs `--commit`: the
      tier table refuses `open_pr` to every task class, so the thing that opens one always has a
      person behind it, and `verify-m6` therefore never opens one

**Left for M7:** `make demo-reset` does not yet close the PR or delete its remote branch. The
`pull_requests` row stores both the branch and the number precisely so that it can — M7's
checklist already names "including remote branches and PRs".

**The hand-written service from M5 stays, as the reference implementation.** It was recorded as
a stub for M6 to replace; it is now permanent, and it is the harness's positive control — the
only implementation that diverges from the procedure, and therefore the standing proof that the
diff engine can still find a real behavioural difference. A green run against the generated
service means nothing on its own; it means something beside a red one from the same harness, the
same cases and the same database. `shadow_runs.implementation_id` is what lets `verify-m5` pin to
`reference` and `verify-m6` to `generated`.

Why the inversion: the M3 spec **documents the planted VAT defect in full** — `Chování` §12 gives
the stacking formula, `Otevřené otázky` flags it by name. So a spec-faithful generated service
reproduces the defect and goes green on the first try. It cannot be the source of beat 4's
findings, and what it would produce instead is a scatter of accidental divergences that differ on
every generation. See `docs/DECISIONS.md`.

The agent writes `pricing.ts` and `persist.ts`. `index.ts` and `db.ts` are the shadow harness's
contract — the replay route, `/health`, and the `/_admin/disconnect` handshake — and stay
platform-owned. Said out loud rather than hidden.

`make verify-m6` — asserts the service passes all golden tests, the feature flag switches cleanly,
a PR is assembled with all four attachments, and — the load-bearing one — that the artefact hash
the deployed service reports at `/health` is the one the agent wrote, so "what ran is what the
agent wrote" is a query across two systems rather than a claim.

**Gate order, once more.** The reference shadow run must come BEFORE the generated one:
`latestRunIds` scopes the decision queue to the newest succeeded run per procedure, so a reference
run afterwards re-fills the queue with findings that have already been decided.

```
demo-reset → map-estate → verify-m3 → generate-oracles → verify-m4
  → shadow-db → shadow-run IMPL=reference → verify-m5
  → implement-service → adopt-service → shadow-run IMPL=generated → verify-m6
```

## M7 — Campaigns, reset, replay — **done**, `make verify-m7` 70/70

The milestone that turns the lane from *done once* into *demonstrable*. Jan's ask, in his words:
start a process that runs triage, spec, oracle, shadow run and decisions **on another procedure**,
live, in the room — including showing how the service is made — without resetting all of Parity
each time.

- [x] Campaign runner + `Zmapovat estate`, `Migrovat proceduru` and `Smazat mrtvé procedury` —
      three definitions **in code**, one `campaign_runs` row per run with the item states it is
      the only record of. Fire-and-forget: the POST returns the row in **6 ms** and the screen
      polls, because `Zmapovat estate` is ten minutes and Vite's proxy kills a request long
      before that. A second start is refused 409
- [x] **Campaigns skip what is already done.** Ten lines that do three things: make a campaign
      safe to re-run in rehearsal, idempotent for the gate, and honest on stage — a full mapping
      is 28 model runs and $7.12, which does not fit in a two-minute beat and never will. On a
      mapped estate the same button reports **14 přeskočeno in 266 ms** and spends nothing
- [x] Deletion campaign assembles a PR removing the 3 dead procedures — three tree entries with
      `sha: null`, no additions, `procedure_id` NULL because it belongs to no single procedure.
      **Assembled, not opened**: the tier table refuses `open_pr` to every task class, so
      `make open-pr PROC=deletion --commit` is the human act
- [x] `Provoz` page: skills, policy tiers, audit log — and the audit log now renders **four**
      outcomes rather than two. `denied` and `failed` had been drawing a green *povoleno* chip,
      which is the opposite of what happened, on 54 of 521 rows
- [x] **A second procedure through the whole lane.** `sp_GetCartSummary`: service written by the
      agent ($1.39), 11/11 golden against it, 279 captured calls replayed over 18 of 18 strata,
      zero differences. Two result sets and an empty write set **on both sides, measured** from
      Change Tracking rather than asserted
- [x] Every agent and shadow run recorded; `PARITY_MODE=replay` serves them at the original
      cadence, scaled by `PARITY_REPLAY_SPEED`. Measured at speed 10: **30.2 s against a
      recorded 30.1 s**, nine of nine steps identical in order, `cost_usd` NULL, the estate's
      total spend unmoved, and both database fingerprints exactly where they were
- [x] `make reset-procedure PROC=x [KEEP_SERVICE=1]` — one procedure back to nothing analysed in
      **105 ms**, with every one of the other procedure's row counts identical across all
      fourteen artefact tables
- [x] A recorded golden run committed to the repo — `scripts/golden-run.sql.gz`, **14 897 rows
      across 20 tables, 3.1 MB gzipped**, with `make record-golden` / `replay-check` /
      `restore-golden` as one mechanism

**Two things came out differently from the plan, and both are better.**

`sp_GetCartSummary` earned `proven` on its first green run — and should not have. It has no
hand-written reference implementation, so the condition "every difference the reference run found
has been decided" quantified over an empty set and passed **vacuously**. `promoteAfterShadow` now
also requires a succeeded `reference` run, and the procedure sits at `shadow` with the blocker
`čeká na rozhodnutí`. That is the better demo: a rung the machine declines to climb on its own.

**`make demo-reset` still does not close the PR or delete its remote branch**, and that is now
deliberate rather than deferred. Everything else the reset touches is inside Postgres and comes
back from the snapshot in two seconds; a remote branch is outside it. The `pull_requests` row
stores the branch and the number so it remains possible — it is one `gh` call away — but it is
the one act in this platform that reaches outward, and reset is the wrong place for it.

`make verify-m7` — 70 checks in nine sections. It **spends nothing**: the reset and the
per-procedure reset are exercised by running the real code inside transactions that are rolled
back, campaigns by running the one campaign that makes no model call, replay by replaying — and
the gate asserts the estate's total spend did not move and that both replays were removed again,
so it leaves the database exactly as it found it.

```
verify-m6 → implement-service PROC=sp_GetCartSummary → adopt-service PROC=sp_GetCartSummary
  → service-suite PROC=sp_GetCartSummary TARGET=service
  → shadow-run PROC=sp_GetCartSummary "" generated → record-golden → verify-m7
```

The 120-second full reset is measured by hand rather than by the gate: `make demo-reset &&
make restore-golden`, which is a reset plus a 3.1 MB restore. Putting it inside the gate would
mean every acceptance run destroyed and rebuilt $16 of live analysis.

## M8 — Rehearsal
- [ ] `docs/DEMO-SCRIPT.md` runs start to finish, three times consecutively, from `make demo-reset`, with no intervention
