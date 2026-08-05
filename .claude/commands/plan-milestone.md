---
description: Enter plan mode for a specific milestone and produce a file-level implementation plan
---

Read `CLAUDE.md`, `docs/SPEC.md` and the section of `docs/MILESTONES.md` for milestone **$1**.

Produce an implementation plan containing:
- every file you will create or modify, with a one-line purpose
- the order of operations
- exactly what `make verify-$1` will assert
- any question that `docs/SPEC.md` does not answer — as a list, not as an assumption

Work only on milestone $1. Do not start the next one. Do not write code in this turn.

If anything in the spec is ambiguous, list it rather than deciding. Ambiguity resolved silently is the main way this build goes wrong.
