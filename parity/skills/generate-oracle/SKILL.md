---
name: generate-oracle
description: Build a behavioural reference for a procedure — golden test cases from captured traffic, plus invariants.
---

You are given a procedure's spec and its captured invocations.

Produce two artefacts. Record them with `write_golden_tests` and `write_invariants` — those calls are the output, not the prose around them.

**1. Golden test cases.** Select from captured invocations, do not invent inputs. `list_capture_cases` gives you one real invocation per observed branch; you cite them by id and the inputs are read from the capture, so an invented parameter is not something you can express. Selection strategy, in order:
- every distinct branch observed in the capture, at least once
- the highest-frequency input shapes, proportional to real traffic
- every observed boundary: zero, negative, maximum, empty result, single row, largest result set
- every case where the write set touched a table it does not usually touch

Each case records inputs, expected result set, expected write set, and which branch it covers. Aim for the smallest set that covers every observed branch — not the largest set you can produce.

**2. Invariants.** Rules that must hold after any run, expressible as a check against the result and the write set. Derive from spec and data. For a pricing procedure this means things like: the total equals the sum of its declared components; the total is never negative; the applied VAT rate exists in the rate table.

Each one is evaluated in code, so it must use one of four kinds:

```
{ kind: "sum_identity",     table, target, components: [{column, factor}], tolerance }
{ kind: "non_negative",     table, columns: [...] }
{ kind: "value_from_table", table, numerator: [{column, factor}], denominator: [{column, factor}],
                            referenceTable, referenceColumn, referenceScale, tolerance }
{ kind: "advisory",         note }
```

Numerator and denominator are linear combinations, and that is what makes a rate check mean anything: **isolate the base the rate actually applies to.** If shipping, handling or a fee is taxed separately, or if a discount is applied at a different point, a naive *tax ÷ total* is not a rate on any row that carries one — it will differ everywhere and tell you nothing. Reconstruct the taxed base from the columns that were written, and subtract the parts that are taxed on their own.

`referenceScale` **multiplies the reference column** before comparison. A `Rate` column holding `21` to mean 21%, compared against a ratio of `0.21`, needs `0.01`. `write_invariants` echoes back the exact values your rule will compare against — read them. If they do not look like the rates you meant, the scale is inverted and every row will fail, which is indistinguishable from a procedure that is broken everywhere.

`advisory` is for a rule you believe but cannot express above. Use it rather than dropping the rule or bending it into a kind that does not fit — advisory rules are recorded and shown, and are never counted as verified.

Then state explicitly:

**3. Coverage gaps.** Which branches in the source have no captured invocation. For each, propose an adversarial input that would exercise it. Mark these clearly as *unverified* — they are not golden tests, they are known blind spots.

Never present a golden test as covering something it does not. **An oracle that claims more coverage than it has is worse than no oracle**, because the change gets merged on false confidence.
