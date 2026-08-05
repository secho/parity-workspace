# Parity — build specification

Specification for Claude Code. Two repositories, one demo. Everything here is meant to be built and run live in front of an audience, repeatedly, from zero.

**Language rule:** code, identifiers, commits and comments in English. **All user-facing UI copy in Czech** — both apps are shown to a Czech-speaking audience. Czech engineering register: `review`, `PR`, `build`, `deploy`, `trigger`, `event`, `sandbox`, `guardrails`, `policy`, `skill registry`, `fleet`, `shadow run` stay English inside Czech grammar.

---

## 1. What this demonstrates

One claim, made concrete: **an agent can take an opaque stored-procedure estate, make it legible (spec), make it verifiable (oracle), and then safely replace a procedure with a service — with proof that behaviour did not change.**

Everything in the build serves that sentence. If a feature does not serve it, it is out.

### Non-goals — the cut

Explicitly **not** built, and each has a one-line answer if asked:

| Not built | Answer in the room |
|---|---|
| Model gateway / routing / model catalogue | "You already run LiteLLM. Parity is a client of a gateway, never one itself — the demo talks to the Anthropic API directly, production would point at yours. One config line." |
| Azure DevOps integration | "The PR adapter is one interface. GitHub here, ADO in production — it's a swap, not a rebuild." |
| Auth, SSO, multi-tenancy, RBAC | Demo runs single-user. |
| Agent swarms, multi-agent orchestration | One agent, several skills. Swarms are a scaling pattern, not a proof point. |
| Cost dashboards, billing | A token/cost counter per run is enough. |
| Agent catalogue / marketplace | That is the commodity shell (appendix deck, slide 11). |

### Indicated but real — shallow, never fake

These appear on screen with enough detail to read as a platform, and each is genuinely wired. **Nothing is a mock.** A single fake screen destroys the credibility of everything else.

- **LLM routing** — every model call goes through a LiteLLM-compatible endpoint. UI shows a `routing přes LLM Gateway` badge with the model name actually used.
- **Skill registry** — a real directory of `SKILL.md` files that the agent actually loads. UI lists them and shows which skill produced which artefact.
- **Policy layer** — a real table of autonomy tiers per task class. It actually gates: below-threshold actions auto-proceed, above-threshold ones block on a human click.
- **Audit log** — every agent step, tool call, token count and decision, appended and viewable.
- **Linear** — behind a feature flag. Each blocked estate item can be linked to a Linear issue. Fixture fallback when the flag is off.

---

## 2. Repositories

| Repo | Contents |
|---|---|
| `parity-platform-demo-app` | The playground: mini e-shop, MS SQL core, monolith, frontend, traffic generator. The thing that gets refactored. |
| `parity` | The platform: estate ingestion, agent, oracle machinery, shadow harness, UI. |

`parity` operates on `parity-platform-demo-app` from the outside — over the database connection, the monolith's capture log, and the GitHub API. It never imports the demo app's code. That separation is the point: Parity must look like something that could be pointed at Alza's real estate.

### Reset requirement — non-negotiable

Both repos come up from zero with:

```
docker compose down -v && docker compose up --build
make seed          # schema + procedures + reference data
make traffic       # generate 90 days of synthetic invocation history
make demo-reset    # wipe Parity state back to "nothing analysed yet"
```

`make demo-reset` must return the whole system to a pristine pre-demo state in under two minutes, including any branches or PRs created on the last run. The demo will be run repeatedly — in rehearsal, in the room, and possibly twice if someone asks to see it again.

---

## 3. The playground — `parity-platform-demo-app`

### Product

**ParityShop** — a fictional Czech e-shop for geek hardware and gadgets. Categories: components, peripherals, single-board computers, retro, merch. Roughly 300 products, 8 categories, 3 warehouses, 500 customers, 5 000 historical orders.

The e-shop only needs to be believable, not beautiful. It exists so the stored procedures have a reason to exist.

### Stack

| Layer | Technology | Why |
|---|---|---|
| Database | **MS SQL Server 2022** (`mcr.microsoft.com/mssql/server`, Developer edition, in Docker) | Alza's core is MS SQL. T-SQL procedures on screen are the single strongest authenticity signal — Kúdeľka will read them. |
| Monolith | **Node 22 + TypeScript**, Fastify, `mssql` driver, single project, no layering | Deliberately monolithic — the business logic lives in the procedures, the monolith is a thin invoker plus glue. Not .NET: one language across the whole build is worth more than stack-shape authenticity, and the authenticity that matters (MS SQL, T-SQL) is untouched. One sentence covers it in the room. |
| Frontend | **React + Vite + TypeScript**, plain CSS | Just enough shop to click through. |
| Extracted service | **Node 22 + TypeScript**, Fastify, separate container | The migration target. |
| Traffic generator | **TypeScript** script | Same toolchain; drives the monolith's HTTP API. |

### Schema — deliberately bad, in Alza's specific way

Two dominant wide tables plus satellites. This is not laziness; it is the thing being demonstrated.

- `dbo.Catalog` — ~60 columns. Product master, pricing, stock, category, supplier, SEO, flags, audit columns, four unused legacy columns. Written by six different procedures.
- `dbo.OrderLedger` — ~70 columns. Orders, order lines denormalised, customer snapshot, payment, shipping, discounts, status history flattened into `Status1..Status6`. Written by five different procedures.
- Satellites: `dbo.Customer`, `dbo.Warehouse`, `dbo.StockMovement`, `dbo.PromoCode`, `dbo.AuditTrail`, `dbo.CustomerScore`.

**The coupling must be real and non-obvious**: procedures that never call each other must write overlapping column sets on `Catalog` and `OrderLedger`. That is what makes the data-coupling graph a discovery rather than a decoration.

### Stored procedures

Fourteen procedures. Ten live, one rarely called, three dead. The oracle-class spread is designed so the triage screen tells a true and varied story.

| # | Procedure | Behaviour | Oracle class | Demo role |
|---|---|---|---|---|
| 1 | `sp_GetProductDetail` | Single product + stock + price | `pure_read` | Easy tier-1 example |
| 2 | `sp_SearchProducts` | Filter, sort, page over `Catalog` | `pure_read` | **Ordering trap** — no `ORDER BY` on ties, so replays legitimately differ. Feeds the noise classifier. |
| 3 | `sp_GetProductAvailability` | Availability across 3 warehouses | `pure_read` | High invocation volume; hot path |
| 4 | `sp_GetCartSummary` | Cart totals, read-only | `pure_read` | Calls into #5's logic by copy-paste — duplication the spec surfaces |
| 5 | `sp_CalculateOrderTotal` | Line items, discounts, promo, VAT, shipping, loyalty | `det_write` (computes, writes a cache row) | **The migration target.** Money, deterministic, invariant-rich. |
| 6 | `sp_ReserveStock` | Decrements stock, writes reservation + `StockMovement` + `AuditTrail` | `det_write` | Multi-table write set — proves write-set diffing |
| 7 | `sp_ApplyPromoCode` | Stacking rules, validity windows, per-customer limits | `det_write` | Nasty edge cases; long-tail coverage story |
| 8 | `sp_PlaceOrder` | Orchestrates 5, 6, 7; assigns order number | `nondet` (`NEWID()`, `GETDATE()`, `IDENTITY`) | **Needs a seam** before it can be shadowed — the blocker table's largest row |
| 9 | `sp_SyncWarehouseDispatch` | Calls an external warehouse HTTP endpoint | `external` | Cannot be shadowed safely — blocked, honestly |
| 10 | `sp_RecalculateCustomerScore` | Ten years of accreted scoring rules, no definition of correct | `none` | **Tier 3.** The honest limit. Raise it yourself on stage. |
| 11 | `sp_LegacyPriceImport_v2` | Called ~4× in 90 days | `det_write` | Cold, not dead — the judgement case |
| 12 | `sp_ExportCatalogXml_OLD` | Zero invocations | `pure_read` | Dead → phase 0 |
| 13 | `sp_MigrateCustomerAddresses` | Zero invocations | `det_write` | Dead → phase 0 |
| 14 | `sp_RecomputeLoyaltyTier_deprecated` | Zero invocations | `det_write` | Dead → phase 0 |

Each procedure must be **genuinely gnarly**: 80–300 lines of T-SQL, nested `IF` blocks, temp tables, cursors in one or two, magic numbers, commented-out blocks, at least one comment in Czech saying something like `-- docasne, opravit pozdeji` dated 2014. It has to look like real legacy or the whole demo reads as a toy.

### Invocation capture

The monolith wraps every procedure call and records to `parity_capture.Invocation`:

```
id · proc_name · called_at · input_params (json) · result_set_hash · result_set (json, sampled)
· write_set (json: table → [{pk, column, before, after}]) · duration_ms · caller_context
```

Write-set capture: each procedure call runs inside a transaction with change tracking on the touched tables (temporal tables or a trigger-based shadow — implementer's choice, but it must be reliable).

**Sampling policy:** full capture for the first 200 calls per procedure, then 1-in-50, plus always-capture on any call whose input hits an uncovered branch. Store bounded — the whole capture table stays under ~200 MB.

### Traffic generator

Produces 90 days of history in one run (~3 minutes):

- **Power-law distribution** — `sp_GetProductAvailability` and `sp_SearchProducts` take ~70 % of all calls; the tail procedures get hundreds not millions.
- **Realistic sessions** — browse → cart → promo → order, so co-invocation is meaningful and the domain-boundary evidence is real.
- **Rare branches on purpose** — leap-day orders, negative stock corrections, Slovak VAT rate, a promo code that stacks with loyalty, an order with 40 line items. These exist so that branch coverage is genuinely incomplete and the adversarial-input step has something to find.
- **Dead procedures get zero calls.** Ever.

---

## 4. The platform — `parity`

### Stack

| Layer | Technology |
|---|---|
| Backend | Node 22 + TypeScript, Fastify |
| Agent | **`@anthropic-ai/claude-agent-sdk`** (TypeScript) |
| Auth | `ANTHROPIC_API_KEY` from the Console. **Not** Pro/Max OAuth — Anthropic's Agent SDK docs prohibit claude.ai subscription auth for products built on the SDK unless previously approved, and this repo is public. |
| Store | Postgres via Drizzle (Parity's own state — deliberately not the demo app's DB) |
| Frontend | React + TypeScript + Vite |
| Queue | In-process worker + SSE for live progress. No Redis, no broker. |

### Visual direction

Parity looks like **an ops console that belongs next to LiteLLM's admin UI** — left sidebar, dense tables, monospace for identifiers, muted surfaces, no marketing gradients. The intended reaction is "this is another part of the stack we already run", not "this is a product someone is selling us".

Concretely: sidebar nav (Estate · Kampaně · Fronta · Skills · Policy · Audit), 13–14 px table type, status as small text chips not colourful pills, a persistent top-right badge `LLM Gateway · <model>` showing the model actually in use.

### Data model

**`Procedure`** — the estate entity, one row per procedure:

```
id · name · schema · source_sql · line_count · domain (nullable)
invocations_90d · last_invoked_at
reads[] · writes[] · write_owner            -- column-level
oracle_class    pure_read | det_write | nondet | external | none
oracle_state    none | golden | invariants | shadow | proven
campaign_status untouched | specced | oracled | shadow | migrated | deleted
blocker         DERIVED, never stored by hand
owner_team · risk_class (money | regulatory | none)
```

`blocker` is a computed property from `oracle_class` + `oracle_state` + `domain`. It cannot be edited. Same principle as the DSL rule: derived, not maintained, so it cannot drift or lie.

Other entities: `Spec`, `GoldenTest`, `Invariant`, `ShadowRun`, `Diff`, `DiffVerdict`, `AgentRun`, `AgentStep`, `Campaign`, `Decision`, `PolicyRule`, `Skill`.

### The agent

One agent, built on the **Claude Agent SDK** (TypeScript). Not a hand-rolled tool-use loop — the SDK supplies the loop, context management, file tools, bash, permission modes and hooks, and three of its features map directly onto claims made on stage.

**Skills are real files, not a UI decoration.** `parity/skills/*.md` are loaded by the SDK via `settingSources: ['project']`. The UI lists them and shows which skill produced which artefact. The claim "update one file, every agent run picks it up" is then literally true and can be demonstrated by editing a skill mid-demo if anyone asks.

**Policy is enforced by a `PreToolUse` hook**, not by prompt wording. The hook reads the autonomy-tier table and refuses a tool call that exceeds the tier for that task class — the run pauses and the item lands in the decision queue. This is the appendix deck's *"pravidla vynucuje platforma, ne prompt"* made executable.

**The audit log falls out of `PostToolUse` hooks.** Every tool call, its arguments, result summary, duration and token count is appended automatically. Nothing is instrumented by hand, so nothing can be forgotten.

**Custom tools** are defined with `tool()` (Zod schemas) and exposed through `createSdkMcpServer()` in-process — no external MCP servers to run:

`query_capture` · `read_procedure` · `write_spec` · `write_test` · `run_shadow` · `open_pr` · `record_decision`

File editing, reading and bash come from the SDK's built-ins.

**Model selection mirrors the hybrid story.** Bulk work across the estate (triage, spec extraction over 14 procedures) runs on a Sonnet-class model; the hard single-shot work (`implement-service`, ambiguous `classify-diff` calls) escalates to an Opus-class model. Set per skill, visible in the UI, and it is the same routing argument made in the main deck — cheap model for volume, best model for the hard thing.

Every run sets `maxTurns` and an explicit permission posture. Unattended runs never use `bypassPermissions`.

| Skill | Input | Output |
|---|---|---|
| `triage` | `source_sql` + capture stats | `oracle_class`, `reads[]`, `writes[]`, risk flags |
| `extract-spec` | `source_sql` + sample invocations | structured Markdown spec: purpose, inputs, behaviour, invariants, data touchpoints, open questions |
| `generate-oracle` | spec + captured invocations | golden test cases + proposed invariants |
| `propose-boundaries` | data-coupling graph + co-invocation | 2–3 candidate decompositions, each scored by cross-boundary writes |
| `implement-service` | spec + golden tests | TypeScript service implementing the procedure's behaviour, + monolith feature-flag wiring |
| `classify-diff` | old vs new result + write set | `noise` (with reason: time, guid, ordering, float) or `behaviour_change` (with explanation) |

Every step streams to the UI and lands in the audit log.

### Shadow run harness

The core mechanism. Must actually work, not be simulated.

1. Pull N captured invocations for the procedure (stratified: hot paths + every distinct branch seen).
2. For each: call the new implementation with identical inputs.
3. Compare **result set** (canonicalised: stable sort, float tolerance, timestamp and GUID normalisation via the seam) **and write set**.
4. New implementation runs against a **restored snapshot database** inside a transaction that is always rolled back. The production-equivalent DB is never touched.
5. Every difference becomes a `Diff` row. The agent classifies each. Only `behaviour_change` reaches the decision queue.

Target for the live demo: replay 2 000+ captured calls of `sp_CalculateOrderTotal` in under 60 seconds, produce a realistic number of raw diffs (dozens), classify nearly all as noise, surface 2–4 real ones.

**One of the surfaced diffs must be a genuine legacy bug** — e.g. the old procedure applies a promo before VAT in one branch and after VAT in another. The agent flags it, the human decides "preserve, then fix separately", and Parity records that decision. This is the most persuasive thirty seconds of the whole demo: it shows the system finding something humans had missed, and shows it *not* silently fixing it.

### Screens

**1 · Estate** (landing). All 14 procedures. Top: total, oracle coverage **weighted by invocation**, quarter's paydown, human intervention rate. A status bar across the portfolio. Below: blocker breakdown table, each row linking to the filtered list. Column-sortable table of procedures with class, state, invocations, blocker.

**2 · Kampaň.** A campaign = one intent over a slice. Live progress per item, agent steps streaming, token/cost counter, PRs opened. Prepared campaigns: `Smazat mrtvé procedury`, `Zmapovat estate`, `Vytáhnout výpočet ceny do služby`.

**3 · Procedura** (drill-down). Tabs: source, spec, oracle (golden tests + invariants with pass rate), shadow runs (chart over time + per-run diff list), decisions, PR. This is where the end-to-end lane is visible on one screen.

**4 · Fronta rozhodnutí.** Only genuine human items, routed by `owner_team`. Header counter: `X odchylek dnes · Y doputovalo k člověku`. Each item: side-by-side old vs new, the agent's reasoning, and buttons — `Zachovat chování`, `Přijmout změnu`, `Eskalovat`.

**5–7 · Skills, Policy, Audit.** Thin but real, as specified in §1.

### Record / replay

Every `AgentRun` and `ShadowRun` persists inputs, outputs and timings. `PARITY_MODE=replay` serves the recorded run with original timings instead of calling the model.

Two reasons, and say both out loud if asked:
1. The demo cannot depend on conference wifi or an API being up.
2. It is the same mechanism the platform uses on production traffic. **Parity replays its own runs exactly the way it replays the estate's.** That coherence is worth a sentence on stage.

Ship a recorded golden run in the repo so a fresh clone can demo immediately.

---

## 5. Demo choreography

Roughly nine minutes, four beats. The build is only finished when this runs start to finish without a human fixing anything.

**Beat 1 — Estate (60 s).** Open on Estate. Fourteen procedures, coverage near zero, everything `untouched`. "This is the situation. Nothing is analysed, nothing is verifiable, and nobody can tell you which of these are safe to touch."

**Beat 2 — Triage and phase 0 (2 min).** Run the `Zmapovat estate` campaign. The agent reads all fourteen, classifies them, builds the coupling graph. The blocker table fills in. Three procedures show zero invocations → run `Smazat mrtvé procedury` → PR opened on GitHub, visible. First measurable paydown, in two minutes, with zero risk.

**Beat 3 — One procedure, end to end (4 min).** Open `sp_CalculateOrderTotal`. Agent extracts the spec — read one paragraph of it aloud; it is in Czech and it is *comprehensible*, which is the point. Agent generates golden tests from captured traffic plus three invariants. Agent implements `pricing-service`. Shadow run fires: 2 000 calls replayed, diffs appear, classifier sorts them, the count of human-facing items settles at three.

**Beat 4 — The decision (2 min).** Open the queue. Three items. One is the legacy promo/VAT bug. Show the side-by-side, show the agent's reasoning, click `Zachovat chování`. Agent adjusts, shadow reruns green, PR opens with spec, tests, service and the recorded decision attached. Back to Estate — coverage moved, the blocker table moved, and **that table is the roadmap**.

Then straight to the roadmap slide of the main deck.

---

## 6. Build order

| Milestone | Definition of done |
|---|---|
| **M0** | `docker compose up` brings up MS SQL + monolith + frontend. Schema, 14 procedures, seed data. Shop is clickable. |
| **M1** | Traffic generator produces 90 days of history. Capture table populated with result and write sets. Sampling works. |
| **M2** | Parity ingests the estate: procedures listed, invocations counted, coupling graph built. Estate screen live. |
| **M3** | Agent + skill loading + LiteLLM client + audit log. `triage` and `extract-spec` working end to end. Procedure screen live. |
| **M4** | `generate-oracle` + golden tests + invariants. Oracle coverage number is real and invocation-weighted. |
| **M5** | Shadow harness: snapshot DB, replay, result + write-set diff, canonicalisation. `classify-diff`. Decision queue live. |
| **M6** | `implement-service` produces `pricing-service`, monolith feature flag, PR to GitHub. Full lane green. |
| **M7** | Campaigns, phase-0 deletion campaign, policy gating, Linear flag, `demo-reset`, recorded golden run, replay mode. |
| **M8** | Rehearsal: choreography §5 runs three times consecutively from `make demo-reset` with no intervention. |

M0–M2 are the foundation and carry no AI at all. Resist the urge to start at M3 — without honest capture data every downstream number is theatre, and theatre is exactly what this demo must not be.

---

## 7. Decisions taken

1. **Shop name** — `ParityShop`.
2. **Monolith language** — Node + TypeScript, one language across the whole build. If anyone asks why not .NET: the procedures and the database are the authentic part, the invoker is glue, and a single toolchain buys build time that went into the shadow harness instead.
3. **Live vs replay** — beats 1, 2 and 4 live; beat 3's model-heavy stretch from a recorded run, framed openly as *"tohle je nahraný běh — stejný mechanismus, kterým platforma přehrává váš provoz"*.
4. **Agent runtime** — Claude Agent SDK with `ANTHROPIC_API_KEY`. Subscription OAuth is not used, deliberately.

## 8. Watch out for

Failure modes worth naming before they cost a day each.

- **Write-set capture is the hard part of M1.** Get it working on `sp_ReserveStock` (four tables) before writing any other capture code. If it is unreliable there, the whole M5 diff is unreliable and nothing downstream is trustworthy.
- **Canonicalisation before classification.** Normalise ordering, timestamps, GUIDs and float tolerance in code *first*; only send what survives to the model. Asking the agent to classify raw noise wastes tokens and produces inconsistent verdicts between demo runs.
- **The procedures must not read as generated.** If all fourteen have the same shape and tidy formatting, the audience discounts everything. Vary line counts wildly, leave commented-out blocks, inconsistent naming (`@custId` vs `@CustomerID`), a cursor in two of them, and a dated Czech comment or two.
- **`make demo-reset` is a first-class feature, not cleanup.** It gets used more times than any other command. Build it at M2, not M7, and run every milestone's acceptance from a fresh reset.
- **Determinism of the demo itself.** Same seed, same traffic, same estate numbers every time. If the coverage percentage on the Estate screen moves between rehearsals, the number stops meaning anything to you on stage.


---

## 9. Two-day scope

This build has a two-day budget. `docs/SCHEDULE.md` lists the cuts made against the scope above and — more importantly — the five things that must **not** be cut. Read it before planning any milestone. Where this document and `SCHEDULE.md` disagree on scope, `SCHEDULE.md` wins.
