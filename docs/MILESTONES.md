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
- [ ] `generate-oracle` produces golden tests from captured invocations
- [ ] Invariants proposed for `sp_CalculateOrderTotal` (total identity, non-negative, VAT rate table)
- [ ] Golden tests execute against the current procedure and pass
- [ ] Coverage number on Estate is real and **invocation-weighted**

`make verify-m4` — asserts golden tests exist and pass for at least 8 procedures, coverage math is weighted not counted.

## M5 — Shadow harness  ⚠ the hard one
- [ ] Snapshot database restore; replay runs in a transaction that always rolls back
- [ ] Result-set and write-set diffing
- [ ] Canonicalisation **in code before the model sees anything**: stable sort, float tolerance, timestamp and GUID normalisation via seam
- [ ] `classify-diff` labels `noise` (with reason) vs `behaviour_change` (with explanation)
- [ ] Decision queue screen with side-by-side and three actions
- [ ] 2 000+ replayed calls of `sp_CalculateOrderTotal` in under 60 s

`make verify-m5` — asserts a full shadow run completes, production DB is provably untouched, noise ratio is realistic, the planted promo/VAT bug surfaces as `behaviour_change`.

## M6 — Service and PR
- [ ] `implement-service` generates `pricing-service` (Node + TS + Fastify)
- [ ] Monolith calls it behind a feature flag; both paths runnable
- [ ] Shadow run against the new service goes green after the human decision
- [ ] `open_pr` opens a real PR on GitHub with spec, tests, service and the recorded decision attached

`make verify-m6` — asserts the service passes all golden tests, the feature flag switches cleanly, a PR URL is produced.

## M7 — Campaigns, reset, replay
- [ ] Campaign runner + `Zmapovat estate` and `Smazat mrtvé procedury`
- [ ] Deletion campaign opens a PR removing the 3 dead procedures
- [ ] `Provoz` page: skills, policy tiers, audit log
- [ ] `make demo-reset` returns everything to pristine in under 2 minutes, including remote branches and PRs
- [ ] Every agent and shadow run recorded; `PARITY_MODE=replay` serves them with original timings
- [ ] A recorded golden run committed to the repo

`make verify-m7` — asserts reset completes under 120 s and leaves zero Parity state, replay mode produces identical output to the recorded live run.

## M8 — Rehearsal
- [ ] `docs/DEMO-SCRIPT.md` runs start to finish, three times consecutively, from `make demo-reset`, with no intervention
