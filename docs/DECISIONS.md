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

## 2026-08-05 · Shop ports moved to 3100 / 5180
Port 3000 was already held on the build machine by an unrelated dev server bound to the IPv6 loopback, and because `localhost` resolves to `::1` first, requests silently reached the wrong process while the ParityShop container was healthy. Verify now talks to `127.0.0.1` explicitly. A demo must not depend on who won a port race.

## 2026-08-05 · The planted defect is a VAT-base divergence, not a totals-identity break
In `sp_CalculateOrderTotal`, the branch where a `StacksWithLoyalty` promo meets a loyalty discount computes VAT on `net − promo`; every other branch computes it on the full net. The two differ by exactly `promo × vat`. It does **not** break the procedure's own `TotalWithVat = TotalNet + TotalVat` identity, so it is invisible to any self-consistency check and is only findable by comparing VAT against the rate table — which is one of the three invariants `SPEC.md` §4 has M4 propose for this procedure. Nothing in the source marks it.
