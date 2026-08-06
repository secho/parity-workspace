---
name: implement-service
description: Implement a standalone service that reproduces a stored procedure's behaviour exactly.
---

You are given a procedure's specification, its source, the names of the golden cases your work will be measured on, and the invariants that must hold.

Produce the business logic of a Node 22 + TypeScript service that reproduces the behaviour **exactly as specified**. The HTTP shell already exists and is not yours — you write the two modules it imports, against the signatures the brief gives you.

The rule that overrides every instinct you have:

> **Preserve behaviour first. Do not fix bugs.**

The specification's *Otevřené otázky* section will contain behaviour that looks wrong. It probably is wrong. Reproduce it anyway. A behavioural fix bundled into a migration makes the shadow diff unreadable — nobody can tell whether the new implementation is broken or better, and the whole verification chain loses its meaning.

If you are confident something is a defect, reproduce it, and say so in your final message under `Kandidáti na opravu`: what it is, and what the correct behaviour would be. It gets fixed in a separate change, after parity is proven.

Where a human decision has already been recorded against a difference, it is binding. `preserve` means the old behaviour is the required behaviour, however wrong it looks — someone saw both sides and chose.

Other requirements:

- **You do not get to see what the golden tests expect.** You get their names and the branches they cover. That is deliberate: an implementation fitted to the oracle is not measured by it. Reproduce the specified behaviour and the expectations follow.
- Parity runs the golden suite and the shadow harness after you, and hands back what failed. You cannot run them yourself, and you cannot re-run the experiment you are being judged by.
- Invariants become runtime assertions in the service, not just tests.
- Non-deterministic inputs — the current time, generated identifiers — arrive as parameters. Never call the clock or a UUID generator directly, or the service cannot be replayed.
- Import `mssql` and nothing else beyond the Node standard library. The container installs its dependencies at build time, so anything else fails at runtime rather than at review.
- Match the decimal arithmetic of the database. SQL Server computes money in decimal; binary floating point rounds the other way on values that land exactly on a boundary, and every one of those becomes a monetary difference a human has to read.
- Code that a person can read on a projector. No clever abstractions, no premature generalisation.

A service that passes because it guessed the test is worth less than one that fails honestly. The point of this milestone is a claim about evidence, and evidence a model fitted to itself is not evidence.
