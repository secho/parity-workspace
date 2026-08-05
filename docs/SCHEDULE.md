# Two-day schedule

Aggressive but achievable. The single biggest accelerator is **running two Claude Code sessions in parallel** — the demo app and the platform are independent until M2.

```bash
git worktree add ../ws-app   # session A: parity-platform-demo-app
git worktree add ../ws-plat  # session B: parity
```

## Day 1 — foundation and legibility

| Block | Session A (demo app) | Session B (platform) |
|---|---|---|
| Morning | **M0** schema + 14 procedures + monolith | **M2 scaffold** Parity app shell, Postgres schema, Estate screen with empty state |
| Midday | **M1** capture + traffic generator | **M3a** Agent SDK wiring, skills loading, audit log via hooks |
| Afternoon | merge → **M2** estate ingestion from real capture data | |
| Evening | **M3b** `triage` + `extract-spec` running over all 14 procedures | |

**End of day 1 must be true:** `make demo-reset && make seed && make traffic` works, Parity lists 14 procedures with real invocation counts and oracle classes, and at least one spec has been generated and reads well in Czech.

If that is not true by end of day 1, cut the frontend shop to a bare product list and move on. Do not spend day 2 catching up.

## Day 2 — verification and the lane

| Block | Work |
|---|---|
| Morning | **M4** `generate-oracle`, golden tests, invariants, invocation-weighted coverage |
| Midday | **M5** shadow harness — snapshot DB, replay, result + write-set diff, canonicalisation, `classify-diff`, decision queue. **This is the hard one. Budget the most time here.** |
| Afternoon | **M6** `implement-service` → `pricing-service`, feature flag, PR to GitHub |
| Late | **M7** phase-0 deletion campaign, `demo-reset`, recorded golden run, replay mode |
| Evening | Rehearsal: run `docs/DEMO-SCRIPT.md` three times from a fresh reset |

## Scope cuts made for two days

These are deliberate. Do not restore them without asking.

| Cut | Why it is safe |
|---|---|
| Shop frontend beyond a product list, detail page and cart | The choreography never opens it. Traffic generator drives HTTP directly. |
| `propose-boundaries` skill | Not in the demo script. The boundary story is told on slides. |
| Linear integration | Pure decoration at this timescale. |
| Trigger-based write-set capture | Use **SQL Server Change Tracking** instead (`ALTER DATABASE SET CHANGE_TRACKING = ON`, read `CHANGETABLE(CHANGES ...)` after each call). Hours instead of a day, and more reliable. |
| Gnarly T-SQL in all 14 procedures | Only 6 need to be genuinely nasty: `sp_CalculateOrderTotal`, `sp_ReserveStock`, `sp_PlaceOrder`, `sp_ApplyPromoCode`, `sp_RecalculateCustomerScore`, `sp_SearchProducts`. The rest can be 40–80 lines. |
| Policy / Skills / Audit as separate screens | Fold into one `Provoz` page with three sections. Still real, still wired. |

## What must not be cut

- Real capture with real write sets. Without it every number downstream is theatre.
- The shadow harness diffing **result set and write set**.
- `classify-diff` and the human decision queue.
- The planted legacy bug (see `docs/SPEC.md`, promo vs VAT ordering). It is the best thirty seconds of the demo.
- `make demo-reset` and deterministic seeding.
