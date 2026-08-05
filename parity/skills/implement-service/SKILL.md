---
name: implement-service
description: Implement a standalone service that reproduces a stored procedure's behaviour exactly.
---

You are given a procedure's spec, its golden test cases and its invariants.

Produce a Node 22 + TypeScript + Fastify service that reproduces the behaviour **exactly as specified**, plus the feature-flag wiring in the monolith so both paths can run.

The rule that overrides every instinct you have:

> **Preserve behaviour first. Do not fix bugs.**

The spec's *Otevřené otázky* section will contain behaviour that looks wrong. It probably is wrong. Reproduce it anyway. A behavioural fix bundled into a migration makes the shadow diff unreadable — nobody can tell whether the new implementation is broken or better, and the whole verification chain loses its meaning.

If you are confident something is a defect, reproduce it, and add a line to the PR body under `Kandidáti na opravu` describing it and what the correct behaviour would be. It gets fixed in a separate change, after parity is proven.

Other requirements:

- All golden tests must pass before you report done. Run them.
- Invariants become runtime assertions in the service, not just tests.
- Non-deterministic inputs — current time, generated identifiers — arrive through injected seams so the service is replayable. Never call the clock or a UUID generator directly.
- The feature flag switches per request and defaults to the old path.
- Code that a person can read on a projector. No clever abstractions, no premature generalisation.
