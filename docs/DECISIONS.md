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

## 2026-08-05 · The replay assertion compared a constant to itself
Caught by the reviewer, and a defect in the acceptance gate rather than in the estate. `sp_CalculateOrderTotal` contains no `SELECT` — it reads into variables and updates `OrderLedger` — so its result set is always empty and its `ResultSetHash` is one constant across every invocation: measured 1 distinct hash across 2 363 rows. The check "pinned-clock replay reproduces the captured result exactly" therefore compared that constant to itself and could not fail. It would have passed with the VAT computation completely broken, on the milestone's own headline criterion, and it was introduced while *strengthening* a check judged too weak.

The assertion now compares what the procedure actually outputs: the money it writes. Verify issues a fresh captured call, reads `TotalNet`/`TotalVat`/`TotalWithVat`/`DiscountAmount` out of the captured write set, replays inside a rolled-back transaction and compares to the cent. Capture and replay run back to back against identical state — reusing an older captured invocation would be unsound, because later traffic may have applied a promo to the same order and any difference would mean nothing. Worth carrying into M4 and M5: for a procedure with no result set, a result-set hash is not evidence. The write set is the output.

## 2026-08-05 · Branch coverage must resolve what the procedure looks up for itself
Also from the reviewer. The `BranchKey` proxy was derived from call parameters alone, but `sp_CalculateOrderTotal` takes only `(OrderNumber, PromoCode, ModifiedBy)` and `sp_GetCartSummary` takes `(CartItems, CustomerID, PromoCode)` — and both branch on the customer's **country** (CZ 21% vs SK 20% VAT) and **loyalty tier**, resolved by a `SELECT` inside the procedure body. A Slovak tier-4 order and a Czech tier-0 order therefore shared one branch key, so "always capture on an uncovered branch" quietly stopped covering the two branches the demo depends on. It was masked by `sp_CalculateOrderTotal`'s raised cap, not avoided. A 500-row customer-facts cache is now consulted synchronously when building the key, and cleared on reset with everything else that outlives a reseed. `verify-m1`'s rare-branch check also asserts `Sampled = 1` rather than mere existence: an unsampled rare branch carries no result set and no write set, so M4 and M5 cannot use it.

## 2026-08-05 · SPEC's 200 MB capture bound is now measured
SPEC §3 requires the capture table stay under ~200 MB and nothing checked it — the design made it very likely true, which is not the same as verified. `verify-m1` now measures it from `sys.allocation_units`.

---

# M2

## 2026-08-05 · Parity keeps its own Postgres, on host port 5433
SPEC §4 puts Parity's state deliberately outside the database it analyses; the port is the
part worth recording. 5432 was already taken on the build machine by an unrelated Postgres,
and M0 already lost half an hour to a port race on 3000. Rules out sharing the demo app's
MS SQL for convenience, which would have quietly destroyed the "could be pointed at Alza's
real estate tomorrow" claim — Parity would own tables inside the estate it audits.

## 2026-08-05 · reads/writes come from a text parser, not from the engine
`sys.dm_sql_referenced_entities` is the obvious source of column-level truth and M0 already
proved it unusable: it silently drops any statement it cannot bind, which is every
`UPDATE ... FROM #temp`, and the gnarliest procedures are exactly the ones with temp tables.
The parser resolves every identifier against `INFORMATION_SCHEMA`, so it cannot invent a
table and `#ReserveLines`, `FROM DATETIME2` and `FETCH NEXT FROM score_cursor` need no
special case. It finds 6 writers on `Catalog` and 6 on `OrderLedger`, matching what M0
observed by execution. Anything it cannot parse — a `MERGE`, say — aborts the ingest rather
than under-reporting, because an absent coupling edge looks exactly like a non-existent one.

## 2026-08-05 · The parse is graded against reality, not against itself
`verify-m2` reads M1's captured write sets and asserts every `Table.Column` the estate was
*observed* to write appears in that procedure's parsed `writes[]`. Costs nothing, mutates
nothing, and cannot be satisfied by a parser that merely looks right. This is the check that
makes the coupling graph evidence instead of decoration.

Two adjustments make it sound rather than approximately true. IDENTITY columns are excluded:
the engine writes them and the source names them nowhere, so the parser correctly cannot see
them. And the comparison uses the **EXEC closure**, not direct writes — `sp_PlaceOrder`
orchestrates three other procedures, so its captured write set legitimately contains theirs.
Without the call graph that reads as 34 parser gaps. The call graph is worth having anyway:
it is the difference between "this procedure writes 87 columns" and "this procedure writes 53
and delegates the rest".

## 2026-08-05 · Dynamic SQL is parsed out of the string literals
`sp_SearchProducts` builds its entire query as a string and hands it to `sp_executesql`, so
blanking string literals — which every other part of the parser depends on — would report the
estate's second-hottest procedure as touching nothing. That would be a lie about 29% of all
traffic on the main screen. String literals that name a real table and read like SQL are
parsed too, and everything found that way is flagged `inferred`: the parser cannot prove which
branches concatenate at runtime and should not pretend otherwise. Recovers 21 `Catalog` columns.

## 2026-08-05 · One captured row is contaminated, and the gate says so out loud
`sp_CalculateOrderTotal` has `Catalog.SoldCount` in exactly one of 2 363 captured write sets,
and only `sp_PlaceOrder` writes that column. Change Tracking unions the column mask across
every change to a row since the capture's version, so a concurrent `sp_PlaceOrder` — almost
certainly `verify-m0`'s probe, which talks to MS SQL directly and bypasses the monolith's
write lock — landed inside the window. M1 documents that the window can absorb one.

The gate distinguishes the two cases rather than widening to accommodate this. A column
observed **more than once**, or one that no procedure in the estate writes, is a parser gap
and fails. A column observed exactly once that some *other* procedure writes is reported as
residue with its count. Loosening the assertion to make it pass would have hidden the next
real gap; deleting the row would have hidden the fact that concurrency can do this at all.

## 2026-08-05 · Ingestion excludes `CallerContext LIKE 'verify:%'`
The same filter `verify-m1` applies to itself. Without it, running an acceptance gate moves
the numbers on the Estate screen — precisely the drift hard rule 5 exists to prevent.

## 2026-08-05 · Ingest refreshes estate facts; only `demo-reset` touches analysis
`make ingest` upserts source, line counts, invocation counts and the parsed graphs, and
deliberately leaves `oracle_class`, `oracle_state`, `campaign_status` and `domain` alone.
Re-reading the source should not cost a run's worth of agent work. `make demo-reset` truncates
everything and re-ingests, because beat 1 of the demo opens on fourteen procedures with
coverage near zero — an empty screen is the wrong resting state. Rules out a single
destructive ingest, which would have made M3 unable to re-read the estate without redoing
triage.

## 2026-08-05 · Coupling is ranked by how narrow the sharing is
The first coupling view was dominated by `ModifiedAt` and `ModifiedBy` — every writer touches
them, so the genuinely interesting collisions were buried under bookkeeping. Sorting by the
number of procedures that write each column puts `Catalog.LastQuotedPrice` and
`OrderLedger.TotalNet` at the top and audit columns at the bottom. A column six procedures
write is an audit column; a column exactly two write is a fight nobody wrote down. Computed,
never a hardcoded list of column names — Parity has to stay pointable at an estate whose
naming conventions it has never seen.

## 2026-08-05 · `blocker` is asserted derived in two independent ways
Absence of a stored column is necessary but not sufficient — a cached value computed once at
ingest would pass that check and still drift. `verify-m2` also flips one procedure's
`oracle_state` directly in Postgres and asserts the blocker the API returns changes with it,
then restores. The same probe proves coverage is invocation-weighted rather than counted:
flipping `sp_GetProductDetail` moves coverage to 11,48%, its real share of traffic, where a
per-procedure count would have said 7,14%.

## 2026-08-05 · Parity connects to ParityShop as `parity_reader`, not as `sa`
Raised by the reviewer: three places described the link as a "read-only connection" while
the credential was unrestricted. The whole separation argument — Parity could be pointed at
Alza's real estate tomorrow — rests on what Parity is *allowed* to do, and "it only reads"
is a much weaker answer than "it cannot write". `db/40-parity-reader.sql` creates a login
with `db_datareader` and nothing else, and `verify-m2` asserts all three halves: the login
can read the estate, it can read procedure source, and the engine refuses its UPDATE.

`GRANT VIEW DEFINITION` is the part that is easy to miss. `db_datareader` can read every
table in the database and still gets NULL back from `sys.sql_modules.definition`, which is
the one column the entire ingest is built on. Without it Parity ingests fourteen procedures
with empty source and the failure presents as a parser bug.

## 2026-08-05 · Four reviewer findings in the parser and the gate, all real
Caught before the PR merged, and all four were the same class of defect: something that
looks right and is silently wrong.

**`reads[]` over-reported by ~76 columns.** The write-target ranges that keep a SET target
from also being scanned as a read were computed with `assignment.indexOf(lhs)`, and `lhs` is
a *prefix* of `assignment` — so that is always 0 and every range collapsed onto the first
assignment. `sp_CalculateOrderTotal` listed 15 of its own 17 written columns as reads. The
offset now comes from the split. Writes were never affected, so the coupling graph was right
throughout; the Data tab was not.

**Dynamic SQL dropped the fragments that mattered.** Literals were filtered individually for
"names a real table", but `sp_SearchProducts` assembles its query from pieces —
`FROM dbo.Catalog c` in one literal, `WHERE c.IsActive = 1` and `ORDER BY c.CreatedAt DESC`
in others that never mention a table. Exactly those were discarded. All literals are now
joined so an alias bound by one fragment resolves the columns named in the rest; recovery on
the estate's second-hottest procedure went from 21 columns to 24, including the filter and
sort columns that every single call uses. `SELECT *` is widened too, which
`sp_MigrateCustomerAddresses` needs.

**A gate assertion that could not fail.** "Every written column has exactly one write_owner"
was `HAVING COUNT(*) > 1` over the owned rows — vacuously true if the feature regressed and
nothing was owned at all. The same shape as M1's replay assertion. It now also asserts that
the number of owned columns equals the number of distinct written columns: 124 of 124.

**The CT-residue rule measured the wrong thing.** It counted row-column pairs inside a write
set, not captures, so a single contaminated capture touching two rows would have failed the
build while a genuine one-row parser gap passed. Now counted per capture. A clean
`make seed && make traffic` also took the known residue to 0 of 3056, which confirms the
diagnosis that it came from `verify-m0`'s probe running concurrently with traffic.

## 2026-08-05 · verify-m2 restores its own probe in `finally`
The blocker and coverage checks mutate `sp_GetProductDetail` in Parity's Postgres and put it
back. The restore was a plain statement, so a throw in between — a fetch timeout is the
realistic one — would have left the estate at 11,48% coverage with a `chybí shadow run`
blocker: the wrong picture for beat 1, and a confusing one to debug because the gate that
caused it had already exited. A gate must not be able to damage the thing it measures.

## 2026-08-05 · `make verify-m0` only passes against a pristine seed, and that is not a bug
Re-running the M0 gate after M2's seed change reported 5 436 orders against an expected
5 000 and a drifted seed checksum. Neither is caused by the change: `make traffic` places
real orders through `sp_PlaceOrder`, so the estate legitimately holds more rows afterwards.
M0's own DECISIONS entry already records that using the shop mutates the estate. verify-m0
reseeds on the way out, so running it a second time immediately gives 36/36.

Worth stating plainly because it will happen again on every milestone: the gates are not
independent, and the order is `seed → verify-m0 → traffic → verify-m1 → demo-reset →
verify-m2`. Running verify-m0 in the middle of that sequence destroys the capture data the
later two depend on.

---

# M3

## 2026-08-05 · Skills move to `parity/skills/<name>/SKILL.md`
The Agent SDK discovers skills at `<cwd>/.claude/skills/<name>/SKILL.md` and does not find
flat files, so the layout was not optional. Content is unchanged. Deviates from SPEC §4's
`skills/*.md` wording; the upside is that a skill can now carry supporting files — a VAT
rate table, a worked example — without revisiting the decision at M4.

## 2026-08-05 · The agent's containment is three layers, and the first one is absence
`docs/SPEC.md` states every procedure's oracle class, which three are dead, and where the
planted bug is. The M0 entry already ruled that the agent must not read it. Three
independent things now make that true, in decreasing order of how much argument they need:

1. **`docs/` is not mounted into the container the agent runs in.** The answer key is not
   merely out of reach, it is not in the filesystem. A path restriction can be reasoned
   around; an absent file cannot.
2. **The run workspace is `/tmp/parity-agent/<runId>`, outside `/app`.** This is the one
   that is easy to get wrong: the SDK walks *up* from `cwd` looking for `.claude/`, so a
   scratch directory inside the repository would have inherited the workspace root's
   `.claude/settings.json` — which allows `Bash(*)`. That would have handed the agent a
   shell and a route to everything, silently. Verified: nothing above `/tmp` holds a
   `.claude`, and `/app` has none either.
3. **`allowedTools` grants `Read` and `Write` and nothing else** — no Bash, no Glob, no
   Grep, no web — with `permissionMode: 'dontAsk'`, which denies anything unlisted rather
   than prompting. Every fact about a procedure arrives through `read_procedure` or
   `query_capture`.

`probe-workspace.ts` asserts the structural half on every run of the gate;
`probe-containment.ts` asserts the live half by pointing the real agent at the file.

## 2026-08-05 · Skills are symlinked into each run workspace, never copied
The claim on stage is "update one skill file and every subsequent run picks it up", and
with a copy that is true only in the sense that a rebuild would also make it true. The
workspace links to the same directory the Provoz page lists and a reviewer can edit
between runs, so the claim is demonstrable rather than described.

## 2026-08-05 · The SDK's published TypeScript reference disagreed with the shipped types
Checked before wiring anything, per the plan's own risk list, and three of the shapes the
docs give are wrong in `@anthropic-ai/claude-agent-sdk@0.3.222`:

- `HookCallback` takes `(input, toolUseID, options)`, not `(payload, extra)`.
- Blocking a tool call is
  `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason } }`,
  not a bare `{ permissionDecision: 'deny' }`.
- `HookCallbackMatcher` is `{ matcher?, hooks: HookCallback[], timeout? }`, not
  `{ event, callback }`.

Two shapes turned out better than documented and are now load-bearing for the gate:
`SDKSystemMessage` carries `skills: string[]`, so "the skills really loaded" is an
assertion rather than an inference; and `SDKResultSuccess` carries `permission_denials`,
which is exactly the receipt the over-tier probe needs.

## 2026-08-05 · Per-tool token counts do not exist, so the audit log does not invent them
The SDK reports `usage` and `total_cost_usd` once per run, on the result message. Tokens
and cost therefore live on `agent_runs`; `audit_entries` records tool name, arguments,
result summary, duration and outcome. A plausible-looking per-call token number would have
been the easiest thing in the build to fabricate and the hardest to notice.

## 2026-08-06 · Inference routes through Claude Platform on AWS
Jan's account. Anthropic-operated with same-day API parity, AWS IAM and AWS Marketplace
billing — **not** Amazon Bedrock, which is partner-operated with prefixed model IDs and a
feature subset. The Agent SDK supports it natively: `CLAUDE_CODE_USE_ANTHROPIC_AWS=1` plus
`ANTHROPIC_AWS_API_KEY`, `ANTHROPIC_AWS_WORKSPACE_ID` and `AWS_REGION`. Model IDs are
unchanged, so the skill registry and every model reference stayed put.

Strengthens rather than weakens the deck's "Parity is a client of a gateway, never one
itself" line: the same platform now demonstrably routes three ways — the Anthropic API, a
LiteLLM-compatible gateway, and a cloud provider — on one config line. `llmRoute()` is the
only place that decides, and the badge reports the model the SDK actually used.

Both AWS values are required with no fallback, so `agentReadiness()` checks them up front.
Discovering a missing workspace ID fourteen procedures into a sweep is the wrong place.

## 2026-08-06 · The API Dockerfile must not omit optional dependencies
`--omit=optional` was copied from the monolith's Dockerfile, where it is harmless. The
Agent SDK ships its native CLI as a per-platform optional dependency, so the image built
clean and then failed at the first agent run with `Native CLI binary for linux-arm64 not
found`. Worth remembering when any future service takes an SDK dependency: the flag is a
monolith-specific optimisation, not a house style.

## 2026-08-06 · The audit log was losing every failed tool call
A tool that runs and throws fires `PostToolUseFailure`, not `PostToolUse`. Only the latter
was registered, so 16 of 195 tool calls in the estate sweep produced no audit row at all —
and a failed call is the one you most want a record of. The whole claim for hook-derived
auditing is that nothing is instrumented by hand so nothing can be forgotten; a silent gap
is worse than no claim.

The gate then hid the fix twice, which is the part worth recording. `verify-m3` counted
only `outcome = 'allowed'`, so the newly-written `failed` rows read as a gap; narrowing it
to exclude `blocked` made the policy probe's refused call read as a gap too. Both times the
hooks were correct and the query was wrong — the same defect as not recording the rows,
one layer up. A tool call now produces exactly one row whichever way it went, and the
assertion admits every outcome.

## 2026-08-06 · The expectation table is derived from the T-SQL, not from SPEC §3
`scripts/m3-expected-classes.json` was first written from SPEC's procedure table. Triage
disagreed on six of fourteen, and on inspection the agent was right every time — it had
read the code and the table had not:

- `sp_SearchProducts` — the ordering trap SPEC §3 designed it for, found unprompted: every
  `ORDER BY` branch sorts a tie-heavy column with no secondary key while paginating with
  `OFFSET`. Unstable ordering is `nondet` by the skill's own definition.
- `sp_LegacyPriceImport_v2` — ruled the clock out as normalisable *first*, correctly, then
  found the real cause in the unexercised `@PriceData IS NULL` branch: every row in an
  import batch is stamped with the same `@Now`, so `TOP 1 … ORDER BY ModifiedAt DESC` has
  guaranteed ties and a plan-dependent tie-break.
- `sp_ReserveStock` — two `SELECT TOP 1` sites with no `ORDER BY`.
- `sp_GetProductDetail`, `sp_GetCartSummary`, `sp_RecalculateCustomerScore` — clock in a
  branch condition, or in arithmetic feeding one.

**This corrects an M1 claim.** The M1 entry above records that eleven procedures read the
clock and *four* branch on it. There are five: `sp_GetProductDetail:45` filters the discount
window with `AND @Now BETWEEN c.DiscountValidFrom AND c.DiscountValidTo`, so the price it
returns depends on the day it runs. The M1 survey missed it; triage did not. SPEC §3 calls
that procedure the easy tier-1 example — the code disagrees, and the code wins.

## 2026-08-06 · A probe reads its verdict from the database, not from a clean return
`probe-policy` originally reported from the run's return value. The SDK **throws** when a
run ends on `maxTurns`, and a denied tool makes the agent spend turns explaining itself, so
the probe died before it could report the refusal it had already successfully provoked. The
refusal and its consequence are both written by the hook before the run ends, so the verdict
is now read from `audit_entries` afterwards. A probe that can only report its finding when
the agent exits tidily fails for the wrong reason.

## 2026-08-06 · OPEN — the blocker table concentrates on one bucket
Nine of fourteen procedures are `nondet`, carrying 25 646 of 45 297 invocations behind a
single `chybí seam` blocker. This is the failure mode the M1 clock rule was written to
prevent, and the rule half-worked: the clock *is* being correctly ruled out as normalisable.
But `nondet` also covers unstable ordering, and this estate is deliberately full of missing
`ORDER BY`s, so the classifications are accurate and the concentration is real.

Accuracy is not the problem; "chybí seam · 9 procedur" is a weak roadmap. The proposed fix
is to split that blocker by *which* seam is needed — clock, ordering, identifier — derived
from `seam_requirements` in `blocker.ts`, still computed and never stored. "Five need a
pinned clock, three need stable ordering" answers "what do we do Monday" in a way one bucket
of nine does not. Deferred rather than done: it changes beat 1's screen, which is Jan's call.

## 2026-08-06 · The SDK discovers its own bundled skills alongside Parity's
`SDKSystemMessage.skills` reports nineteen skills, not five: Parity's own plus the CLI's
bundled ones (`doctor`, `loop`, `run`, …). The `skills: [name]` option is a context filter,
so the model only ever sees the one skill enabled for that run, and the Provoz page lists
the five real files on disk. Recorded because "the agent loads exactly our five skills" is
a stronger claim than the init message supports, and someone will read that array on stage.

## 2026-08-06 · A branch switch silently breaks the running stack
Checking out a branch that does not contain `parity/api/src` or `parity/web/src` deletes
those directories, and the running containers keep their bind mounts pointed at the deleted
inode. Recreating the files on the next checkout does not re-resolve the mount. The failure
is quiet in the worst way: the web app serves HTTP 200 and renders a **white screen**
(`Failed to load url /src/main.tsx` appears only in the container log), and `parity-api`
keeps reporting **healthy** because `tsx` already holds the code in memory — while `/app/src`
inside it is empty and the next `docker compose exec` would fail.

Hit while fast-forwarding `main` after merging M3: local `main` was twelve commits behind
and did not yet contain `parity/`, so the checkout deleted both trees before the merge put
them back. `make remount` force-recreates the two containers and then asserts both mounts
are non-empty, so the recovery is one command and the check cannot pass on a stale mount.
Branch switching is normal during a demo; a white screen at beat 1 with a healthy API is a
bad thing to debug in the room.

---

# M4

## 2026-08-06 · A golden test's expectation is recorded now, not read from the capture
The obvious reading of "golden tests from captured invocations" is to compare against the
captured result and write set. M1 already proved that unsound and the entry above says why:
ninety days of later traffic touched the same rows, so a captured value and a value produced
today differ for reasons that have nothing to do with the code. M1's own replay check handles
this by capturing and replaying back to back against identical state.

So a case takes its **inputs, ambient context, branch label and provenance** from
`parity_capture`, and its **expectation** from executing the current procedure inside a
rolled-back transaction. That is the only comparison where both sides saw the same database.
`sourceInvocationId` is stored and `verify-m4` re-reads it, asserting the stored parameters
still byte-match the capture — "generated from real traffic" is checkable rather than claimed.

The obvious objection is that a baseline recorded from the current procedure and then compared
to the current procedure is a tautology. It is, unless something can make it fail, which is
why `probe-oracle` exists and why the gate refuses a green suite without it.

## 2026-08-06 · Change Tracking cannot see a transaction that never commits
M1 captures write sets from `CHANGETABLE(CHANGES …)`, and reusing it here was the plan. It
cannot work: CT records committed change, and every golden execution rolls back. The harness
instead fingerprints each candidate table per row (`BINARY_CHECKSUM`) before the call and
again after, both inside the transaction, and reads back the full image of every row whose
fingerprint moved. Post-images only — a golden test compares one run of the procedure against
another, so "what the row became" is the whole answer. Before-images are what M5 needs to
render a diff a human can read, and the same snapshot can produce them.

Two smaller findings. `BINARY_CHECKSUM(*)` cannot be qualified by an alias, so the diff needs
a second snapshot rather than a join against the base table. And measured cost is ~25 ms per
call on `sp_CalculateOrderTotal`, which leaves M5's 2 000-replay budget intact.

## 2026-08-06 · Normalise the clock, not dates
Blanking every datetime-shaped value would be easy and would quietly destroy the evidence a
golden test exists to hold: an order date, a promo validity window, a computed dispatch date
are all behaviour. A timestamp is therefore normalised only when it falls inside the wall-clock
window the run itself occupied, which makes it provably a value read off the clock.

Built from measurement, not from a guess: two runs of `sp_CalculateOrderTotal` against
identical state differ in exactly four columns — `Catalog.LastQuotedAt`, `Catalog.ModifiedAt`,
`OrderLedger.CalcCachedAt`, `OrderLedger.ModifiedAt`. Every money column is stable.

`sp_ReserveStock` then forced a second rule. It writes
`ExpiresAt = DATEADD(MINUTE, @reservationMinutes, @now)`, which lands *outside* the window by
construction and drifts run to run exactly as `ModifiedAt` does. Such a value is normalised to
its offset (`<clock+1800s>`) rather than blanked, because the offset is the behaviour — the
test should still fail if the reservation window becomes an hour. The rule applies **forward
only**: a write set holds whole row images, so it carries columns the procedure never touched,
and `Catalog.LastQuotedAt` is seeded history. Measuring a past date against a moving anchor
turned a perfectly stable value into a drifting one, which is how this presented. A value dated
in the future cannot be observed history.

## 2026-08-06 · Three bugs in the canonicaliser, all found by running it twice
Not by reading it. Each was invisible in the code and obvious in a diff of two runs.

**Identity keys are integers**, so testing "is this a freshly created key" after the number
branch meant it never fired, and every inserting procedure reported unstable.

**A new key is referenced across tables.** `sp_ReserveStock` inserts a `StockReservation` and
writes that key into `OrderLedger.ReservationID`. Collected per table, the foreign key stayed a
raw integer and drifted. Collected across the whole write set it normalises consistently, which
also strengthens the assertion: it now proves the FK points at the row that was created.
Matching is by column name as well as value — the estate's identity ranges overlap, so a fresh
`ReservationID` of 1956 would otherwise have silently normalised an unrelated `ProductID`.

**A GUID can be embedded.** `sp_PlaceOrder` writes `PaymentRef = 'PR-' + NEWID()`, so an
anchored pattern missed it. The unanchored pattern then introduced its own trap: `.test()` on a
global regex advances `lastIndex` and misses every other match, so the code replaces and
compares rather than testing first.

All six exercised procedures are now stable across repeat runs, including the ordering trap
(`sp_SearchProducts`, normalising `ordering`) and `sp_PlaceOrder` (`clock`, `guid`, `identity`).

## 2026-08-06 · The branch key is too coarse to reach the planted defect, and that is the whole ballgame
The first full run produced five cases, 5/5 passing, and **zero invariant violations** — a
clean green board that had missed the one thing worth finding.

`list_capture_cases` picked the lowest sampled invocation per `BranchKey`, and every
`sp_CalculateOrderTotal` call carrying VERNY20 shares the key `promo=VERNY20` whether or not
the customer also had a loyalty discount. The planted defect lives precisely in the
intersection: the branch needs `@StacksFlag = 1 AND @LoyaltyDiscount > 0`. The lowest id
(43757) has `LoyaltyDiscountAmount = 0` and never enters it; 43901 has 1961.11 and does. Keyed
on inputs alone the defect is unreachable by construction, and the oracle reports full branch
coverage while missing it.

A stratum is now the branch key **and a coarse signature of what the call wrote** — per numeric
column, whether it landed on zero, positive or negative — derived from the captured write set.
Coarse on purpose: exact values would make every invocation its own stratum, while the sign
pattern is exactly what separates "a promo applied and a loyalty discount did not" from "both
did". Eleven cases now, both VERNY20 variants among them, and the rate invariant fires.

M1 learned the same lesson from the other side: the branch key was widened once already, after
it emerged that two procedures resolve country and loyalty tier *inside* the body. Inputs do not
determine the path. This closes the remaining half — outcome does.

## 2026-08-06 · Invariants are a closed vocabulary, evaluated in code
The agent proposes which columns and which reference table; it never supplies a check. Free
text would be a comment, and a comment presented as verification is what this build exists not
to ship — and SQL from the model, executed against the estate, is not a thing worth building.

Four kinds: `sum_identity`, `non_negative`, `value_from_table`, and `advisory` for anything that
cannot be expressed, which is recorded and shown but never counted as verified. Numerator and
denominator are **linear combinations** of columns, and that is what makes a rate check mean
anything — a naive `TotalVat / TotalNet` is not a rate on any order carrying a discount, so it
would differ everywhere and say nothing. Every identifier is checked against
`INFORMATION_SCHEMA` before an invariant is stored: a mistyped column would otherwise skip every
row and sit on screen at zero violations, looking exactly like a rule that holds.

## 2026-08-06 · The oracle finds the planted defect, and the identity proves why nobody else did
`TotalVat` is defined as `TotalWithVat − TotalNet`, so `TotalWithVat = TotalNet + TotalVat`
holds by construction on every branch — the self-consistency check can never fail. The defect
is only visible against the rate table: the stacking branch computes VAT on `Net − Promo`,
giving a derived rate of **0.168** where the table holds {0.10, 0.15, 0.20, 0.21}. That is
0.21 × 0.8, the promo being 20%.

`verify-m4` asserts both halves — that the rate invariant is violated, and that the identity
invariant is not. The second is the one that explains fifteen years.

## 2026-08-06 · A second login, `parity_runner`, because executing is a different act from analysing
`parity_reader` stays `db_datareader` and nothing else, so M2's assertion that the engine
refuses its UPDATE is untouched and "Parity cannot write to the estate it analyses" stays true
of the credential the analysis runs under. The runner may EXECUTE and write, always inside a
transaction that is rolled back — and two things it cannot do are grants rather than
conventions: it holds no DDL, and it is **DENYed `sp_SyncWarehouseDispatch`**, which sends
Database Mail. A sent email cannot be rolled back, so no transaction discipline makes it safe
to replay; the engine refusing it is a better guarantee than a list in the code remembering to
skip it. M5 needs this principal anyway.

## 2026-08-06 · A violated invariant does not block promotion; a failing golden test does
`oracle_state` moves to `golden` when the cases pass, and to `invariants` when the procedure
also carries an evaluated rule. A suite with a failing case does not promote at all — coverage
answers "how much of what actually runs is now provable", and counting a procedure whose own
golden tests disagree with it would make the headline number wrong in the flattering direction.

A violated invariant is the opposite case: the oracle worked, and what it found is that the
procedure breaks a rule it declares. That is a finding about the estate, not an absence of an
oracle, so it is reported on the procedure screen and does not lower the state. No new blocker
key was invented for it — routing findings to the human queue is M5's job.

## 2026-08-06 · Gate order, again
`verify-m3` asserts coverage is exactly zero, which is true after `map-estate` and false after
`generate-oracles`. The sequence is
`demo-reset → map-estate → verify-m3 → generate-oracles → verify-m4`.
The M2 entry above already records that the gates are not independent; this is the same shape
one milestone on, and it is why `generate-oracles` is a separate command rather than part of
the gate.

`verify-m4` deliberately does not run `demo-reset`: doing so would destroy a sweep's worth of
live model output and make the gate expensive to re-run. That the oracle tables are cleared is
asserted structurally instead, from `information_schema`, by checking they cascade from
`procedures`.

## 2026-08-06 · An invariant broken nearly everywhere is a mis-stated rule, not a finding
`sp_ApplyPromoCode` produced a `value_from_table` rule that failed **16 of 17** checks: it
compared `Catalog.DiscountPct`, which is stored as a percentage, against a ratio. Left
unqualified that is sixteen false findings sitting beside the one true one, and the true one
stops being visible — which is the failure mode the whole build is organised against.

The distinction is structural rather than a matter of taste. A real defect is an exception by
construction: it lives in one branch, so it appears in a minority of cases — the planted
promo/VAT defect violates 2 of 21. A rule that does not describe the procedure fails almost
everywhere. So an invariant violated in more than half of its checks is reported as
**`nepotvrzeno`**, with its counts intact, and excluded from the violation headline.

Not deleted and not hidden: it is still a lead for a reviewer, and suppressing it would be the
same overclaiming in the other direction. Derived on every read, never stored — same reasoning
as `blocker`, because a stored judgement drifts from the numbers it was drawn from.

`verify-m4` asserts both halves for `sp_CalculateOrderTotal`: that the rate invariant is
violated, and that it is violated in a *minority* of cases. Without the second, a mis-stated
rule would satisfy the first and read as a discovery.

## 2026-08-06 · The write tools replace across runs and accumulate within one
`write_invariants` and `write_golden_tests` originally deleted everything for the procedure
before inserting, so that re-running the skill left the suite it had just decided on rather
than that suite plus an earlier attempt's. Correct across runs, wrong within one: the agent
batches. On `sp_CalculateOrderTotal` it called `write_invariants` twice — ten rules, then one —
and the second call deleted the ten. The procedure came out of a successful run carrying a
single invariant, and nothing anywhere reported a problem.

The delete is now scoped to rows from a *different* `agent_run_id`, with the insert upserting
on `(procedure_id, name)`. A re-run still replaces; a second call within the same run adds.

Worth stating because the failure was invisible from every angle except counting: the run
succeeded, the tool returned "Stored 1 invariants", the suite passed, and the only symptom was
a number that looked low. The gate now asserts `sp_CalculateOrderTotal` carries at least three
invariants covering all three evaluable kinds, so a recurrence fails the build.

## 2026-08-06 · Branch coverage is enforced on the migration target and reported everywhere else
The skill asks for "every distinct branch observed in the capture, at least once". Measured
against the estate that is a demanding bar: `sp_ApplyPromoCode` has twenty distinct branch
keys, `sp_SearchProducts` thirteen, `sp_PlaceOrder` eleven — while `sp_CalculateOrderTotal`
has five, and its suite covers all five.

`verify-m4` therefore asserts full coverage for `sp_CalculateOrderTotal` and prints the ratio
for everything else. The asymmetry is deliberate rather than a rounding-down: the migration
target is the procedure that actually gets replaced at M6, so a branch its oracle never saw is
a branch a new implementation could change with nothing noticing. Elsewhere an eight-of-twenty
suite is a real oracle and an incomplete one, and the honest thing is to show the number rather
than to fail the build or, worse, to round it into a green tick.

What *is* enforced everywhere is that nothing overclaims: no suite may cover a branch its
procedure was never observed taking.

## 2026-08-06 · Invariants are evaluated over the write set, so a pure read has nothing to check
`sp_GetCartSummary` came back with nine passing golden cases and **zero invariant checks**. Not
a bug in the rules — the evaluator walks the rows a call wrote, and a `pure_read` procedure
writes none. Four of the fourteen are in that position.

Left as a stated limit rather than papered over. Golden tests still cover these procedures
completely: for a read, the result set *is* the output, and that is exactly what the case
compares. What is missing is the second, stronger claim — that the output obeys a rule stated
independently of the code — and for reads the vocabulary has no way to express it, because
every kind is written in terms of columns a row landed on.

The extension is small and obvious (a `<result>` pseudo-table, so a rule can range over result
rows the way it ranges over written ones) and it is deliberately not built here: it changes what
the skill must be told, which means re-running the whole sweep, and M4's acceptance asks for
invariants on `sp_CalculateOrderTotal`, which writes. Recorded so M5 inherits the decision
rather than rediscovering it.

The consequence on screen matters more than the gap. A rule with zero checks now reads
`nevyhodnoceno`, never `nepotvrzeno` — "nothing to check here" and "this rule is broken almost
everywhere" are opposite findings and must not share a chip.

## 2026-08-06 · For a read, the result set supplies the stratification shape
`sp_GetProductAvailability` drew exactly **one** golden case. It has one observed branch key,
and — being a read — an empty write set, so the outcome signature added nothing and every one
of its 588 sampled calls fell into a single stratum.

That procedure carries 19 600 invocations, 43% of all traffic in the estate. Coverage is
invocation-weighted, so a single replayed call would have moved the headline number further
than anything else in the sweep while verifying almost nothing. That is the overclaiming the
skill's closing rule forbids, arriving through the back door of a selection heuristic rather
than through a bad test.

The signature now falls back to the captured result set when there is no write set: bucketed
row count per recordset, plus the sign, boolean or null-ness of the first row's columns.
Bucketed because row counts vary continuously and exact values would make every call unique.
That distinguishes in-stock from backordered, empty from single from many — the distinctions a
read actually makes, and ones the input-derived branch key cannot see because the procedure
resolves them in its body.

The same lesson as the branch-key entry above, one layer along: a stratification heuristic that
is silent about what it cannot distinguish produces a confident, small, useless suite.

## 2026-08-06 · A tool denied by `allowedTools` never reached the audit log
Found by `verify-m4`, on its first run, at 39/40: 185 tool calls across the oracle sweep and
184 audit rows. The missing one was a **`Bash`** call in `sp_PlaceOrder`'s run — the agent
reaching for a shell it does not have.

The mechanism is the same shape as M3's `PostToolUseFailure` bug, one layer earlier. A tool
that is not in `allowedTools` is refused by the SDK *before* `PreToolUse` runs, so Parity's
policy hook never fires and nothing is written. Parity's own tier table was never involved,
because the call never got as far as it. The result is a hole in exactly the wrong place: of
185 events, the single one an auditor would most want to see — the agent trying to leave its
sandbox — was the only one with no record.

`SDKResultSuccess.permission_denials` already carried it, and `client.ts` was already
harvesting it into `RunResult`; it simply was not being written down. `executeRun` now appends
an `audit_entries` row with `outcome = 'denied'` for each denial. Three refusal paths now each
produce exactly one row: `blocked` (Parity's tier table said no), `failed` (the tool threw),
and `denied` (the SDK never permitted it).

Regenerating rather than patching: the pre-fix runs are missing a row that cannot be
reconstructed, so every `generate-oracle` run was rebuilt with the corrected runner instead of
deleting the one row that failed the gate. Removing the inconvenient record to make a number go
green is the exact failure this project is organised against.

## 2026-08-06 · The rate check inverted its own units, and the quarantine hid it correctly
On a re-run, `sp_CalculateOrderTotal` reported **zero findings**. The rule was structurally
right — the same numerator and taxed base as before — but it carried `referenceScale: 100`
instead of `0.01`, so it compared a derived ratio of `0.21` against `2100`. It then failed
16 of 16 checks and was quarantined as `nepotvrzeno`.

Every mechanism behaved correctly and the outcome was still wrong. No false finding was
reported, which is what the quarantine is for; but the true finding — the one the demo turns
on — disappeared, and the run looked clean. A green board that has quietly lost the thing it
exists to find is the worst state this system can be in.

Two changes, and the second is the one that matters. The parameter is now documented as a
multiplier with the worked example inline. And `write_invariants` **echoes back the values the
rule will actually compare against**: `compares VatRate.Rate × 100 = 2100.0000, 2000.0000, …`.
Reading a parameter back does not catch an inverted unit; seeing `2100` where you meant a VAT
rate is unmissable.

The wider point for M5: an invariant that fails everywhere and one that fails in one branch are
opposite findings, and only the counts distinguish them. Anything that classifies must be shown
its own arithmetic before it commits, not asked to get it right unaided.

## 2026-08-06 · The clock-offset quantum was smaller than the slowest call
`sp_PlaceOrder`'s suite came back 10/11 on a re-run having been 11/11 before, and the diff was
`ExpiresAt: <clock+1800s>` against `<clock+1801s>`.

Not the estate. `sp_ReserveStock` writes `DATEADD(MINUTE, 30, @now)`, and the normalised offset
is measured from the run's own clock read, so it always carries however long the call took to
reach that statement. Rounded to the nearest second, thirty minutes lands on 1800 or 1801
depending on whether that took under or over half a second — and `sp_PlaceOrder`, which
orchestrates three other procedures, is the only call in the estate slow enough to cross it.

The offset is now floored to ten seconds. Flooring is the half that makes the quantum a real
margin: the excess is always positive, so an offset of exactly 1800 s stays 1800 s for any call
under ten seconds, where rounding leaves a boundary in the middle of the range. The earlier
entry above predicted this failure in its own words — *"stable for ε < 500 ms"* — and shipped
it anyway. A tolerance stated as a known limit is still a bug when the limit is inside the
operating range.

Caught only because the golden suite is run twice and compared. A single baseline-then-verify
pass on a fast procedure would never have shown it.

## 2026-08-06 · Deliberately-rare traffic is included by the platform, not chosen by the agent
Three consecutive runs of `generate-oracle` over `sp_CalculateOrderTotal` produced three
different suites. Two included the VERNY20-with-loyalty stratum and found the promo/VAT defect;
one picked a different ten cases, missed it, and reported a clean board. Same code, same
capture, same skill.

That is fatal on its own terms. Hard rule 5 says the same seed and the same traffic must give
the same numbers every run, and here the single most important number in the demo depended on
which ten of forty strata a model happened to prefer. It is also the exact failure the estate
was built to contain: `SPEC.md` §3 plants leap-day orders, negative stock, Slovak VAT, a
stacked promo and a forty-line order precisely because they are a handful of calls among tens
of thousands, and a suite assembled by judgement drops them while still looking complete.

`write_golden_tests` now always includes one case per rare-branch stratum — the deterministic
lowest sampled id for each distinct `CallerContext LIKE 'traffic:%'` — adding any the agent did
not select and saying so in the tool result. The agent still decides the shape of the suite;
the platform guarantees the floor.

This is the same division of labour as the policy hook, and for the same reason: a rule that
matters is enforced by the platform, not requested in a prompt. The alternative — rejecting the
suite and asking the agent to try again — was rejected because a run that cannot satisfy the
rule would then produce no oracle at all, trading a silent gap for a loud absence.
