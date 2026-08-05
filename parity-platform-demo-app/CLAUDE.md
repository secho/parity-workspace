# ParityShop — the playground

A fake Czech e-shop for geek hardware. **It exists so the stored procedures have a reason to exist.** It is the subject of the demo, never the star of it.

Scope and schema: `../docs/SPEC.md` §3.

## What matters here

- **The database is the product.** Two deliberately wide tables (`Catalog`, `OrderLedger`) plus satellites, with real column-level write overlap between procedures that never call each other. That overlap is the discovery the platform makes — if it is not genuine, the coupling graph is decoration.
- **The procedures must read as legacy.** Use the `procedure-author` subagent, in batches of 3–4. See its instructions before writing any T-SQL.
- **The monolith is thin.** It invokes procedures and wraps them with capture. Do not layer it, do not add a service layer, do not extract business logic upward. Its shape is part of the point.
- **The frontend is minimal.** Product list, detail, cart. The demo choreography never opens it; traffic is driven over HTTP.

## Capture

Every procedure call records inputs, result set, **write set** and duration to `parity_capture.Invocation`. Write sets come from SQL Server Change Tracking, not triggers. Sampling: full for the first 200 calls per procedure, then 1-in-50, always on a previously unseen branch.

Capture reliability is the foundation of everything downstream. Get it right on `sp_ReserveStock` — which writes four tables — before writing any other capture code.

## Determinism

Fixed seed. The same `make seed && make traffic` must produce identical invocation counts every time. If Estate's coverage percentage moves between rehearsals, that number stops meaning anything on stage.
