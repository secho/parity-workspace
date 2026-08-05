---
description: Run the full demo choreography end to end and report anything that would break on stage
---

Run `make demo-reset`, then execute every beat of `docs/DEMO-SCRIPT.md` in order, driving the system exactly as the presenter would.

Report:
- any step requiring manual intervention
- any step taking longer than its budgeted time
- any number that differs from the previous run with the same seed
- any UI surface showing an empty, loading or error state at a moment when the presenter would be talking over it

Do not fix anything in this run. Report first.
