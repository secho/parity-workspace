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
- [ ] Change Tracking enabled; every procedure call records inputs, result set, **write set**, duration
- [ ] Sampling policy: full for first 200 calls per proc, then 1-in-50, always on uncovered branches
- [ ] Traffic generator produces 90 days of history in one run, power-law distributed
- [ ] Rare branches present: leap day, negative stock, Slovak VAT, stacked promo, 40-line order
- [ ] The 3 dead procedures have exactly zero invocations

`make verify-m1` — asserts capture rows exist for all live procs, write sets non-empty for `sp_ReserveStock` across 4 tables, dead procs at zero, distribution is power-law.

## M2 — Estate ingestion
- [ ] Parity app shell: sidebar, Postgres schema, Drizzle migrations
- [ ] Ingest procedures from MS SQL: name, source, line count, invocation counts
- [ ] Column-level `reads[]` / `writes[]` parsed from T-SQL; data-coupling graph built
- [ ] `blocker` is a **derived property**, never stored
- [ ] Estate screen live: totals, invocation-weighted coverage, status bar, blocker breakdown, sortable table

`make verify-m2` — asserts 14 procedures ingested, coupling graph has cross-procedure column overlaps, blocker values are computed not persisted.

## M3 — Agent, skills, spec
- [ ] Agent SDK wired, `ANTHROPIC_API_KEY`, `settingSources: ['project']`
- [ ] `parity/skills/*.md` loaded as real files and listed in the UI
- [ ] Audit log populated from `PostToolUse` hooks; policy gate on `PreToolUse`
- [ ] `triage` classifies all 14 into oracle classes correctly
- [ ] `extract-spec` produces a readable Czech spec; run it over all 14
- [ ] Procedure detail screen: source, spec, agent steps streaming via SSE
- [ ] Agent runs with cwd in an isolated scratch dir, NOT the workspace root
- [ ] settingSources points only at parity/skills/ — never the whole project
- [ ] docs/ is unreachable from the agent's file tools; verify-m3 asserts
      that a prompt asking the agent to read docs/SPEC.md fails

`make verify-m3` — asserts every procedure has an `oracle_class` and a `Spec`, audit log has rows for every tool call, a deliberately over-tier action is blocked by the hook.

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
