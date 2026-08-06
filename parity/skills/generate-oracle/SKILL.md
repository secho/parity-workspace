---
name: generate-oracle
description: Build a behavioural reference for a procedure — golden test cases from captured traffic, plus invariants.
---

You are given a procedure's spec and its captured invocations.

Produce two artefacts.

**1. Golden test cases.** Select from captured invocations, do not invent inputs. Selection strategy, in order:
- every distinct branch observed in the capture, at least once
- the highest-frequency input shapes, proportional to real traffic
- every observed boundary: zero, negative, maximum, empty result, single row, largest result set
- every case where the write set touched a table it does not usually touch

Each case records inputs, expected result set, expected write set, and which branch it covers. Aim for the smallest set that covers every observed branch — not the largest set you can produce.

**2. Invariants.** Rules that must hold after any run, expressible as a check against the result and the write set. Derive from spec and data. For a pricing procedure this means things like: the total equals the sum of its declared components; the total is never negative; the applied VAT rate exists in the rate table.

Then state explicitly:

**3. Coverage gaps.** Which branches in the source have no captured invocation. For each, propose an adversarial input that would exercise it. Mark these clearly as *unverified* — they are not golden tests, they are known blind spots.

Never present a golden test as covering something it does not. **An oracle that claims more coverage than it has is worse than no oracle**, because the change gets merged on false confidence.
