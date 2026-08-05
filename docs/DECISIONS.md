# Decisions log

Append-only. One entry per non-trivial choice: what, why, and what it rules out. Claude Code writes here during the build; so does Jan.

Format: `## YYYY-MM-DD · short title` then 2–4 lines.

---

## 2026-08-05 · Platform is named Parity
The name carries the central claim — prove behaviour is unchanged before replacing anything. Rules out generic naming like "AI SDLC platform", which is a category rather than a product.

## 2026-08-05 · Node + TypeScript across the whole build
One language for monolith, services, platform and traffic generator. Rules out .NET, which would be closer to Alza's real shape but costs build time that is better spent on the shadow harness. The authenticity that matters — MS SQL and T-SQL — is untouched.

## 2026-08-05 · MS SQL Server 2022 in Docker, not Postgres
T-SQL procedures on screen are the strongest authenticity signal available. Postgres would be more convenient and would immediately read as an exercise.

## 2026-08-05 · Agent built on the Claude Agent SDK with an API key
Anthropic's Agent SDK docs prohibit claude.ai subscription auth for products built on the SDK unless previously approved, and this repo is public. Rules out `claude setup-token` workarounds.

## 2026-08-05 · Parity is a client of a gateway, never a gateway itself
Alza already runs LiteLLM. A thin `LLMProvider` interface with an OpenAI-compatible second implementation keeps "point it at your gateway" literally true as a config change.

## 2026-08-05 · Write-set capture via SQL Server Change Tracking
Chosen over trigger-based shadow tables for time. Rules out per-table trigger maintenance; accepted limitation is row-level rather than statement-level granularity, which is sufficient for diffing.

## 2026-08-05 · `blocker` is derived, never stored
Computed from `oracle_class` + `oracle_state` + `domain`. A stored blocker can drift from reality and then lies on the main screen — the same failure the DSL rule in the presentation warns about.

---

# M0

## 2026-08-05 · One git repository at the workspace root
`SPEC.md` §2 says "two repositories", `README.md` says `git init` in each app, but `SCHEDULE.md` uses `git worktree add`, which only works with a single repo — and `SPEC.md` §9 makes `SCHEDULE.md` win on scope disagreements. One `main`, milestone branches, path-scoped PRs. Rules out separate GitHub remotes per app; M6/M7 open PRs against this repo at the `parity-platform-demo-app/` path. The "Parity never imports the demo app's code" rule is a source-dependency rule and is unaffected.

## 2026-08-05 · MS SQL Server 2022 runs under amd64 emulation on Apple Silicon
Measured before writing any code: boot ~35 s, 100 000 rows into a 70-column table in 0.7 s, 2 000 stored-procedure calls in 0.94 s. M5's target of 2 000 replays in under 60 s therefore has roughly 60× headroom at the database layer. Rules out falling back to `azure-sql-edge`, which is arm64-native but a retired product with feature gaps that would put M1's Change Tracking at risk.

## 2026-08-05 · `sp_SyncWarehouseDispatch` calls out via Database Mail, not HTTP
Outbound HTTP from T-SQL is impossible on SQL Server for Linux: `xp_cmdshell` does not exist (`sp_configure` rejects the option outright), `sp_OACreate` is Windows-only, `sp_invoke_external_rest_endpoint` is Azure-only, and CLR on Linux is SAFE-only. `skills/triage.md` defines `external` as "HTTP, linked server, **mail**, message queue", so mail qualifies. The procedure sends dispatch orders through `msdb.dbo.sp_send_dbmail` to a `mailpit` container, verified end to end. Better than HTTP for the demo: a sent email cannot be rolled back, which is a sharper reason the procedure cannot be shadowed. Rules out adding a second SQL Server container for a linked server.

## 2026-08-05 · Fixed `DEMO_EPOCH` of 2026-08-05, no wall-clock reads
Every seeded date derives from one constant and a seeded PRNG; `Math.random()` and argument-less `new Date()` appear nowhere in the seed. Verified by reseeding twice and comparing `CHECKSUM_AGG` fingerprints, which `make verify-m0` now asserts against a committed `scripts/seed-checksum.json`. Hard rule 5 made executable rather than aspirational. If the demo date slips, bump the constant and re-seed.

## 2026-08-05 · `OrderLedger` is one row per order line
`SPEC.md` §3 says "order lines denormalised" with order-level columns repeated. The alternative reading — line data flattened into columns — would need `Line1..Line40` to hold the 40-line rare branch. 5 000 orders produce 16 214 line rows. Consequence, and the point: caching one order total means updating every line of that order, which is why `sp_CalculateOrderTotal` writes far more rows than it computes.

## 2026-08-05 · All 11 live-procedure routes in M0; dead procedures get none
M1 is the milestone `SPEC.md` §8 flags as the hard one. Moving the monolith's route surface into M0 leaves M1 with capture and the traffic generator only. The three dead procedures are referenced nowhere under `monolith/src/`, which makes "exactly zero invocations" a structural guarantee rather than an observation — `make verify-m0` asserts their absence.

## 2026-08-05 · Column write-overlap designed explicitly, asserted from the engine
Six procedures write `Catalog`, five write `OrderLedger`, per `SPEC.md` §3. The sharpest pairs are deliberate: `sp_ApplyPromoCode` and `sp_LegacyPriceImport_v2` both write `Catalog.PriceWithDiscount` and `DiscountPct` with different formulas; the dead `sp_MigrateCustomerAddresses` writes the `OrderLedger` snapshot and address columns that the hot `sp_PlaceOrder` owns. `make verify-m0` reads `sys.dm_sql_referenced_entities(..., 'OBJECT')` filtered to `is_updated = 1`, so the assertion comes from SQL Server's own column-level dependency data and cannot be satisfied by documentation. The matrix is deliberately not committed inside `parity-platform-demo-app/`, so M2 has to parse it out of the T-SQL.

## 2026-08-05 · Write overlap is asserted by execution, not by static analysis
`sys.dm_sql_referenced_entities` looked like the perfect source of column-level write truth, straight from the engine. It is not: it silently drops any statement it cannot bind at analysis time, which includes every `UPDATE ... FROM #temp` — and the gnarliest procedures in this estate are exactly the ones that use temp tables. It under-reported `Catalog`'s writers as 4 when the T-SQL genuinely has 6. `make verify-m0` therefore runs each procedure, fingerprints the watched columns before and after, and reseeds afterwards. Behaviour cannot lie in that direction, and it rehearses the mechanism M5's shadow harness needs.

## 2026-08-05 · Fingerprints use `SUM(CHECKSUM(col))`, never `CHECKSUM_AGG`
`CHECKSUM_AGG` is XOR-based, so repeated identical values cancel pairwise. On a freshly seeded `OrderLedger` where 16 000 rows share a value, the aggregate is 0 and small write sets vanish: updating three rows of `TotalWithVat` left it bit-identical while `SUM` moved. This affected both the write probes and the determinism fingerprint that enforces hard rule 5, so both now sum per-row checksums. Worth remembering for M5's canonicalisation — the same trap is waiting there.

## 2026-08-05 · `OrderLedger` ends up with six writers, not the five SPEC §3 predicts
`sp_SyncWarehouseDispatch` writes the dispatch and status columns as well as `Catalog` stock, which SPEC's prose did not count. Kept rather than trimmed: removing the write to hit a number in descriptive text would weaken the coupling graph for no gain. `verify-m0` asserts "5 or more". `Catalog` is exactly 6 as specified.

## 2026-08-05 · The shop exposes the write side, not just browsing
`SCHEDULE.md` cut the storefront to list, detail and cart because the choreography never opens it. Reopened deliberately, at Jan's request, so the shop can be used to explain that the estate genuinely works and how: checkout now calls `sp_PlaceOrder`, and the order screen calls `sp_CalculateOrderTotal` and `sp_SyncWarehouseDispatch`, each button labelled with the procedure behind it. Two thin reads were added to support it — `GET /api/customers` (the shop has no login, so checkout picks a seeded customer, and the loyalty tier is what makes the pricing branches differ) and `GET /api/orders/:orderNumber` (no procedure in the estate reads an order back). Traffic still goes over HTTP for M1; nothing about the capture seam changes. Note that using the shop mutates the estate, so `make seed` is needed before `make verify-m0` will pass its exact row counts again.

## 2026-08-05 · Dropping the database has to survive a live application
`make seed` drops and recreates `ParityShop`, and `SET SINGLE_USER WITH ROLLBACK IMMEDIATE` is not sufficient: it permits one connection, and the running shop-api's pool reclaims that slot before `DROP` executes. The failed drop then leaves the database stuck in SINGLE_USER with the app holding the slot, where even `ALTER DATABASE` is refused and recovery needs a manual `KILL`. Taking it OFFLINE instead avoids the race but is worse — dropping an offline database leaves its files on disk, so the next `CREATE DATABASE` fails on duplicate filenames. The working form kills sessions, then does SINGLE_USER plus DROP in the same batch, retrying up to ten times and always restoring MULTI_USER on failure. Verified by reseeding five times consecutively with the whole stack up. M2's `demo-reset` depends on this being reliable rather than usually-fine.

## 2026-08-05 · Shop ports moved to 3100 / 5180
Port 3000 was already held on the build machine by an unrelated dev server bound to the IPv6 loopback, and because `localhost` resolves to `::1` first, requests silently reached the wrong process while the ParityShop container was healthy. Verify now talks to `127.0.0.1` explicitly. A demo must not depend on who won a port race.

## 2026-08-05 · The planted defect is a VAT-base divergence, not a totals-identity break
In `sp_CalculateOrderTotal`, the branch where a `StacksWithLoyalty` promo meets a loyalty discount computes VAT on `net − promo`; every other branch computes it on the full net. The two differ by exactly `promo × vat`. It does **not** break the procedure's own `TotalWithVat = TotalNet + TotalVat` identity, so it is invisible to any self-consistency check and is only findable by comparing VAT against the rate table — which is one of the three invariants `SPEC.md` §4 has M4 propose for this procedure. Nothing in the source marks it.

## 2026-08-05 · Agent must not be able to read its own answer key
docs/SPEC.md states every procedure's oracle class, which three are dead,
and where the planted bug is. If the agent can read it, triage is theatre
and one question in the room exposes it. All procedure knowledge must come
through read_procedure and query_capture only.
---

# M1

## 2026-08-05 · Capture records ambient values, not just input parameters
Eleven of the fourteen procedures read the ambient clock and **four branch on it**: `sp_CalculateOrderTotal:123` and `sp_GetCartSummary:86` test promo validity against wall-clock time, `sp_ApplyPromoCode:65` does the same for its validity window, and `sp_RecalculateCustomerScore:109` gates the dead 2019 campaign multiplier. A procedure's output is therefore a function of *when it ran*, not only of its inputs. Without recording that, a shadow run of any time-branching procedure lands in a different promo-validity regime than the capture did and reports a `behaviour_change` that never happened — the oracle becomes worthless, and worse, it becomes confidently wrong. `parity_capture.Invocation.Context` records the ambient values the procedure could read (server `GETDATE()`, `SYSDATETIME()`, `SYSUTCDATETIME()`, `@@DATEFIRST`, `@@LANGUAGE`), taken in the same round-trip as the Change Tracking version so they agree.

Three distinct clocks now live in the capture table and must never be conflated: `CalledAt` is the *simulated* timeline the traffic generator invents to produce 90 days of history in one run; `RealCalledAt` is the wall clock; `Context.getdate` is what the procedure actually read. Only the third one drives behaviour. A consequence worth stating: because the generator backdates `CalledAt` but `GETDATE()` still returns today, the captured promo-validity branches reflect the real date, not the simulated one. That is honest — the procedure really did run today — but it means the branch mix depends on when the demo runs. `VERNY20`, which carries the planted defect, is valid to 2026-12-31; `verify-m1` asserts the stacked-promo branch actually fires, so if the demo slips past that date the failure is loud rather than silent.

`GETDATE()` cannot be overridden inside T-SQL without editing the estate, which is off limits. So the pin lands in the replacement service's injected clock at M6 — M1's job is only to make sure the value was recorded, so that pinning is possible at all.

## 2026-08-05 · Clock and identifier use is classified by *how* it is used, not whether it appears
`skills/triage.md` now distinguishes a clock or GUID written only into a timestamp or identifier column — normalisable, procedure stays `det_write` — from one used in a branch condition or in arithmetic, which makes it `nondet`. Triage must say which of the two it found and quote the line. This overrides the standing "prefer `nondet` when uncertain" rule, which now applies only when the distinction genuinely cannot be made. Without it, 11 of 14 procedures touch `GETDATE()`/`NEWID()` — mostly for audit timestamps — so triage would mark almost the whole estate `nondet`, the blocker table would be one undifferentiated column, and the Estate screen would stop telling the story the demo depends on.

Consequence to watch at M3: by this rule `sp_CalculateOrderTotal` reads the clock in a *branch condition* at line 123, so an honest triage classifies it `nondet`, while `SPEC.md` §3's table calls it `det_write` and makes it the migration target. Both are defensible — it is `det_write` **given a pinned clock**, exactly as `sp_PlaceOrder` is shadowable given a seam. If the Estate screen shows `nondet` there, that is the rule working, not a bug, and the answer in the room is that the seam is the injected clock.

## 2026-08-05 · Write-set extraction is two-phase, and the reason is a 80× difference
The obvious form is one query joining `CHANGETABLE`, the base table and `FOR SYSTEM_TIME AS OF` for all twelve tracked tables. It is also unusable: `AS OF` unions the base table with its history, so every capture scanned every table whether or not it had changed. Measured at ~3 s per captured call against 38 ms for a single table in isolation, which put a 3 000-call traffic run past ten minutes. Phase 1 now asks Change Tracking alone which rows and columns changed — it never touches a base table — and phase 2 fetches row images only for the one to five tables that actually changed, filtered by primary key so both the base table and the history can seek. Same output, ~40 ms per captured call.

## 2026-08-05 · Traffic is planned before it is issued, with exact per-procedure counts
The whole call plan is built from the seeded PRNG up front, then executed. Nothing about the plan can depend on how fast the server answered or which request finished first. Counts per procedure are exact — computed as a deficit against a target and then shuffled with a seeded Fisher-Yates — rather than sampled independently from weights, so `verify-m1` can assert equality between two runs instead of a tolerance band, and so the session mix cannot quietly skew the distribution.

## 2026-08-05 · Writes are issued in a single serial lane; reads run concurrently
A captured write owns the Change Tracking version window, so a concurrent write from any other call lands in its write set. Reads are ~70% of traffic and never write, so they run at concurrency 24 while writes go through one lane. Running writes concurrently would be faster but would let stock-depletion order vary between runs, which changes which backorder branches fire — and hard rule 5 outranks throughput. The serial lane is what sets total volume: 40 000 calls, sized so the run fits SPEC's ~3 minute budget.

## 2026-08-05 · Sampler state must be reset with the database
The sampler's per-procedure counters and its set of already-seen branch keys live in the monolith's memory, and `make seed` drops the database without touching them. A second `seed && traffic` therefore inherited the first run's counts, sampled differently, and produced different numbers — two branches went entirely unsampled because they had been "seen" during an earlier run. The traffic generator now calls `POST /api/_capture/reset` before issuing anything, which also clears the cached column metadata, since column ids are not stable across a reseed. Caught by `verify-m1`'s own determinism check rather than in the room.

## 2026-08-05 · verify-m1 flushes the capture buffer before counting
Capture rows are batched in memory for throughput. An early run of the acceptance script counted 1 736 captured `sp_CalculateOrderTotal` invocations against a real figure of 2 126, purely because it read while the recorder was still draining, and would have failed the M5 precondition for no reason. Verify now flushes first. A test that races the thing it measures reports noise, and noise in an acceptance gate is worse than no gate.
