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

---

# M5 — decided before the build

## 2026-08-06 · M5 shadows a hand-written pricing stub, not an agent-generated service
M5's gate requires the planted promo/VAT bug to surface as `behaviour_change`, and a behaviour
*change* needs two implementations that differ. `implement-service` is M6, so replaying the old
procedure against itself would produce only noise and the gate could not be met as written.

M5 therefore writes a minimal pricing service by hand, implementing the spec correctly — VAT on
the full net in every branch. The shadow run diffs the old procedure against it, `classify-diff`
sorts noise from behaviour, and the promo/VAT divergence surfaces exactly as the acceptance
demands. M6 then replaces the stub with the agent-generated service against a harness that is
already proven.

Rules out merging `implement-service` into M5. `SCHEDULE.md` already names M5 the hard one; a
failure with both a new harness and a newly generated service in play is ambiguous between them,
and that ambiguity is expensive precisely where there is least time. The cost accepted is a
throwaway implementation, and that the M5 screen shows a service no agent wrote.

## 2026-08-06 · The shadow runs against a separate restored database
`SPEC.md` §4 says "restored snapshot database" and M4's rolled-back-transaction harness was the
tempting shortcut, since it exists and `verify-m4` already proves it leaks nothing.

Taken on performance, and the reason is the same one M4 hit from the other side: **Change
Tracking cannot see a transaction that never commits.** On a separate database the replay can
COMMIT, which puts CT back in play — the mechanism M1 measured at ~40 ms per captured call
against the 100–176 ms per case that before/after fingerprinting costs today. It also makes
"production is provably untouched" trivially true rather than argued: the shadow connection
never opens against ParityShop at all.

The restore mechanism — BACKUP/RESTORE, a second `make seed` under another database name, or a
file-level copy — is deferred to implementation and chosen on whichever resets fastest, since
`demo-reset` has to stay under two minutes.

## 2026-08-06 · Coverage by branch, not by volume — the 2 000-call target is superseded
`SPEC.md` §4 and `DEMO-SCRIPT.md` beat 3 both say 2 000+ replayed calls in under 60 s. That
number was written before anything was measured. M5 will instead replay a stratified few hundred
chosen to cover every observed branch, and report the real figure.

The argument for the change is that the number was measuring the wrong thing. Two thousand calls
of `sp_CalculateOrderTotal` drawn by volume are overwhelmingly the same handful of branches
repeated; a few hundred drawn by stratum cover strictly more behaviour and take a fraction of the
time. M4 already demonstrated this on the selection side — the estate's hottest procedure had one
observed branch key across 588 sampled calls, and volume told us nothing the shape did not.

Consequence to handle in M5, not later: `DEMO-SCRIPT.md` beat 3 still says "2 000+ captured
calls replayed" and must be updated to the measured figure once it exists. Leaving the two
disagreeing is exactly the drift hard rule 5 exists to prevent, and the rehearsal at M8 is the
wrong place to discover it.

---

# M5 — during the build

## 2026-08-06 · The shadow database is a plain BACKUP/RESTORE, and the revert costs 530 ms
The M5 entry above left the restore mechanism open — snapshot, second seed, or file copy —
to be chosen on whichever resets fastest. Measured on the real 200 MB estate before writing
anything: `BACKUP` 391 ms, `RESTORE` as a second database 612 ms, and a **revert of 530 ms,
repeatable**. `make shadow-db` builds the whole thing from nothing in 0.8 s.

That killed the database-snapshot design this started as. A snapshot reverts faster in
theory, but at half a second a plain RESTORE is ~1.6 s across the three reverts a shadow run
needs, against a 16 s replay — and it drops an entire mechanism from the build: snapshot
lifecycle, its limitations, and a `CREATE DATABASE` grant. Rules out the second-seed route
too, which would have needed `00-database.sql`, `40-parity-reader.sql` and
`41-parity-runner.sql` parameterised by database name.

The copy inherits everything by construction, which is worth more than it sounds: Change
Tracking on twelve tables, the twelve temporal histories, all fourteen procedures, both
parity logins mapped by SID, and the `DENY EXECUTE ON sp_SyncWarehouseDispatch`. The runner
is guarded on the copy by the same grant that guards it on the estate, rather than by a
second copy of the rule.

## 2026-08-06 · RESTORE resets the database owner, and the revert baseline is taken after ownership moves
Found by hitting it. `RESTORE` restores the owner recorded *in the backup*, so restoring
ParityShop's own backup handed the shadow copy back to `sa` every time — and the next revert
failed, because `parity_shadow` was no longer the owner and only the owner may restore. The
database was then stuck in SINGLE_USER with no principal able to bring it back.

So the revert baseline is backed up **from the shadow database after ownership is
transferred**, not from ParityShop. Every revert then restores a file that already says
`parity_shadow`, and ownership survives. `SET MULTI_USER` is attempted in a `finally`
whatever happens, because a reset that can strand the database it resets is worse than no
reset.

## 2026-08-06 · `parity_shadow` owns the copy and has no user in the estate at all
A third principal, and the argument is the same one that split `parity_runner` off
`parity_reader` at M4: resetting a database is a different act from executing a procedure.
`RESTORE` over an existing database needs sysadmin, dbcreator, or the database's own owner,
and this login is the third of those and nothing else — no server role, so it cannot create a
database; `make shadow-db` runs as `sa` and hands the finished copy over.

The part worth saying out loud: the principal that can wipe and rebuild a database is the
most dangerous one in the build, and it is the one principal with **no route to production
whatsoever**. `verify-m5` asserts the engine returns Msg 916 when it reaches for ParityShop.

`VIEW CHANGE TRACKING` is granted to `parity_runner` **on the copy only**. `db_datareader`
does not imply it, and reading a write set out of CT needs it — but the runner only replays
on the copy, so that is the only place it needs to see what changed. `41-parity-runner.sql`
deliberately does not grant it, which keeps the runner's reach into the estate itself at
exactly what M4 needed.

## 2026-08-06 · The shadow commits, so the Czech line in the demo script had to change
`MILESTONES.md` M5 said "replay runs in a transaction that always rolls back" and
`DEMO-SCRIPT.md` beat 3 said *"její transakce se zahazuje"*. Both are now wrong, and
deliberately: Change Tracking cannot see a transaction that never commits, which is the whole
reason the M5 entry above chose a separate database. Measured here, the two mechanisms agree
exactly on the same invocation — same tables, same rows, same money to the cent — and CT
costs 99 ms against 179 ms for M4's before/after fingerprinting.

What replaces the sentence is stronger, not weaker. "Production is untouched" stops being an
argument about transaction discipline and becomes an observation about the connection string:
the shadow path never opens ParityShop at all. Both documents are updated to say that.

## 2026-08-06 · Two passes over the same restored state, and what that bounds
The comparison is pass A (the procedure) against pass B (the replacement), both replaying the
same cases in the same order from the same reverted database. M1 and M4 both recorded why the
obvious alternative — compare today's run to the captured values — is unsound: ninety days of
later traffic touched the same rows.

The bound, stated rather than discovered at M8: pass B writes different values wherever the
implementations diverge, so a case could in principle read what an earlier case in the same
pass wrote. For `sp_CalculateOrderTotal` the only written column it ever reads back is
`PromoCodeUsed`, and both sides set it identically, so the passes stay comparable. A
procedure that fed its own outputs back would need a revert per case, at 530 ms each.

## 2026-08-06 · A diff is per case, table and column; a finding is a signature
An order writes its summary onto every one of its lines, so one wrong total appears on three
to forty rows. Counting those separately would inflate every number in the demo by the average
order size and tell nobody anything. Diffs are therefore aggregated per case, table and
column — 400 cases produced 1 668 of them.

A **finding** is a group of diffs sharing a signature: scope, table, column, and — for numeric
changes — whether the difference is material or sub-cent. The magnitude bucket is in the
signature because a finding is a thing a human decides once, and grouping a hundredth-of-a-
heller rounding difference with a 1 647 Kč VAT difference would force one verdict to cover
both. It is a structural property of the difference, not a judgement about it; the model still
decides what each class means. Whether a finding is still open is derived — a
`behaviour_change` signature with no `decisions` row — never a stored flag, same reasoning as
`blocker`.

## 2026-08-06 · One model run per finding, and the canonicaliser's work is recorded rather than discarded
`SPEC.md` §8 says normalise in code first and send only what survives. The measured split on
the migration target: **1 668 raw differences, 1 600 resolved by canonicalisation, 68
surviving across 4 findings, 4 model runs.** 95.9% never reached a model.

Two choices make that checkable instead of asserted. Every raw difference is **stored**,
including the ones canonicalisation resolved, with the normalisation that resolved it and no
`agent_run_id` — so "the model never saw these" is a query, and `verify-m5` runs it. And
classification is one run per *finding*, not per difference: asking the same question 68 times
would be slow, expensive, and free to answer differently each time, which is the drift M4
already paid for when three runs of `generate-oracle` produced three different suites.

## 2026-08-06 · The hand-written service uses binary floating point, and 18 of 400 orders land on a rounding boundary
Not planted. The service was written the obvious way — JavaScript numbers, rounded to four
decimals at each point the procedure assigns to a `DECIMAL(18,4)` variable — and 18 of 400
replayed orders came out one hundredth of a heller apart from the procedure.

Checked before deciding it was acceptable, because shipping a known transcription error and
calling it noise would be dishonest. It is not a transcription error: on order 2026003462 the
exact value is `17 901.982 35`, precisely on the boundary, where SQL Server's decimal
arithmetic rounds half away from zero and binary floating point has already lost the half.

Kept, and reported as what it is. It is exactly the class of defect a shadow harness exists to
catch — invisible to any test comparing to two decimal places — and it gives `classify-diff`
two genuinely different residual classes to tell apart rather than one. The skill's rule that
a monetary difference is never noise sends it to a human, which is the right answer: a cent is
for a person to decide.

## 2026-08-06 · The measured numbers, and the three documents that had to move
`SPEC.md` §4, `MILESTONES.md` and `DEMO-SCRIPT.md` all said "2 000+ captured calls replayed in
under 60 seconds", written before anything was measured and already superseded by the M5
entry above. The real figures: **400 cases covering 27 of 27 observed strata, both passes, in
16.2 s — 40.5 ms per case.** Two thousand calls drawn by volume would have been the same
handful of branches repeated; 400 drawn by stratum cover every behaviour the estate was
observed taking.

`DEMO-SCRIPT.md` beat 4 said "three items". The real count is four findings, of which two are
the promo/VAT defect seen on `TotalVat` and `TotalWithVat` and two are the rounding boundary
above. Updated to the measured figure rather than left to be discovered at the rehearsal.

## 2026-08-06 · verify-m5 does not run demo-reset, and one of its checks could not fail
Both caught by reading the gate's own output after it passed 58/58.

**The reset.** An earlier version ended by running `make demo-reset` and asserting the shadow
tables were empty afterwards. `verify-m4` had already made this decision one milestone
earlier and for the same reason, and it is worse here: `resetState` truncates `procedures`, so
the M5 gate took M3's estate sweep and M4's oracle sweep down with M5's shadow run — roughly
twelve dollars of inference to re-run the gate. `verify-m2` owns the timing and pristine-state
assertions; what M5 adds is that the four new tables are named in the truncate list, which is
asserted from the source.

**The vacuous check.** "Every noise verdict carries a reason from the closed list" passed
against **zero noise verdicts** — canonicalisation had taken all of it, so the model returned
none. It would have gone on passing with the vocabulary deleted. This is the same shape as
M1's replay assertion, M2's write-owner assertion and M4's rate check, and each of those
passed while the thing it named was broken. It now states the contract in both directions
over every model verdict — a reason exactly when the verdict is noise, an explanation
otherwise — and the run reports that the noise vocabulary went unexercised rather than
implying it was verified.

## 2026-08-06 · Canonicalisation can *introduce* a difference, and driving the diff from the raw walk alone dropped it
The diff engine walks the raw pair and the canonical pair separately: a column that differs in
the first and not the second is one canonicalisation resolved. That direction is the whole
point. The other direction looked impossible and is not.

Normalisation is not per value. The GUID and identity maps assign ordinals in order of first
encounter, **per side**, so two implementations that write the same two new identifiers in the
opposite order are raw-equal on every row and canonically different on both. Iterating only the
raw differences would have dropped that entirely — no diff row, nothing on screen, and a
shadow run reporting clean.

Unreachable for `sp_CalculateOrderTotal`, which inserts no rows and writes no GUIDs, so it
would have sat undetected until M6 pointed the harness at `sp_PlaceOrder` and its
`PaymentRef = 'PR-' + NEWID()`. Found by asking what the second walk could contain that the
first does not, rather than by a failing test. A silently dropped difference is the one failure
mode this build cannot afford, since it is indistinguishable from success.

## 2026-08-06 · The check that the agent cannot decide was itself a fixture
Caught by the reviewer, and the fifth instance of this build's recurring defect: an assertion
that passes on the strength of something the test itself created.

`verify-m5` proved "record_decision is reserved to a human" by selecting the `policy_rules`
row and asserting `requires_human`. `seedPolicy` writes that row unconditionally on every
boot, so the check was reading back its own fixture. It would have kept passing if `decide()`
regressed, or if `record_decision` were quietly added to `classify-diff`'s `allowedTools` —
and the rule it names is the one the entire decision queue exists to enforce.

`probe-decision` now provokes the refusal for real, the same shape as M3's `probe-policy`: a
`classify-diff` run is instructed as plainly as possible to record a decision, with the tool
**granted at the SDK layer on purpose** so that what refuses it can only be Parity's tier
table. The gate asserts both halves — that the hook blocked it, and that nothing was written.
One live model run, which is what M3 already pays for the equivalent guarantee.

Three smaller findings from the same review, all fixed:

- **`classify_diff` and the decision undo were unscoped by run.** A signature names a shape,
  not a run, so once M6 re-runs a shadow after a decision, an unscoped update would reach back
  and relabel the previous run's rows. Both now scope to one run.
- **`rowsAffected` counted raw rows on a surviving column**, including rows canonicalisation
  had resolved, so a finding could claim more rows than it covers. It now takes the count from
  the canonical walk.
- **`noiseReasonFor` fell back to `ordering`** for any write-set resolution it could not
  explain — but only result-set rows are sorted, so ordering can never resolve a write-set
  value. A plausible label on something nobody understands is how a wrong reason survives
  review; it now returns `unexplained`, and the gate fails the build on it.

## 2026-08-06 · No chart over time on the shadow tab, and why that is not a gap yet
`SPEC.md` §4 lists "shadow runs (chart over time + per-run diff list)" for the procedure
screen. The tab ships the per-run numbers, the verdict breakdown and the findings, and **no
chart**, because a fresh demo produces exactly one real shadow run and a time series over one
point is decoration. Absent rather than simulated, per hard rule 4. It becomes worth building
at M6, when a second run after the human's decision gives the axis two points that mean
something — which is also the moment the chart would actually say something on stage.

## 2026-08-06 · A newline inside a template literal silently turned every finding into noise
The worst defect of the milestone, and the one the negative control was built for.

The diff engine lines the raw walk up against the canonical one by a `(table, column)` key,
and the key was a template literal written out at each of the five places that needed it. An
edit split one of them across two lines. The producer then emitted `OrderLedger⏎TotalVat`
while the consumer looked up `OrderLedger TotalVat`, nothing ever matched, and **every
difference that survived canonicalisation was reclassified as mechanical noise**. The shadow
run came back `1 668 raw, 1 668 resolved, 0 findings`: a clean board, produced by an engine
that had stopped being able to find anything.

It typechecked. It ran. It reported success. Nothing in the output looked wrong — the only
symptom was a zero where a four had been, on a run that is *supposed* to sometimes find
nothing. This is the exact failure mode `docs/SPEC.md` §1 is organised against, arriving
through a stray keystroke rather than through a design mistake.

Three things came out of it:

- **`probe-shadow` caught it, and nothing else would have.** The A/A control still passed —
  an engine that finds nothing passes a test that expects nothing. The one-unit perturbation
  went from `detected: 1` to `detected: 0`, which is the whole reason the gate refuses a green
  shadow run without it. M4 shipped `probe-oracle` on the same argument and it held here.
- **The key is now one function.** `columnKey(table, column)` is defined once and used by
  every producer and consumer, joined by a NUL rather than a space. One definition cannot
  disagree with itself, and no column name can contain a NUL.
- **The container was serving a stale copy of the file.** Repeated whole-file rewrites left
  Docker's bind mount pointing at an older version, so a fix on the host had no effect inside
  the container and the debugging went in circles for several rounds. `make remount` did not
  clear it; replacing the file so it took a new inode did. Worth knowing before a demo: if a
  change appears to have no effect, compare `wc -c` on both sides before doubting the change.

## 2026-08-06 · A tolerance wide enough to blur the rate table against itself
Found by re-running the oracle sweep, which M5 was forced to do after its own gate destroyed
M3's and M4's output. Three runs of `generate-oracle` over `sp_CalculateOrderTotal` had
previously produced three different suites; this one produced a fourth kind of wrong.

The rule was structurally perfect. Numerator `TotalVat − 0,21 × ShippingCost`, denominator
`TotalNet + Promo + Loyalty − Shipping`, which reconstructs `NetSubtotal` exactly — and on the
stacking branch it derives **0,168**, the same figure M4 recorded. It then reported **0
violations in 39 checks**, because the agent set `tolerance: 0,02` and `|0,168 − 0,15| = 0,018`.
The derived rate matched the 15 % entry of the reference table and the rule passed.

The table holds {0,10 · 0,15 · 0,20 · 0,21}, whose closest pair is 0,01 apart. Any tolerance at
or above 0,005 makes two legitimate rates indistinguishable; 0,02 makes four of them mush. A
rule that cannot tell its own reference values apart is not a rate check, and it had quietly
swallowed the one finding the whole demo turns on.

M4 met the same trap one parameter along — `referenceScale` inverted — and answered it by
echoing the compared values back. Echoing was not enough here, because 0,02 looks entirely
reasonable next to a list of rates. So the platform now **refuses** it: `write_invariants`
computes the smallest gap between distinct scaled reference values and rejects any tolerance
at or above half of it, naming the largest usable value in the rejection. The skill states the
rule too, so the first attempt is usually right rather than corrected. Same division of labour
as the policy hook and M4's rare-branch floor — a rule that matters is enforced, not requested.

Re-run after the fix: 17 cases, **1 finding**, `derived rate 0.168000 is not in VatRate.Rate
(0.1000, 0.1500, 0.2000, 0.2100)`. `verify-m4` back to 40/40.

## 2026-08-06 · `promote` moved oracle_state backwards, and the ladder now only goes up
`verify-m5` failed its two promotion checks: the migration target read `invariants` where it
should have read `shadow`, with the blocker back at `chybí shadow run`.

Not M5's doing. `verify-m4` re-runs every golden suite, and `promote()` wrote the state a
passing suite earns — `invariants` — straight over the `shadow` a completed shadow run had
already set. Running the gates in the documented order avoids it, but a state ladder that only
holds while commands are issued in the right order is not a ladder, and the visible symptom is
the Estate screen regressing: the roadmap tells the room something that stopped being true.

`promote` now compares against an explicit ordered ladder and only ever moves forward. A
passing oracle suite is evidence that the golden tests still hold; it is not evidence that the
shadow run which came after them has been undone.

## 2026-08-06 · A gate check that counted every run in the database
`verify-m5`'s "one model run per finding" compared the count of *all* `classify-diff` runs ever
recorded against this run's finding count. A second shadow run and every `probe-decision`
invocation both add classify-diff runs, so the check passed or failed on history that had
nothing to do with the run it was asserting — it read 6 against 4 findings and went red while
the property it names was true.

Now counted as `COUNT(DISTINCT agent_run_id)` over the diffs of that shadow run. The lesson is
the one this milestone kept relearning: a gate assertion has to be scoped to the thing it
claims to measure, or it is measuring the fixture.

## 2026-08-06 · The queue listed every shadow run's findings, not the latest one's
Found in use, not in review, which is the only reason it was found at all.

Jan ran `make shadow-run`, went to the queue, and clicked through it. The decisions were
recorded correctly — and he had to make eight of them for four findings, because three shadow
runs existed and `GET /api/queue` aggregated all of them.

A finding's `signature` names the *shape* of a difference — `write_set:OrderLedger.TotalVat:material` —
so it recurs identically in every run that reproduces it. `itemsFor(db, null)` had no run
scoping, so each finding appeared once per run, React was handed duplicate keys, and the
number in the header counted work that had already been done. This is the third time the same
mistake has been made in this file: `classify_diff` and the decision undo were both fixed for
it during the build. Anything keyed on a signature has to say which run it means.

`null` now means "the newest succeeded run of each procedure" rather than "every run of every
procedure". Superseded runs keep their rows and their decisions; they simply stop being what
the queue asks about. Two checks in `verify-m5` cover it — no signature may appear twice, and
every item shown must belong to its procedure's newest run.

## 2026-08-06 · The gate assumed nobody had used the queue yet
The same session exposed a second defect, in `verify-m5` rather than in the product. Its
decision-button check took `queue.open[0]` and pressed it, which crashes once a human has
decided everything — the normal state after a demo, not an exceptional one. A gate that only
runs before anyone has touched the thing it gates is not much of a gate.

It now works from whatever state the queue is in: it decides an already-decided item if that
is all there is, and restores the prior decision — not just deletes it — in the `finally`.
Silently clearing a recorded human decision is exactly the damage `verify-m2` established a
gate must not be able to do.

---

# M6 — service and PR

## 2026-08-06 · The generated service cannot be the source of the demo's findings
The plan for M6 assumed `implement-service` would produce a service that diverges from the
procedure, because it implements what the spec says while the procedure does something
undocumented in one branch. That assumption is false, and it was checked against the live
database rather than argued about: the M3 spec for `sp_CalculateOrderTotal` documents the
planted VAT defect three times over — `Chování` §12 gives the stacking branch by name and by
formula, `Invarianty` states both VAT bases as a rule, and `Otevřené otázky` flags it as
*"Nekonzistentní základ DPH mezi stacking a nestacking větví"*.

That is `skills/extract-spec/SKILL.md` working exactly as written — *describe what it does, not
what it should do*. The spec is a faithful reimplementation guide, so a spec-faithful service
reproduces the defect and its shadow run is green on the first try. What it would produce
instead is a scatter of accidental divergences — float rounding, NULL handling, fallback
ordering — different on every generation, which hard rule 5 forbids and which would make the
number of items in the decision queue a function of what a model wrote that morning.

## 2026-08-06 · The hand-written service stays, as the reference implementation
So the milestone inverts. M5's hand-written service was recorded as a stub for M6 to replace;
it is now permanent, and it is the harness's **positive control** — the only implementation
that diverges from the procedure, and therefore the standing proof that the diff engine can
still find a real behavioural difference. The generated service is the one that goes green.

This supersedes two recorded intents: the comment at `docker-compose.yml` saying M6 replaces
the source in place, and the M5 entry above saying the same. Both are rewritten.

A green run against the generated service means nothing on its own; it means something beside
a red one produced by the same harness, the same case set and the same database on the same
day. `verify-m6` asserts both, and `shadow_runs.implementation_id` is what lets each gate pin
to its own run — `verify-m5` to `reference`, `verify-m6` to `generated`.

It also makes the stage line stronger. Not *"the agent wrote a buggy service"*, which invites
"so your agent is unreliable?", but *the platform compared two implementations of one rule,
found a fifteen-year-old bug neither author knew about, refused to fix it silently, and then
produced the implementation that preserves it — with proof.*

## 2026-08-06 · The generated source reaches disk through Postgres, not a bind mount
parity-api has no mount into `parity-platform-demo-app` and does not get one. The reason is the
policy layer rather than tidiness: `decide()` waves through every tool whose name is not
prefixed `mcp__parity__`, and the SDK's built-in `Write` is exactly that. A write mount would
hand the agent a capability the tier table does not govern, does not display on the Provoz page
and cannot refuse — in the one milestone whose whole claim is that the platform gates what the
agent does.

There is a duller second reason. `client.ts` disposes the run workspace in a `finally`, so
anything written with the SDK's file tools is gone the moment the run ends. Whatever the agent
produces has to be captured *during* the run either way.

So the agent calls `write_service_file`, the bytes land in `service_artifacts`, and a host-side
`make adopt-service` materialises them over HTTP. Three consequences worth having: the source is
versioned per attempt, `demo-reset` removes it by cascade like everything else, and `open_pr`
reads the same rows the shadow run replayed, so the PR cannot drift from what was measured.

## 2026-08-06 · The agent writes the rules, the platform owns the shell
`write_service_file` accepts `pricing.ts` and `persist.ts` and refuses everything else.
`index.ts` and `db.ts` are the shadow harness's contract — `/replay/<proc>` taking the captured
parameters verbatim, `/health`, and the `/_admin/disconnect` handshake that keeps a revert at
530 ms instead of an unbounded wait. No specification describes any of them, and the failure
mode of re-deriving the route shape is four hundred replay cases returning 404, which the diff
engine would faithfully report as four hundred behavioural differences.

Said out loud rather than hidden: the agent wrote the pricing rules and the writes, the HTTP
shell is the migration harness's contract. The tool also refuses any import outside `fastify`,
`mssql` and the Node standard library, because the container installs its dependencies at build
time and a missing module fails at runtime, not at review.

## 2026-08-06 · The agent never sees what the golden tests expect
There is no tool that returns `expected_result` or `expected_write_set`, and no policy row that
could permit one. An implementation fitted to the oracle is not measured by it. The agent gets
the case *names* and the branches they cover — a description of the job, not the answer to it.

Same division of labour as `write_golden_tests` taking invocation ids instead of parameter
values, invariants being evaluated in code, and canonicalisation happening before the model
sees anything.

## 2026-08-06 · The clock pin lands in the golden suite and nowhere else
`golden_tests.baseline_context` has been declared since M4 and was never written; `recordBaseline`
now populates it. The service-side suite pins the service to that instant, and canonicalises
against that instant's clock window rather than today's — having pinned the service to the
baseline, the timestamps it writes belong to the baseline's window, and handing the canonicaliser
the current one would leave them looking like literal dates and fail every case on a field that
is normalised away on both sides.

The shadow harness must never use the pin. `GETDATE()` cannot be overridden inside T-SQL, so
pass A cannot be pinned, and pinning pass B alone would flip every clock-dependent branch on one
side only and manufacture divergence across four hundred cases. This reads like an obvious
improvement and is a trap.

## 2026-08-06 · `watchWrites` is factored out rather than copied
The golden suite has to measure a service with the same instrument that recorded the
expectation, so the before/after fingerprint logic is lifted out of `executeRolledBack` and
takes an `invoke` callback — a procedure call in one case, an HTTP request in the other.
A second copy of the checksum logic would drift, and the first symptom would be a "behaviour
change" that is really two different ways of asking what changed. `docs/DECISIONS.md` records
M5 learning that about `bindParameters`.

Whether the work is thrown away is the caller's business: the procedure runs inside a
transaction and rolls back, the service commits over its own connection and the shadow database
is reverted before each case. Reverting per case is ~530 ms and buys the property the baseline
had — every case starting from the same state.

## 2026-08-06 · The negative control for the golden suite is the reference implementation
Rather than fabricating a perturbation, the suite is run against the hand-written service,
which is known to diverge. Measured: **16 of 17 cases pass and `verny20_stacking_triggered`
fails** — the planted defect's own branch — with `TotalNet` identical on both sides
(29 416,6342) and `TotalVat` moving 6 589,3261 → 8 236,6576.

A suite that cannot fail is not evidence. M1 and M2 each shipped an assertion that compared a
constant to itself, and both times it was found by asking what would make it red.

## 2026-08-06 · The expectations recorded on ParityShop hold on the restored copy
Golden expectations were recorded against the estate inside a rolled-back transaction; the
service runs against `ParityShop_Shadow` and commits. Whether the two agree was assumed rather
than demonstrated, so `verify-m6` runs the **procedure** through the same service-side path on
the shadow copy first and asserts it is green. Measured: 17/17. If that ever goes red, nothing
else in the section means anything, so it is the first check in it.

## 2026-08-06 · `proven` needs a decision, not just a green run
`oracle_state` reaches `proven` only when three things hold at once: the run was against the
generated service, it surfaced no findings, and every behavioural difference the reference run
found carries a recorded decision. A green run against an implementation that simply reproduces
everything is proof that nothing changed, not that anyone agreed to anything — and `proven` is a
claim about a decision having been taken. Beat 4 is exactly this: the click is what moves the
estate.

Promote, never demote, the same rule and reason as the oracle's ladder.

## 2026-08-06 · `proven` short-circuits the blocker ladder
`blockerFor` returns `no_domain` when `domain` is null, and `domain` is null for all fourteen
rows with nothing in the codebase writing it. Without a short-circuit, the demo's closing move —
the blocker table advancing as `sp_CalculateOrderTotal` is migrated — would land on
`nepřiřazená doména`, which reads as a *new* problem appearing at the moment the story is
supposed to be finishing.

## 2026-08-06 · Three pricing services, each pinned to one database
`pricing-service` (reference, shadow copy), `pricing-service-generated` (the agent's, shadow
copy) and `pricing-service-live` (the agent's, the estate, behind the monolith's flag). The
live one connects as `sa`, like the monolith itself, and never as `parity_runner` —
`parity_runner` has `db_datawriter` on the estate, and using it here would put a footnote on
"Parity cannot write to the estate it analyses".

Rejected: one service choosing its database per request. It would put one process in a position
to write to both, and M5's *"the shadow connection never opens against ParityShop at all"* would
stop being an observation about a connection string and become an argument about a code path.

## 2026-08-06 · The flag is per request, defaults to the old path, and is not captured
`x-parity-pricing: service` routes one request to the extracted service; anything else,
including a value nobody recognises, runs the procedure. A migration is only reversible while
the thing it replaced still runs.

Service-path calls are deliberately **not** written to `parity_capture.Invocation`. A call that
never reached a procedure is not a procedure invocation, and recording it as one would put rows
into the capture describing calls the estate never made — the table every number downstream is
drawn from.

The two paths cannot be told apart by their response: the procedure has no result set, so the
endpoint has always returned `{ total: null }`. They are told apart by what they write and by
which service saw the request, which is what the gate asserts on.

## 2026-08-06 · Assembling a PR and opening one are separate acts
`open_pr` assembles the branch, the files and the Czech body and persists them; opening is a
second, explicit step. Opening a pull request on a public repository is the one act in this
platform that `make demo-reset` cannot take back, so `verify-m6` only ever assembles — and the
tier table refuses `open_pr` to every task class, which means whatever does open one always has
a person behind it. `probe-pr` provokes that refusal live, because `seedPolicy` writes the tier
table unconditionally and a check against it could not fail.

The PR carries exactly the four things `docs/MILESTONES.md` names — spec, tests, service and the
recorded decision. Not the feature flag and not the HTTP shell: both are platform code already
on `main` by the time anyone opens it, and a PR that re-states merged code is one nobody reads
to the end.

## 2026-08-06 · One repository, and the token comes from `gh`
PRs open against `secho/parity-workspace` at the `parity-platform-demo-app/` path, as the M0
entry requires. `GITHUB_DEMO_REPO` named a repository that does not exist and was read by no
code; it is replaced by `GITHUB_REPO`. `make github-token` takes the token from the `gh` CLI the
operator is already signed in to and writes it into `.env`, which is gitignored — nothing is
pasted by hand and no credential enters the repository. Without one, Parity assembles the PR and
reports why it cannot open it; it never shows a URL nothing opened.

The GitHub client is plain `fetch` against the Git Data API — blobs, tree, commit, ref, PR — in
one file, no Octokit. Four documented REST calls did not justify a seventh dependency, and
*"the PR adapter is one interface, GitHub here and ADO in production"* is a credible sentence
only if the file behind it can be read in one sitting.

## 2026-08-06 · Decisions are read by procedure, not by the latest run
The queue is scoped to the newest succeeded run per procedure, correctly — it shows work, and
superseded work is not work. M6 makes the consequence visible: the moment the generated service
replays green, the latest run has zero findings, so the queue empties and takes the *decided*
list with it. Beat 4 would end on a blank screen immediately after the most important click in
the demo. A decision is a record, not work; it belongs to the procedure and outlives the run
that provoked it, and the procedure screen's `Rozhodnutí` tab reads it that way.

## 2026-08-06 · The shadow run asks its target what it is
`shadow_runs.implementation` was a hardcoded literal at M5 — harmless with one replacement, and
actively wrong with two: the agent's service would have been recorded as the hand-written one.
It is now derived from the target's `/health`, including the artefact hash it is serving, so
"the source that was replayed is the source the agent wrote" is a query across two systems
rather than an assumption. A health gate runs before pass B for the same reason: a service that
is down or has no adopted source says so, instead of failing four hundred cases on a run whose
status still reads `succeeded`.

## 2026-08-06 · VERNY20 expires on 2026-12-31
`db/30-reference.sql` sets the promo's validity window, and the planted divergence needs
`@PromoDiscount > 0`. Outside that window both branches compute the same value and the defect
vanishes from the shadow run. Seed and traffic are pinned to `DEMO_EPOCH`, but the *replay*
reads the live server clock on both sides, so the demo is correct until the end of 2026 and
silently degrades afterwards. Recorded here because M6 is the last milestone positioned to
notice it.

## 2026-08-06 · Replay serves recordings from the live tables, not from a parallel store
The plan considered `recorded_*` tables that `resetState` would not touch. They were not built,
and the reason is that the snapshot makes them redundant: `make restore-golden` puts the whole
recorded analysis back in two seconds, so after a reset the recordings are there again along with
the artefacts they produced. A parallel store would have to be kept in sync with the real one and
would answer a question — "what did this run do?" — that the real tables already answer. Replay
therefore means: find the newest **non-replayed** succeeded run of this skill for this procedure,
and re-materialise it. `agent_runs.replayed_from IS NULL` is what stops a rehearsal from replaying
a replay of a replay.

## 2026-08-06 · A replayed run writes rows, progressively — it does not stream a phantom
The obvious implementation of replay pushes the recorded steps down the SSE stream and writes
nothing. It produces a completely empty screen. `Procedure.tsx` treats the SSE event as a *signal
to refetch* and discards the payload, so the table is the interface: the rows are written as the
replay proceeds and the event goes out **after** the insert. This is also why `playRecording`'s
emit callback is awaited.

## 2026-08-06 · A replayed run carries the model but not the cost
`cost_usd` and the token counts stay NULL on a replayed row, while the model, the turn count and
the output are copied. The row is a real record of something that really happened — a replay —
and the one column that measures whether replay is doing what it claims is the spend. `verify-m7`
reads the estate's total before and after and requires it not to move; copying the recorded cost
would make that check fail, and it would be a lie in exactly the wrong place. No audit rows either:
the audit log falls out of `PostToolUse`, no hook fired, and inventing entries would break the
claim that nothing in it is instrumented by hand.

## 2026-08-06 · `promoteAfterShadow` requires a reference run before granting `proven`
`sp_GetCartSummary` earned `proven` on its first green run. It has no hand-written reference
implementation, so the condition "every behavioural difference the reference run found has a
recorded decision" quantified over an empty set and passed vacuously — the ladder handed out its
top rung for nothing, which is the failure mode M1 and M2 each shipped once. The ladder now also
requires a succeeded `reference` run to exist. The refusal is the better story: the lane ran end
to end and the platform declines to call it proven, because nothing here has ever been shown to
diverge.

## 2026-08-06 · `campaign_runs` is one table with an `items` array
Not `campaigns` + `campaign_items`. There are exactly three campaigns and their definitions are
code, so a `campaigns` table would be a table with three hardcoded rows behind three functions.
Item state is the opposite case: the deletion campaign produces no agent runs at all, so "which
items are done" cannot be derived from anything — which is precisely when storing it is right.
The same test `blocker` passes in the other direction.

## 2026-08-06 · Campaigns skip completed items
Ten lines, three reasons: rehearsable, idempotent for the gate, and honest about beat 2's timing.
`Zmapovat estate` is 28 model runs and $7.12; that does not fit in a two-minute beat and no amount
of choreography will make it. Started on a mapped estate the same button finishes in 266 ms and
reports *14 přeskočeno*, which is true. The probe that checks this **refuses to run** when the
estate is not fully mapped — a gate that could accidentally spend $7 is a gate that eventually
does.

## 2026-08-06 · The deletion PR has a NULL `procedure_id`, so `resetState` names `pull_requests`
It removes three procedures at once and belongs to none of them. The consequence is easy to miss:
a NULL foreign key does not cascade, so the row survives `TRUNCATE procedures` and beat 1 would
open with yesterday's deletion PR still assembled. `resetState` therefore names `pull_requests`
and `campaign_runs` explicitly — `campaign_runs` has no foreign key at all — and `verify-m7`
checks the list empirically rather than by reading it: it truncates what the reset truncates
inside a transaction it rolls back, and requires the set of tables still holding rows to be
exactly `{policy_rules}`.

## 2026-08-06 · A deletion is a tree entry with `sha: null`
No delete call, no second code path. A git tree is a complete statement about the paths it
mentions, so an entry naming an existing path with a null sha says "not in this tree". `CommitFile`
gained `contents: string | null` and the blob loop skips blob creation for a null. This is the one
M7 claim asserted by construction rather than by exercise: the gate checks the assembled tree, and
the API call itself only happens when a person runs `make open-pr PROC=deletion --commit`.

## 2026-08-06 · `verify-m7` runs destructive code inside transactions it rolls back
Both resets are real code paths with real consequences — `demo-reset` costs $16 of analysis to
undo, `reset-procedure` costs $1.39. Reading the table list out of the source and agreeing with it
is not a check, it is a second copy of the same opinion. TRUNCATE and DELETE are both transactional
in Postgres, so the gate runs the actual functions, measures what happened, and rolls back. The
probes also clean up the two replays they create, so the gate leaves the database exactly as it
found it — otherwise every acceptance run would invalidate the committed snapshot it had just
verified.

## 2026-08-06 · The demo script's numbers are checked against Postgres on every gate run
`verify-m7` §9 reads `docs/DEMO-SCRIPT.md` and requires the figures in beats 3 and 4 to be the
ones in the database, compared with whitespace flattened so that a non-breaking thousands
separator is not mistaken for a wrong number. This build has shipped a stale demo number twice.
A number in that file is now a claim the gate enforces.

## 2026-08-06 · Four audit outcomes, four labels
`Provoz.tsx` rendered anything that was not `blocked` as a green *povoleno* chip, so `denied` (the
SDK refusing a tool that is not in `allowedTools`) and `failed` (the call erroring) both displayed
as successes — 54 of 521 rows saying the opposite of what happened. The two refusals are red with
different labels naming which gate said no; `failed` is amber, because the call happened.

## 2026-08-06 · `PARITY_MODE` is on the badge in both directions
It used to show only when it was not `live`. That makes the most likely on-stage failure —
running a stretch in the wrong mode — invisible in exactly one direction: a replayed beat
announced itself, and a beat that was meant to be replayed and quietly went live did not.
`LIVE` is grey, `REPLAY` is amber and boxed, and both are always on screen.

## 2026-08-06 · The replay source is a second database, and the earlier decision was wrong
Two entries above, replay was recorded as reading recordings out of the live tables, on the
grounds that `make restore-golden` puts them back after a reset. That holds right up to the
question anyone actually asks: *can beat 1 open on an empty estate and beats 2–4 still be
replayed?* No — the recordings ARE the analysis, `resetState` truncates `agent_runs` and
`agent_steps` with everything else, and a replay reading from the live database can therefore only
ever re-show what is already on screen. The plan's original `recorded_*` tables existed for exactly
this and should not have been dropped.

They come back as `parity_replay`, a second database built by `make load-replay-source` from the
committed snapshot — the same three commands `replay-check` uses, so the database replay reads from
is built identically to the one the round-trip is proven against. Nothing writes to it. It is
opened lazily, so a stack running `PARITY_MODE=live` never needs it to exist.

Measured from a genuinely blank estate: the whole `Zmapovat estate` campaign replays in 94 s for
$0.00, and the migration lane on one procedure in 15 s. Live those are an hour and $9, and five
minutes per procedure.

## 2026-08-06 · A replayed run re-materialises what it produced, not just its transcript
The obvious shape of replay re-emits steps. That gives you a step stream and an empty Specifikace
tab, because `runner.ts` truncates every tool input to 2 000 characters — the `write_spec` step in
a recording carries 2 000 characters of a specification that is 15 368 long. So each skill declares
what it writes and a replayed run copies exactly that for exactly that procedure: the spec, the
golden cases and invariants, the service artefacts, and triage's classification. `verify-m7` §10
compares the materialised specification to the recorded one **byte for byte** from a reset
database, because a length check would pass on the truncated copy the transcript really does carry.

Three rules hold it together. Identity across the two databases is **by name**, never by id, since
`demo-reset` re-ingests and assigns fresh ids. `agent_run_id` on a copied artefact points at the
**replay**, not at the recording — the recorded run does not exist in the live database and the row
is genuinely the output of the run now on screen. And nothing copied moves the ladder:
`oracle_state` is still promoted by `promoteAfterOracle` and `promoteAfterShadow` from executions
that really happen, because recording a baseline runs the procedure and that costs nothing.

## 2026-08-06 · `replayed_from` is not a foreign key
It holds an id from the replay source. A foreign key cannot express a cross-database reference, and
the constraint that existed while the two were one database was dropped at M7 rather than kept as
something that happened to hold. The first replay after the source moved failed on it immediately,
which is the good version of finding out.
