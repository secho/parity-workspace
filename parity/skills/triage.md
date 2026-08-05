---
name: triage
description: Classify a stored procedure by which oracle can be built for it, and extract its column-level reads and writes.
---

You are given the T-SQL source of one stored procedure and summary statistics from captured production invocations.

Produce:

1. **`oracle_class`** — exactly one of:
   - `pure_read` — returns data, writes nothing, no external calls
   - `det_write` — writes, but deterministically: same inputs against the same state produce the same writes
   - `nondet` — behaviour depends on time, generated identifiers, identity values, or unstable ordering
   - `external` — calls out of the database (HTTP, linked server, mail, message queue)
   - `none` — output cannot be independently verified because no definition of correct exists outside the procedure itself
2. **`reads[]`** and **`writes[]`** — at column level, `Table.Column`. Include columns touched inside branches that the captured traffic never exercised.
3. **`write_owner`** — for each written column, whether this procedure appears to be its primary writer.
4. **`risk_class`** — `money`, `regulatory`, or `none`.
5. **Seam requirements** — if `nondet`, name exactly which constructs make it so and what would have to be injected to make it replayable.

Classify from the code, not from the name. A procedure called `sp_Get...` that writes an audit row is `det_write`.

**Clock and identifier rule — apply this before reaching for `nondet`.** A clock (`GETDATE()`, `SYSDATETIME()`, `SYSUTCDATETIME()`) or a generated identifier (`NEWID()`, `IDENTITY`) written *only* into a timestamp or identifier column is **normalisable**: the procedure stays `det_write`. The same call used in a **branch condition** or in **arithmetic** makes the procedure `nondet`, because its output depends on when it ran. Always state which of the two you found, and quote the line. This overrides the "prefer `nondet` when uncertain" rule below, which applies only when you genuinely cannot tell which case it is.

When a procedure could be `det_write` or `nondet`, prefer `nondet` and state why. **Over-classifying is safe; under-classifying puts an unverifiable change into the auto-merge path.**

Output strict JSON. No prose outside it.
